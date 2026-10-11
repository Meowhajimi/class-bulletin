"""tools/backup-to-word.py 的测试。

重点是：生成的 .docx 必须是真实可用的 Word 文件。
这里用严格的方式校验 —— 解压、逐个必需部件检查、用 XML 解析器解析正文、
并把文本抽出来确认公告内容真的写进去了。

运行：python tools/tests/backup_docx_test.py
"""

from __future__ import annotations

import importlib.util
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from xml.etree import ElementTree

BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, BASE_DIR)

# 工具文件名带连字符（方便当命令输入），所以按路径加载
_spec = importlib.util.spec_from_file_location(
    "backup_to_word", os.path.join(BASE_DIR, "tools", "backup-to-word.py")
)
if _spec is None or _spec.loader is None:  # pragma: no cover
    raise SystemExit("找不到 tools/backup-to-word.py")
_backup = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_backup)

W_NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"

if not sys.stdout.isatty():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass

passed = 0
failed = 0

NOW = datetime(2026, 10, 10, 20, 0, tzinfo=timezone(timedelta(hours=8)))


def check(name: str, condition: bool, detail: str = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"  [通过] {name}")
    else:
        failed += 1
        print(f"  [失败] {name}" + (f" —— {detail}" if detail else ""))


def docx_text(path: str) -> str:
    """把 docx 里所有文字抽出来，顺便校验结构。"""
    with zipfile.ZipFile(path) as archive:
        assert archive.testzip() is None, "zip 损坏"
        names = archive.namelist()
        for required in ("[Content_Types].xml", "_rels/.rels", "word/document.xml"):
            assert required in names, f"缺少必需部件 {required}"
        xml = archive.read("word/document.xml").decode("utf-8")
    root = ElementTree.fromstring(xml)
    return "\n".join(node.text or "" for node in root.iter(f"{W_NS}t"))


SAMPLE = [
    {
        "id": "m1",
        "title": "本周五交实验报告",
        "body": "提交到学习通。\n注意格式要求。",
        "published_at": "2026-10-10T05:21:00+00:00",
        "expires_at": "2099-01-01T00:00:00+00:00",
        "is_urgent": True,
    },
    {
        "id": "m2",
        "title": "已过期的通知",
        "body": "这条已经过期了。",
        "published_at": "2020-01-01T00:00:00+00:00",
        "expires_at": "2020-02-01T00:00:00+00:00",
        "is_urgent": False,
    },
    {
        "id": "m3",
        "title": "标题里有 <尖括号> 和 & 符号",
        "body": "",
        "published_at": "2026-10-01T00:00:00+00:00",
        "expires_at": None,
    },
]


