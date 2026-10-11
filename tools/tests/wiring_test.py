"""接线检查：import 路径、命名导入、以及 qs('#id') 对应的元素是否真的存在。

为什么需要这个测试（真实事故）：
    app.js 里用 `qs('#section-tabs')` 取顶部标签行的容器，
    而 `qs()` 在找不到元素时是**直接抛异常**的：
        throw new Error('页面上找不到元素：#section-tabs')
    也就是说，如果我只改了 JS、忘了在 index.html 里加那个 <nav>，
    整个首页会在启动瞬间白屏 —— 而且**所有现有测试都是绿的**
    （单元测试只测纯函数，渲染测试只测组件，没人检查 HTML 和 JS 的对应关系）。

    栏目标签行恰好就是这种情况：新加的 JS 查询了一个新加的 DOM 元素。
    所以这里把"JS 要什么元素 / HTML 有没有"变成一条自动检查。

检查三件事：
    1. 相对 import 的文件真的存在（防止改名/移动后忘了改 import）
    2. 从本项目模块里 import 的名字，在目标文件里真的有 export
    3. 每个 `qs('#xxx')` 的 id，在对应的 HTML 文件里真的存在

运行：python tools/tests/wiring_test.py
"""

from __future__ import annotations

import os
import re
import sys

BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
WEB_DIR = os.path.join(BASE_DIR, "web")

if not sys.stdout.isatty():
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


