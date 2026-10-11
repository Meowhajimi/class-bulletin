"""`.bat` 文件的解析安全检查。

为什么需要（真实事故）：
    `推送到GitHub.bat` 里，推送失败时的提示是这样写的：

        if errorlevel 1 (
          echo   [失败] 推送没成功。常见原因：
          echo          · 需要登录 GitHub —— 弹出的窗口里授权即可
          echo          · 网络不通 —— 多试一次，或换个时间
          echo          · 远程仓库是新建的开发分支冲突 —— 到 GitHub 上看提示
          ...
        )

    文件本身完全正常（UTF-8、CRLF、无 BOM、无控制字节），
    但 cmd.exe 在 `chcp 65001`（UTF-8 代码页）下解析**多字节字符 + 括号块**时
    会出现位置错乱：它把一整行从中间劈开，然后拿后半截去当命令执行：

        '开发分支冲突' is not recognized as an internal or external command

    于是三条提示只打出了两条半，最后还多出一行莫名其妙的报错。

    这个坑很隐蔽：文件"看起来"没问题，也只有**推送失败**这条冷路径才会走到，
    平时根本不会触发。

结论与规矩：
    .bat 的**控制流（括号块）里不要写中文**。
    要输出中文提示，用 `goto` 跳到块外的标签去 `echo`。

本测试检查：
    1. 每个 .bat 都是 CRLF、无 BOM（cmd 对 LF 结尾的 bat 会解析出错）
    2. 括号块里没有中文 echo（上面那个事故的形状）
    3. 自检：检测逻辑真的能抓出这种写法

运行：python tools/tests/bat_safety_test.py
"""

from __future__ import annotations

import os
import re
import sys

BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

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


def bat_files() -> list[str]:
    return sorted(
        name
        for name in os.listdir(BASE_DIR)
        if name.lower().endswith(".bat") and os.path.isfile(os.path.join(BASE_DIR, name))
    )


def read_bytes(name: str) -> bytes:
    with open(os.path.join(BASE_DIR, name), "rb") as handle:
        return handle.read()


HAS_CHINESE = re.compile(r"[\u4e00-\u9fff]")
# 行尾是 ( 的，视为"括号块开始"（if ... ( / for ... ( / else (）
BLOCK_OPEN = re.compile(r"\(\s*$")
# 行首是 ) 的，视为"块结束"
BLOCK_CLOSE = re.compile(r"^\s*\)")


def chinese_echo_in_blocks(text: str) -> list[int]:
    """找出"括号块里 echo 中文"的行号。

    抽成函数是为了能自检 —— 一个检测器如果连已知的坏样本都抓不出来，
    它只是在给项目增加虚假的安全感。
    """
    hits: list[int] = []
    depth = 0
    for number, line in enumerate(text.split("\r\n"), start=1):
        if depth == 0:
            if BLOCK_OPEN.search(line) and not line.strip().lower().startswith("rem"):
                depth = 1
            continue
        if BLOCK_CLOSE.match(line):
            depth = 0
            continue
        if line.strip().lower().startswith("echo") and HAS_CHINESE.search(line):
            hits.append(number)
    return hits


def main() -> int:
    names = bat_files()
    check("找得到根目录下的 .bat", bool(names), "一个都没有？")

    print("\n一、行尾必须是 CRLF、且不能有 BOM")
    for name in names:
        raw = read_bytes(name)
        bare_lf = raw.count(b"\n") - raw.count(b"\r\n")
        check(f"{name} 是 CRLF（裸 LF {bare_lf} 个）", bare_lf == 0, f"含 {bare_lf} 个裸 LF")
        check(f"{name} 没有 BOM", not raw.startswith(b"\xef\xbb\xbf"))

    print("\n二、括号块里不能 echo 中文（cmd 的 UTF-8 解析会错位）")
    offenders: dict[str, list[int]] = {}
    for name in names:
        text = read_bytes(name).decode("utf-8", "replace")
        hits = chinese_echo_in_blocks(text)
        if hits:
            offenders[name] = hits
    check(
        "所有 .bat 的括号块里都没有中文",
        not offenders,
        "；".join(f"{name} 第 {lines} 行" for name, lines in offenders.items()),
    )

    print("\n三、自检：检测逻辑真的能抓出这种写法吗")
    known_bad = "\r\n".join(
        [
            "@echo off",
            "if errorlevel 1 (",
            "  echo   [失败] 推送没成功。常见原因：",
            "  echo          · 远程仓库是新建的开发分支冲突 —— 到 GitHub 上看提示",
            "  exit /b 1",
            ")",
        ]
    )
    check("★ 能抓出「括号块里 echo 中文」（就是本文件开头那个事故）",
          chinese_echo_in_blocks(known_bad) == [3, 4],
          str(chinese_echo_in_blocks(known_bad)))

    known_good = "\r\n".join(
        [
            "@echo off",
            "if errorlevel 1 goto :push_failed",
            "echo   [成功] 已推送",
            "exit /b 0",
            ":push_failed",
            "echo   [失败] 推送没成功。常见原因：",
            "echo          · 网络不通 —— 多试一次",
            "exit /b 1",
        ]
    )
    check("正确的写法（goto 到块外）不误报", chinese_echo_in_blocks(known_good) == [])

    ascii_block = "if errorlevel 1 (\r\n  echo   push failed\r\n)\r\n"
    check("纯 ASCII 的括号块不误报", chinese_echo_in_blocks(ascii_block) == [])

    print("\n" + "=" * 52)
    print(f"通过 {passed} 项，失败 {failed} 项")
    print("=" * 52)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
