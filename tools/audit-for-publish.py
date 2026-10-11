"""公开源码前的体检。

用途：把仓库改成 Public（或打包发给同学）之前跑一遍，
      确认没有把密钥、口令、个人信息带出去。

为什么需要：
    这台仓库是要给同学看的，而"公开"是不可逆的 —— 一旦公开，
    历史里的任何东西都可能已经被别人 clone 走了。
    所以宁可多检查一遍。

检查四类东西：
    1. 机密 key（service_role / sb_secret_ / JWT 私钥）
    2. 本机专用文件是否被 git 跟踪（本地口令、黑名单、数据库、备份）
    3. 个人信息（真实邮箱、手机号、身份证号样式）
    4. 会公开、但"本来就已经公开"的东西（线上站点的接口地址等）—— 只提示，不算问题

用法：
    python tools/audit-for-publish.py
退出码 0 = 可以公开；1 = 有问题，先处理。
"""

from __future__ import annotations

import os
import re
import subprocess
import sys

# 中文 Windows 控制台默认 GBK，打印符号会崩，所以强制 UTF-8
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, OSError):
    pass

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ---- 绝不能出现在公开仓库里的东西 ----
#
# 这里刻意按"真实机密的**结构特征**"来判断，而不是按关键词 ——
# 否则测试文件里那些故意放的假 key 会一直误报，让人麻木。
# 例如真实的 sb_secret_ key 是 40 位左右的随机串；
# 而测试用的 `sb_secret_verysecretvalue` 又短又像单词，一眼就是假的。
SECRET_PATTERNS = [
    ("私钥文件内容", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("GitHub 令牌", re.compile(r"gh[pousr]_[A-Za-z0-9]{30,}")),
    ("Stripe 样式密钥", re.compile(r"sk_(?:live|test)_[A-Za-z0-9]{20,}")),
]

# 新版机密 key：前缀 + 足够长且足够随机的后缀
SB_SECRET = re.compile(r"sb_secret_[A-Za-z0-9_\-]{10,}")
# 旧版 JWT：必须真的长得像 JWT（三段、够长），而不是只出现 service_role 这个词
JWT_LIKE = re.compile(r"eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{10,}")


def is_real_sb_secret(token: str) -> bool:
    """真 sb_secret_ key 是长且随机的；短词形、或整段字母表顺序的都是测试假串。"""
    body = token[len("sb_secret_") :]
    if len(body) < 30:
        return False
    lowered = body.lower()
    # 明显的顺序串（测试里最爱这么写）
    if "abcdefghijklmnop" in lowered or "0123456789" in body or "abcdefgh" in lowered:
        return False
    kinds = sum(
        [
            any(char.islower() for char in body),
            any(char.isupper() for char in body),
            any(char.isdigit() for char in body),
        ]
    )
    return kinds >= 2 and len(set(body)) >= 12


def jwt_role(token: str) -> str:
    """从 JWT 中间那段解出 role（解不出就返回空串）。"""
    import base64
    import json as jsonlib

    try:
        payload = token.split(".")[1]
        padding = "=" * (-len(payload) % 4)
        data = jsonlib.loads(base64.urlsafe_b64decode(payload + padding).decode("utf-8"))
        return str(data.get("role", ""))
    except Exception:  # noqa: BLE001
        return ""

# 个人信息样式（会逐个列出，让你自己判断）
# 注意排除各种"示例/测试"域名：本项目的示例邮箱都用 *.local / *.test / example.*
PRIVACY_PATTERNS = [
    ("手机号", re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)")),
    ("身份证号样式", re.compile(r"(?<!\d)\d{17}[\dXx](?!\d)")),
    (
        "真实邮箱（非示例）",
        re.compile(
            r"[\w.+-]+@(?![\w-]*\.(?:local|test|invalid)\b)(?!example\.)[\w-]+\.[a-z]{2,}",
            re.IGNORECASE,
        ),
    ),
]


def looks_like_placeholder(token: str) -> bool:
    """测试用的假 key 有明显规律；真 key 是随机串。

    为什么要这个：`tools/tests/` 里**必须**放假的 key 才能测出扫描器有效，
    所以直接报"发现机密 key"会造成误报，反而让人麻木。
    这里把明显是假货的挑出来单独列，让你扫一眼确认 —— 而不是无声地忽略。
    """
    lowered = token.lower()
    for run in ("abcdefgh", "abcdef", "01234567", "12345678", "abcdabcd", "xxxx", "yyyy", "testtest", "placeholder"):
        if run in lowered:
            return True
    # 连续 5 个递增字母（abcd…）
    for index in range(len(lowered) - 4):
        window = lowered[index : index + 5]
        if window.isalpha() and all(
            ord(window[step + 1]) - ord(window[step]) == 1 for step in range(4)
        ):
            return True
    return False

# 这些文件属于"本机专用"，必须被 git 忽略、且不被跟踪
LOCAL_ONLY_FILES = [
    "local_config.json",
    os.path.join("server", "class_bulletin.db"),
    os.path.join("server", "ip_blacklist.json"),
    "supabase_service_key.txt",
]

TEXT_EXTENSIONS = {".md", ".js", ".mjs", ".py", ".json", ".html", ".css", ".bat", ".txt", ".sql", ".ts", ".svg", ".yml", ".yaml"}
SKIP_DIRS = {"__pycache__", ".git", "node_modules", ".venv"}
# 本文件自己含有检测用的正则字面量，会自己命中自己，跳过
SKIP_FILES = {os.path.join("tools", "audit-for-publish.py")}

problems: list[str] = []
notes: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"  [{'通过' if ok else '问题'}] {name}" + (f" —— {detail}" if detail else ""))
    if not ok:
        problems.append(f"{name}{(' —— ' + detail) if detail else ''}")


