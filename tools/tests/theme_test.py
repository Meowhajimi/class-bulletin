"""主题一致性检查（CSS 变量 + 深色模式 + 文字对比度）。

为什么需要：
    美化是主观的，但有三件事是**客观可验证**的，而且正好覆盖"改主题时最容易犯的错"：

    1. 悬空的 CSS 变量
       改了变量定义的名字，却忘了改用处 → 那处样式会静默失效，
       页面上只是"有点不对"，很难定位。
    2. 深色模式漏了变量
       浅色里加了 --color-xxx，深色模式没给 → 深色下出现刺眼的白色块。
    3. 对比度不够
       文字颜色调得太淡，在手机上（尤其阳光下）读不清。
       WCAG AA 要求正文 ≥ 4.5:1。

    我无法渲染浏览器，观感只能靠人看；但这三件事机器能查，就不该靠人眼。

运行：python tools/tests/theme_test.py
"""

from __future__ import annotations

import os
import re
import sys

BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CSS_DIR = os.path.join(BASE_DIR, "web", "css")

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


# ============================== 读取 CSS ==============================


def read_css_files() -> dict[str, str]:
    files = {}
    for name in sorted(os.listdir(CSS_DIR)):
        if name.endswith(".css"):
            with open(os.path.join(CSS_DIR, name), "r", encoding="utf-8") as handle:
                files[name] = handle.read()
    return files


def strip_comments(text: str) -> str:
    return re.sub(r"/\*.*?\*/", "", text, flags=re.S)


def split_blocks(css: str) -> tuple[dict[str, str], dict[str, str]]:
    """把 tokens.css 拆成 (浅色变量, 深色变量)。

    深色部分在 @media (prefers-color-scheme: dark) 里，所以先切出媒体查询再解析。
    """
    light: dict[str, str] = {}
    dark: dict[str, str] = {}

    match = re.search(
        r"@media\s*\(prefers-color-scheme:\s*dark\)\s*\{(.*)", css, flags=re.S
    )
    if match:
        dark_text = match.group(1)
        light_text = css[: match.start()]
    else:
        dark_text = ""
        light_text = css

    def collect(text: str, target: dict[str, str]) -> None:
        for name, value in re.findall(r"(--[\w-]+)\s*:\s*([^;]+);", text):
            target[name] = value.strip()

    collect(light_text, light)
    collect(dark_text, dark)
    return light, dark


# ============================== 对比度计算 ==============================


