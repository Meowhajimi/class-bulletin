"""本地服务器的安全防护：登录失败锁定、递增解锁、风控封禁、IP 黑名单。

为什么防护做在本地服务器上（而不是网页里）：
    网页是纯静态的，浏览器既看不到自己的公网 IP，也无法替你记住"别人的"
    失败次数 —— 清一下缓存、换个浏览器就绕过了。真正的拦截只能发生在
    **我们自己的服务器进程里**，也就是这个模块。它被 serve.py 使用。

策略（可在 config 里调）：
    · 同一 IP 登录失败满 10 次 → 锁定；锁定时长 = 30 分钟的整数倍
      （10~19 次 → 30 分钟，20~29 次 → 60 分钟，30 次 → 90 分钟）
    · 失败超过 30 次 → **永久封禁**，不再自动解锁
    · 风控：识别扫描探测、路径穿越、注入尝试、异常高频请求，
      累计风险分达到阈值 → **永久封禁**
    · 永久封禁只能由本机（127.0.0.1）在 /security 页面手动解除，
      或者手动编辑 server/ip_blacklist.json

时间来源可注入（now 参数），所以整套逻辑都能在测试里精确验证。
"""

from __future__ import annotations

import json
import os
import re
import secrets
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable


def constant_time_equals(a: str, b: str) -> bool:
    """常量时间的字符串比较。

    普通的 `a == b` 会在第一个不同的字符处立刻返回，理论上可以按响应时间
    一个字符一个字符地猜出密码。这个函数无论如何都比较完整个字符串。

    注意：`secrets.compare_digest` 对 str 只接受纯 ASCII，所以先编码成字节，
    这样密码/邮箱里出现中文也不会抛异常。
    """
    return secrets.compare_digest(str(a).encode("utf-8"), str(b).encode("utf-8"))

# ============================== 策略 ==============================


@dataclass
class Policy:
    """所有阈值集中在这里，方便按需调整。"""

    # 登录失败相关
    fail_threshold: int = 10  # 达到这个次数开始锁定
    base_lock_minutes: int = 30  # 锁定时长的基本单位（整数倍递增）
    hard_fail_limit: int = 30  # 超过这个次数 → 永久封禁

    # 风控相关
    risk_limit: int = 10  # 风险分达到这个值 → 永久封禁
    not_found_burst: int = 20  # 60 秒内 404 超过这个数 → 记为一次风险
    unauthorized_burst: int = 12  # 60 秒内 401 超过这个数 → 记为一次风险
    burst_window_seconds: int = 60

    # 事件日志保留条数（每个 IP）
    max_events: int = 30


# 各类可疑行为的风险分
RISK_WEIGHTS = {
    "traversal": 4,  # 路径穿越（想读服务器上的文件）
    "injection": 4,  # SQL / 命令注入尝试
    "sensitive_path": 2,  # 探测 .env / .git / wp-admin 之类
    "bad_encoding": 3,  # %00 空字节之类
    "oversized": 2,  # 超长 URL / 超大参数
    "not_found_burst": 3,  # 短时间内大量 404（扫描器行为）
    "unauthorized_burst": 3,  # 短时间内大量 401（撞密码行为）
    "bad_request": 1,  # 畸形请求
}


# ============================== 判定结果 ==============================


@dataclass
class Decision:
    """一次检查的结果：放行还是拦下。"""

    allowed: bool
    reason: str = ""
    permanent: bool = False
    locked_until: float | None = None
    retry_after_seconds: int = 0
    remaining_attempts: int | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "allowed": self.allowed,
            "reason": self.reason,
            "permanent": self.permanent,
            "retry_after_seconds": self.retry_after_seconds,
            "remaining_attempts": self.remaining_attempts,
        }


ALLOW = Decision(allowed=True)


# ============================== 可疑请求识别 ==============================

# 注意：这些是"明显的攻击特征"，不是完整的攻击检测。
# 目的是挡住扫描器和脚本小子，不是挡住定向攻击者。

_TRAVERSAL_PATTERNS = (
    re.compile(r"\.\.[/\\]"),  # ../ 或 ..\
    re.compile(r"%2e%2e[%/\\]", re.IGNORECASE),  # 编码过的 ../
    re.compile(r"/(etc/passwd|etc/shadow|proc/self)", re.IGNORECASE),
    re.compile(r"[a-zA-Z]:\\[a-zA-Z]", re.IGNORECASE),  # C:\... 形式的绝对路径
)