def read(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            return handle.read()
    except OSError:
        return ""


def js_files() -> list[str]:
    found: list[str] = []
    for root, _dirs, files in os.walk(os.path.join(WEB_DIR, "js")):
        for name in files:
            if name.endswith(".js"):
                found.append(os.path.join(root, name))
    return sorted(found)


# 只匹配 `import ... from './xxx.js'` / `"../xxx.js"`
IMPORT_RE = re.compile(
    r"""import\s+(?P<names>[^;]*?)\s+from\s+['"](?P<path>\.{1,2}/[^'"]+)['"]""",
    re.DOTALL,
)
QS_RE = re.compile(r"""qs\(\s*['"]#([\w-]+)['"]""")


def exported_names(source: str) -> set[str]:
    """粗略收集一个模块导出的名字（够用即可，不追求完整 ES 语法）。"""
    names: set[str] = set()

    for match in re.finditer(r"export\s+(?:async\s+)?function\s+([\w$]+)", source):
        names.add(match.group(1))
    for match in re.finditer(r"export\s+(?:const|let|var|class)\s+([\w$]+)", source):
        names.add(match.group(1))
    # export { a, b as c }
    for match in re.finditer(r"export\s*\{([^}]*)\}", source):
        for piece in match.group(1).split(","):
            piece = piece.strip()
            if not piece:
                continue
            alias = re.split(r"\s+as\s+", piece)
            names.add(alias[-1].strip())
    return names


def imported_names(clause: str) -> list[str]:
    """从 import 的"名字部分"里取出被导入的标识符。"""
    clause = clause.strip()
    if not clause or clause.startswith("*"):
        return []
    brace = re.search(r"\{([^}]*)\}", clause, re.DOTALL)
    if not brace:
        # 默认导入：import foo from '...'
        return [clause.split(",")[0].strip()] if clause else []
    names = []
    for piece in brace.group(1).split(","):
        piece = piece.strip()
        if not piece:
            continue
        names.append(re.split(r"\s+as\s+", piece)[0].strip())
    return names


def qs_problems(script_source: str, html_source: str) -> list[str]:
    """脚本里 qs('#id') 要的元素，HTML 里有没有。抽出来是为了能自检。"""
    present = set(re.findall(r"""id=["']([\w-]+)["']""", html_source))
    problems = []
    for found in QS_RE.finditer(script_source):
        if found.group(1) not in present:
            problems.append(found.group(1))
    return problems


def main() -> int:
    files = js_files()
    check("找得到 web/js 下的脚本", bool(files), "目录结构变了？")

    print("\n一、相对 import 的目标文件必须存在")
    missing: list[str] = []
    for path in files:
        source = read(path)
        for match in IMPORT_RE.finditer(source):
            target = match.group("path")
            resolved = os.path.normpath(os.path.join(os.path.dirname(path), target))
            if not os.path.isfile(resolved):
                missing.append(f"{os.path.relpath(path, BASE_DIR)} → {target}")
    check("所有相对 import 都能找到文件", not missing, "；".join(missing))

    print("\n二、import 的名字必须在目标文件里有 export")
    unresolved: list[str] = []
    for path in files:
        source = read(path)
        for match in IMPORT_RE.finditer(source):
            target = match.group("path")
            resolved = os.path.normpath(os.path.join(os.path.dirname(path), target))
            if not os.path.isfile(resolved):
                continue
            exports = exported_names(read(resolved))
            for name in imported_names(match.group("names")):
                if name and name not in exports:
                    unresolved.append(
                        f"{os.path.relpath(path, BASE_DIR)} 导入了 {name}，"
                        f"但 {target} 里没有 export"
                    )
    check("所有命名导入都有对应的 export", not unresolved, "；".join(unresolved))

    print("\n三、qs('#id') 查询的元素必须在 HTML 里存在")
    # 页面脚本 → 它所在的 HTML（app.js 在 index.html 里跑，admin.js 在 admin.html 里跑……）
    page_pairs = [
        ("js/app.js", "index.html"),
        ("js/message.js", "message.html"),
        ("js/admin.js", "admin.html"),
    ]
    problems: list[str] = []
    checked_ids = 0
    for script, page in page_pairs:
        script_path = os.path.join(WEB_DIR, *script.split("/"))
        page_path = os.path.join(WEB_DIR, page)
        if not os.path.isfile(script_path) or not os.path.isfile(page_path):
            problems.append(f"找不到 {script} 或 {page}")
            continue
        script_source = read(script_path)
        checked_ids += len(QS_RE.findall(script_source))
        for element_id in qs_problems(script_source, read(page_path)):
            problems.append(f"{script} 查询 #{element_id}，但 {page} 里没有这个元素")
    check(
        f"全部 {checked_ids} 个 qs('#id') 都能在对应页面里找到",
        not problems,
        "；".join(problems),
    )

    print("\n四、栏目功能的关键元素与模块都在")
    index_html = read(os.path.join(WEB_DIR, "index.html"))
    check("index.html 有栏目标签容器 #section-tabs", 'id="section-tabs"' in index_html)
    check(
        "标签容器留了 role=tablist（读屏软件才认得出这是标签行）",
        'role="tablist"' in index_html,
    )
    check(
        "section-tabs.js 存在",
        os.path.isfile(os.path.join(WEB_DIR, "js", "ui", "section-tabs.js")),
    )
    admin_html = read(os.path.join(WEB_DIR, "admin.html"))
    check("admin.html 存在（管理页）", bool(admin_html))
    check(
        "管理页脚本会挂载栏目管理面板",
        "sectionPanel" in read(os.path.join(WEB_DIR, "js", "admin.js")),
    )

    print("\n五、自检：这些检查真的能抓出问题吗（否则它只是看起来很有用）")

    check(
        "★ 能抓出「JS 查了一个 HTML 里没有的元素」",
        qs_problems("const x = qs('#section-tabs');", "<div id='other'></div>")
        == ["section-tabs"],
    )
    check(
        "元素存在时不误报",
        qs_problems("const x = qs('#section-tabs');", '<nav id="section-tabs"></nav>') == [],
    )
    check(
        "双引号写法也能认（qs(\"#id\")）",
        qs_problems('const x = qs("#a");', "<div id='a'></div>") == [],
    )
    check(
        "★ 能抓出「import 了不存在的文件」",
        bool(IMPORT_RE.search("import { a } from './nope.js';")),
    )
    check(
        "★ 能抓出「import 了没导出的名字」",
        "renderSectionTabs" not in exported_names("function renderSectionTabs() {}"),
    )
    check(
        "导出能被认出来",
        "renderSectionTabs" in exported_names("export function renderSectionTabs() {}"),
    )
    check(
        "export {} 的别名写法也能认出来",
        "b" in exported_names("const a = 1; export { a as b };"),
    )

    print("\n" + "=" * 52)
    print(f"通过 {passed} 项，失败 {failed} 项")
    print("=" * 52)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
