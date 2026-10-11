"""上传前打包 `web/` 到 `dist/`，并做一次"别把机密 key 发出去"的检查。

为什么需要它：
  1. 把要上传的文件整理到一个干净的目录，省得拖错文件夹
     （拖错是新手最常见的翻车方式：同学会看到 /web/index.html 这种路径）。
  2. 上传前扫描一遍，防止有人不小心把 secret / service_role key 打包进去。
     网页前端只需要"可发布 key"，机密 key 一旦公开就等于把管理员权限送人。

用法：
    python tools/package-web.py
然后把生成的 dist/ 目录【里面的内容】上传（拖进去）即可。
"""

from __future__ import annotations

import base64
import json
import os
import re
import shutil
import sys
import zipfile

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB_DIR = os.path.join(BASE_DIR, "web")
DIST_DIR = os.path.join(BASE_DIR, "dist")
ZIP_PATH = os.path.join(BASE_DIR, "class-bulletin.zip")

TEXT_SUFFIXES = {".js", ".mjs", ".html", ".css", ".json", ".svg", ".md", ".txt", ".webmanifest"}

# 只匹配"看起来真的是一个 key"的字符串。
# 注意：注释里写到 sb_secret_... 或 service_role 这些名字是不算问题的，
# 否则每次改注释都会被自己拦住（这正是第一版的毛病）。
SECRET_KEY_RE = re.compile(r"sb_secret_[A-Za-z0-9_\-]{6,}")
JWT_RE = re.compile(r"eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+")

if not sys.stdout.isatty():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    except (AttributeError, OSError):
        pass


def jwt_role(token: str) -> str:
    """解出 JWT payload 里的 role；解不出来返回空字符串。"""
    try:
        segment = token.split(".")[1]
        padded = segment.replace("-", "+").replace("_", "/")
        padded += "=" * ((4 - len(padded) % 4) % 4)
        payload = json.loads(base64.b64decode(padded).decode("utf-8", "replace"))
    except (IndexError, ValueError, TypeError):
        return ""
    role = payload.get("role") if isinstance(payload, dict) else None
    return role if isinstance(role, str) else ""


def scan_text(text: str, filename: str) -> tuple[list[str], list[str]]:
    """扫描一段文本，返回 (危险项, 提醒项)。

    判定依据是"真的当 key 用"，而不是"提到了某个词"：
      - 出现 sb_secret_xxxxxx 这种真实机密 key → 危险
      - 出现 role 为 service_role 的完整 JWT     → 危险
    """
    problems: list[str] = []
    warnings: list[str] = []

    for match in SECRET_KEY_RE.finditer(text):
        problems.append(
            f"{filename} 里出现了新版机密 key：{match.group(0)[:16]}…（能绕过全部权限）"
        )

    for match in JWT_RE.finditer(text):
        role = jwt_role(match.group(0))
        if role == "service_role":
            problems.append(f"{filename} 里出现了 role=service_role 的 JWT（能绕过全部权限）")
        elif role and role != "anon":
            warnings.append(f"{filename} 里有一个 role={role} 的 JWT，请确认它该不该出现在网页里")

    # 同一个 key 在文件里出现多次时只报一条
    return sorted(set(problems)), sorted(set(warnings))


def object_block(config_text: str, key: str) -> str:
    """截出 `key: { ... }` 这一段（按花括号配平，能处理嵌套）。

    ★ 为什么需要：config 里不止一个 `url:` 字段
      （`site.url` 是站点地址、`supabase.url` 是接口地址）。
      不限定范围的话，正则会把**先出现的那个**当成接口地址 ——
      这个 bug 真的发生过：`[配置] 接口地址` 打出来是站点地址，
      而且**没有任何报错**。宁可比对麻烦一点，也不要静默取错。
    """
    match = re.search(r"^\s*" + re.escape(key) + r":\s*\{", config_text, re.MULTILINE)
    if not match:
        return ""
    start = match.end() - 1
    depth = 0
    for index in range(start, len(config_text)):
        char = config_text[index]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return config_text[start : index + 1]
    return config_text[start:]