def main() -> int:
    print("\n一、状态判断")

    check(
        "未过期 → 有效",
        _backup.describe_status(SAMPLE[0], NOW) == "有效",
        _backup.describe_status(SAMPLE[0], NOW),
    )
    check(
        "已过期 → 已过期",
        _backup.describe_status(SAMPLE[1], NOW) == "已过期",
        _backup.describe_status(SAMPLE[1], NOW),
    )
    future = {"published_at": (NOW + timedelta(days=3)).isoformat(), "expires_at": None}
    check("发布时间在未来 → 未到发布时间", _backup.describe_status(future, NOW) == "未到发布时间")

    check("过期的会说明过期时间", "过期" in _backup.describe_expiry(SAMPLE[1], NOW), _backup.describe_expiry(SAMPLE[1], NOW))
    check("没设过期时间则不显示", _backup.describe_expiry(SAMPLE[2], NOW) == "")

    print("\n二、生成 docx 并校验结构")

    with tempfile.TemporaryDirectory() as temp_dir:
        path = os.path.join(temp_dir, "备份.docx")
        _backup.write_docx(path, _backup.build_document_xml(SAMPLE, "https://demo.supabase.co", NOW))

        check("文件已生成", os.path.isfile(path))
        check("文件不是空的", os.path.getsize(path) > 500, f"{os.path.getsize(path)} 字节")

        text = docx_text(path)  # 内部含 zip 与 XML 的完整校验
        check("zip 与三个必需部件齐全、XML 可解析", True)

        check("写进了公告标题", "本周五交实验报告" in text)
        check("写进了正文", "提交到学习通。" in text)
        check("正文换行保留为独立段落", "注意格式要求。" in text)
        check("写进了发件时间", "2026-10-10 13:21" in text, "应转成本地时间显示")
        check("写进了状态", "状态：有效" in text and "状态：已过期" in text)
        check("写进了备份来源", "https://demo.supabase.co" in text)
        check("写进了总条数", "共 3 条公告" in text)
        check("尖括号与 & 号原样显示（未被破坏）", "标题里有 <尖括号> 和 & 符号" in text)
        check("空正文有占位提示", "（无正文）" in text)
        check("有结束标记", "备份结束（共 3 条）" in text)

        print("\n二之二、紧急标记")
        check("紧急公告在标题前带【紧急】", "【紧急】本周五交实验报告" in text)
        check("紧急公告的元信息里标出紧急", "标记：紧急" in text)
        check("普通公告不加紧急标记", "【紧急】已过期的通知" not in text)
        check(
            "0/1 形式也要认（本地 SQLite 返回的是 1）",
            _backup.is_urgent({"is_urgent": 1}) is True and _backup.is_urgent({"is_urgent": 0}) is False,
        )

        print("\n二之三、正文要有明确标识（真实事故：只写了正文，没有标签，")
        print("        一段短正文看起来像元信息的残留物，被误以为「正文没导出」）")

        xml = _backup.build_document_xml(SAMPLE, "https://demo.supabase.co", NOW)

        check("出现了「正文：」标签", "正文：" in text)
        check("每条公告都有一个「正文：」", text.count("正文：") == len(SAMPLE), f"实际 {text.count('正文：')} 个")

        # 位置校验：「正文：」必须紧挨在正文**之前**，不能脱节
        label_at = text.index("正文：")
        body_at = text.index("提交到学习通。")
        check("「正文：」排在正文之前", label_at < body_at, f"标签 {label_at} / 正文 {body_at}")

        # 正文段落要带左缩进，才能和灰色元信息在视觉上分开
        check("正文段落有左缩进 w:ind", 'w:ind w:left="284"' in xml)
        check("正文段落有 1.5 倍行距", 'w:line="360"' in xml)
        check("条目之间有分隔线 w:pBdr", "<w:pBdr>" in xml and "D8DCE4" in xml)

        # OOXML 对 pPr / rPr 子元素顺序有要求，顺序错了 Word 可能忽略样式或报错。
        # 注意：必须**逐个段落**检查 —— 跨段落比位置是没有意义的
        #（标题里的 <w:spacing> 当然在第一条分隔线的 <w:pBdr> 之前）。
        check(
            "每个段落的 pPr 子元素顺序都合法（pBdr → spacing → ind → jc）",
            paragraph_order_problems(xml, "pPr") == [],
            "；".join(paragraph_order_problems(xml, "pPr")),
        )
        check(
            "每个段落的 rPr 子元素顺序都合法（b → color → sz → szCs）",
            paragraph_order_problems(xml, "rPr") == [],
            "；".join(paragraph_order_problems(xml, "rPr")),
        )

        print("\n二之四、两套实现（Python 与浏览器 JS）排版必须一致")
        check(
            "两边的 BLOCK_STYLES 完全一致",
            js_block_styles() == _backup.BLOCK_STYLES,
            f"JS={js_block_styles()}  PY={_backup.BLOCK_STYLES}",
        )

    print("\n三、边界情况")

    with tempfile.TemporaryDirectory() as temp_dir:
        path = os.path.join(temp_dir, "空.docx")
        _backup.write_docx(path, _backup.build_document_xml([], "https://demo.supabase.co", NOW))
        text = docx_text(path)
        check("零条公告也能生成，不崩", "共 0 条公告" in text)

    with tempfile.TemporaryDirectory() as temp_dir:
        path = os.path.join(temp_dir, "控制符.docx")
        dirty = {"title": "正常\u0000标题\u0007", "body": "带\u001b控制符", "published_at": "", "expires_at": None}
        _backup.write_docx(path, _backup.build_document_xml([dirty], "x", NOW))
        text = docx_text(path)
        check("危险控制字符被清掉（否则 Word 打不开）", "正常标题" in text)

    check(
        "ISO 时间能转成本地时间",
        _backup.format_time("2026-10-10T05:21:00+00:00") != "未知",
        _backup.format_time("2026-10-10T05:21:00+00:00"),
    )
    check("空时间显示为未知", _backup.format_time("") == "未知")

    print("\n四、交叉验证：浏览器端生成的文件，Word 格式是否也合格")

    # 网页上的「导出 Word 备份」用的是 web/js/ui/docx.js 里的代码。
    # 这里让 node 跑同一份代码生成一个 docx，再用上面的严格方式校验它 ——
    # 这样就能确定：同学/学委从网页导出的，确实是能打开的 Word 文件。
    ok, detail = cross_check_browser_generator()
    if ok is None:
        print(f"  [跳过] {detail}")
    else:
        check("浏览器端生成的 docx 通过严格校验", ok, detail)

    print("\n" + "=" * 46)
    print(f"通过 {passed} 项，失败 {failed} 项")
    print("=" * 46)
    return 1 if failed else 0


