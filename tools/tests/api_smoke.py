"""端到端冒烟测试：在进程内启动真实服务器，把接口全部跑一遍。

只依赖 Python 标准库，直接运行：
    python tools/tests/api_smoke.py

它测的是 `serve.py` 真正使用的路由与接口实现，
所以这里通过就说明前端 `data/supabase.js` 走的路径是通的。
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from typing import Any

BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, BASE_DIR)

# 输出被重定向到文件/管道时，统一按 UTF-8 写，避免中文变成乱码
if not sys.stdout.isatty():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass

from server import db  # noqa: E402
from server.local_api import LocalAPI  # noqa: E402
from server.static_site import StaticSite  # noqa: E402
import serve  # noqa: E402

ADMIN_EMAIL = "admin@test.local"
ADMIN_PASSWORD = "test-password-123"

passed = 0
failed = 0
skipped = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"  [通过] {name}")
    else:
        failed += 1
        print(f"  [失败] {name}" + (f" —— {detail}" if detail else ""))


def skip(name: str, reason: str) -> None:
    global skipped
    skipped += 1
    print(f"  [跳过] {name} —— {reason}")


def request(
    url: str,
    method: str = "GET",
    body: Any = None,
    token: str | None = None,
    apikey: str = "local-anon-key",
) -> tuple[int, Any, dict[str, str]]:
    """发一个请求，返回 (状态码, 解析后的 JSON 或原始字节, 响应头)。"""
    data = None
    headers = {"apikey": apikey}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            raw = response.read()
            status = response.status
            resp_headers = {k.lower(): v for k, v in response.headers.items()}
    except urllib.error.HTTPError as error:
        raw = error.read()
        status = error.code
        resp_headers = {k.lower(): v for k, v in error.headers.items()}
    except urllib.error.URLError as error:
        raise SystemExit(f"无法连接测试服务器：{error}") from error

    parsed: Any = None
    if raw:
        try:
            parsed = json.loads(raw.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            parsed = raw
    return status, parsed, resp_headers


def main() -> int:
    temp_dir = tempfile.mkdtemp(prefix="class-bulletin-test-")
    conn = db.connect(os.path.join(temp_dir, "test.db"))

    api = LocalAPI(conn, admin_email=ADMIN_EMAIL, admin_password=ADMIN_PASSWORD)
    site = StaticSite(os.path.join(BASE_DIR, "web"))
    handler = serve.make_handler(api, site, quiet=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{httpd.server_address[1]}"
    print(f"\n测试服务器：{base}\n")

    try:
        print("一、读取与权限")
        status, payload, _ = request(f"{base}/rest/v1/messages?select=*&order=published_at.desc")
        check("未登录也能读列表（同学只读）", status == 200 and payload == [], f"{status} {payload}")

        status, _, _ = request(f"{base}/rest/v1/messages", method="POST", body={"title": "偷偷发一条"})
        check("未登录写入被拒绝（401）", status == 401, f"实际 {status}")

        status, _, _ = request(
            f"{base}/rest/v1/messages?id=eq.whatever", method="DELETE"
        )
        check("未登录删除被拒绝（401）", status == 401, f"实际 {status}")

        print("\n二、登录")
        status, payload, _ = request(
            f"{base}/auth/v1/token?grant_type=password",
            method="POST",
            body={"email": ADMIN_EMAIL, "password": "wrong-password"},
        )
        check("口令错误登录失败（400）", status == 400, f"实际 {status}")

        status, payload, _ = request(
            f"{base}/auth/v1/token?grant_type=password",
            method="POST",
            body={"email": ADMIN_EMAIL.upper(), "password": ADMIN_PASSWORD},
        )
        check("邮箱大小写不敏感且登录成功", status == 200 and "access_token" in (payload or {}), f"{status} {payload}")
        check("返回 refresh_token", bool((payload or {}).get("refresh_token")))
        access_token = (payload or {}).get("access_token", "")
        refresh_token = (payload or {}).get("refresh_token", "")

        print("\n三、发布 / 修改 / 删除")
        status, payload, _ = request(
            f"{base}/rest/v1/messages",
            method="POST",
            body={
                "title": "第一条公告",
                "body": "正文第一行\n正文第二行",
                "published_at": "2025-03-01T08:00:00+08:00",
                "expires_at": "2025-03-05T23:59:00+08:00",
            },
            token=access_token,
        )
        check("登录后可发布（201）", status == 201, f"实际 {status} {payload}")
        created = (payload or [{}])[0]
        message_id = created.get("id", "")
        check("返回了 id", bool(message_id), str(payload))
        check("标题原样保存", created.get("title") == "第一条公告")
        check("正文保留换行", created.get("body") == "正文第一行\n正文第二行")
        check(
            "时间统一转成 UTC",
            created.get("published_at", "").startswith("2025-03-01T00:00:00"),
            str(created.get("published_at")),
        )

        status, _, _ = request(
            f"{base}/rest/v1/messages", method="POST", body={"title": "   "}, token=access_token
        )
        check("空标题被拒绝（400）", status == 400, f"实际 {status}")

        status, _, _ = request(
            f"{base}/rest/v1/messages",
            method="POST",
            body={"title": "x" * 201},
            token=access_token,
        )
        check("超长标题被拒绝（400）", status == 400, f"实际 {status}")

        print("\n三之二、紧急公告字段（is_urgent）")
        status, payload, _ = request(
            f"{base}/rest/v1/messages",
            method="POST",
            body={"title": "紧急通知", "is_urgent": True},
            token=access_token,
        )
        urgent_row = (payload or [{}])[0]
        check("可以发布紧急公告", status == 201, f"实际 {status}")
        check(
            "is_urgent 存为真值",
            urgent_row.get("is_urgent") is True,
            f"实际 {urgent_row.get('is_urgent')!r}（应当是布尔 true，不是 1）",
        )

        # 不传该字段时应当是 false，不能是 null
        status, payload, _ = request(
            f"{base}/rest/v1/messages",
            method="POST",
            body={"title": "普通通知"},
            token=access_token,
        )
        normal_row = (payload or [{}])[0]
        check(
            "不传 is_urgent 时默认为 false",
            normal_row.get("is_urgent") is False,
            f"实际 {normal_row.get('is_urgent')!r}",
        )

        status, payload, _ = request(
            f"{base}/rest/v1/messages?id=eq.{normal_row.get('id')}",
            method="PATCH",
            body={"is_urgent": True},
            token=access_token,
        )
        check(
            "可以把已有公告改成紧急",
            status == 200 and (payload or [{}])[0].get("is_urgent") is True,
            f"{status} {payload}",
        )

        status, payload, _ = request(
            f"{base}/rest/v1/messages?id=eq.{normal_row.get('id')}",
            method="PATCH",
            body={"is_urgent": False},
            token=access_token,
        )
        check(
            "也可以取消紧急",
            status == 200 and (payload or [{}])[0].get("is_urgent") is False,
            f"{status} {payload}",
        )

        status, payload, _ = request(f"{base}/rest/v1/messages?select=*")
        listed = next((item for item in payload or [] if item["id"] == urgent_row.get("id")), None)
        check(
            "列表里能带出紧急状态",
            listed is not None and listed.get("is_urgent") is True,
            f"{listed}",
        )

        # 把这一节造的数据清掉，免得影响后面几节的数据集
        for extra_id in (urgent_row.get("id"), normal_row.get("id")):
            if extra_id:
                request(f"{base}/rest/v1/messages?id=eq.{extra_id}", method="DELETE", token=access_token)

        status, payload, _ = request(
            f"{base}/rest/v1/messages?id=eq.{message_id}",
            method="PATCH",
            body={"title": "改过的标题"},
            token=access_token,
        )
        check("修改标题成功", status == 200 and (payload or [{}])[0].get("title") == "改过的标题", f"{status} {payload}")

        status, payload, _ = request(
            f"{base}/rest/v1/messages?id=eq.{message_id}",
            method="PATCH",
            body={"expires_at": None},
            token=access_token,
        )
        check("可以把过期时间清空（永不过期）", status == 200 and (payload or [{}])[0].get("expires_at") is None, f"{status} {payload}")

        status, _, _ = request(
            f"{base}/rest/v1/messages?id=eq.00000000-0000-0000-0000-000000000000",
            method="PATCH",
            body={"title": "不存在"},
            token=access_token,
        )
        check("改不存在的消息返回 404", status == 404, f"实际 {status}")

        print("\n四、排序（首页依赖这条规则）")
        for title, when in [
            ("较早的通知", "2025-01-01T09:00:00+08:00"),
            ("最新的通知", "2025-06-01T09:00:00+08:00"),
            ("中间的通知", "2025-04-01T09:00:00+08:00"),
        ]:
            request(
                f"{base}/rest/v1/messages",
                method="POST",
                body={"title": title, "published_at": when},
                token=access_token,
            )
        status, payload, _ = request(f"{base}/rest/v1/messages?select=*&order=published_at.desc")
        titles = [item["title"] for item in payload or []]
        # 期望顺序：06-01 → 04-01 → 03-01（第一条公告被改过标题）→ 01-01
        # 只看这几个固定数据之间的相对顺序，这样以后再加测试数据也不会误报
        fixtures = ["最新的通知", "中间的通知", "改过的标题", "较早的通知"]
        check(
            "列表按发布时间倒序",
            [title for title in titles if title in fixtures] == fixtures,
            str(titles),
        )
        published_list = [item["published_at"] for item in payload or []]
        check(
            "整体时间确实是非递增的",
            published_list == sorted(published_list, reverse=True),
            str(published_list),
        )

        print("\n五、登录态刷新")
        status, payload, _ = request(
            f"{base}/auth/v1/token?grant_type=refresh_token",
            method="POST",
            body={"refresh_token": refresh_token},
        )
        check("可以刷新登录态", status == 200 and "access_token" in (payload or {}), f"{status} {payload}")
        new_access = (payload or {}).get("access_token", "")
        status, _, _ = request(
            f"{base}/rest/v1/messages",
            method="POST",
            body={"title": "用新令牌发布"},
            token=new_access,
        )
        check("新令牌可用", status == 201, f"实际 {status}")

        status, _, _ = request(
            f"{base}/auth/v1/token?grant_type=refresh_token",
            method="POST",
            body={"refresh_token": refresh_token},
        )
        check("旧 refresh_token 已失效（轮换）", status == 401, f"实际 {status}")

        status, _, _ = request(f"{base}/auth/v1/logout", method="POST", body={}, token=new_access)
        check("登出成功", status == 204, f"实际 {status}")
        status, _, _ = request(
            f"{base}/rest/v1/messages", method="POST", body={"title": "登出后发布"}, token=new_access
        )
        check("登出后不能再写（401）", status == 401, f"实际 {status}")

        print("\n六、删除")
        status, _, _ = request(
            f"{base}/rest/v1/messages?id=eq.{message_id}", method="DELETE", token=access_token
        )
        check("删除成功（204）", status == 204, f"实际 {status}")
        _, payload, _ = request(f"{base}/rest/v1/messages?select=*")
        check(
            "删除后列表里没有它",
            all(item["id"] != message_id for item in payload or []),
            str([item["title"] for item in payload or []]),
        )

        print("\n七、静态页面")
        index_path = os.path.join(BASE_DIR, "web", "index.html")
        if os.path.isfile(index_path):
            status, payload, headers = request(f"{base}/")
            check("首页返回 200", status == 200, f"实际 {status}")
            check(
                "首页是 HTML",
                "text/html" in headers.get("content-type", ""),
                headers.get("content-type", ""),
            )
            status, _, headers = request(f"{base}/js/config.js")
            check("JS 的 MIME 是 text/javascript", status == 200 and "text/javascript" in headers.get("content-type", ""), headers.get("content-type", ""))
            status, _, headers = request(f"{base}/css/tokens.css")
            check("CSS 能取到", status == 200 and "text/css" in headers.get("content-type", ""), f"{status} {headers.get('content-type','')}")
            status, _, _ = request(f"{base}/admin.html")
            check("管理页能取到", status == 200, f"实际 {status}")
            status, _, _ = request(f"{base}/%2e%2e/serve.py")
            check("挡掉目录穿越", status == 404, f"实际 {status}")

            # /api 前缀：公网上由 Cloudflare Pages 的 Function 转发到 Supabase；
            # 本地预览没有那个 Function，所以服务器要自己剥掉 /api 处理，
            # 这样 config.js 只填一个 /api 就能在三种环境下都通。
            print("\n七之二、/api 同源前缀（本地预览也要能走）")
            status, payload, _ = request(f"{base}/api/rest/v1/messages?select=*")
            check("/api 前缀能读到公告列表", status == 200, f"实际 {status}")
            check(
                "/api 返回的是真的数据（不是 404 页面）",
                isinstance(payload, list),
                str(type(payload).__name__),
            )
            status, _, _ = request(
                f"{base}/api/rest/v1/messages", method="POST", body={"title": "匿名发布"}
            )
            check("未登录时 /api 写入仍然被拒（权限没有被代理放大）", status in (401, 403), f"实际 {status}")
            status, payload, _ = request(f"{base}/api/rest/v1/rpc/presence_count", method="POST", body={})
            check("/api 下的 RPC 也能用（在线人数）", status == 200 and isinstance(payload, int), f"{status} {payload}")
            status, _, _ = request(f"{base}/api/nonsense")
            check("/api 下的未知路径仍然 404", status == 404, f"实际 {status}")
        else:
            skip("静态页面相关检查", "web/index.html 还不存在")

        print("\n八、静态服务器单元检查")
        check(
            "未知扩展名不会被当成脚本",
            StaticSite.content_type("a.bin") == "application/octet-stream",
        )
        check(
            "越界路径被拦下",
            StaticSite(BASE_DIR).resolve("/../evil.txt") is None,
        )

        print("\n九、老数据库自动迁移（升级不丢数据）")
        # 模拟"升级前就已经存在的库"：只有老字段，没有 is_urgent。
        # connect() 必须自动补列，否则老用户一升级就报 no such column。
        legacy_path = os.path.join(temp_dir, "legacy.db")
        legacy = sqlite3.connect(legacy_path)
        legacy.executescript(
            """
            create table messages (
              id           text primary key,
              title        text not null,
              body         text not null default '',
              published_at text not null,
              expires_at   text,
              created_by   text,
              created_at   text not null,
              updated_at   text not null
            );
            """
        )
        legacy.execute(
            "insert into messages (id, title, body, published_at, created_at, updated_at)"
            " values ('old-1', '升级前的老公告', '老数据', '2025-01-01T00:00:00+00:00',"
            " '2025-01-01T00:00:00+00:00', '2025-01-01T00:00:00+00:00')"
        )
        legacy.commit()
        legacy.close()

        migrated = db.connect(legacy_path)
        legacy_columns = {row["name"] for row in migrated.execute("pragma table_info(messages)")}
        check("自动补上了 is_urgent 列", "is_urgent" in legacy_columns, str(sorted(legacy_columns)))
        check("自动补上了 section_id 列", "section_id" in legacy_columns, str(sorted(legacy_columns)))

        old_row = db.get_message(migrated, "old-1")
        check("老公告没有丢", old_row is not None and old_row["title"] == "升级前的老公告", str(old_row))
        check(
            "老公告的 is_urgent 读出来是布尔 False（不是 0/None）",
            old_row is not None and old_row["is_urgent"] is False,
            f"实际 {old_row.get('is_urgent')!r}",
        )

        # 老库升级后必须自动有栏目，并且老公告被回填进去 ——
        # 否则前端会看到一堆"没有栏目"的公告
        migrated_sections = db.list_sections(migrated)
        check("老库自动建了默认栏目", len(migrated_sections) == 1, str(migrated_sections))
        check(
            "默认栏目名与 schema.sql 一致",
            migrated_sections and migrated_sections[0]["name"] == db.DEFAULT_SECTION_NAME,
            str(migrated_sections),
        )
        check(
            "★ 老公告被回填到默认栏目",
            old_row is not None and old_row.get("section_id") == migrated_sections[0]["id"],
            f"实际 {old_row.get('section_id') if old_row else None!r}",
        )

        new_row = db.create_message(migrated, {"title": "升级后新公告", "is_urgent": True}, user_id=None)
        check("迁移后能写入紧急公告", new_row.get("is_urgent") is True, str(new_row.get("is_urgent")))
        check("没传栏目时自动落到默认栏目", new_row.get("section_id") == migrated_sections[0]["id"], str(new_row.get("section_id")))

        # 反复调用 connect 应当幂等，不能报"列已存在"
        try:
            db.connect(legacy_path)
            check("重复迁移是幂等的（不会报错）", True)
        except sqlite3.OperationalError as exc:
            check("重复迁移是幂等的（不会报错）", False, str(exc))
        migrated.close()

        print("\n十、在线人数")
        status, _, _ = request(
            f"{base}/rest/v1/rpc/presence_heartbeat",
            method="POST",
            body={"p_session": "smoke-session-aaaaaaaa"},
        )
        check("心跳返回 204", status == 204, f"实际 {status}")

        status, payload, _ = request(
            f"{base}/rest/v1/rpc/presence_count", method="POST", body={}
        )
        check("取人数返回数字", status == 200 and isinstance(payload, int), f"{status} {payload!r}")
        check("一个会话心跳后人数为 1", payload == 1, f"实际 {payload!r}")

        # 第二个会话
        request(
            f"{base}/rest/v1/rpc/presence_heartbeat",
            method="POST",
            body={"p_session": "smoke-session-bbbbbbbb"},
        )
        _, payload, _ = request(f"{base}/rest/v1/rpc/presence_count", method="POST", body={})
        check("两个会话 → 2 人", payload == 2, f"实际 {payload!r}")

        # 同一个会话重复心跳不该被算成两个人
        request(
            f"{base}/rest/v1/rpc/presence_heartbeat",
            method="POST",
            body={"p_session": "smoke-session-bbbbbbbb"},
        )
        _, payload, _ = request(f"{base}/rest/v1/rpc/presence_count", method="POST", body={})
        check("同一会话重复心跳不会重复计数", payload == 2, f"实际 {payload!r}")

        # 非法会话号：当作没看见，不报错，也不计数
        status, _, _ = request(
            f"{base}/rest/v1/rpc/presence_heartbeat", method="POST", body={"p_session": "x"}
        )
        check("过短的会话号被忽略（不报错）", status == 204, f"实际 {status}")
        _, payload, _ = request(f"{base}/rest/v1/rpc/presence_count", method="POST", body={})
        check("非法会话号不会计入人数", payload == 2, f"实际 {payload!r}")

        status, _, _ = request(
            f"{base}/rest/v1/rpc/presence_heartbeat", method="POST", body={"p_session": "y" * 100}
        )
        _, payload, _ = request(f"{base}/rest/v1/rpc/presence_count", method="POST", body={})
        check("过长的会话号也被忽略", payload == 2, f"实际 {payload!r}")

        status, _, _ = request(f"{base}/rest/v1/rpc/no_such_function", method="POST", body={})
        check("不存在的函数返回 404", status == 404, f"实际 {status}")

        print("\n十一、栏目（sections）")
        # 需要登录态才能写；先拿一个 token
        status, login_payload, _ = request(
            f"{base}/auth/v1/token?grant_type=password",
            method="POST",
            body={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        )
        admin_token = (login_payload or {}).get("access_token", "")

        status, sections, _ = request(f"{base}/rest/v1/sections")
        check("同学无需登录即可读栏目", status == 200 and isinstance(sections, list), f"{status} {sections!r}")
        check("默认就有一个栏目", len(sections) == 1, str(sections))
        check(
            "默认栏目名与 db.py 常量一致",
            sections and sections[0].get("name") == db.DEFAULT_SECTION_NAME,
            str(sections),
        )
        default_section_id = sections[0]["id"] if sections else ""

        status, _, _ = request(
            f"{base}/rest/v1/sections", method="POST", body={"name": "没登录也想加栏目"}
        )
        check("未登录不能新增栏目", status == 401, f"实际 {status}")

        status, created, _ = request(
            f"{base}/rest/v1/sections", method="POST", body={"name": "班级事务"}, token=admin_token
        )
        check("登录后能新增栏目", status == 201 and created and created[0]["name"] == "班级事务", f"{status} {created!r}")
        new_section_id = created[0]["id"] if created else ""

        status, _, _ = request(
            f"{base}/rest/v1/sections", method="POST", body={"name": "班级事务"}, token=admin_token
        )
        check("栏目重名被拒（409，与 Supabase 的 23505 一致）", status == 409, f"实际 {status}")

        status, _, _ = request(
            f"{base}/rest/v1/sections", method="POST", body={"name": "   "}, token=admin_token
        )
        check("空栏目名被拒（400）", status == 400, f"实际 {status}")

        status, _, _ = request(
            f"{base}/rest/v1/sections", method="POST", body={"name": "长" * 41}, token=admin_token
        )
        check("栏目名超过 40 字被拒（400）", status == 400, f"实际 {status}")

        # 首尾空格应当被 trim 后当成同一个名字
        status, _, _ = request(
            f"{base}/rest/v1/sections", method="POST", body={"name": "  班级事务  "}, token=admin_token
        )
        check("名称首尾空格会被 trim，仍算重名", status == 409, f"实际 {status}")

        status, renamed, _ = request(
            f"{base}/rest/v1/sections?id=eq.{new_section_id}",
            method="PATCH",
            body={"name": "班委通知"},
            token=admin_token,
        )
        check("能重命名栏目", status == 200 and renamed and renamed[0]["name"] == "班委通知", f"{status} {renamed!r}")

        status, _, _ = request(
            f"{base}/rest/v1/sections?id=eq.{new_section_id}",
            method="PATCH",
            body={"name": db.DEFAULT_SECTION_NAME},
            token=admin_token,
        )
        check("改名撞上已有名字也被拒（409）", status == 409, f"实际 {status}")

        # 往新栏目里发一条公告，然后验证"非空栏目不能删"
        status, made, _ = request(
            f"{base}/rest/v1/messages",
            method="POST",
            body={"title": "班委通知示例", "section_id": new_section_id},
            token=admin_token,
        )
        check("能把公告发到指定栏目", status == 201 and made and made[0].get("section_id") == new_section_id, f"{status} {made!r}")
        temp_message_id = made[0]["id"] if made else ""

        status, payload, _ = request(
            f"{base}/rest/v1/sections?id=eq.{new_section_id}", method="DELETE", token=admin_token
        )
        check("★ 非空栏目不能删（409）", status == 409, f"实际 {status}")
        check("拒绝原因写明了「还有 N 条公告」", "还有" in str(payload), str(payload))

        status, _, _ = request(
            f"{base}/rest/v1/messages?id=eq.{temp_message_id}", method="DELETE", token=admin_token
        )
        check("先把里面的公告删掉", status == 204, f"实际 {status}")

        status, _, _ = request(
            f"{base}/rest/v1/sections?id=eq.{new_section_id}", method="DELETE", token=admin_token
        )
        check("空栏目可以删", status == 204, f"实际 {status}")

        status, _, _ = request(
            f"{base}/rest/v1/sections?id=eq.{default_section_id}", method="DELETE", token=admin_token
        )
        check("★ 最后一个栏目不能删（409）", status == 409, f"实际 {status}")

        status, _, _ = request(
            f"{base}/rest/v1/messages",
            method="POST",
            body={"title": "发到不存在的栏目", "section_id": "no-such-section"},
            token=admin_token,
        )
        check("发到不存在的栏目被拒（400）", status == 400, f"实际 {status}")

        status, _, _ = request(
            f"{base}/rest/v1/sections?id=eq.no-such-section",
            method="PATCH",
            body={"name": "随便"},
            token=admin_token,
        )
        check("改不存在的栏目返回 404", status == 404, f"实际 {status}")

        print("\n十二、本地安全防护（登录锁定 / 风控 / 黑名单）")
        # 这一段会把 127.0.0.1 锁掉，所以放在最后，并且每小段结束都解封
        guard = api.guard

        # —— 风控：静态路径的探测也要被记到（扫描器最常打这些）——
        guard.unblock("127.0.0.1")
        guard.forget("127.0.0.1")
        for probe in ("/.env", "/.git/config", "/wp-admin/"):
            request(f"{base}{probe}")
        record = guard.snapshot()["records"][0]
        check("探测 /.env、/.git/config、/wp-admin 会被记风险分", record["risk"] == 6, f"实际 {record['risk']}")

        # 继续探测到阈值 → 永久封禁 → 整站不可访问
        request(f"{base}/.ssh/id_rsa")
        status, payload, _ = request(f"{base}/phpmyadmin")
        check("风险分达到上限后立即返回 403", status == 403, f"实际 {status}")
        check("封禁原因写明是攻击行为", "攻击" in str(payload), str(payload))

        status, _, _ = request(f"{base}/rest/v1/messages?select=*")
        check("永久封禁后连读公告都被拒", status == 403, f"实际 {status}")
        status, _, _ = request(f"{base}/admin.html")
        check("永久封禁后静态页面也不给（整站拦截）", status == 403, f"实际 {status}")

        # 管理页必须仍然能打开，否则就把自己永久锁死了
        status, _, _ = request(f"{base}/security")
        check("永久封禁期间 /security 仍可打开（否则无法自救）", status == 200, f"实际 {status}")

        status, payload, _ = request(
            f"{base}/security/api", method="POST", body={"action": "unblock", "ip": "127.0.0.1"}
        )
        check("本机可以把 IP 从黑名单里解封", status == 200 and payload.get("ok") is True, str(payload))

        status, _, _ = request(f"{base}/rest/v1/messages?select=*")
        check("解封后恢复正常访问", status == 200, f"实际 {status}")

        # —— 登录失败锁定 ——
        guard.unblock("127.0.0.1")
        guard.forget("127.0.0.1")
        for index in range(1, 11):
            status, payload, _ = request(
                f"{base}/auth/v1/token?grant_type=password",
                method="POST",
                body={"email": ADMIN_EMAIL, "password": "wrong"},
            )
        # 第 10 次是"触发锁定的那一次"，所以它仍然是一次登录失败响应（400），
        # 但响应里会明确告诉对方已被锁定。
        check("第 10 次失败会告知已锁定", status == 400 and payload.get("locked") is True, str(payload))
        check(
            "锁定原因里写明了 30 分钟",
            "30 分钟" in str(payload),
            str(payload),
        )

        # 第 11 次开始，请求在进登录逻辑之前就被挡下（403）
        status, payload, _ = request(
            f"{base}/auth/v1/token?grant_type=password",
            method="POST",
            body={"email": ADMIN_EMAIL, "password": "wrong"},
        )
        check("第 11 次起直接被拦截（403）", status == 403, f"实际 {status}")

        status, payload, _ = request(
            f"{base}/auth/v1/token?grant_type=password",
            method="POST",
            body={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        )
        check("锁定期间连正确密码也进不去", status == 403, f"实际 {status}")

        # 关键体验点：临时锁定只挡登录，不能连累同学看公告
        status, _, _ = request(f"{base}/rest/v1/messages?select=*")
        check("临时锁定不影响同学读公告", status == 200, f"实际 {status}")
        status, _, _ = request(f"{base}/")
        check("临时锁定不影响打开首页", status == 200, f"实际 {status}")

        # 解封后恢复正常
        guard.unblock("127.0.0.1")
        status, _, _ = request(
            f"{base}/auth/v1/token?grant_type=password",
            method="POST",
            body={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        )
        check("解封后可以正常登录", status == 200, f"实际 {status}")

        # —— 黑名单的可读性（本机要能看懂发生了什么）——
        snapshot = guard.snapshot()
        check("管理页快照带策略阈值", snapshot["policy"]["fail_threshold"] == 10, str(snapshot["policy"]))
        check("快照能列出 IP 记录", "records" in snapshot and "ip" in snapshot["records"][0])

        guard.forget("127.0.0.1")
    finally:
        httpd.shutdown()
        conn.close()

    print(f"\n{'=' * 46}")
    print(f"通过 {passed} 项，失败 {failed} 项，跳过 {skipped} 项")
    print("=" * 46)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
