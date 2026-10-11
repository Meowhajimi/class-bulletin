"""本地服务器安全防护的测试（server/security.py）。

为什么要测这些：
    锁定策略是一堆数字（10 次、30 分钟整数倍、30 次永久、风险分阈值），
    写错一个边界就会出现两种糟糕情况：
      · 太松：等于没防护
      · 太紧：你自己手滑输错几次就被永久封禁，还得手动改文件救回来
    所以每个边界都要有测试钉住。时间是可注入的，测试里不用真的等 30 分钟。

运行：python tools/tests/security_test.py
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile

BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

_spec = importlib.util.spec_from_file_location(
    "server_security", os.path.join(BASE_DIR, "server", "security.py")
)
_security = importlib.util.module_from_spec(_spec)
# 必须先登记到 sys.modules：dataclasses 会按 cls.__module__ 反查模块，
# 不在 sys.modules 里就会报 "'NoneType' object has no attribute '__dict__'"
sys.modules["server_security"] = _security
_spec.loader.exec_module(_security)

SecurityGuard = _security.SecurityGuard
Policy = _security.Policy

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


class Clock:
    """可手动推进的假时钟。"""

    def __init__(self, start: float = 1_700_000_000.0) -> None:
        self.value = start

    def __call__(self) -> float:
        return self.value

    def advance(self, seconds: float) -> None:
        self.value += seconds

    def advance_minutes(self, minutes: float) -> None:
        self.advance(minutes * 60)


def main() -> int:
    clock = Clock()

    print("\n一、常量时间比较（防止按响应时间猜密码）")
    check("相同的字符串判为相等", _security.constant_time_equals("abc123", "abc123"))
    check("不同的字符串判为不等", not _security.constant_time_equals("abc123", "abc124"))
    check("长度不同也不报错", not _security.constant_time_equals("abc", "abcdef"))
    check(
        "含中文也不会抛异常（compare_digest 对非 ASCII 会报错，所以要先编码）",
        _security.constant_time_equals("口令", "口令")
        and not _security.constant_time_equals("口令", "密码"),
    )

    print("\n二、锁定策略：10 次起步，30 分钟的整数倍递增")

    guard = SecurityGuard(policy=Policy(), now=clock)
    ip = "10.0.0.9"

    check("一开始放行", guard.check(ip).allowed)

    # 前 9 次失败：不锁，只提示还剩几次
    for index in range(1, 10):
        decision = guard.record_login_failure(ip)
        if not decision.allowed:
            check(f"第 {index} 次失败不该锁定", False, decision.reason)
            break
    else:
        check("前 9 次失败都不锁定", True)

    check("第 9 次后还剩 1 次机会", guard.check(ip).remaining_attempts == 1)

    # 第 10 次失败：锁定 30 分钟
    decision = guard.record_login_failure(ip)
    check("第 10 次失败会锁定", not decision.allowed, decision.reason)
    check("锁定时长是 30 分钟", decision.retry_after_seconds == 30 * 60, str(decision.retry_after_seconds))
    check("锁定期间 check 也不放行", not guard.check(ip).allowed)
    check(
        "锁定原因里写明了倍数（便于自己看懂）",
        "30 分钟" in decision.reason and "1 倍" in decision.reason,
        decision.reason,
    )

    # 等 30 分钟：自动解锁
    clock.advance_minutes(30)
    check("满 30 分钟后自动解锁", guard.check(ip).allowed)

    # 再失败到 20 次：这次锁 60 分钟
    for _ in range(10):
        decision = guard.record_login_failure(ip)
    check("第 20 次失败锁定 60 分钟（2 倍）", decision.retry_after_seconds == 60 * 60, decision.reason)
    clock.advance_minutes(60)
    check("满 60 分钟后自动解锁", guard.check(ip).allowed)

    # 再失败到 30 次：锁 90 分钟（3 倍）
    for _ in range(10):
        decision = guard.record_login_failure(ip)
    check("第 30 次失败锁定 90 分钟（3 倍）", decision.retry_after_seconds == 90 * 60, decision.reason)
    clock.advance_minutes(90)
    check("满 90 分钟后仍可解锁（还没到永久封禁）", guard.check(ip).allowed)

    # 第 31 次：永久封禁
    decision = guard.record_login_failure(ip)
    check("第 31 次失败 → 永久封禁", decision.permanent and not decision.allowed, decision.reason)
    clock.advance_minutes(60 * 24 * 365)
    check("永久封禁过一年也不会自动解开", not guard.check(ip).allowed)
    check("永久封禁时 retry_after 为 0（等多久都没用）", guard.check(ip).retry_after_seconds == 0)

    print("\n三、登录成功会清空失败计数（但不清风控分）")
    guard2 = SecurityGuard(policy=Policy(), now=clock)
    for _ in range(5):
        guard2.record_login_failure("10.0.0.10")
    guard2.record_login_success("10.0.0.10")
    check(
        "成功一次后，失败计数归零（不会攒着下次一起算）",
        guard2.check("10.0.0.10").remaining_attempts == 10,
        str(guard2.check("10.0.0.10").remaining_attempts),
    )

    print("\n四、风控：识别攻击特征")
    cases = [
        ("路径穿越 ../../etc/passwd", "GET", "/../../etc/passwd", "", b"", "traversal"),
        ("编码过的路径穿越 %2e%2e%2f", "GET", "/%2e%2e%2f%2e%2e%2fetc", "", b"", "traversal"),
        ("想读 /etc/passwd", "GET", "/rest/v1/../../etc/passwd", "", b"", "traversal"),
        ("SQL 注入 union select", "GET", "/rest/v1/messages", "select=union+select+1", b"", "injection"),
        ("SQL 注入 or 1=1", "POST", "/rest/v1/messages", "", b'{"title":"\' or 1=1 --"}', "injection"),
        ("命令拼接 ; rm -rf", "POST", "/rest/v1/messages", "", b'{"title":"; rm -rf /"}', "injection"),
        ("XSS 试探 <script>", "POST", "/rest/v1/messages", "", b'{"body":"<script>alert(1)</script>"}', "injection"),
        ("探测 .env", "GET", "/.env", "", b"", "sensitive_path"),
        ("探测 .git 配置", "GET", "/.git/config", "", b"", "sensitive_path"),
        ("探测 /wp-admin", "GET", "/wp-admin/", "", b"", "sensitive_path"),
        ("探测 phpmyadmin", "GET", "/phpmyadmin/index.php", "", b"", "sensitive_path"),
        ("空字节 %00", "GET", "/index.html%00.png", "", b"", "bad_encoding"),
    ]
    for label, method, path, query, body, expected in cases:
        findings = _security.inspect_request(method, path, query, body)
        kinds = {kind for kind, _ in findings}
        check(f"能识别：{label}", expected in kinds, f"实际 {sorted(kinds)}")

    print("\n五、正常请求不能误报（否则自己用都会被封）")
    normal = [
        ("首页", "GET", "/", "", b""),
        ("读公告列表", "GET", "/rest/v1/messages", "select=*&order=published_at.desc", b""),
        ("搜索关键词", "GET", "/rest/v1/messages", "title=ilike.*作业*", b""),
        ("登录", "POST", "/auth/v1/token", "grant_type=password", b'{"email":"a@b.c","password":"x"}'),
        ("发布公告（正文里有英文和符号）", "POST", "/rest/v1/messages", "",
         '{"title":"Homework 1 & 2","body":"注意：<不重要> 与 A/B 测试"}'.encode("utf-8")),
        ("带日期的筛选", "GET", "/rest/v1/messages", "published_at=gte.2026-05-01", b""),
        ("在线人数心跳", "POST", "/rest/v1/rpc/presence_heartbeat", "", b'{"p_session":"abc12345"}'),
        ("详情页", "GET", "/message.html", "id=0f8f-adf9", b""),
    ]
    for label, method, path, query, body in normal:
        findings = _security.inspect_request(method, path, query, body)
        check(f"不误报：{label}", not findings, f"误报为 {findings}")

    print("\n六、风险分累积到阈值 → 永久封禁")
    guard3 = SecurityGuard(policy=Policy(risk_limit=10), now=clock)
    attacker = "203.0.113.7"

    # sensitive_path 每次 +2 → 第 5 次达到 10
    allowed_count = 0
    for index in range(1, 6):
        decision = guard3.record_suspicion(attacker, "sensitive_path", f"第 {index} 次探测")
        if decision.allowed:
            allowed_count += 1
    check("前 4 次只记账不封禁", allowed_count == 4, str(allowed_count))
    check("第 5 次达到风险上限 → 永久封禁", not guard3.check(attacker).allowed)
    check("封禁原因写明是攻击行为", "攻击" in guard3.check(attacker).reason, guard3.check(attacker).reason)

    # 一次严重行为（traversal +4）只要 3 次就到 12
    guard4 = SecurityGuard(policy=Policy(risk_limit=10), now=clock)
    decisions = [guard4.record_suspicion("198.51.100.2", "traversal", "穿越") for _ in range(3)]
    check(
        "路径穿越 3 次（每次 4 分）就封禁",
        not decisions[-1].allowed and decisions[-1].permanent,
        str([d.allowed for d in decisions]),
    )

    print("\n七、高频 404 / 401 会被识别为扫描")
    guard5 = SecurityGuard(policy=Policy(not_found_burst=5), now=clock)
    scanner = "198.51.100.9"
    triggered = None
    for _ in range(5):
        result = guard5.record_burst(scanner, "not_found_burst")
        if result is not None:
            triggered = result
    check("连续 5 次 404 触发一次风控记账", triggered is not None)
    check("触发后风险分被加上", guard5.snapshot()["records"][0]["risk"] > 0)

    # 时间窗口过去后重新计数
    guard6 = SecurityGuard(policy=Policy(not_found_burst=5), now=clock)
    other = "198.51.100.10"
    for _ in range(4):
        guard6.record_burst(other, "not_found_burst")
    clock.advance(120)  # 超过 60 秒窗口
    check("窗口过期后不会累积触发", guard6.record_burst(other, "not_found_burst") is None)

    print("\n八、手动封禁 / 解封（只有本机能做）")
    guard7 = SecurityGuard(policy=Policy(), now=clock)
    victim = "10.1.2.3"
    guard7.block(victim, "管理员手动封禁", permanent=True)
    check("手动封禁后立刻拦截", not guard7.check(victim).allowed)
    check("手动解封后恢复", guard7.unblock(victim) and guard7.check(victim).allowed)
    check("解封同时清掉失败次数与风险分", guard7.check(victim).remaining_attempts == 10)

    # 临时封禁（按分钟）
    guard7.block("10.1.2.4", "临时封 10 分钟", permanent=False, minutes=10)
    check("临时封禁生效", not guard7.check("10.1.2.4").allowed)
    clock.advance_minutes(11)
    check("临时封禁到期自动解除", guard7.check("10.1.2.4").allowed)

    print("\n九、持久化：重启服务器后黑名单还在")
    with tempfile.TemporaryDirectory() as temp_dir:
        path = os.path.join(temp_dir, "ip_blacklist.json")
        first = SecurityGuard(path, policy=Policy(), now=clock)
        first.block("203.0.113.99", "探测 .env", permanent=True)
        for _ in range(3):
            first.record_login_failure("203.0.113.50")

        check("黑名单文件已写出", os.path.isfile(path))
        with open(path, "r", encoding="utf-8") as handle:
            saved = json.load(handle)
        check("文件内容是可读的 JSON（方便你手动编辑）", "records" in saved)

        # 模拟重启
        second = SecurityGuard(path, policy=Policy(), now=clock)
        check("重启后永久封禁仍然有效", not second.check("203.0.113.99").allowed)
        check("重启后失败次数被保留", second.check("203.0.113.50").remaining_attempts == 7)

        # 文件损坏也不能让服务器起不来
        with open(path, "w", encoding="utf-8") as handle:
            handle.write("{ 这不是合法 JSON")
        third = SecurityGuard(path, policy=Policy(), now=clock)
        check("黑名单文件损坏时不影响服务器启动（当作空名单）", third.check("203.0.113.99").allowed)

    print("\n十、管理页快照")
    guard8 = SecurityGuard(policy=Policy(), now=clock)
    guard8.block("203.0.113.1", "探测", permanent=True)
    for _ in range(12):
        guard8.record_login_failure("203.0.113.2")
    snap = guard8.snapshot()
    check("快照统计了永久封禁数", snap["banned"] == 1, str(snap["banned"]))
    check("快照统计了锁定中数量", snap["locked"] == 1, str(snap["locked"]))
    check("永久封禁排在最前面", snap["records"][0]["permanent"] is True)
    check("快照带上了当前策略阈值（页面上能显示）", snap["policy"]["fail_threshold"] == 10)
    check("锁定的记录带有剩余解锁秒数", snap["records"][1]["unlock_in_seconds"] > 0)

    print("\n" + "=" * 50)
    print(f"通过 {passed} 项，失败 {failed} 项")
    print("=" * 50)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