# OOXML 规定 pPr / rPr 的子元素必须按固定顺序出现。
# 这里只列出本项目用到的部分（完整顺序见 ECMA-376 的 CT_PPr / CT_RPr）。
PPR_ORDER = ["<w:pStyle", "<w:keepNext", "<w:pBdr", "<w:shd", "<w:tabs",
             "<w:spacing", "<w:ind", "<w:jc"]
RPR_ORDER = ["<w:rFonts", "<w:b/>", "<w:i/>", "<w:color", "<w:sz ", "<w:szCs "]


def paragraphs_of(xml_text: str) -> list[str]:
    """把 document.xml 拆成段落列表。

    注意 `<w:p>` 不会误匹配 `<w:pPr>`（后者是 `Pr>` 结尾），所以这个简单正则是安全的。
    """
    return re.findall(r"<w:p>.*?</w:p>", xml_text, flags=re.S)


def paragraph_order_problems(xml_text: str, kind: str) -> list[str]:
    """逐段检查 pPr / rPr 里的子元素顺序，返回不合法的描述列表。"""
    order = PPR_ORDER if kind == "pPr" else RPR_ORDER
    problems: list[str] = []

    for index, para in enumerate(paragraphs_of(xml_text), start=1):
        block = re.search(rf"<w:{kind}>(.*?)</w:{kind}>", para, flags=re.S)
        if not block:
            continue
        content = block.group(1)

        found = []
        for canonical, marker in enumerate(order):
            position = content.find(marker)
            if position >= 0:
                found.append((position, canonical, marker.strip("<w:/>")))

        found.sort()  # 按在 XML 里出现的先后排列
        canonical_seq = [item[1] for item in found]
        if canonical_seq != sorted(canonical_seq):
            problems.append(
                f"第 {index} 段的 {kind} 顺序不对：{' → '.join(item[2] for item in found)}"
            )

    return problems


def find_node() -> str | None:
    """找 node：先看 PATH，再看 Windows 常见安装位置（本机 node 没加进 PATH）。"""
    node = shutil.which("node") or r"C:\Program Files\nodejs\node.exe"
    if node and os.path.isfile(node):
        return node
    local = os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "nodejs", "node.exe")
    return local if os.path.isfile(local) else None


def run_node(script: str, args: list[str]) -> tuple[bool, str]:
    """在临时目录里跑一段 ESM 脚本，返回 (是否成功, 输出或错误)。"""
    node = find_node()
    if not node:
        return False, "找不到 node"

    with tempfile.TemporaryDirectory() as temp_dir:
        script_path = os.path.join(temp_dir, "task.mjs")
        with open(script_path, "w", encoding="utf-8") as handle:
            handle.write(script)
        try:
            completed = subprocess.run(
                [node, script_path, *args],
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=60,
                check=False,
            )
        except (OSError, subprocess.SubprocessError) as error:
            return False, f"运行 node 失败：{error}"

    if completed.returncode != 0:
        return False, (completed.stderr or completed.stdout or "").strip()[:400]
    return True, (completed.stdout or "").strip()