_INJECTION_PATTERNS = (
    re.compile(r"\bunion\b.{0,20}\bselect\b", re.IGNORECASE),
    re.compile(r"\bor\b\s+['\"]?\d+['\"]?\s*=\s*['\"]?\d+", re.IGNORECASE),  # or 1=1
    re.compile(r"\bdrop\s+(table|database)\b", re.IGNORECASE),
    re.compile(r"\b(sleep|benchmark|pg_sleep)\s*\(", re.IGNORECASE),
    re.compile(r";\s*(rm|cat|curl|wget|nc)\s", re.IGNORECASE),
    re.compile(r"<script[\s>]", re.IGNORECASE),
    re.compile(r"\b(exec|eval)\s*\(", re.IGNORECASE),
)

_SENSITIVE_PATHS = (
    "/.env",
    "/.git",
    "/.ssh",
    "/wp-admin",
    "/wp-login",
    "/wp-content",
    "/xmlrpc.php",
    "/phpmyadmin",
    "/pma",
    "/admin.php",
    "/shell",
    "/backdoor",
    "/vendor/phpunit",
    "/composer.lock",
    "/.aws",
    "/.docker",
    "/server-status",
    "/actuator",
    "/config.json",
    "/backup",
    "/db.sql",
    "/dump.sql",
)


def inspect_request(
    method: str,
    path: str,
    query: str = "",
    body: bytes = b"",
    policy: Policy | None = None,
) -> list[tuple[str, str]]:
    """检查一个请求有没有明显的攻击特征。

    @returns [(风险类型, 说明)]，空列表表示没发现问题。
    """
    active = policy or Policy()
    findings: list[tuple[str, str]] = []
    target = f"{path}?{query}" if query else path

    # 1) URL 或 body 里有没有路径穿越 / 注入特征
    haystacks = [("URL", target)]
    if body:
        try:
            text = body.decode("utf-8", errors="replace")
        except Exception:  # pragma: no cover - decode 不会抛
            text = ""
        if text:
            haystacks.append(("请求体", text[:8192]))

    for where, text in haystacks:
        for pattern in _TRAVERSAL_PATTERNS:
            if pattern.search(text):
                findings.append(("traversal", f"{where}里出现路径穿越特征：{pattern.pattern}"))
                break
        for pattern in _INJECTION_PATTERNS:
            if pattern.search(text):
                findings.append(("injection", f"{where}里出现注入特征：{pattern.pattern}"))
                break

    # 2) 探测敏感文件
    lowered = path.lower()
    for candidate in _SENSITIVE_PATHS:
        if lowered.startswith(candidate) or lowered.endswith(candidate):
            findings.append(("sensitive_path", f"探测敏感路径 {path}"))
            break

    # 3) 空字节等异常编码
    if "%00" in target.lower() or "\x00" in path:
        findings.append(("bad_encoding", "URL 里含空字节"))

    # 4) 超长请求（扫描器/DoS 常见特征）
    if len(target) > 512:
        findings.append(("oversized", f"URL 过长（{len(target)} 字符）"))

    # 5) 不认识的 HTTP 方法
    if method.upper() not in {"GET", "HEAD", "POST", "PATCH", "DELETE", "OPTIONS", "PUT"}:
        findings.append(("bad_request", f"异常 HTTP 方法 {method}"))

    return findings


# ============================== 主体 ==============================


@dataclass
class IpRecord:
    """一个 IP 的当前状态。"""

    ip: str
    failures: int = 0
    risk: int = 0
    lock_until: float = 0.0
    permanent: bool = False
    reason: str = ""
    manual: bool = False
    first_seen: float = 0.0
    last_seen: float = 0.0
    events: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "ip": self.ip,
            "failures": self.failures,
            "risk": self.risk,
            "lock_until": self.lock_until or None,
            "permanent": self.permanent,
            "reason": self.reason,
            "manual": self.manual,
            "first_seen": self.first_seen or None,
            "last_seen": self.last_seen or None,
            "events": self.events[-10:],
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "IpRecord":
        return cls(
            ip=str(data.get("ip", "")),
            failures=int(data.get("failures") or 0),
            risk=int(data.get("risk") or 0),
            lock_until=float(data.get("lock_until") or 0.0),
            permanent=bool(data.get("permanent")),
            reason=str(data.get("reason") or ""),
            manual=bool(data.get("manual")),
            first_seen=float(data.get("first_seen") or 0.0),
            last_seen=float(data.get("last_seen") or 0.0),
            events=list(data.get("events") or []),
        )


