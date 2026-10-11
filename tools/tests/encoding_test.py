"""乱码（双重编码）检测的测试。

为什么需要：
    有一次用 PowerShell 批量改文档，它默认按 GBK 读了 UTF-8 文件、
    又按 UTF-8 写回 —— README.md 整个变成「鐝骇鍏憡鏍?」这种乱码。
    **没有报错、测试也全绿**，因为所有测试都不检查文档的可读性。

    所以这里既测"检测工具本身有效"，也测"当前项目里的文件都是干净的"。
    后者才是真正防回归的那一条。

运行：python tools/tests/encoding_test.py
"""

from __future__ import annotations

import importlib.util
import os
import sys
import tempfile

BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, OSError):
    pass

_spec = importlib.util.spec_from_file_location(
    "check_encoding", os.path.join(BASE_DIR, "tools", "check_encoding.py")
)
_checker = importlib.util.module_from_spec(_spec)
sys.modules["check_encoding"] = _checker
_spec.loader.exec_module(_checker)

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


CLEAN = "# 班级公告栏\n\n一个班级公告网页：**同学只读浏览，学习委员一人发布**。\n"


def corrupt(text: str) -> str:
    """复现当初那种损坏：UTF-8 字节按 GBK 解读（解不出的用 ? 顶替），再存成 UTF-8。

    注意 `errors="replace"` —— 这正是当初损坏时的情况，
    也就解释了为什么恢复出来的文本里会看到 `?`（那部分字节已经**永久丢失**）。
    """
    return text.encode("utf-8").decode("gbk", errors="replace")


def corrupt_lossless(text: str):
    """只有当 UTF-8 字节恰好能被 GBK 无损解读时，才返回损坏结果；否则返回 None。

    这种"无损损坏"是**可逆**的，用来验证修复函数真能还原。
    """
    try:
        return text.encode("utf-8").decode("gbk")
    except UnicodeDecodeError:
        return None


# 找一个能无损往返的中文样本（不同字的 UTF-8 字节不一定都是合法 GBK 序列）
LOSSLESS_SAMPLE = None
for _candidate in (
    "班级公告栏",
    "公告",
    "测试",
    "同学只读",
    "发布通知",
    "作业",
    "教室",
    "本周课程安排",
):
    if corrupt_lossless(_candidate):
        LOSSLESS_SAMPLE = _candidate
        break


