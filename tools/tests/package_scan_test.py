"""tools/package-web.py 里"机密 key 检测"的测试。

这个检查第一版写成"文中出现 service_role 就报警"，结果被 config.js 里的
**注释**误伤，白白拦住部署。所以这里两个方向都要测：
  不能误报（注释里提名字是正常的）
  不能漏报（真的填入机密 key 必须拦住）

运行：python tools/tests/package_scan_test.py
"""

from __future__ import annotations

import base64
import importlib.util
import json
import os
import sys

BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, BASE_DIR)

# 工具文件名带连字符（方便当命令输入），所以按路径加载而不是 import 名字
_spec = importlib.util.spec_from_file_location(
    "package_web", os.path.join(BASE_DIR, "tools", "package-web.py")
)
if _spec is None or _spec.loader is None:  # pragma: no cover
    raise SystemExit("找不到 tools/package-web.py")
_package_web = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_package_web)

jwt_role = _package_web.jwt_role
read_config_values = _package_web.read_config_values
scan_text = _package_web.scan_text

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


def make_jwt(payload: dict) -> str:
    header = base64.urlsafe_b64encode(json.dumps({"alg": "HS256", "typ": "JWT"}).encode()).decode().rstrip("=")
    body = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
    return f"{header}.{body}.fakesignature"


def main() -> int:
    print("\n一、不能误报（注释里提到这些名字是正常的）")

    comment_only = """
    /**
     * ✘ 绝对不要在这里填下面这两种：
     *     sb_secret_...                 —— 新版机密 key
     *     eyJ...（角色是 service_role） —— 旧版 service_role key
     */
    anonKey: 'sb_publishable_7_R6JURyS8QGOOK1CHwPFw_6MMPUcnE',
    """
    problems, _ = scan_text(comment_only, "config.js")
    check("注释里的 sb_secret_... 不算问题", problems == [], str(problems))
    check("注释里的 service_role 字样不算问题", not any("service_role" in p for p in problems), str(problems))
    check("填了可发布 key 时不报警", problems == [], str(problems))

    problems, _ = scan_text("// 说明文字：服务端才会用到 service_role\nconst x = 1;", "app.js")
    check("普通代码注释提到 service_role 不算问题", problems == [], str(problems))

    print("\n二、不能漏报（真的填了机密 key 必须拦住）")

    problems, _ = scan_text("anonKey: 'sb_secret_abcdefghijklmnop',", "config.js")
    check("抓到新版机密 key", len(problems) == 1, str(problems))

    problems, _ = scan_text(f"anonKey: '{make_jwt({'role': 'service_role'})}',", "config.js")
    check("抓到 service_role 的 JWT", len(problems) == 1 and "service_role" in problems[0], str(problems))

    problems, _ = scan_text(f"const key = '{make_jwt({'role': 'service_role'})}';", "somewhere.js")
    check("其它文件里的 service_role JWT 也抓得到", len(problems) == 1, str(problems))

    problems, warnings = scan_text(f"anonKey: '{make_jwt({'role': 'anon'})}',", "config.js")
    check("旧版 anon key 不报警", problems == [], str(problems))

    print("\n三、config.js 取值解析（只看赋值，不看注释）")

    url, key = read_config_values(comment_only)
    check("解析出 url", url == "", f"实际 {url!r}")
    check("解析出 anonKey", key.startswith("sb_publishable_"), f"实际 {key!r}")

    url2, key2 = read_config_values(
        "    url: 'https://demo.supabase.co',\n    anonKey: 'sb_publishable_xyz',"
    )
    check("带缩进的赋值也能解析", url2 == "https://demo.supabase.co" and key2 == "sb_publishable_xyz", f"{url2} / {key2}")

    print("\n四、JWT 解析")

    check("解析 role=anon", jwt_role(make_jwt({"role": "anon"})) == "anon")
    check("解析 role=service_role", jwt_role(make_jwt({"role": "service_role"})) == "service_role")
    check("乱码返回空字符串", jwt_role("not-a-jwt") == "")
    check("空字符串不崩", jwt_role("") == "")

    print("\n" + "=" * 46)
    print(f"通过 {passed} 项，失败 {failed} 项")
    print("=" * 46)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
