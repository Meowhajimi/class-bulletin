"""页脚「源码」链接的测试。

为什么需要：
    这个链接是**指向外部站点**的，外部链接最容易犯两个错：
      1. 忘了 rel="noopener" —— 被打开的页面能通过 window.opener 反过来操纵本站
      2. 把地址写死在 HTML 里 —— 以后换仓库要改多个文件（本项目规矩是只改 config.js）

    所以这里既断言"链接存在且安全"，也断言"地址来自 config.js 且留空时能隐藏"。

运行：python tools/tests/footer_link_test.py
"""

from __future__ import annotations

import os
import re
import sys

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

    print("\n" + "=" * 52)
    print(f"通过 {passed} 项，失败 {failed} 项")
    print("=" * 52)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