class SecurityGuard:
    """按 IP 记状态、做判定。线程安全，可持久化到本地文件。"""

    def __init__(
        self,
        path: str | None = None,
        *,
        policy: Policy | None = None,
        now: Callable[[], float] = time.time,
    ) -> None:
        self.path = path
        self.policy = policy or Policy()
        self._now = now
        self._lock = threading.RLock()
        self._records: dict[str, IpRecord] = {}
        # 最近事件时间戳，用于识别"高频 404/401"
        self._bursts: dict[tuple[str, str], list[float]] = {}
        if path:
            self.load()

    # ---------- 时间 ----------

    def _clock(self) -> float:
        return float(self._now())

    # ---------- 持久化 ----------

    def load(self) -> None:
        if not self.path or not os.path.isfile(self.path):
            return
        try:
            with open(self.path, "r", encoding="utf-8") as handle:
                data = json.load(handle)
        except (OSError, ValueError):
            # 文件坏了也不能让服务器起不来：当作空名单，并保留坏文件供排查
            return
        with self._lock:
            for item in data.get("records", []):
                if isinstance(item, dict) and item.get("ip"):
                    record = IpRecord.from_dict(item)
                    self._records[record.ip] = record

    def save(self) -> None:
        """原子写：先写临时文件再替换，避免断电/中断留下半个文件。"""
        if not self.path:
            return
        with self._lock:
            data = {
                "updated_at": self._clock(),
                "records": [
                    record.to_dict()
                    for record in self._records.values()
                    if record.permanent or record.failures or record.risk or record.lock_until
                ],
            }
        directory = os.path.dirname(os.path.abspath(self.path))
        os.makedirs(directory, exist_ok=True)
        temp = f"{self.path}.tmp"
        with open(temp, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2, sort_keys=True)
        os.replace(temp, self.path)

    # ---------- 内部工具 ----------

    def _record(self, ip: str) -> IpRecord:
        record = self._records.get(ip)
        if record is None:
            now = self._clock()
            record = IpRecord(ip=ip, first_seen=now, last_seen=now)
            self._records[ip] = record
        record.last_seen = self._clock()
        return record

    def _log(self, record: IpRecord, kind: str, detail: str) -> None:
        record.events.append({"at": self._clock(), "kind": kind, "detail": detail[:200]})
        if len(record.events) > self.policy.max_events:
            del record.events[: -self.policy.max_events]

    def _permanent_ban(self, record: IpRecord, reason: str) -> Decision:
        record.permanent = True
        record.reason = reason
        record.lock_until = 0.0
        self._log(record, "permanent_ban", reason)
        self.save()
        return Decision(allowed=False, reason=reason, permanent=True)

    # ---------- 对外：检查是否放行 ----------

    def check(self, ip: str) -> Decision:
        """进任何受保护操作之前调用。"""
        with self._lock:
            record = self._records.get(ip)
            if record is None:
                return ALLOW

            if record.permanent:
                return Decision(
                    allowed=False,
                    reason=record.reason or "该 IP 已被永久封禁",
                    permanent=True,
                )

            now = self._clock()
            if record.lock_until and record.lock_until > now:
                remaining = int(record.lock_until - now)
                return Decision(
                    allowed=False,
                    reason=record.reason or "尝试过于频繁，暂时锁定中",
                    locked_until=record.lock_until,
                    retry_after_seconds=remaining,
                )

            # 锁定期已过：自动解锁，但失败次数保留（再犯会跳更长的时间）
            if record.lock_until and record.lock_until <= now:
                record.lock_until = 0.0
                record.reason = ""

            remaining_attempts = max(0, self.policy.fail_threshold - record.failures)
            return Decision(allowed=True, remaining_attempts=remaining_attempts)

    # ---------- 对外：登录结果 ----------

    def record_login_failure(self, ip: str) -> Decision:
        with self._lock:
            record = self._record(ip)
            record.failures += 1
            failures = record.failures
            self._log(record, "login_fail", f"登录失败第 {failures} 次")

            if failures > self.policy.hard_fail_limit:
                return self._permanent_ban(
                    record,
                    f"登录失败 {failures} 次，超过 {self.policy.hard_fail_limit} 次上限，已永久封禁",
                )

            if failures >= self.policy.fail_threshold:
                multiple = max(1, failures // self.policy.fail_threshold)
                minutes = self.policy.base_lock_minutes * multiple
                record.lock_until = self._clock() + minutes * 60
                record.reason = (
                    f"登录连续失败 {failures} 次，已锁定 {minutes} 分钟"
                    f"（{self.policy.base_lock_minutes} 分钟的 {multiple} 倍）"
                )
                self._log(record, "lock", record.reason)
                self.save()
                return Decision(
                    allowed=False,
                    reason=record.reason,
                    locked_until=record.lock_until,
                    retry_after_seconds=minutes * 60,
                )

            self.save()
            return Decision(
                allowed=True,
                remaining_attempts=self.policy.fail_threshold - failures,
                reason=(
                    f"密码不正确，还可以试 "
                    f"{self.policy.fail_threshold - failures} 次"
                ),
            )

    def record_login_success(self, ip: str) -> None:
        """登录成功：清掉失败计数，但**不清**风控分和永久封禁。"""
        with self._lock:
            record = self._records.get(ip)
            if record is None or record.permanent:
                return
            if record.failures:
                self._log(record, "login_ok", f"登录成功，清空此前 {record.failures} 次失败记录")
            record.failures = 0
            record.lock_until = 0.0
            record.reason = ""
            self.save()

    # ---------- 对外：风控 ----------

    def record_suspicion(self, ip: str, kind: str, detail: str = "") -> Decision:
        """记一次可疑行为；风险分够了就永久封禁。"""
        weight = RISK_WEIGHTS.get(kind, 1)
        with self._lock:
            record = self._record(ip)
            record.risk += weight
            self._log(record, kind, f"{detail}（+{weight} 分）")

            if record.permanent:
                return Decision(allowed=False, reason=record.reason, permanent=True)

            if record.risk >= self.policy.risk_limit:
                return self._permanent_ban(
                    record,
                    f"检测到攻击行为（{kind}），风险分 {record.risk} 达到上限，已永久封禁",
                )

            self.save()
            return Decision(
                allowed=True,
                reason=f"已记录可疑行为：{detail or kind}（风险分 {record.risk}/{self.policy.risk_limit}）",
            )

    def record_burst(self, ip: str, kind: str) -> Decision | None:
        """记录一次 404/401；若短时间内过多，按风控处理。"""
        window = self.policy.burst_window_seconds
        key = (ip, kind)
        now = self._clock()
        with self._lock:
            stamps = self._bursts.setdefault(key, [])
            stamps.append(now)
            # 只保留窗口内的
            while stamps and stamps[0] < now - window:
                stamps.pop(0)

            limit = (
                self.policy.not_found_burst
                if kind == "not_found_burst"
                else self.policy.unauthorized_burst
            )
            if len(stamps) >= limit:
                stamps.clear()
                return self.record_suspicion(
                    ip,
                    kind,
                    f"{window} 秒内出现 {limit} 次异常请求",
                )
            return None

    # ---------- 对外：手动管理 ----------

    def block(self, ip: str, reason: str, *, permanent: bool = True, minutes: int = 0) -> IpRecord:
        with self._lock:
            record = self._record(ip)
            record.manual = True
            if permanent:
                record.permanent = True
                record.reason = reason or "管理员手动封禁"
                record.lock_until = 0.0
            else:
                record.lock_until = self._clock() + max(1, minutes) * 60
                record.reason = reason or f"管理员手动锁定 {minutes} 分钟"
            self._log(record, "manual_block", record.reason)
            self.save()
            return record

    def unblock(self, ip: str) -> bool:
        """解除封禁：清掉永久标记、锁定、失败次数与风险分。"""
        with self._lock:
            record = self._records.get(ip)
            if record is None:
                return False
            record.permanent = False
            record.lock_until = 0.0
            record.failures = 0
            record.risk = 0
            record.reason = ""
            record.manual = False
            self._log(record, "manual_unblock", "管理员解除了封禁")
            self.save()
            return True

    def forget(self, ip: str) -> bool:
        with self._lock:
            existed = self._records.pop(ip, None) is not None
            if existed:
                self.save()
            return existed

    # ---------- 对外：给管理页看 ----------

    def snapshot(self) -> dict[str, Any]:
        now = self._clock()
        with self._lock:
            records = []
            for record in self._records.values():
                item = record.to_dict()
                item["locked"] = bool(
                    record.permanent or (record.lock_until and record.lock_until > now)
                )
                if not record.permanent and record.lock_until:
                    item["unlock_in_seconds"] = max(0, int(record.lock_until - now))
                else:
                    item["unlock_in_seconds"] = 0
                records.append(item)

            # 永久封禁的排最前，然后按风险分/失败次数
            records.sort(
                key=lambda item: (
                    not item["permanent"],
                    -(item["risk"] or 0),
                    -(item["failures"] or 0),
                )
            )
            return {
                "now": now,
                "policy": {
                    "fail_threshold": self.policy.fail_threshold,
                    "base_lock_minutes": self.policy.base_lock_minutes,
                    "hard_fail_limit": self.policy.hard_fail_limit,
                    "risk_limit": self.policy.risk_limit,
                },
                "total": len(records),
                "banned": sum(1 for item in records if item["permanent"]),
                "locked": sum(1 for item in records if item["locked"] and not item["permanent"]),
                "records": records,
            }