def git_tracked_files() -> list[str] | None:
    try:
        result = subprocess.run(
            ["git", "ls-files"],
            cwd=BASE_DIR,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=True,
        )
        return [line for line in result.stdout.splitlines() if line.strip()]
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


def iter_text_files():
    for root, dirs, files in os.walk(BASE_DIR):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for name in files:
            path = os.path.join(root, name)
            if os.path.relpath(path, BASE_DIR) in SKIP_FILES:
                continue
            if os.path.splitext(name)[1].lower() in TEXT_EXTENSIONS:
                yield path


def git(*args: str) -> str | None:
    """跑一条 git 命令，返回 stdout；失败返回 None。"""
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=BASE_DIR,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=True,
        )
        return result.stdout
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


def deep_scan() -> None:
    """深度扫描：只看当前文件是不够的，历史里的东西一样会被公开。"""
    print("\n五、深度扫描（git 历史 / 提交身份 / 路径泄露 / 远程地址）")

    # --- 5.1 提交历史里出现过的内容 ---
    patches = git("log", "--all", "-p", "--no-color", "--unified=0")
    if patches is None:
        check("能读取提交历史", False, "git log 失败")
        return
    check("能读取提交历史", True, f"补丁文本 {len(patches)} 字符")

    history_hits: list[str] = []
    for label, pattern in SECRET_PATTERNS:
        for _match in pattern.finditer(patches):
            history_hits.append(label)
    for match in SB_SECRET.finditer(patches):
        if is_real_sb_secret(match.group(0)):
            history_hits.append("真实的 sb_secret_ key")
    for match in JWT_LIKE.finditer(patches):
        if jwt_role(match.group(0)) == "service_role":
            history_hits.append("真正的 service_role JWT")
    check("提交历史里没有机密", not history_hits, "；".join(sorted(set(history_hits))[:5]))

    # --- 5.2 提交者身份（会不会把你的真名/真邮箱写进公开历史）---
    print("\n    · 提交历史里的作者身份：")
    authors = git("log", "--all", "--format=%an <%ae>")
    if authors:
        people = sorted({line.strip() for line in authors.splitlines() if line.strip()})
        for person in people:
            print(f"        {person}")
        suspicious = [p for p in people if "class-bulletin@local" not in p]
        if suspicious:
            notes.append("提交者身份非占位：" + "；".join(suspicious))
            print("      ⚠️ 上面有**非占位身份**。如果那是你的真名/真邮箱，公开后会出现在")
            print("         每一条提交记录里。介意的话见 SECURITY.md 的「改提交身份」。")
        else:
            print("      ✅ 全部是占位身份（class-bulletin@local），没有真名真邮箱")

    # --- 5.3 远程地址里有没有嵌令牌 ---
    print("\n    · 远程仓库地址：")
    remotes = git("remote", "-v") or ""
    for line in remotes.splitlines():
        if line.strip():
            print(f"        {line.strip()}")
    token_in_remote = re.search(r"https://[^\s/]+:[^\s@]+@", remotes)
    check(
        "远程地址里没有内嵌账号/令牌",
        not token_in_remote,
        f"形如 {token_in_remote.group(0)}" if token_in_remote else "",
    )

    # --- 5.4 绝对路径 / 用户名泄露 ---
    print("\n    · 含 Windows 绝对路径的文件（会暴露电脑用户名）：")
    path_hits: list[str] = []
    for path in iter_text_files():
        try:
            with open(path, "r", encoding="utf-8") as handle:
                text = handle.read()
        except (UnicodeDecodeError, OSError):
            continue
        for match in re.finditer(r"[A-Za-z]:\\Users\\[^\\\s\"']+", text):
            path_hits.append(f"{os.path.relpath(path, BASE_DIR)} → {match.group(0)}")
    if path_hits:
        for item in sorted(set(path_hits))[:8]:
            print(f"        · {item}")
        notes.append(f"{len(path_hits)} 处绝对路径含电脑用户名")
    else:
        print("        （无）✅")

    # --- 5.5 内网 IP ---
    print("\n    · 内网 IP（示例地址，一般无妨）：")
    lan_hits: set[str] = set()
    for path in iter_text_files():
        try:
            with open(path, "r", encoding="utf-8") as handle:
                text = handle.read()
        except (UnicodeDecodeError, OSError):
            continue
        for match in re.finditer(
            r"(?<!\d)(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3})(?!\d)", text
        ):
            lan_hits.add(f"{os.path.relpath(path, BASE_DIR)} → {match.group(0)}")
    if lan_hits:
        for item in sorted(lan_hits)[:5]:
            print(f"        · {item}")
    else:
        print("        （无）✅")