def main() -> int:
    print("\n一、检测逻辑本身是否有效")

    clean_markers = _checker.count_markers(CLEAN)
    broken = corrupt(CLEAN)
    broken_markers = _checker.count_markers(broken)

    check("正常中文不会被误判", clean_markers < _checker.THRESHOLD, f"可疑字 {clean_markers} 个")
    check(
        "损坏的文本会被判为乱码",
        broken_markers >= _checker.THRESHOLD,
        f"可疑字 {broken_markers} 个（阈值 {_checker.THRESHOLD}）",
    )
    check("损坏确实改变了内容", broken != CLEAN)
    check(
        "损坏后的文本里看不到原句（说明真的坏了）",
        "班级公告栏" not in broken,
        broken[:30],
    )

    print("\n二、修复函数（能修的就修，修不了不抛异常、也不拖累其它行）")
    repaired = _checker.repair(broken)
    check("修复不会抛异常", isinstance(repaired, str))
    # 有 ? 的地方字节已丢失，所以这里只要求"不变得更糟"
    check(
        "字节丢失的损坏：修复后不会更糟",
        _checker.count_markers(repaired) <= broken_markers,
        f"修前 {broken_markers} → 修后 {_checker.count_markers(repaired)}",
    )

    check("能找到可用于验证的样本", bool(LOSSLESS_SAMPLE), "没找到能无损往返的中文")
    if LOSSLESS_SAMPLE:
        lossless = corrupt_lossless(LOSSLESS_SAMPLE)
        check(
            f"★ 无损损坏能被完全还原（样本「{LOSSLESS_SAMPLE}」）",
            _checker.repair(lossless) == LOSSLESS_SAMPLE,
            f"还原成了 {_checker.repair(lossless)!r}",
        )

    # 混合场景：一行能救、一行救不回 —— 能救的那行必须被救回来
    mixed = (corrupt_lossless("公告") or "公告") + "\n" + corrupt("坏行") + "\n"
    mixed_fixed = _checker.repair(mixed)
    check(
        "★ 一行坏了不该拖累其它行（逐行修复）",
        "公告" in mixed_fixed,
        repr(mixed_fixed[:40]),
    )

    print("\n三、★ 当前项目里的文件必须都是干净的（这条才是防回归的）")

    dirty = []
    for path in _checker.iter_text_files():
        try:
            with open(path, "r", encoding="utf-8") as handle:
                text = handle.read()
        except (UnicodeDecodeError, OSError):
            continue
        count = _checker.count_markers(text)
        if count >= _checker.THRESHOLD:
            dirty.append((os.path.relpath(path, BASE_DIR), count))

    check(
        "没有被双重编码的文件",
        not dirty,
        "有乱码：" + "、".join(f"{name}({count})" for name, count in dirty),
    )
    if dirty:
        print("\n     修法：python tools/check_encoding.py --fix")
        print("     修不好就从 git 恢复：git show HEAD:文件名 > 文件名")

    print("\n三之二、★ 所有 .bat 必须是 CRLF 换行 + 无 BOM")

    # 为什么单列一条：cmd.exe 遇到 LF 换行会**把行拆错**
    # （`echo.` 被当成命令 `ho`，整个脚本就废了）。
    # 这个坑真的发生过 —— 用脚本批量改计数时，写出时把 CRLF 变成了 LF。
    bat_files = [
        name for name in sorted(os.listdir(BASE_DIR)) if name.lower().endswith(".bat")
    ]
    check("项目里有 .bat 文件", len(bat_files) > 0, f"找到 {len(bat_files)} 个")

    bad_endings: list[str] = []
    bad_bom: list[str] = []
    for name in bat_files:
        with open(os.path.join(BASE_DIR, name), "rb") as handle:
            raw = handle.read()
        lf_only = raw.count(b"\n") - raw.count(b"\r\n")
        if lf_only:
            bad_endings.append(f"{name}（{lf_only} 行只有 LF）")
        if raw[:3] == b"\xef\xbb\xbf":
            bad_bom.append(name)

    check(
        "全部用 CRLF 换行（LF 会让 cmd 拆错行）",
        not bad_endings,
        "、".join(bad_endings),
    )
    check("全部没有 UTF-8 BOM", not bad_bom, "、".join(bad_bom))
    if bad_endings or bad_bom:
        print("\n     修法（Python，newline='' 读写才不做换行翻译）：")
        print("       io.open(p, encoding='utf-8', newline='').read()")
        print("       → 把 \\r\\n 统一成 \\n 再换成 \\r\\n → 用 newline='' 写回")

    print("\n四、真造一个坏文件，端到端验证检测能抓到")
    with tempfile.TemporaryDirectory() as temp_dir:
        target = os.path.join(temp_dir, "broken.md")
        with open(target, "w", encoding="utf-8") as handle:
            handle.write(corrupt(CLEAN))
        with open(target, "r", encoding="utf-8") as handle:
            got = _checker.count_markers(handle.read())
        check("写进磁盘的坏文件也能被检出", got >= _checker.THRESHOLD, f"可疑字 {got} 个")

        good = os.path.join(temp_dir, "clean.md")
        with open(good, "w", encoding="utf-8") as handle:
            handle.write(CLEAN)
        with open(good, "r", encoding="utf-8") as handle:
            got_good = _checker.count_markers(handle.read())
        check("同一目录下的正常文件不会被误判", got_good < _checker.THRESHOLD)

    print("\n" + "=" * 52)
    print(f"通过 {passed} 项，失败 {failed} 项")
    print("=" * 52)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
