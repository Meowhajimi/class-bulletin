"""检测并修复"双重编码"（乱码）的文本文件。

为什么需要：
    用 PowerShell 批改文档时，如果读取时猜错了编码（例如把 UTF-8 当成 GBK），
    再用 UTF-8 写回，中文就会变成「涓€涓彮绾у叕鍛婄綉椤?」这种乱码。
    这种损坏不会报错，只有在肉眼看文档时才发现 —— 所以必须有个工具盯着。

怎么判断：
    正常中文里极少出现「锛 鈥 銆 鐨 涓 鍦 鍙 鎴 绠 璁」这些字。
    它们大量出现，就说明是"UTF-8 字节被当成 GBK 解读后又存成 UTF-8"。

修复原理（正好是损坏的逆运算）：
    损坏：utf8_bytes --按 GBK 解读--> 文本 --存成 UTF-8--> 乱码文件
    修复：乱码文本 --编码回 GBK--> utf8_bytes --按 UTF-8 解读--> 原文

用法：
    python tools/check_encoding.py          # 只检查（有问题时退出码 1）
    python tools/check_encoding.py --fix    # 检查并就地修复
"""

from __future__ import annotations

import os
import sys

# 中文 Windows 的控制台默认是 GBK，打印 ✅ 这类字符会直接抛 UnicodeEncodeError。
# 这里强制切换成 UTF-8，并且用 errors="replace" 兜底 —— 绝不让"打印"把脚本搞崩。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, OSError):
    pass

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 这些字在正常中文里很少见，但在双重编码的乱码里几乎必然出现
MOJIBAKE_MARKERS = "锛鈥銆鐨涓鍦鍙鎴绠璁鐢瑕鏄閿鍜鍚鎬浣犲ソ"

# 只检查这些扩展名（其余按二进制跳过）
TEXT_EXTENSIONS = {".md", ".js", ".py", ".json", ".html", ".css", ".bat", ".txt", ".sql", ".ts", ".svg", ".mjs"}

# 这些目录不检查
SKIP_DIRS = {"__pycache__", ".git", "node_modules", ".venv"}

# 这些文件不检查：本文件自己就包含下面那串乱码字符作为检测依据（会自己命中自己）
SKIP_FILES = {os.path.join("tools", "check_encoding.py")}

# 单个文件里出现多少个可疑字才算坏（避免个别字误报）
THRESHOLD = 3


def iter_text_files():
    for root, dirs, files in os.walk(BASE_DIR):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for name in files:
            path = os.path.join(root, name)
            if os.path.relpath(path, BASE_DIR) in SKIP_FILES:
                continue
            if os.path.splitext(name)[1].lower() in TEXT_EXTENSIONS:
                yield path


def count_markers(text: str) -> int:
    return sum(text.count(char) for char in MOJIBAKE_MARKERS)


def repair(text: str) -> str:
    """把双重编码的文本还原。

    ★ 逐行处理，而不是整篇一起处理 —— 因为损坏时有些字节会丢（变成 `?`），
      那一行就救不回来了；但**不该因此放弃其它能救的行**。
      （第一版写成"整篇 all-or-nothing"，结果 README.md 一行坏掉就全都修不了。）
    """
    lines = text.splitlines(keepends=True)
    fixed_lines = []
    for line in lines:
        try:
            fixed_lines.append(line.encode("cp936").decode("utf-8"))
        except (UnicodeEncodeError, UnicodeDecodeError):
            fixed_lines.append(line)  # 这行救不回来就原样留着
    return "".join(fixed_lines)


def main() -> int:
    fix = "--fix" in sys.argv

    broken: list[tuple[str, int]] = []
    repaired: list[str] = []
    failed: list[str] = []

    for path in iter_text_files():
        try:
            with open(path, "r", encoding="utf-8") as handle:
                text = handle.read()
        except (UnicodeDecodeError, OSError):
            continue  # 不是 UTF-8 文本，跳过（例如二进制被误收）

        count = count_markers(text)
        if count < THRESHOLD:
            continue

        relative = os.path.relpath(path, BASE_DIR)
        broken.append((relative, count))

        if not fix:
            continue

        fixed = repair(text)
        if fixed == text or count_markers(fixed) >= count:
            failed.append(relative)
            continue

        with open(path, "w", encoding="utf-8", newline="") as handle:
            handle.write(fixed)
        repaired.append(relative)

    print("=" * 60)
    if not broken:
        print("  没有发现乱码文件 ✅")
        print("=" * 60)
        return 0

    print(f"  发现 {len(broken)} 个文件有乱码：")
    for relative, count in sorted(broken, key=lambda item: -item[1]):
        mark = "已修复" if relative in repaired else ("修复失败" if relative in failed else "待修复")
        print(f"    [{mark}] {relative}   （可疑字 {count} 个）")
    print("=" * 60)

    if not fix:
        print("\n  加 --fix 可以就地修复。修复前建议先 git commit，方便对比。")
        return 1

    if failed:
        print(f"\n  有 {len(failed)} 个文件修不好（数据已丢失，需要从 git 恢复）：")
        for relative in failed:
            print(f"    · {relative}")
        return 1

    print(f"\n  已修复 {len(repaired)} 个文件。请 git diff 看一遍再提交。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