def main() -> int:
    print("=" * 62)
    print("  公开源码前体检")
    print("=" * 62)

    print("\n一、git 是否忽略了本机专用文件")
    tracked = git_tracked_files()
    if tracked is None:
        check("能读取 git 状态", False, "这个目录还不是 git 仓库，或没装 git")
    else:
        check("能读取 git 状态", True, f"共跟踪 {len(tracked)} 个文件")
        tracked_set = {path.replace("/", os.sep) for path in tracked}
        for relative in LOCAL_ONLY_FILES:
            in_repo = relative in tracked_set
            check(f"{relative} 没有被提交", not in_repo, "❌ 它已经在仓库里了！" if in_repo else "已被忽略")

    print("\n二、文件内容里有没有机密")
    secret_hits: list[str] = []
    placeholder_hits: list[str] = []
    for path in iter_text_files():
        try:
            with open(path, "r", encoding="utf-8") as handle:
                text = handle.read()
        except (UnicodeDecodeError, OSError):
            continue
        where = os.path.relpath(path, BASE_DIR)

        for label, pattern in SECRET_PATTERNS:
            for _match in pattern.finditer(text):
                secret_hits.append(f"{where} → {label}")

        # 新版机密 key：短的都是测试假串（真 key 有 40 位左右随机后缀）
        for match in SB_SECRET.finditer(text):
            token = match.group(0)
            if is_real_sb_secret(token):
                secret_hits.append(f"{where} → 真实的 sb_secret_ 机密 key")
            else:
                placeholder_hits.append(f"{where} → sb_secret_（长度{len(token)}，像假串）")

        # 旧版 JWT：只有解出来 role=service_role 才算真问题
        for match in JWT_LIKE.finditer(text):
            role = jwt_role(match.group(0))
            if role == "service_role":
                secret_hits.append(f"{where} → 真正的 service_role JWT")
            else:
                placeholder_hits.append(f"{where} → JWT（role={role or '未知'}，不是 service_role）")

    check("没有机密 key / 私钥", not secret_hits, "；".join(secret_hits[:5]))
    if placeholder_hits:
        print(f"    另有 {len(placeholder_hits)} 处命中，但特征上**是测试用的假串**（请扫一眼确认）：")
        seen: set[str] = set()
        for item in placeholder_hits:
            if item not in seen:
                seen.add(item)
                print(f"      · {item}")
        print("    这些是为了测试「密钥扫描器本身有效」而故意放的假 key —— 不是真机密。")

    print("\n三、有没有个人信息（需要你亲自判断）")
    privacy_hits: list[tuple[str, str]] = []
    for path in iter_text_files():
        try:
            with open(path, "r", encoding="utf-8") as handle:
                text = handle.read()
        except (UnicodeDecodeError, OSError):
            continue
        for label, pattern in PRIVACY_PATTERNS:
            for match in pattern.finditer(text):
                privacy_hits.append((os.path.relpath(path, BASE_DIR), f"{label}：{match.group(0)}"))
    if privacy_hits:
        # 占位示例（admin@class.local）已经被上面的正则排除了，剩下的都值得看一眼
        for where, what in privacy_hits[:10]:
            notes.append(f"{where} → {what}")
        print(f"    发现 {len(privacy_hits)} 处，逐一列出：")
        for where, what in privacy_hits[:10]:
            print(f"      · {where}  {what}")
        if len(privacy_hits) > 10:
            print(f"      …… 还有 {len(privacy_hits) - 10} 处")
        print("    这些**不一定是问题**，但公开前请自己确认一遍。")
    else:
        print("    没有发现疑似个人信息 ✅")

    print("\n四、会公开、但本来就已经公开的信息（只提示）")
    for path in iter_text_files():
        try:
            with open(path, "r", encoding="utf-8") as handle:
                text = handle.read()
        except (UnicodeDecodeError, OSError):
            continue
        if re.search(r"https://[a-z0-9]+\.supabase\.co", text):
            notes.append(f"{os.path.relpath(path, BASE_DIR)} 含 Supabase 项目地址")
    print("    · 线上站点的接口地址、publishable key、Turnstile Site Key")
    print("      —— 这些**本来就能从公开网页上看到**（任何人在浏览器里")
    print("         打开 /js/config.js 就能读到），所以放进仓库不增加风险。")
    print("    · 它们的设计用途就是公开；真正的门是服务端验证码 + 管理员口令。")

    deep_scan()

    print("\n" + "=" * 62)
    if problems:
        print(f"  结论：有 {len(problems)} 个问题，**先别公开**")
        for item in problems:
            print(f"    · {item}")
        print("=" * 62)
        return 1

    print("  结论：可以公开 ✅（上面第三节请自己再确认一眼）")
    print("=" * 62)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