def read_config_values(config_text: str) -> tuple[str, str]:
    """从 config.js 里取出**接口**的 url 与 anonKey（只在 supabase 块里找）。

    取值正则允许 `url:` 出现在行首，也允许写成单行对象
    （`supabase: { url: '...' }`）—— 用户可能重新排版，不该因此解析失败。
    """
    block = object_block(config_text, "supabase")
    url_match = re.search(r"(?:^|[\s{,])url:\s*'([^']*)'", block, re.MULTILINE)
    key_match = re.search(r"(?:^|[\s{,])anonKey:\s*'([^']*)'", block, re.MULTILINE)
    return (
        url_match.group(1).strip() if url_match else "",
        key_match.group(1).strip() if key_match else "",
    )


def read_site_url(config_text: str) -> str:
    """取出**站点**的公开地址（site.url），用于分享卡片与 canonical。"""
    block = object_block(config_text, "site")
    url_match = re.search(r"(?:^|[\s{,])url:\s*'([^']+)'", block, re.MULTILINE)
    return url_match.group(1).strip() if url_match else ""


def inject_preconnect(html_path: str, api_url: str) -> bool:
    """在 HTML 的 <head> 里插入 preconnect，提前和接口服务器握手。

    理由：同学第一次打开页面时，DNS + TLS 握手要占掉好几个往返。
    提前声明一下，浏览器就能在解析页面时并行去握手，省下这段等待。

    注意：只改打包产物（dist/），不改 web/ 源码 ——
    源码里依然只在 config.js 一处配置地址。
    """
    if not os.path.isfile(html_path):
        return False

    with open(html_path, "r", encoding="utf-8") as handle:
        html = handle.read()

    marker = '  <link rel="stylesheet" href="css/tokens.css" />'
    if 'rel="preconnect"' in html or marker not in html:
        return False

    hint = (
        "  <!-- 提前和接口服务器握手，减少首次打开的等待（打包时自动插入） -->\n"
        f'  <link rel="preconnect" href="{api_url}" crossorigin />\n'
        f'  <link rel="dns-prefetch" href="{api_url}" />\n'
    )
    with open(html_path, "w", encoding="utf-8") as handle:
        handle.write(html.replace(marker, hint + marker, 1))
    return True


def inject_share_url(html_path: str, site_url: str, path: str) -> bool:
    """把 og:url 与 canonical 的绝对地址注入到 HTML 里。

    为什么必须打包时注入、而且必须写进源码（不能用 JS 填）：
        微信 / QQ 的爬虫**不执行 JavaScript**。分享到群里时，
        它们只读 HTML 源码里的这些标签。用 JS 填的话，
        分享出去就只有光秃秃一个网址。

    为什么不在 web/ 源码里写死：
        那样换域名就要改多个文件。本项目规矩是"地址只在 config.js 一处"。
    """
    if not os.path.isfile(html_path):
        return False

    with open(html_path, "r", encoding="utf-8") as handle:
        html = handle.read()

    if 'property="og:url"' in html:
        return False

    absolute = site_url.rstrip("/") + "/" + path.lstrip("/")
    # 用正则找 og:locale，并且**沿用它的缩进** ——
    # 不写死"两个空格"，否则谁把 HTML 重新排版一下，注入就静默失效。
    meta = re.search(r'^([ \t]*)<meta property="og:locale"[^>]*>', html, re.MULTILINE)
    if not meta:
        return False
    indent = meta.group(1)

    html = html.replace(
        meta.group(0),
        meta.group(0)
        + "\n"
        + f'{indent}<meta property="og:url" content="{absolute}" />'
        # 缩略图：微信/QQ 生成卡片时很看重图片，而它们对 SVG 支持不好，
        # 所以用 web/assets/share.png（由 tools/make-share-image.py 生成）
        + "\n"
        + f'{indent}<meta property="og:image" content="{site_url.rstrip("/")}/assets/share.png" />'
        + "\n"
        + f'{indent}<meta property="og:image:width" content="512" />'
        + "\n"
        + f'{indent}<meta property="og:image:height" content="512" />'
        + "\n"
        + f'{indent}<meta property="og:image:alt" content="班级公告栏" />',
        1,
    )

    # 同时把 canonical 换成绝对地址（没写 canonical 的页面就补一条）
    if 'rel="canonical"' in html:
        html = re.sub(
            r'<link rel="canonical" href="[^"]*" />',
            f'<link rel="canonical" href="{absolute}" />',
            html,
            count=1,
        )
    else:
        html = html.replace(
            '  <meta name="theme-color"',
            f'  <link rel="canonical" href="{absolute}" />\n  <meta name="theme-color"',
            1,
        )

    with open(html_path, "w", encoding="utf-8") as handle:
        handle.write(html)
    return True


