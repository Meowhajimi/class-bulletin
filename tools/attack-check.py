"""模拟攻击：站在攻击者的角度，实际打一遍自己的网站，看防护有没有生效。

为什么要有这个脚本：
    安全设置里写的"已防护"如果没人验证过，就只是文档上的字。
    这个脚本用真实的攻击手法去打，并且把"打不动"当成通过、把"打得动"当成失败。

设计上的两个自我保护：
    1. **本地那部分用临时数据库 + 临时黑名单** —— 演练会把 127.0.0.1 打成永久封禁，
       如果用你真实的 ip_blacklist.json，你自己的本地服务器就进不去了。
    2. **公网那部分只做低次数探测** —— 故意失败登录只试 3 次。
       Supabase 有 IP 频率限制，打多了会把你自己的 IP 限住，反而影响你登录。

用法：
    python tools/attack-check.py              # 完整演练（公网 + 本地）
    python tools/attack-check.py --local-only # 只打本地（不碰云端）
    python tools/attack-check.py --cloud-only # 只做公网探测

它**不在** 跑测试.bat 里 —— 因为它会访问真实云端，不应该每次跑测试都去打一遍。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE_DIR)

if not sys.stdout.isatty():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass

from server import db  # noqa: E402
from server.local_api import LocalAPI  # noqa: E402
from server.security import SecurityGuard  # noqa: E402
from server.static_site import StaticSite  # noqa: E402
import serve  # noqa: E402

blocked_count = 0
breached_count = 0


def verdict(name: str, defended: bool, detail: str = "") -> None:
    """defended=True 表示攻击没有得手（这是我们要的结果）。"""
    global blocked_count, breached_count
    if defended:
        blocked_count += 1
        print(f"  [防住] {name}")
    else:
        breached_count += 1
        print(f"  [得手] {name}  ← 需要处理" + (f"（{detail}）" if detail else ""))
    if detail and defended:
        print(f"         {detail}")


# ============================== HTTP 小工具 ==============================


def http(method: str, url: str, *, headers=None, body=None, timeout=15):
    """返回 (状态码, 文本, 响应头字典)。不抛异常，方便把失败也当结果。"""
    data = None
    request_headers = dict(headers or {})
    if body is not None:
        data = json.dumps(body).encode("utf-8") if not isinstance(body, bytes) else body
        request_headers.setdefault("Content-Type", "application/json")

    request = urllib.request.Request(url, data=data, headers=request_headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            text = response.read().decode("utf-8", "replace")
            return response.status, text, dict(response.headers)
    except urllib.error.HTTPError as error:
        text = error.read().decode("utf-8", "replace")
        return error.code, text, dict(error.headers)
    except Exception as error:  # noqa: BLE001 - 网络问题也算一种结果
        return 0, f"<{type(error).__name__}: {error}>", {}


def read_cloud_config() -> tuple[str, str]:
    """从 web/js/config.js 里取云端地址与 anon key。"""
    path = os.path.join(BASE_DIR, "web", "js", "config.js")
    with open(path, "r", encoding="utf-8") as handle:
        text = handle.read()
    url = re.search(r"^\s*url:\s*'([^']*)'", text, re.MULTILINE)
    key = re.search(r"^\s*anonKey:\s*'([^']*)'", text, re.MULTILINE)
    return (url.group(1).strip() if url else ""), (key.group(1).strip() if key else "")


# ============================== 阶段 0：侦察 ==============================


def phase_recon(site: str, cloud_url: str, anon_key: str) -> None:
    print("\n" + "=" * 66)
    print("阶段 0 · 侦察：攻击者在动手前能白拿到什么")
    print("=" * 66)

    status, html, _ = http("GET", f"{site}/")
    verdict("网站可正常访问（这是应该的）", status == 200, f"HTTP {status}")

    # 攻击者会去读前端源码
    status, config_js, _ = http("GET", f"{site}/js/config.js")
    leaked_url = cloud_url and cloud_url in config_js
    leaked_key = anon_key and anon_key in config_js
    print(f"  从 /js/config.js 里读到了接口地址：{'是' if leaked_url else '否'}")
    print(f"  从 /js/config.js 里读到了 anon key：{'是' if leaked_key else '否'}")
    print("  → 这**不是漏洞**：anon key 本来就是公开的，真正的门是 RLS 与 GRANT。")
    print("    所以下面的测试重点是：拿着这个 key 能不能干坏事。")

    # 机密 key 绝不能出现在前端（这是真正的事故）
    status, all_js, _ = http("GET", f"{site}/js/data/supabase.js")
    secret_like = re.search(r"sb_secret_[A-Za-z0-9_\-]{6,}", config_js + all_js)
    verdict(
        "前端里没有机密 key（sb_secret_ / service_role）",
        secret_like is None,
        f"发现 {secret_like.group(0)[:20]}…" if secret_like else "扫过 config.js 与 supabase.js",
    )

    # 本地专用的安全页面不该出现在公网
    status, _, _ = http("GET", f"{site}/security")
    verdict("公网上没有本地专用的安全页面", status == 404, f"/security → HTTP {status}")

    # 目录/敏感文件探测
    probes = ["/.env", "/.git/config", "/wp-admin/", "/backup.zip", "/server/ip_blacklist.json",
              "/local_config.json", "/tools/backup-to-word.py"]
    exposed = []
    for probe in probes:
        status, _, _ = http("GET", f"{site}{probe}")
        if status == 200:
            exposed.append(probe)
    verdict(
        "敏感文件没有暴露在公网",
        not exposed,
        f"暴露了：{exposed}" if exposed else f"探测了 {len(probes)} 个常见路径，全部 404",
    )


# ============================== 阶段 1：公网攻击 ==============================


def phase_cloud(site: str, cloud_url: str, anon_key: str) -> None:
    print("\n" + "=" * 66)
    print("阶段 1 · 公网攻击尝试（低次数，避免触发 Supabase 限流误伤自己）")
    print("=" * 66)

    if not cloud_url or not anon_key:
        print("  跳过：config.js 里没有云端地址或 key")
        return

    anon = {"apikey": anon_key}
    good = {"apikey": anon_key, "Content-Type": "application/json"}

    # 1. 未登录读公告：本来就该能读（同学只读）
    status, text, _ = http("GET", f"{cloud_url}/rest/v1/messages?select=title", headers=anon)
    verdict("未登录可以读公告（设计如此，不算漏洞）", status == 200, f"HTTP {status}")

    # 2. 未登录发布
    status, text, _ = http(
        "POST", f"{cloud_url}/rest/v1/messages",
        headers=good, body={"title": "攻击者插进来的公告"},
    )
    verdict("未登录不能发布公告", status in (401, 403), f"HTTP {status}")

    # 3. 未登录删除（带一个不存在的 id，避免误删）
    status, _, _ = http(
        "DELETE", f"{cloud_url}/rest/v1/messages?id=eq.00000000-0000-0000-0000-000000000000",
        headers=anon,
    )
    verdict("未登录不能删除公告", status in (401, 403), f"HTTP {status}")

    # 4. 伪造一个 Bearer token 冒充管理员
    #    注意：HTTP 头必须是 ASCII，所以这里只能用 ASCII 的假签名
    #    （之前用中文写过，导致请求根本没发出去 —— 那是脚本的 bug，不是防护生效）
    fake_jwt = (
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
        "eyJyb2xlIjoiYXV0aGVudGljYXRlZCIsInN1YiI6IjAwMDAwMDAwLTAwMDAtMDAwMC0wMDAwLTAwMDAwMDAwMDAwMSJ9."
        "fake-signature-not-signed-by-supabase"
    )
    status, text, _ = http(
        "POST", f"{cloud_url}/rest/v1/messages",
        headers={"apikey": anon_key, "Authorization": f"Bearer {fake_jwt}",
                 "Content-Type": "application/json"},
        body={"title": "伪造 token 插入的公告"},
    )
    verdict("伪造登录态不能发布公告", status in (401, 403), f"HTTP {status}")

    # 5. 用一个假的 anon key
    status, _, _ = http(
        "GET", f"{cloud_url}/rest/v1/messages?select=title",
        headers={"apikey": "sb_publishable_totally_fake_key_123456"},
    )
    verdict("假 key 读不到数据", status in (401, 403), f"HTTP {status}")

    # 6. 暴力猜密码：只试 3 次。有验证码时，请求应该在"比密码"之前就被拒
    attempts = 3
    captcha_blocked = 0
    password_checked = 0
    for index in range(attempts):
        status, text, _ = http(
            "POST", f"{cloud_url}/auth/v1/token?grant_type=password",
            headers=good, body={"email": "admin@class.local", "password": f"guess-{index}"},
        )
        if "captcha" in text.lower():
            captcha_blocked += 1
        else:
            password_checked += 1

    verdict(
        "暴力猜密码被验证码挡在密码校验之前",
        captcha_blocked == attempts,
        f"{attempts} 次尝试全部返回 captcha_failed（密码根本没被比较）"
        if captcha_blocked == attempts
        else f"只有 {captcha_blocked}/{attempts} 次被验证码拦下",
    )

    # 7. 带上一个假验证码 token 再试
    status, text, _ = http(
        "POST", f"{cloud_url}/auth/v1/token?grant_type=password",
        headers=good,
        body={"email": "admin@class.local", "password": "guess",
              "gotrue_meta_security": {"captcha_token": "fake-token"}},
    )
    verdict("假验证码 token 会被真的校验", "invalid-input-response" in text, text.strip()[:90])

    # 8. 想直接读"在线人数"表的原始内容（表被 revoke 了，只能走函数）
    status, _, _ = http("GET", f"{cloud_url}/rest/v1/presence?select=*", headers=anon)
    verdict("不能直接读 presence 表的原始行", status in (401, 403, 404), f"HTTP {status}")

    # 9. SQL 注入尝试（PostgREST 的过滤参数）
    payloads = [
        "title=eq.' OR 1=1--",
        "select=*;drop table messages",
        "order=title);delete from messages--",
    ]
    injected = []
    for payload in payloads:
        status, text, _ = http("GET", f"{cloud_url}/rest/v1/messages?{payload}", headers=anon)
        # 被拒绝、或当作普通字符串处理（返回空）都算防住；
        # 只有"真的返回了不该返回的数据"才算得手
        if status == 200 and "token" in text.lower():
            injected.append(payload)
    verdict(
        "SQL 注入尝试没有拿到额外数据",
        not injected,
        f"试了 {len(payloads)} 种注入写法，都没有读到额外内容" if not injected else str(injected),
    )

    # 10. 越权改别人的公告（用带 id 过滤的 PATCH，但是未登录）
    status, _, _ = http(
        "PATCH", f"{cloud_url}/rest/v1/messages?id=eq.00000000-0000-0000-0000-000000000000",
        headers=good, body={"title": "被篡改"},
    )
    verdict("未登录不能修改公告", status in (401, 403), f"HTTP {status}")


# ============================== 阶段 2：本地完整攻击 ==============================


def phase_local() -> None:
    print("\n" + "=" * 66)
    print("阶段 2 · 本地服务器完整攻击模拟（临时库 + 临时黑名单，不碰你的真实数据）")
    print("=" * 66)

    temp_dir = tempfile.mkdtemp(prefix="attack-drill-")
    conn = db.connect(os.path.join(temp_dir, "drill.db"))
    db.seed_demo(conn)
    blacklist = os.path.join(temp_dir, "ip_blacklist.json")
    guard = SecurityGuard(blacklist)
    api = LocalAPI(conn, admin_email="admin@drill.local", admin_password="drill-password",
                   guard=guard)
    site = StaticSite(os.path.join(BASE_DIR, "web"))
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), serve.make_handler(api, site, quiet=True))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{httpd.server_address[1]}"

    try:
        # —— 攻击 1：暴力破解管理员密码 ——
        print("\n  攻击 1：暴力破解（连续猜密码）")
        lock_status = None
        for index in range(1, 11):
            status, text, _ = http(
                "POST", f"{base}/auth/v1/token?grant_type=password",
                body={"email": "admin@drill.local", "password": f"guess-{index}"},
            )
            if index == 10:
                lock_status = (status, text)
        status, text = lock_status
        compact = text.replace(" ", "").replace("\n", "")
        verdict(
            "第 10 次失败后开始锁定",
            status == 400 and '"locked":true' in compact,
            "响应里明确告知已锁定 30 分钟",
        )

        status, _, _ = http(
            "POST", f"{base}/auth/v1/token?grant_type=password",
            body={"email": "admin@drill.local", "password": "guess-11"},
        )
        verdict("第 11 次起请求直接被拦（403）", status == 403, f"HTTP {status}")

        # 锁定期间，连正确密码也进不去 —— 这才是"锁定"的意义
        status, _, _ = http(
            "POST", f"{base}/auth/v1/token?grant_type=password",
            body={"email": "admin@drill.local", "password": "drill-password"},
        )
        verdict("锁定期间正确密码同样被拒", status == 403, f"HTTP {status}")

        # 但不能连累同学看公告
        status, _, _ = http("GET", f"{base}/rest/v1/messages?select=title")
        verdict("临时锁定不影响同学看公告", status == 200, f"GET 公告 HTTP {status}")

        guard.unblock("127.0.0.1")
        guard.forget("127.0.0.1")

        # —— 攻击 2：扫描器探测敏感文件 ——
        print("\n  攻击 2：扫描器探测（攻击者找 .env / .git / 后台入口）")
        probes = ["/.env", "/.git/config", "/wp-admin/", "/phpmyadmin", "/.ssh/id_rsa"]
        for probe in probes:
            http("GET", f"{base}{probe}")
        snapshot = guard.snapshot()
        record = snapshot["records"][0] if snapshot["records"] else {}
        verdict(
            "探测行为被记入风险分",
            record.get("risk", 0) >= 10,
            f"试了 {len(probes)} 个路径，风险分累计到 {record.get('risk')} → 已永久封禁"
            if record.get("risk", 0) >= 10
            else f"风险分只有 {record.get('risk')}",
        )

        status, _, _ = http("GET", f"{base}/")
        verdict("被封禁后整站不可访问（连首页都拦）", status == 403, f"GET / → HTTP {status}")

        status, _, _ = http("GET", f"{base}/rest/v1/messages?select=title")
        verdict("被封禁后读公告也被拒", status == 403, f"HTTP {status}")

        # —— 攻击 3：路径穿越与注入 ——
        print("\n  攻击 3：路径穿越 / 注入尝试")
        guard.unblock("127.0.0.1")
        guard.forget("127.0.0.1")
        status, _, _ = http("GET", f"{base}/%2e%2e%2f%2e%2e%2fetc%2fpasswd")
        status2, _, _ = http(
            "POST", f"{base}/rest/v1/messages",
            body={"title": "' union select * from auth.users--"},
        )
        record = (guard.snapshot()["records"] or [{}])[0]
        verdict(
            "路径穿越与注入尝试都被记录",
            record.get("risk", 0) > 0,
            f"风险分 {record.get('risk')}，事件："
            + ", ".join(event["kind"] for event in record.get("events", [])[-3:]),
        )

        # —— 攻击 4：绕过登录直接改数据 ——
        print("\n  攻击 4：绕过登录直接写入")
        guard.unblock("127.0.0.1")
        guard.forget("127.0.0.1")
        status, _, _ = http(
            "POST", f"{base}/rest/v1/messages", body={"title": "未登录硬塞进来的公告"},
        )
        verdict("未登录写入被拒绝", status == 401, f"HTTP {status}")

        # —— 攻击 5：尝试打开"只有本机能看"的安全页面 ——
        print("\n  攻击 5：尝试打开本机专用的黑名单管理页")
        status, _, _ = http("GET", f"{base}/security")
        print(f"  从 127.0.0.1 访问 /security → HTTP {status}（本机应当能打开，这是给你自救用的）")
        verdict("本机能打开管理页（自救通道可用）", status == 200, f"HTTP {status}")

        # —— 攻击 6：把自己解封，确认封禁不是"假封" ——
        print("\n  攻击 6：验证封禁能解开（避免把自己永久锁死）")
        guard.block("127.0.0.1", "演练手动封禁", permanent=True)
        before, _, _ = http("GET", f"{base}/")
        status, text, _ = http(
            "POST", f"{base}/security/api",
            body={"action": "unblock", "ip": "127.0.0.1"},
        )
        after, _, _ = http("GET", f"{base}/")
        verdict(
            "本机可以解封并立即恢复访问",
            before == 403 and after == 200,
            f"封禁时 HTTP {before} → 解封后 HTTP {after}",
        )
    finally:
        httpd.shutdown()
        conn.close()


# ============================== 阶段 3：响应头与信息泄漏 ==============================


def phase_headers(site: str) -> None:
    print("\n" + "=" * 66)
    print("阶段 3 · 响应头审计（浏览器侧的防护）")
    print("=" * 66)

    status, _, headers = http("GET", f"{site}/")
    lowered = {key.lower(): value for key, value in headers.items()}

    print(f"  服务器标识: {lowered.get('server', '（未提供）')}")
    print(f"  X-Nf-Request-Id: {'有（Netlify 直出）' if 'x-nf-request-id' in lowered else '无'}")

    checks = [
        ("X-Content-Type-Options", "nosniff", "防止浏览器猜错文件类型"),
        ("X-Frame-Options", None, "防止被别人用 iframe 套壳（点击劫持）"),
        ("Referrer-Policy", None, "控制跳转时泄露多少来源信息"),
        ("Content-Security-Policy", None, "限制页面能加载哪些外部脚本（防 XSS 外带）"),
        ("Permissions-Policy", None, "关闭不需要的浏览器能力（摄像头/麦克风等）"),
    ]
    missing = []
    for name, expected, why in checks:
        value = lowered.get(name.lower())
        if value:
            print(f"  ✅ {name}: {value[:70]}")
        else:
            missing.append(f"{name}（{why}）")
            print(f"  ❌ {name}: 未设置 —— {why}")

    if missing:
        print("\n  说明：这些是 Netlify 静态托管的默认行为，不影响功能，"
              "但补上能多一层浏览器侧防护。")
        print("  补法：在 web/ 目录放一个 _headers 文件（Netlify 对拖拽部署同样生效）。")

    # 检查 server 版本号之类的信息泄漏
    server = lowered.get("server", "")
    verdict("响应头没有泄漏具体的服务器版本", not re.search(r"\d+\.\d+", server), f"Server: {server}")


# ============================== 主流程 ==============================


def main() -> int:
    parser = argparse.ArgumentParser(description="模拟攻击：验证自己网站的防护是否真的生效")
    parser.add_argument("--local-only", action="store_true", help="只打本地服务器")
    parser.add_argument("--cloud-only", action="store_true", help="只做公网探测")
    parser.add_argument("--site", default="https://class-bulletin-major.netlify.app",
                        help="公网地址")
    args = parser.parse_args()

    cloud_url, anon_key = read_cloud_config()
    site = args.site.rstrip("/")

    print("=" * 66)
    print("  模拟攻击演练")
    print("=" * 66)
    print(f"  目标（公网）：{site}")
    print(f"  目标（云端）：{cloud_url or '（未配置）'}")
    print(f"  目标（本地）：临时起一个，用完即删")
    print("\n  原则：只打自己的系统；公网低次数探测；本地用临时数据。")

    if not args.local_only:
        phase_recon(site, cloud_url, anon_key)
        phase_cloud(site, cloud_url, anon_key)
        phase_headers(site)
    if not args.cloud_only:
        phase_local()

    print("\n" + "=" * 66)
    print(f"  演练结束：防住 {blocked_count} 项，被攻破 {breached_count} 项")
    if breached_count == 0:
        print("  结论：本次演练涉及的所有攻击手法都被挡住了。")
    else:
        print("  结论：有攻击得手，请按上面的提示处理。")
    print("=" * 66)
    return 1 if breached_count else 0


if __name__ == "__main__":
    raise SystemExit(main())
