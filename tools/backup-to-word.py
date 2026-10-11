"""把云端的所有公告导出成 Word (.docx) 备份。

为什么需要它（和网页上的「导出 Word 备份」按钮有什么区别）：
    网页上的按钮要求网站还活着。而本脚本是**直连你 Supabase 的数据库**的，
    所以即使 Netlify 上的网站彻底失效、连管理页都打不开，
    只要云端数据还在，你依然能把全部公告导出成 Word。

用法：
    python tools/backup-to-word.py
    python tools/backup-to-word.py --out-dir D:\\班级备份
    python tools/backup-to-word.py --from-json backups\\公告备份-xxx.json   # 云端也没了时用

每次运行都会生成两个带时间戳的文件（不会覆盖旧备份）：
    backups/公告备份-2026-10-10-2015.docx   ← 给人看的 Word 文档
    backups/公告备份-2026-10-10-2015.json   ← 给程序看的原始数据，用于将来恢复

只依赖 Python 标准库，不需要安装任何东西。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
import zipfile
from datetime import datetime
from xml.sax.saxutils import escape

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_PATH = os.path.join(BASE_DIR, "web", "js", "config.js")
DEFAULT_OUT_DIR = os.path.join(BASE_DIR, "backups")

XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"

CONTENT_TYPES = (
    XML_HEADER
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" '
    + 'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + "</Types>"
)

ROOT_RELS = (
    XML_HEADER
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" '
    + 'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
    + 'Target="word/document.xml"/></Relationships>'
)

# 每种段落样式对应的 Word 排版。
# 单位：sz 半磅（21 = 10.5 磅）；space/line 为 twips（240 = 1 行）；indent 为 twips（567 ≈ 1 厘米）
# ⚠️ 与 web/js/ui/docx.js 的 BLOCK_STYLES 必须保持一致（两份实现，改一处要改两处）
BLOCK_STYLES = {
    "title": {"size": 36, "bold": True, "align": "center", "space": 240},
    # 每条公告的标题：比正文明显，上方留白拉开条目
    "heading": {"size": 30, "bold": True, "align": "left", "spaceBefore": 240, "space": 80},
    "meta": {"size": 18, "color": "808080", "align": "left", "space": 40},
    # 「正文：」这类小标签
    "label": {"size": 18, "color": "808080", "align": "left", "space": 40, "spaceBefore": 120},
    # 正文：左缩进 + 1.5 倍行距，和灰色元信息明显区分
    "body": {"size": 21, "align": "left", "space": 80, "indent": 284, "line": 360},
    "gap": {"size": 21, "align": "left", "space": 120},
    # 条目之间的细分隔线（空段落 + 下边框）
    "divider": {"size": 2, "align": "left", "space": 200, "border": "D8DCE4"},
}

if not sys.stdout.isatty():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    except (AttributeError, OSError):
        pass


# ============================== 读取配置 ==============================


def read_config(path: str) -> tuple[str, str]:
    """从 web/js/config.js 里取出接口地址与可发布 key（只看赋值，不看注释）。"""
    with open(path, "r", encoding="utf-8") as handle:
        text = handle.read()
    url_match = re.search(r"^\s*url:\s*'([^']*)'", text, re.MULTILINE)
    key_match = re.search(r"^\s*anonKey:\s*'([^']*)'", text, re.MULTILINE)
    return (
        url_match.group(1).strip() if url_match else "",
        key_match.group(1).strip() if key_match else "",
    )


def fetch_messages(url: str, key: str, timeout: int = 20) -> list[dict]:
    """直连 REST 接口，取回全部公告（按发布时间倒序）。"""
    endpoint = f"{url.rstrip('/')}/rest/v1/messages?select=*&order=published_at.desc"
    request = urllib.request.Request(endpoint, headers={"apikey": key, "Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


# ============================== 生成 Word ==============================


def is_urgent(message: dict) -> bool:
    """与前端 data/contract.js 的 isUrgentMessage 保持同一套判断。"""
    value = message.get("is_urgent")
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return False


def format_time(value: str) -> str:
    """把 ISO 时间变成本地时间显示，例：2026-10-10 13:21。"""
    if not value:
        return "未知"
    try:
        moment = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return str(value)
    return moment.astimezone().strftime("%Y-%m-%d %H:%M")


def describe_status(message: dict, now: datetime) -> str:
    """有效 / 已过期 / 未到发布时间"""
    expires = message.get("expires_at")
    if expires:
        try:
            if datetime.fromisoformat(str(expires).replace("Z", "+00:00")) <= now:
                return "已过期"
        except ValueError:
            pass
    published = message.get("published_at")
    if published:
        try:
            if datetime.fromisoformat(str(published).replace("Z", "+00:00")) > now:
                return "未到发布时间"
        except ValueError:
            pass
    return "有效"


def describe_expiry(message: dict, now: datetime) -> str:
    expires = message.get("expires_at")
    if not expires:
        return ""
    try:
        moment = datetime.fromisoformat(str(expires).replace("Z", "+00:00"))
    except ValueError:
        return ""
    if moment <= now:
        return f"已于 {format_time(expires)} 过期"
    remaining = moment - now
    days = remaining.days
    if days >= 1:
        return f"{days} 天后过期（{format_time(expires)}）"
    hours = max(1, int(remaining.total_seconds() // 3600))
    return f"{hours} 小时后过期（{format_time(expires)}）"


def paragraph(text: str, style: str = "body") -> str:
    """渲染一个段落；文字里的换行会拆成多个段落。

    ⚠️ OOXML 规定 pPr 的子元素必须按固定顺序出现（否则 Word 可能报错或忽略样式）。
    本函数用到的顺序：pBdr → spacing → ind → jc。rPr 的顺序：b → color → sz → szCs。
    """
    spec = BLOCK_STYLES.get(style, BLOCK_STYLES["body"])

    properties = ""
    if spec.get("border"):
        properties += (
            f'<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" '
            f'w:color="{spec["border"]}"/></w:pBdr>'
        )

    spacing = []
    if spec.get("spaceBefore"):
        spacing.append(f'w:before="{spec["spaceBefore"]}"')
    if spec.get("space"):
        spacing.append(f'w:after="{spec["space"]}"')
    if spec.get("line"):
        spacing.append(f'w:line="{spec["line"]}"')
        # auto = 倍数行距（240 单倍，360 = 1.5 倍）
        spacing.append(f'w:lineRule="{spec.get("lineRule", "auto")}"')
    if spacing:
        properties += f'<w:spacing {" ".join(spacing)}/>'

    if spec.get("indent"):
        properties += f'<w:ind w:left="{spec["indent"]}" w:right="{spec["indent"]}"/>'

    if spec.get("align") and spec["align"] != "left":
        properties += f'<w:jc w:val="{spec["align"]}"/>'

    run_properties = ""
    if spec.get("bold"):
        run_properties += "<w:b/>"
    if spec.get("color"):
        run_properties += f'<w:color w:val="{spec["color"]}"/>'
    run_properties += f'<w:sz w:val="{spec["size"]}"/><w:szCs w:val="{spec["size"]}"/>'

    pieces = []
    for line in str(text or "").split("\n"):
        # 控制字符在 XML 里非法，会让 Word 报"内容有问题"，先清掉
        cleaned = re.sub(r"[\x00-\x08\x0B\x0C\x0E-\x1F]", "", line)
        pieces.append(
            f"<w:p>{'<w:pPr>' + properties + '</w:pPr>' if properties else ''}"
            f"<w:r><w:rPr>{run_properties}</w:rPr>"
            f'<w:t xml:space="preserve">{escape(cleaned)}</w:t></w:r></w:p>'
        )
    return "".join(pieces)


def build_document_xml(messages: list[dict], source: str, generated_at: datetime) -> str:
    """生成 word/document.xml。排版与网页上导出的保持一致。"""
    now = datetime.now().astimezone()
    blocks: list[tuple[str, str]] = [
        ("班级公告栏", "title"),
        ("公告备份文档", "meta"),
        ("", "divider"),
        (
            f"备份时间：{generated_at.strftime('%Y-%m-%d %H:%M')}　共 {len(messages)} 条公告\n"
            f"数据来源：{source}",
            "meta",
        ),
        (
            "说明：本文档由「班级公告栏」导出，用于网站或云端数据失效时找回内容。请妥善保存。",
            "meta",
        ),
        ("", "divider"),
    ]

    for index, message in enumerate(messages, start=1):
        urgent = is_urgent(message)
        blocks.append(
            (
                f"{index}. {'【紧急】' if urgent else ''}"
                f"{(message.get('title') or '（无标题）').strip()}",
                "heading",
            )
        )
        blocks.append(
            (
                f"发布时间：{format_time(message.get('published_at'))}　"
                f"状态：{describe_status(message, now)}"
                + ("　标记：紧急" if urgent else ""),
                "meta",
            )
        )
        expiry_note = describe_expiry(message, now)
        if expiry_note:
            blocks.append((f"过期情况：{expiry_note}", "meta"))
        # ★ 先给出「正文：」标签，再输出正文（带缩进）。
        #   否则一段短正文看起来像元信息的残留物，会被误以为"正文没导出"。
        blocks.append(("正文：", "label"))
        blocks.append((message.get("body") or "（无正文）", "body"))
        # 条目之间加细分隔线
        blocks.append(("", "divider"))

    blocks.append((f"—— 备份结束（共 {len(messages)} 条）——", "meta"))

    body = "".join(paragraph(text, style) for text, style in blocks)
    return (
        f'{XML_HEADER}<w:document xmlns:w="{W_NS}"><w:body>{body}'
        '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
        '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>'
        "</w:sectPr></w:body></w:document>"
    )


def write_docx(path: str, document_xml: str) -> None:
    """docx 就是一个装着 XML 的 zip。"""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", CONTENT_TYPES)
        archive.writestr("_rels/.rels", ROOT_RELS)
        archive.writestr("word/document.xml", document_xml)


# ================================ 主流程 ================================


def main() -> int:
    parser = argparse.ArgumentParser(description="把班级公告导出成 Word 备份")
    parser.add_argument("--out-dir", default=DEFAULT_OUT_DIR, help="备份输出目录")
    parser.add_argument("--config", default=CONFIG_PATH, help="config.js 路径")
    parser.add_argument("--from-json", default="", help="不联网，直接从已有的 json 备份重新生成 docx")
    parser.add_argument("--quiet", action="store_true", help="只打印结果")
    args = parser.parse_args()

    out_dir = os.path.abspath(args.out_dir)
    os.makedirs(out_dir, exist_ok=True)

    url = ""
    if args.from_json:
        json_path = os.path.abspath(args.from_json)
        if not os.path.isfile(json_path):
            print(f"[错误] 找不到 json 文件：{json_path}")
            return 1
        with open(json_path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        messages = payload.get("messages", payload if isinstance(payload, list) else [])
        url = payload.get("source", "") if isinstance(payload, dict) else ""
        print(f"[数据] 从本地文件读取：{json_path}")
    else:
        if not os.path.isfile(args.config):
            print(f"[错误] 找不到配置文件：{args.config}")
            return 1
        url, key = read_config(args.config)
        if not url:
            print("[错误] config.js 里的 supabase.url 是空的，不知道去哪儿取数据。")
            return 1
        if not args.quiet:
            print(f"[配置] 接口地址：{url}")
        try:
            messages = fetch_messages(url, key)
        except urllib.error.HTTPError as error:
            print(f"[错误] 接口返回 HTTP {error.code}。")
            if error.code == 401:
                print("       多半是 anonKey 填错了，或者填了机密 key。")
            elif error.code == 404:
                print("       表不存在：supabase/schema.sql 可能还没跑成功。")
            return 1
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            print(f"[错误] 连不上服务器：{error}")
            print("       网络不通时无法备份。请检查网络，或稍后再试。")
            print("       （已有备份不会被改动，可放心。）")
            return 1

    if not messages:
        print("[提示] 云端目前没有任何公告，不生成空备份。")
        return 0

    generated_at = datetime.now().astimezone()
    stamp = generated_at.strftime("%Y-%m-%d-%H%M")
    docx_path = os.path.join(out_dir, f"班级公告栏备份-{stamp}.docx")
    json_path = os.path.join(out_dir, f"班级公告栏备份-{stamp}.json")

    write_docx(docx_path, build_document_xml(messages, url, generated_at))

    with open(json_path, "w", encoding="utf-8") as handle:
        json.dump(
            {
                "source": url,
                "exported_at": generated_at.isoformat(timespec="seconds"),
                "count": len(messages),
                "messages": messages,
            },
            handle,
            ensure_ascii=False,
            indent=2,
        )

    print()
    print("=" * 56)
    print(f"  备份完成：共 {len(messages)} 条公告")
    print("=" * 56)
    print(f"  Word 文档：{docx_path}")
    print(f"  原始数据：{json_path}（将来恢复用得上）")
    print(f"  文件大小：{os.path.getsize(docx_path) / 1024:.1f} KB")
    print()
    print("  最新的公告都在这份 Word 里了。建议连同网站一起保存好。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