def main() -> int:
    if not os.path.isdir(WEB_DIR):
        print(f"[错误] 找不到网页目录：{WEB_DIR}")
        return 1

    problems: list[str] = []
    warnings: list[str] = []
    file_count = 0
    total_bytes = 0

    # ---- 1. 先扫描，再打包：发现问题就不产出 dist，免得手快传上去 ----
    for root, _dirs, files in os.walk(WEB_DIR):
        for name in files:
            path = os.path.join(root, name)
            relative = os.path.relpath(path, WEB_DIR).replace("\\", "/")
            file_count += 1
            total_bytes += os.path.getsize(path)

            if os.path.splitext(name)[1].lower() not in TEXT_SUFFIXES:
                continue
            try:
                with open(path, "r", encoding="utf-8", errors="replace") as handle:
                    content = handle.read()
            except OSError as exc:
                warnings.append(f"{relative} 读不了：{exc}")
                continue

            found_problems, found_warnings = scan_text(content, relative)
            problems.extend(found_problems)
            warnings.extend(found_warnings)

    # ---- 2. 检查 config.js 的公开 key 是否填对 ----
    config_path = os.path.join(WEB_DIR, "js", "config.js")
    api_url = ""
    api_path = ""
    if os.path.isfile(config_path):
        with open(config_path, "r", encoding="utf-8", errors="replace") as handle:
            config_text = handle.read()
        url, key = read_config_values(config_text)
        api_url = url

        # 启用了同源 /api 代理时，浏览器**不会**再直接访问 Supabase，
        # 所以必须跳过下面的 preconnect 注入 —— 否则等于让浏览器白白去连
        # 一个在中国移动上会被 ERR_CONNECTION_RESET 的主机名。
        match = re.search(r"apiPath\s*:\s*['\"]([^'\"]*)['\"]", config_text)
        api_path = match.group(1).strip() if match else ""
        if api_path:
            print(f"[配置] 接口走同源代理：{api_path}/*（浏览器不再直连 Supabase）")

        # 站点公开地址：用于分享卡片的 og:url 与 canonical
        site_url = read_site_url(config_text)
        if site_url:
            print(f"[配置] 站点地址：{site_url}")
        else:
            warnings.append(
                "config.js 里的 site.url 是空的 —— 分享到微信/QQ 时卡片里的链接会不完整"
            )

        if url:
            print(f"[配置] 接口地址：{url}")
        else:
            warnings.append(
                "config.js 里的 supabase.url 是空的 —— 部署到公网后同学会看到「还没有连接到服务器」"
            )

        if not key:
            warnings.append("config.js 里的 anonKey 是空的 —— 连真 Supabase 会读不到数据")
        elif key.startswith("sb_publishable_"):
            print("[配置] key 类型：新版可发布 key ✅（就该填这个）")
        elif key.startswith("sb_secret_"):
            problems.append("config.js 的 anonKey 是机密 key（sb_secret_...）")
        elif key.startswith("eyJ"):
            role = jwt_role(key)
            if role == "service_role":
                problems.append("config.js 的 anonKey 是 service_role key")
            else:
                print(f"[配置] key 类型：旧版 JWT，role={role or '未知'} ✅")
        else:
            warnings.append(f"config.js 的 key 格式认不出来：{key[:12]}…")

    print(f"\n共 {file_count} 个文件，合计 {total_bytes / 1024:.1f} KB\n")

    for message in sorted(set(warnings)):
        print(f"[提醒] {message}")
    if warnings:
        print()

    if problems:
        for message in sorted(set(problems)):
            print(f"[危险] {message}")
        print("\n为避免把这串 key 传到公网，本次没有生成 dist/ 目录。")
        print("请先改好 web/js/config.js，再重新运行本命令。")
        print("（如果它已经上传过，请立刻到 Supabase → Settings → API Keys 删除并轮换。）")
        return 1

    # ---- 3. 打包成目录 ----
    if os.path.isdir(DIST_DIR):
        shutil.rmtree(DIST_DIR)
    shutil.copytree(WEB_DIR, DIST_DIR)

    # ---- 4. 给接口服务器加"提前握手"提示 ----
    # 为什么要在这一步做：这样 web/ 源码里就不用写死任何地址，
    # 仍然只在 config.js 一处配置；打包时再按实际地址注入。
    #
    # 注意：启用了同源 /api 代理时**必须跳过** —— 那时浏览器访问的是
    # 站点自己的域名，根本不会连 Supabase，注入 preconnect 反而会让浏览器
    # 去试连一个（在中国移动上）会被重置的主机名。
    if api_url.startswith("https://") and not api_path:
        optimized = [
            name
            for name in ("index.html", "admin.html")
            if inject_preconnect(os.path.join(DIST_DIR, name), api_url)
        ]
        if optimized:
            print(f"[优化] 已在 {'、'.join(optimized)} 里插入 preconnect（提前连接接口服务器）")
    elif api_path:
        print("[优化] 已跳过 preconnect（走同源代理，不需要提前连 Supabase）")

    # ---- 4b. 注入分享卡片的绝对地址（og:url / canonical）----
    # 微信、QQ 的爬虫不执行 JS，所以这些标签必须在 HTML 源码里；
    # 但地址不写死在 web/ 源码里 —— 打包时按 config.js 的 site.url 注入。
    if site_url:
        injected = [
            name
            for name, path in (("index.html", ""), ("message.html", "message.html"))
            if inject_share_url(os.path.join(DIST_DIR, name), site_url, path)
        ]
        if injected:
            print(f"[优化] 已在 {'、'.join(injected)} 里注入 og:url / canonical（分享卡片用）")

    # ---- 5. 再打一个 zip：上传框可以直接丢 zip，比拖文件夹更不容易出错 ----
    if os.path.isfile(ZIP_PATH):
        os.remove(ZIP_PATH)
    with zipfile.ZipFile(ZIP_PATH, "w", zipfile.ZIP_DEFLATED) as archive:
        for root, _dirs, files in os.walk(DIST_DIR):
            for name in files:
                full = os.path.join(root, name)
                # 关键：压缩包内部不能带 dist/ 这一层，
                # index.html 必须躺在压缩包最外层，否则部署出来会变成 /dist/index.html
                relative = os.path.relpath(full, DIST_DIR).replace("\\", "/")
                archive.write(full, relative)

    zip_kb = os.path.getsize(ZIP_PATH) / 1024
    print(f"[完成] 已生成目录：{DIST_DIR}")
    print(f"[完成] 已生成压缩包：{ZIP_PATH}（{zip_kb:.1f} KB）")
    print("\n接下来：")
    print("  1. 国内请用 Netlify：打开 https://app.netlify.com/drop")
    print("     把 class-bulletin.zip 拖进去（注册认领站点时用邮箱，别用 GitHub 登录）")
    print("  2. 部署完会给你一个 https://xxx.netlify.app 网址")
    print("  3. 先用电脑打开确认首页有公告")
    print("  4. 再用手机打开确认排版正常，然后把网址发到班级群")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
