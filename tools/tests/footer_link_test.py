"""页脚源码链接 + 页面元信息（分享卡片）的测试。

为什么需要：
    1. 页脚那个链接是**指向外部站点**的，最容易犯两个错：
       · 忘了 rel="noopener" —— 被打开的页面能通过 window.opener 反向操纵本站
       · 把地址写死在 HTML 里 —— 以后换仓库要改多个文件（本项目规矩是只改 config.js）
    2. 分享卡片（og: 标签）必须写在 HTML 源码里 —— 微信/QQ 的爬虫**不执行 JS**。
       用 JS 填的话，分享到群里就只有光秃秃一个网址。
    3. ★ 真发生过的一个静默 bug：config 里有两个 `url:` 字段
       （`site.url` 和 `supabase.url`），打包脚本的正则取到了**先出现的那个**，
       于是"[配置] 接口地址"打出来是站点地址 —— **没有任何报错**。
       这里专门盯住它。

运行：python tools/tests/footer_link_test.py
"""

from __future__ import annotations

import importlib.util
import os
import re
import sys
import tempfile

BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, OSError):
    pass

passed = 0
failed = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"  [通过] {name}")
    else:
        failed += 1
        print(f"  [失败] {name}" + (f" —— {detail}" if detail else ""))


def read(relative: str) -> str:
    path = os.path.join(BASE_DIR, relative)
    if not os.path.isfile(path):
        return ""
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read()


REPO_URL = "https://github.com/Meowhajimi/class-bulletin"


