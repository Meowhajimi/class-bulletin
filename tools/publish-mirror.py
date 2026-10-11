"""把网站文件上传到 Supabase Storage —— ⚠️ 它**无法**产出可访问的网站。

⚠️ 先说结论（2026-10 实测，别再试图绕过）：

    Supabase 从设计上不允许托管网站。它会对**任何 `text/html` 响应**
    强制做两件事：
      · 把 Content-Type 改成 `text/plain`
      · 加上 `Content-Security-Policy: default-src 'none'; sandbox`

    Storage 直链如此，自己写的 Edge Function 也如此（`.js`/`.css` 不受影响，
    所以不是代码问题，是平台层面的限制，没有开关可关）。

    也就是说：这个脚本上传完，那些文件**下载**下来是对的，
    但**用浏览器打开只会看到 HTML 源码**，不能当网站用。

    想给同学一个"主站打不开时的备用入口"，只有换一个网络路径不同的域名，
    见项目根目录 `安全设置.md` 的「同学打不开怎么办 → 办法 ②」。

那这个脚本还留着干什么：
    · 作为一次完整排查的记录（本文件与 Edge Function 都通过了测试）
    · 如果以后要往桶里放**图片/附件**之类不需要当网页渲染的文件，仍然可用

用法（如果你确实要把文件传上去）：
    1. 先在 Supabase 跑 supabase/mirror.sql（建公开桶）
    2. 从 Supabase → Settings → API Keys 复制「机密 key」存到
       项目根目录的 `supabase_service_key.txt`（已 gitignore）
    3. python tools/publish-mirror.py

⚠️ service_role key 是管理员万能钥匙：
    · 只存在你本机，**绝不能进 web/ 目录、绝不能进部署包**（打包脚本会拦）
    · 既然镜像这条路不通，**建议直接把那个文件删掉**
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE_DIR)

from server.static_site import StaticSite  # noqa: E402

BUCKET = "site"
# Edge Function 的入口路径（函数名必须叫 mirror）。见 supabase/functions/mirror/index.ts
FUNCTION_PATH = "/functions/v1/mirror/"
KEY_FILE = os.path.join(BASE_DIR, "supabase_service_key.txt")
DIST_DIR = os.path.join(BASE_DIR, "dist")

if not sys.stdout.isatty():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass


def read_project_url() -> str:
    """从 web/js/config.js 里读接口地址（也就是 Supabase 项目地址）。"""
    path = os.path.join(BASE_DIR, "web", "js", "config.js")
    with open(path, "r", encoding="utf-8") as handle:
        text = handle.read()
    match = re.search(r"^\s*url:\s*'([^']*)'", text, re.MULTILINE)
    return (match.group(1).strip().rstrip("/") if match else "")


def read_service_key() -> str:
    """读取 service_role key：先看文件，再看环境变量。"""
    if os.path.isfile(KEY_FILE):
        with open(KEY_FILE, "r", encoding="utf-8-sig") as handle:
            # 允许文件里带注释和换行，只取第一个看起来像 key 的长串
            for line in handle:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                return line
    return os.environ.get("SUPABASE_SERVICE_KEY", "").strip()


def describe_key(key: str) -> str:
    """判断 key 的类型（只输出类型，不输出 key 本身）。"""
    if key.startswith("sb_secret_"):
        return "新版机密 key（sb_secret_...）"
    if key.startswith("sb_publishable_"):
        return "新版可发布 key（sb_publishable_...）—— 没有上传权限"
    if key.startswith("eyJ") and key.count(".") == 2:
        return "旧版 JWT（eyJ...）"
    return f"无法识别的格式（前 8 个字符：{key[:8]}…，长度 {len(key)}）"


def validate_key_shape(key: str) -> tuple[bool, str]:
    """先看 key 的形状对不对，不急着发请求。

    为什么要单独做这一步：拿一个明显不是密钥的东西去请求，Storage 会返回
    一个含糊的 400，很容易被误读成"桶不存在"，于是人被引去重跑建表脚本 ——
    白折腾一趟。这里先在本机拦住，并直接说清该去哪儿复制。
    """
    if key.startswith("sb_secret_"):
        if len(key) < 20:
            return False, f"sb_secret_ 开头但太短（只有 {len(key)} 个字符），像是没复制全"
        return True, "新版机密 key"

    if key.startswith("eyJ") and key.count(".") == 2:
        if len(key) < 100:
            return False, f"看着像 JWT 但明显偏短（只有 {len(key)} 个字符），像是没复制全"
        return True, "旧版 service_role JWT"

    if key.startswith("sb_publishable_"):
        return False, "这是「可发布 key」，它只能读、没有上传权限"

    return False, (
        f"这不像一个 Supabase 密钥：长度 {len(key)}，"
        f"前 8 个字符是 {key[:8]}…"
    )


# 拿不到正确 key 时给的提示。写具体一点，省得来回猜。
KEY_HELP = """
  正确的密钥有两种，任选其一（都在 Supabase 后台同一个页面）：

  ① 新版「机密 key」（推荐）
     位置：Settings → API Keys → **Publishable and secret API keys** 标签
     找到名字是 default 的 Secret key，点 Reveal 再复制
     长相：sb_secret_ 开头，总长约 45 个字符

  ② 旧版 service_role JWT
     位置：Settings → API Keys → **Legacy API keys** 标签
     复制 service_role 那一行
     长相：eyJ 开头，中间有两个点，总长 200 个字符以上

  ⚠️ 下面这些都不是密钥，别复制：
     · Project ID / Reference（20 位左右，例如 xzafymhzqlkolblugzgp）
     · 数据库密码（Database password）
     · anon / publishable key（只能读，没有上传权限）

  复制后整行粘进 supabase_service_key.txt（不要加引号、不要只粘一半、不要带说明文字）。