def to_rgb(value: str) -> tuple[int, int, int] | None:
    """把 #rgb / #rrggbb 解析成 (r,g,b)；其它写法（rgba、渐变）返回 None。"""
    value = value.strip()
    match = re.fullmatch(r"#([0-9a-fA-F]{3})", value)
    if match:
        return tuple(int(char * 2, 16) for char in match.group(1))  # type: ignore[return-value]
    match = re.fullmatch(r"#([0-9a-fA-F]{6})", value)
    if match:
        digits = match.group(1)
        return tuple(int(digits[i : i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]
    return None


def relative_luminance(rgb: tuple[int, int, int]) -> float:
    channels = []
    for value in rgb:
        srgb = value / 255
        channels.append(srgb / 12.92 if srgb <= 0.03928 else ((srgb + 0.055) / 1.055) ** 2.4)
    red, green, blue = channels
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue


def contrast_ratio(foreground: str, background: str) -> float | None:
    front = to_rgb(foreground)
    back = to_rgb(background)
    if not front or not back:
        return None
    light = max(relative_luminance(front), relative_luminance(back))
    dark = min(relative_luminance(front), relative_luminance(back))
    return (light + 0.05) / (dark + 0.05)


# ============================== 检查项 ==============================


def main() -> int:
    files = read_css_files()
    if "tokens.css" not in files:
        print(f"[错误] 在 {CSS_DIR} 里找不到 tokens.css")
        return 1

    tokens_css = strip_comments(files["tokens.css"])
    light, dark = split_blocks(tokens_css)

    print(f"\n一、CSS 变量定义（共 {len(files)} 个样式文件）")
    check(f"浅色模式定义了变量", len(light) > 20, f"{len(light)} 个")
    check("深色模式定义了变量", len(dark) > 10, f"{len(dark)} 个")

    print("\n二、所有 var(--x) 引用都必须有定义（改了变量名却忘改用处 → 样式静默失效）")
    used: dict[str, list[str]] = {}
    for name, raw in files.items():
        for variable in re.findall(r"var\(\s*(--[\w-]+)", strip_comments(raw)):
            used.setdefault(variable, []).append(name)

    defined = set(light) | set(dark)
    dangling = {name: where for name, where in used.items() if name not in defined}
    check(
        f"{len(used)} 个变量引用全部有定义",
        not dangling,
        "；".join(f"{name}（用于 {', '.join(sorted(set(where)))}）" for name, where in dangling.items()),
    )

    print("\n三、深色模式必须覆盖所有颜色变量（漏了会在深色下出现白色块）")
    missing_dark = sorted(
        name
        for name, value in light.items()
        # 只要求颜色类变量：以 --color- 开头且有具体颜色值
        if name.startswith("--color-") and to_rgb(value) and name not in dark
    )
    check(
        f"{sum(1 for n in light if n.startswith('--color-'))} 个 --color-* 变量在深色模式里都有对应值",
        not missing_dark,
        "；".join(missing_dark),
    )
    check("深色模式定义里没有浅色独有变量的拼写错误", not (set(dark) - set(light)),
          "；".join(sorted(set(dark) - set(light))))

    print("\n四、文字对比度（WCAG AA：正文 ≥ 4.5:1，大字/图形 ≥ 3:1）")

    # (名称, 前景变量, 背景变量, 最低要求)
    pairs = [
        ("标题 在卡片上", "--color-text", "--color-surface", 4.5),
        ("正文 在卡片上", "--color-text-soft", "--color-surface", 4.5),
        ("次要信息 在卡片上", "--color-muted", "--color-surface", 4.5),
        ("辅助信息 在卡片上", "--color-muted-soft", "--color-surface", 4.5),
        ("标题 在页面底色上", "--color-text", "--color-bg", 4.5),
        ("次要信息 在页面底色上", "--color-muted", "--color-bg", 4.5),
        ("正文 在次级底色上", "--color-text-soft", "--color-surface-alt", 4.5),
        ("主按钮文字", "--color-on-accent", "--color-accent", 4.5),
        ("紧急徽章文字", "--color-on-accent", "--color-danger", 4.5),
        ("警告徽章文字", "--color-warn", "--color-warn-soft", 4.5),
        ("危险徽章文字", "--color-danger", "--color-danger-soft", 4.5),
        ("成功徽章文字", "--color-success", "--color-success-soft", 4.5),
        ("强调色文字 在卡片上", "--color-accent", "--color-surface", 4.5),
    ]

    for mode_name, values in (("浅色", light), ("深色", dark)):
        print(f"  ——— {mode_name}模式 ———")
        for label, front_var, back_var, minimum in pairs:
            front = values.get(front_var)
            back = values.get(back_var)
            if not front or not back:
                check(f"{label}（{front_var} on {back_var}）", False, "变量不存在")
                continue
            ratio = contrast_ratio(front, back)
            if ratio is None:
                check(f"{label}", False, f"无法解析颜色：{front} / {back}")
                continue
            check(
                f"{label}  {ratio:.2f}:1（要求 ≥ {minimum}）",
                ratio >= minimum,
                f"{front} on {back} 只有 {ratio:.2f}:1",
            )

    print("\n五、字号阶梯要递增（改主题时手滑写反会很难看）")
    sizes = {name: int(value.replace("px", "")) for name, value in light.items()
             if re.fullmatch(r"--text-[\w-]+", name) and value.endswith("px")}
    ordered = [sizes.get(f"--text-{key}") for key in ("xs", "sm", "base", "lg", "xl", "2xl")]
    check(
        "xs < sm < base < lg < xl < 2xl",
        all(a is not None and b is not None and a < b for a, b in zip(ordered, ordered[1:])),
        str(ordered),
    )
    check("正文不小于 15px（手机上好读）", (sizes.get("--text-base") or 0) >= 15, str(sizes.get("--text-base")))
    check("触控目标不小于 44px", (light.get("--control-height") or "").startswith("44"),
          str(light.get("--control-height")))

    print("\n" + "=" * 52)
    print(f"通过 {passed} 项，失败 {failed} 项")
    print("=" * 52)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