def main() -> int:
    config = read(os.path.join("web", "js", "config.js"))
    index = read(os.path.join("web", "index.html"))
    message = read(os.path.join("web", "message.html"))
    app_js = read(os.path.join("web", "js", "app.js"))
    message_js = read(os.path.join("web", "js", "message.js"))

    print("\n一、config.js 是唯一配置点")
    check("config.js 里配了 site.repoUrl", "repoUrl" in config)
    check(f"repoUrl 指向正确的仓库", REPO_URL in config, "地址不对")
    check(
        "repoUrl 的注释说明了「留空则不显示」",
        "留空" in config.split("repoUrl")[0][-400:],
        "最好在注释里写清留空的行为",
    )

    print("\n二、首页与详情页都有这个链接")
    for label, html in (("index.html", index), ("message.html", message)):
        check(f"{label} 里有 id=repo-link 的链接", 'id="repo-link"' in html)
        check(f"{label} 里带了 href（静态兜底，JS 挂了也能点）", REPO_URL in html)

    print("\n三、外链安全（这两个属性缺一不可）")
    # 取出 <a ... id="repo-link" ...> 这一段标签
    for label, html in (("index.html", index), ("message.html", message)):
        match = re.search(r"<a[^>]*id=\"repo-link\"[^>]*>", html, re.DOTALL)
        check(f"{label} 能找到 repo-link 标签", bool(match))
        if not match:
            continue
        tag = match.group(0)
        check(f"{label} 的链接带 target=\"_blank\"", 'target="_blank"' in tag)
        check(
            f"{label} 的链接带 rel=\"noopener noreferrer\"（防止被反向操纵）",
            "noopener" in tag and "noreferrer" in tag,
            tag.replace("\n", " ")[:120],
        )
        check(
            f"{label} 默认隐藏（hidden），由 JS 按 config 决定是否显示",
            "hidden" in tag,
            tag.replace("\n", " ")[:120],
        )

    print("\n四、两个页面都用 config 里的地址去填，而不是各写一份")
    check("app.js 引用了 #repo-link", "repo-link" in app_js)
    check("app.js 从 CONFIG.site.repoUrl 取值", "CONFIG.site.repoUrl" in app_js)
    check("message.js 引用了 #repo-link", "repo-link" in message_js)
    check("message.js 从 CONFIG.site.repoUrl 取值", "CONFIG.site.repoUrl" in message_js)

    print("\n五、留空时应能隐藏（不留一个点不动的死链）")
    check(
        "app.js 在地址为空时会隐藏链接",
        re.search(r"repoUrl[\s\S]{0,200}hidden = true", app_js) is not None,
        "没找到隐藏逻辑",
    )
    check(
        "message.js 在地址为空时会隐藏链接",
        re.search(r"repoUrl[\s\S]{0,200}hidden = true", message_js) is not None,
        "没找到隐藏逻辑",
    )

    print("\n六、分享卡片（og: 标签必须在 HTML 源码里 —— 爬虫不执行 JS）")
    for label, html in (("index.html", index), ("message.html", message)):
        for prop in ("og:type", "og:site_name", "og:title", "og:description", "og:locale"):
            check(
                f"{label} 有 {prop}",
                f'property="{prop}"' in html,
                "爬虫读不到这个标签，分享卡片会不完整",
            )
        check(
            f"{label} 有 meta description（部分平台用它当摘要）",
            'name="description"' in html,
        )

    print("\n七、★ 打包脚本必须取对 config 里的地址（这里踩过一个静默 bug）")
    spec = importlib.util.spec_from_file_location(
        "package_web", os.path.join(BASE_DIR, "tools", "package-web.py")
    )
    package_web = importlib.util.module_from_spec(spec)
    sys.modules["package_web"] = package_web
    spec.loader.exec_module(package_web)

    api_url, anon_key = package_web.read_config_values(config)
    site_url = package_web.read_site_url(config)

    check(
        "读到的接口地址是 supabase.co（不是站点地址）",
        "supabase.co" in api_url,
        f"实际读到：{api_url}",
    )
    check(
        "★ 不会因为 site.url 排在前面就取错（这就是那个静默 bug）",
        "pages.dev" not in api_url,
        f"接口地址被取成了站点地址：{api_url}",
    )
    check("读到的站点地址是 pages.dev", "pages.dev" in site_url, site_url)
    check("两种地址确实不同", api_url != site_url, "读成了同一个地址")
    check("anonKey 读到了", bool(anon_key) and anon_key.startswith("sb_publishable_"))

    print("\n八、注入分享链接的函数本身要能用")
    with tempfile.TemporaryDirectory() as temp_dir:
        target = os.path.join(temp_dir, "index.html")
        with open(target, "w", encoding="utf-8") as handle:
            handle.write(
                '<html><head>\n'
                '  <meta property="og:locale" content="zh_CN" />\n'
                '  <meta name="theme-color" content="#2563eb" />\n'
                "</head></html>"
            )
        changed = package_web.inject_share_url(target, "https://example.com/", "")
        with open(target, "r", encoding="utf-8") as handle:
            out = handle.read()
        check("注入函数返回 True", changed is True)
        check("注入后有 og:url", 'property="og:url" content="https://example.com/"' in out)
        check("顺手补上了 canonical", 'rel="canonical" href="https://example.com/"' in out)
        check("重复调用不会注入两次", package_web.inject_share_url(target, "https://example.com/", "") is False)

    print("\n九、分享缩略图（微信/QQ 看重图片，且不支持 SVG）")
    png_path = os.path.join(BASE_DIR, "web", "assets", "share.png")
    check("web/assets/share.png 存在", os.path.isfile(png_path), "缩略图没生成")
    if os.path.isfile(png_path):
        with open(png_path, "rb") as handle:
            raw = handle.read()
        check("是真正的 PNG（签名正确）", raw[:8] == b"\x89PNG\r\n\x1a\n")
        check("不是空文件", len(raw) > 500, f"{len(raw)} 字节")
        # IHDR 里的宽高：偏移 16 起，各 4 字节大端
        width = int.from_bytes(raw[16:20], "big")
        height = int.from_bytes(raw[20:24], "big")
        check("尺寸够微信当缩略图（≥300×300）", width >= 300 and height >= 300, f"{width}×{height}")
        check("是方图（卡片缩略图更稳）", width == height, f"{width}×{height}")
    check(
        "生成脚本还在（以后想换图能重新生成）",
        os.path.isfile(os.path.join(BASE_DIR, "tools", "make-share-image.py")),
    )

    print("\n十、注入的标签里要带上 og:image")
    with tempfile.TemporaryDirectory() as temp_dir:
        target = os.path.join(temp_dir, "index.html")
        with open(target, "w", encoding="utf-8") as handle:
            handle.write('<meta property="og:locale" content="zh_CN" />')
        package_web.inject_share_url(target, "https://example.com/", "")
        with open(target, "r", encoding="utf-8") as handle:
            out = handle.read()
        check("注入后有 og:image（绝对地址）",
              'property="og:image" content="https://example.com/assets/share.png"' in out)
        check("带 og:image:width/height", "og:image:width" in out and "og:image:height" in out)

    print("\n" + "=" * 52)
    print(f"通过 {passed} 项，失败 {failed} 项")
    print("=" * 52)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