"""


def auth_headers(key: str) -> dict[str, str]:
    """构造认证头。

    ★ 这里是踩过的坑（Supabase 官方文档明确写了）：
      新版密钥（sb_secret_ / sb_publishable_）**不是 JWT**，只能放在 `apikey` 头里。
      如果同时放进 `Authorization: Bearer`，平台会试图把它当 JWT 解析，
      直接返回 `Invalid JWT` / `Invalid Compact JWS`（就是这次的报错）。

      旧版 JWT（eyJ...）两种都行，所以这里只对 JWT 额外加 Authorization。
    """
    headers = {"apikey": key}
    if key.startswith("eyJ") and key.count(".") == 2:
        headers["Authorization"] = f"Bearer {key}"
    return headers


def check_bucket(url: str, key: str) -> tuple[bool, str, str]:
    """上传前先确认 key 有权限、桶也存在（避免传 30 个文件才发现问题）。

    返回 (是否就绪, 给人看的信息, 问题类别)。
    类别用来决定给什么建议 —— 之前把"key 无效"也报成"桶不存在"，
    结果把人引去重跑建表脚本，白折腾一趟。
    """
    request = urllib.request.Request(
        f"{url}/storage/v1/bucket/{BUCKET}",
        method="GET",
        headers={**auth_headers(key), "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            data = json.loads(response.read().decode("utf-8", "replace") or "{}")
            return True, f"桶已就绪（public={data.get('public')}）", ""
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")[:200]
        # 认证类问题：key 不对（不是密钥 / 抄错 / 已失效 / 权限不够）
        if error.code in (401, 403) or "JWS" in detail or "JWT" in detail or "Unauthorized" in detail:
            return False, f"key 被拒绝（HTTP {error.code}）：{detail}", "key"
        if error.code == 404:
            return False, "桶 site 不存在", "bucket"
        if error.code == 400:
            # 400 在 Storage 里既可能是"桶不存在"，也可能是"key 不合规"，
            # 所以先把 key 形状检查过再做这一步；到这里多半还是 key 的问题
            return False, f"请求被拒绝（HTTP 400）：{detail}", "key"
        return False, f"HTTP {error.code} {detail}", "other"
    except Exception as error:  # noqa: BLE001
        return False, f"{type(error).__name__}: {error}", "network"


def upload(url: str, key: str, remote_path: str, data: bytes, content_type: str) -> tuple[bool, str]:
    request = urllib.request.Request(
        f"{url}/storage/v1/object/{BUCKET}/{remote_path}",
        data=data,
        method="POST",
        headers={
            **auth_headers(key),
            "Content-Type": content_type,
            # 覆盖同名文件，便于反复发布
            "x-upsert": "true",
            "Cache-Control": "max-age=60",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return 200 <= response.status < 300, f"HTTP {response.status}"
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")[:200]
        return False, f"HTTP {error.code} {detail}"
    except Exception as error:  # noqa: BLE001
        return False, f"{type(error).__name__}: {error}"


def probe(url: str, remote_path: str) -> tuple[int, str, int]:
    """取回公开 URL，返回 (状态码, Content-Type, 字节数)。"""
    public = f"{url}/storage/v1/object/public/{BUCKET}/{remote_path}"
    try:
        with urllib.request.urlopen(public, timeout=30) as response:
            body = response.read()
            return response.status, response.headers.get("Content-Type", ""), len(body)
    except urllib.error.HTTPError as error:
        return error.code, "", 0
    except Exception:  # noqa: BLE001
        return 0, "", 0


def collect_files() -> list[tuple[str, str]]:
    """收集 dist/ 下要上传的文件，返回 [(本地路径, 远端路径)]。

    `_headers` 是 Netlify 专用文件，镜像上不需要。
    """
    pairs: list[tuple[str, str]] = []
    for root, _dirs, names in os.walk(DIST_DIR):
        for name in sorted(names):
            if name == "_headers":
                continue
            local = os.path.join(root, name)
            remote = os.path.relpath(local, DIST_DIR).replace(os.sep, "/")
            pairs.append((local, remote))
    return pairs


def probe_function(url: str, path: str = "") -> tuple[int, str, int]:
    """取回 Edge Function 入口，返回 (状态码, Content-Type, 字节数)。"""
    entry = f"{url}{FUNCTION_PATH}{path}"
    try:
        with urllib.request.urlopen(entry, timeout=30) as response:
            body = response.read()
            return response.status, response.headers.get("Content-Type", ""), len(body)
    except urllib.error.HTTPError as error:
        return error.code, "", 0
    except Exception:  # noqa: BLE001
        return 0, "", 0


def main() -> int:
    parser = argparse.ArgumentParser(description="把网站镜像到 Supabase Storage")
    parser.add_argument("--dir", default=DIST_DIR, help="要上传的目录（默认 dist/）")
    parser.add_argument("--check", action="store_true", help="只检查镜像现状，不上传")
    args = parser.parse_args()

    url = read_project_url()
    if not url:
        print("[错误] web/js/config.js 里没有填接口地址，无法确定 Supabase 项目。")
        return 1

    print("=" * 62)
    print("  发布备用镜像到 Supabase Storage")
    print("=" * 62)
    print(f"  项目地址：{url}")
    print(f"  存储桶　：{BUCKET}（公开只读）")

    storage_url = f"{url}/storage/v1/object/public/{BUCKET}/index.html"
    entry_url = f"{url}{FUNCTION_PATH}"

    if args.check:
        print()
        print("  正在检查备用入口（Edge Function）……")
        status, ctype, size = probe_function(url)
        print(f"    入口 → HTTP {status}  {ctype}  {size} 字节")
        print()
        if status == 200 and "text/html" in ctype:
            print(f"  ✅ 备用入口可用：{entry_url}")
            return 0
        if status == 404:
            print("  ❌ 还没部署 Edge Function（或名字不是 mirror）。")
            print("     步骤见 安全设置.md「办法 ①」；函数代码在 supabase/functions/mirror/index.ts")
        elif "text/plain" in ctype:
            print("  ⚠️ 返回的是 text/plain —— 说明函数没有把 Content-Type 改对。")
        else:
            print(f"  ⚠️ 异常状态。Storage 直链（永远不能当网页用）：{storage_url}")
        return 1

    if not os.path.isdir(args.dir):
        print(f"[错误] 找不到目录 {args.dir}，请先双击「打包上传.bat」生成。")
        return 1

    key = read_service_key()
    if not key:
        print()
        print(f"  缺少密钥。请二选一：")
        print(f"    ① 新建文件 {os.path.basename(KEY_FILE)}，把密钥粘进去（已在 .gitignore 里）")
        print("    ② 或设置环境变量 SUPABASE_SERVICE_KEY")
        print(KEY_HELP)
        print("  ⚠️ 这个 key 只存本机，绝不要放进 web/ 目录或发给任何人。")
        return 1

    print(f"  key 类型：{describe_key(key)}")

    # ★ 先在本机检查 key 的形状。
    #   不先检查的话，一个明显不是密钥的值会让 Storage 返回含糊的 400，
    #   很容易被误读成"桶不存在"，人被引去重跑建表脚本白折腾一趟。
    shape_ok, shape_detail = validate_key_shape(key)
    if not shape_ok:
        print()
        print(f"  [错误] {shape_detail}")
        print(KEY_HELP)
        return 1

    # 再做一次真实请求：确认 key 有效、桶存在、权限够
    ready, detail, category = check_bucket(url, key)
    if not ready:
        print()
        print(f"  [错误] 无法访问存储桶：{detail}")
        print()
        if category == "bucket":
            print("  解决：Supabase → SQL Editor → 跑 supabase/mirror.sql 建公开桶。")
            print("        （跑完应该看到 1 行结果：id=site, name=site, public=true）")
        elif category == "key":
            print("  这是密钥问题。请重新复制一次：")
            print(KEY_HELP)
        elif category == "network":
            print("  网络不通。请检查能否访问 Supabase（本工具的其它命令是怎么表现的？）")
        return 1
    print(f"  桶状态　：{detail}")

    pairs = collect_files()
    if not pairs:
        print(f"[错误] {args.dir} 里没有文件。")
        return 1

    print(f"  待上传　：{len(pairs)} 个文件")
    print()

    ok = 0
    failed: list[str] = []
    for local, remote in pairs:
        with open(local, "rb") as handle:
            data = handle.read()
        content_type = StaticSite.content_type(local).split(";")[0]
        success, detail = upload(url, key, remote, data, content_type)
        if success:
            ok += 1
            print(f"    [OK]   {remote}")
        else:
            failed.append(f"{remote}（{detail}）")
            print(f"    [失败] {remote}  {detail}")

    print()
    print("=" * 62)
    print(f"  上传完成：成功 {ok} / {len(pairs)}")

    if failed:
        print("  失败清单：")
        for item in failed:
            print(f"    · {item}")
        print()
        print("  如果报 404 bucket not found → 先跑 supabase/mirror.sql 建桶")
        print("  如果报 401/403 → 用的 key 不是机密 key（见上面的取 key 说明）")
        return 1

    # 自检：走 Edge Function 的入口，才是能当网页用的地址
    print()
    print("  正在自检备用入口（Edge Function）……")
    status, ctype, size = probe_function(url)
    print(f"    入口 /            → HTTP {status}  Content-Type: {ctype}  {size} 字节")
    js_status, js_type, _ = probe_function(url, "js/app.js")
    print(f"    入口 /js/app.js   → HTTP {js_status}  Content-Type: {js_type}")

    good = status == 200 and "text/html" in ctype and js_status == 200 and "javascript" in js_type

    # 顺带说明 Storage 直链的情况：它**永远**不能当网页用，这是 Supabase 故意的，
    # 列出来是为了以后不再有人（包括我）误以为"上传成功 = 能用"。
    s_status, s_type, _ = probe(url, "index.html")
    print()
    print(f"  （参考）Storage 直链 → HTTP {s_status}  {s_type}")
    if "text/plain" in s_type:
        print("            ↑ 这是 Supabase 有意为之：Storage 里的 .html 一律降级为")
        print("              text/plain 并加 CSP sandbox，防止被拿去托管钓鱼网站。")
        print("              所以**必须**通过上面的 Edge Function 入口访问，直链不行。")

    print()
    if good:
        print("  ✅ 备用入口可用：")
        print()
        print(f"     {entry_url}")
        print()
        print("  把它发给同学：「如果主站打不开，用这个链接试试。」")
    elif status == 404:
        print("  文件已上传，但备用入口还打不开：Edge Function 还没部署。")
        print()
        print("  下一步（全程在浏览器里，不用装工具）：")
        print("    Supabase → Edge Functions → Deploy a new function → Via Editor")
        print("    函数名填 mirror → 粘贴 supabase/functions/mirror/index.ts 的内容")
        print("    → Deploy function → 然后重新运行本脚本自检")
    else:
        print("  ⚠️ 备用入口返回了异常结果，请把这段输出发给我。")
    print("=" * 62)
    return 0 if good else 1


if __name__ == "__main__":
    raise SystemExit(main())