def js_block_styles() -> dict | None:
    """把 web/js/ui/docx.js 里的 BLOCK_STYLES 读出来，用于和 Python 侧比对。

    两边是两份独立实现（浏览器导出 / 本地脚本导出），
    排版一旦漂移，同一个班级的备份会出现两种样子，所以这里强制它们一致。
    """
    import json

    docx_js = os.path.join(BASE_DIR, "web", "js", "ui", "docx.js")
    if not os.path.isfile(docx_js):
        return None

    script = (
        "import { readFileSync } from 'node:fs';\n"
        f"const source = readFileSync({json.dumps(docx_js)}, 'utf8');\n"
        "const match = source.match(/const BLOCK_STYLES = (\\{[\\s\\S]*?\\n\\};)/);\n"
        "if (!match) { console.error('没找到 BLOCK_STYLES'); process.exit(1); }\n"
        "const value = eval('(' + match[1].replace(/;\\s*$/, '') + ')');\n"
        "process.stdout.write(JSON.stringify(value));\n"
    )
    ok, output = run_node(script, [])
    if not ok:
        return None
    try:
        return json.loads(output)
    except ValueError:
        return None


def cross_check_browser_generator() -> tuple[bool | None, str]:
    """调 node 运行 web/js/ui/docx.js，生成 docx 后严格校验。

    找不到 node 时返回 (None, 原因)，当作跳过而不是失败。
    """
    node = find_node()
    if not node:
        return None, "找不到 node，跳过（不影响其它测试）"

    docx_js = os.path.join(BASE_DIR, "web", "js", "ui", "docx.js")
    if not os.path.isfile(docx_js):
        return None, "找不到 web/js/ui/docx.js"

    with tempfile.TemporaryDirectory() as temp_dir:
        script_path = os.path.join(temp_dir, "generate.mjs")
        output_path = os.path.join(temp_dir, "浏览器备份.docx")

        # 用 as_uri() 生成 file:// URL，能正确处理路径里的空格（本仓库路径就带空格）
        script = (
            'import { writeFileSync } from "node:fs";\n'
            f'import {{ buildDocxBytes }} from "{Path(docx_js).as_uri()}";\n'
            "const blocks = [\n"
            "  { text: '班级公告栏', style: 'title' },\n"
            "  { text: '本周五交实验报告', style: 'heading' },\n"
            "  { text: '发布时间：2026-10-10 13:21', style: 'meta' },\n"
            "  { text: '正文：', style: 'label' },\n"
            "  { text: '正文第一行\\n第二行，带 <尖括号> 和 & 符号', style: 'body' },\n"
            "  { text: '', style: 'divider' },\n"
            "];\n"
            "writeFileSync(process.argv[2], Buffer.from(buildDocxBytes(blocks)));\n"
        )
        with open(script_path, "w", encoding="utf-8") as handle:
            handle.write(script)

        try:
            completed = subprocess.run(
                [node, script_path, output_path],
                capture_output=True,
                text=True,
                timeout=60,
                check=False,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            return None, f"调用 node 失败，跳过：{exc}"

        if completed.returncode != 0:
            message = (completed.stderr or completed.stdout or "").strip().splitlines()
            return False, f"node 生成失败：{message[-1] if message else '未知错误'}"

        if not os.path.isfile(output_path):
            return False, "node 没有产出文件"

        try:
            text = docx_text(output_path)
        except (zipfile.BadZipFile, ElementTree.ParseError, AssertionError) as exc:
            return False, f"产物不是合法 docx：{exc}"

        problems = []
        if "本周五交实验报告" not in text:
            problems.append("缺少公告标题")
        if "正文第一行" not in text or "第二行" not in text:
            problems.append("正文换行没有正确拆分")
        if "<尖括号>" not in text:
            problems.append("尖括号被破坏了")
        if "&" not in text:
            problems.append("& 号丢失")

        return (not problems), "；".join(problems) if problems else ""


if __name__ == "__main__":
    raise SystemExit(main())
