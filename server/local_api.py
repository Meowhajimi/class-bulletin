"""用 SQLite 实现 Supabase 的 /auth/v1 与 /rest/v1 接口。

前端的 `web/js/data/supabase.js` 只认这两个路径和它们的语义，
所以同一份前端代码既能连真 Supabase，也能连这个本地服务器。
"""

from __future__ import annotations

import json
import secrets
import sqlite3
import threading
import time
from typing import Any

from . import db
from .security import SecurityGuard, constant_time_equals, inspect_request

# 本地服务器只有一个管理员账号，给它一个固定 UUID
ADMIN_USER_ID = "00000000-0000-0000-0000-000000000001"

MAX_BODY_BYTES = 1024 * 1024  # 1 MB，防止超大请求


class TokenStore:
    """内存里的登录态。服务器重启后需要重新登录，这对本地使用足够。"""

    def __init__(self, access_ttl: int, refresh_ttl: int) -> None:
        self.access_ttl = access_ttl
        self.refresh_ttl = refresh_ttl
        self._lock = threading.Lock()
        self._access: dict[str, tuple[str, float]] = {}
        self._refresh: dict[str, tuple[str, float]] = {}

    def issue(self, user_id: str) -> dict[str, Any]:
        access_token = secrets.token_urlsafe(32)
        refresh_token = secrets.token_urlsafe(32)
        with self._lock:
            self._access[access_token] = (user_id, time.time() + self.access_ttl)
            self._refresh[refresh_token] = (user_id, time.time() + self.refresh_ttl)
        return {
            "access_token": access_token,
            "refresh_token": refresh_token,
            "expires_in": self.access_ttl,
        }

    def resolve_access(self, token: str) -> str | None:
        with self._lock:
            entry = self._access.get(token)
            if not entry:
                return None
            user_id, expires_at = entry
            if expires_at < time.time():
                self._access.pop(token, None)
                return None
        return user_id

    def resolve_refresh(self, token: str) -> str | None:
        with self._lock:
            entry = self._refresh.get(token)
            if not entry:
                return None
            user_id, expires_at = entry
            if expires_at < time.time():
                self._refresh.pop(token, None)
                return None
        return user_id

    def revoke(self, token: str) -> None:
        with self._lock:
            self._access.pop(token, None)
            self._refresh.pop(token, None)


class LocalAPI:
    """Supabase 兼容接口。返回值统一是 (HTTP 状态码, JSON 负载或 None, 附加头)。"""

    ACCESS_TTL = 8 * 3600
    REFRESH_TTL = 30 * 86400

    def __init__(
        self,
        conn: sqlite3.Connection,
        admin_email: str,
        admin_password: str,
        guard: SecurityGuard | None = None,
    ) -> None:
        self.conn = conn
        self.admin_email = (admin_email or "").strip().lower()
        self.admin_password = admin_password or ""
        self.tokens = TokenStore(self.ACCESS_TTL, self.REFRESH_TTL)
        # 安全防护：登录失败锁定 + 风控。没传就自己建一个（测试里方便）
        self.guard = guard if guard is not None else SecurityGuard()

    # ---------- 路由 ----------

    @staticmethod
    def owns(path: str) -> bool:
        """这个路径是否由接口层负责（否则交给静态文件服务）。"""
        return path.startswith("/auth/v1") or path.startswith("/rest/v1")

    def handle(
        self,
        method: str,
        path: str,
        query: dict[str, list[str]],
        headers: dict[str, str],
        body: bytes,
        client_ip: str = "127.0.0.1",
    ) -> tuple[int, Any, dict[str, str]]:
        # ① 风控：先看这个 IP 是不是已经被封了，再看请求本身可不可疑
        blocked = self.screen_request(method, path, query, body, client_ip)
        if blocked is not None:
            return blocked

        try:
            if path.startswith("/auth/v1"):
                result = self._handle_auth(method, path, query, headers, body, client_ip)
            elif path.startswith("/rest/v1"):
                result = self._handle_rest(method, path, query, headers, body)
            else:
                result = self._error(404, "Not found", "404")
        except db.DuplicateError as exc:
            # 唯一约束冲突 → 409，与 PostgREST 对 Postgres 23505 的行为一致
            result = self._error(409, str(exc), "23505")
        except db.ValidationError as exc:
            result = self._error(400, str(exc), "400")
        except json.JSONDecodeError:
            result = self._error(400, "请求体不是合法的 JSON", "400")

        # ② 记一笔 401/404，用于识别扫描器和撞密码
        self.record_status(client_ip, result[0])
        return result

    # ---------- 安全防护 ----------

    # 只有登录接口才需要"连正确密码也不许进"；
    # 临时锁定不应该影响同学刷公告（否则一次手滑会让同学的手机看不了通知）
    LOGIN_PATH_MARKER = "/token"

    @classmethod
    def _is_login_request(cls, path: str) -> bool:
        return cls.LOGIN_PATH_MARKER in path

    def screen_request(
        self,
        method: str,
        path: str,
        query: dict[str, list[str]] | str,
        body: bytes,
        client_ip: str,
    ) -> tuple[int, Any, dict[str, str]] | None:
        """风控入口。返回 None 表示放行；否则返回要直接回给客户端的内容。

        serve.py 对**所有**请求都会调它（包括 /styleguide.html、/.env 这类静态路径）——
        扫描器最常打的就是静态路径，只在接口层拦是拦不住的。
        """
        decision = self.guard.check(client_ip)
        if not decision.allowed:
            # 永久封禁：整个站点都不给看
            # 临时锁定：只挡登录，同学照旧能看公告
            if decision.permanent or self._is_login_request(path):
                headers: dict[str, str] = {}
                if decision.retry_after_seconds:
                    # 标准做法：告诉对方多久以后再来
                    headers["Retry-After"] = str(decision.retry_after_seconds)
                return self._error(
                    403,
                    decision.reason,
                    "ip_blocked" if decision.permanent else "ip_locked",
                    extra=headers,
                )

        # 请求本身有没有明显攻击特征
        if isinstance(query, str):
            flat_query = query
        else:
            flat_query = "&".join(
                f"{key}={value}" for key, values in query.items() for value in values
            )
        findings = inspect_request(method, path, flat_query, body, self.guard.policy)
        if findings:
            banned = None
            for kind, detail in findings:
                result = self.guard.record_suspicion(client_ip, kind, detail)
                if not result.allowed:
                    banned = result
                    break
            if banned is not None:
                return self._error(403, banned.reason, "ip_blocked")

        return None

    def record_status(self, client_ip: str, status: int) -> None:
        """按响应码记一笔，用于识别扫描器（大量 404）与撞密码（大量 401）。"""
        if status == 404:
            self.guard.record_burst(client_ip, "not_found_burst")
        elif status == 401:
            self.guard.record_burst(client_ip, "unauthorized_burst")

    # ---------- /auth/v1 ----------

    def _handle_auth(
        self,
        method: str,
        path: str,
        query: dict[str, list[str]],
        headers: dict[str, str],
        body: bytes,
        client_ip: str = "127.0.0.1",
    ) -> tuple[int, Any, dict[str, str]]:
        if method != "POST":
            return self._error(405, "Only POST is supported", "405")

        if path.rstrip("/").endswith("/logout"):
            token = self._bearer(headers)
            if token:
                self.tokens.revoke(token)
            return 204, None, {}

        if not path.rstrip("/").endswith("/token"):
            return self._error(404, "Not found", "404")

        grant_type_value = query.get("grant_type", [""])[0]
        payload = self._json(body) or {}

        if grant_type_value == "password":
            email = str(payload.get("email", "")).strip().lower()
            password = str(payload.get("password", ""))

            # 常量时间比较：避免通过响应快慢一个字符一个字符地猜密码
            email_ok = constant_time_equals(email, self.admin_email)
            password_ok = constant_time_equals(password, self.admin_password)

            if email_ok and password_ok:
                self.guard.record_login_success(client_ip)
                return self._session_response(ADMIN_USER_ID, self.admin_email)

            # 失败要记账：满 10 次锁定（30 分钟的整数倍），超过 30 次永久封禁。
            # 锁定期间必须明确告诉对方"你被锁了" —— 否则本人会一直重试，
            # 把临时锁定刷成永久封禁。
            decision = self.guard.record_login_failure(client_ip)
            if not decision.allowed:
                return (
                    400,
                    {
                        "error": "invalid_grant",
                        "error_description": decision.reason,
                        "locked": True,
                        "permanent": decision.permanent,
                        "retry_after_seconds": decision.retry_after_seconds,
                    },
                    {},
                )

            # 未达阈值：结构与 Supabase 保持一致，只多一句还剩几次
            return 400, {
                "error": "invalid_grant",
                "error_description": decision.reason or "Invalid login credentials",
                "remaining_attempts": decision.remaining_attempts,
            }, {}

        if grant_type_value == "refresh_token":
            refresh_token = str(payload.get("refresh_token", ""))
            user_id = self.tokens.resolve_refresh(refresh_token)
            if not user_id:
                return self._error(401, "Invalid Refresh Token", "refresh_token_not_found")
            # 轮换：旧 refresh token 立刻失效，防止被重复使用
            self.tokens.revoke(refresh_token)
            return self._session_response(user_id, self.admin_email)

        return self._error(
            400, "Unsupported grant_type", "unsupported_grant_type"
        )

    def _session_response(self, user_id: str, email: str) -> tuple[int, Any, dict[str, str]]:
        issued = self.tokens.issue(user_id)
        payload = {
            "token_type": "bearer",
            "expires_at": int(time.time()) + issued["expires_in"],
            "user": {
                "id": user_id,
                "aud": "authenticated",
                "role": "authenticated",
                "email": email,
            },
            **issued,
        }
        return 200, payload, {}

    # ---------- /rest/v1 ----------

    def _handle_rest(
        self,
        method: str,
        path: str,
        query: dict[str, list[str]],
        headers: dict[str, str],
        body: bytes,
    ) -> tuple[int, Any, dict[str, str]]:
        # 在线人数用两个"函数"（和 Supabase 的 RPC 对应）
        if "/rpc/" in path:
            return self._handle_rpc(method, path, body)

        # 栏目：与真 Supabase 的 /rest/v1/sections 对应
        if path.rstrip("/").endswith("/sections"):
            return self._handle_sections(method, query, headers, body)

        # 目前只有 messages 一张表；加新表就在这里加一个分支
        if not path.rstrip("/").endswith("/messages"):
            return self._error(404, "Not found", "404")

        filters = self._filters(query)
        message_id = filters.get("id")

        if method == "GET":
            # 同学只读：和 Supabase 的公开读策略一致，无需登录
            if message_id:
                row = db.get_message(self.conn, message_id)
                return 200, ([row] if row else []), {}
            return 200, db.list_messages(self.conn), {}

        # 以下都是写操作：和 RLS 一样，必须带有效登录态
        user_id = self._user_id(headers)
        if not user_id:
            return self._error(
                401, "未登录或登录已过期，请重新登录", "401"
            )

        if method == "POST":
            payload = self._json(body) or {}
            created = db.create_message(self.conn, payload, user_id)
            return 201, [created], self._representation_headers(headers)

        if message_id is None:
            return self._error(400, "缺少 id 参数", "400")

        if method == "PATCH":
            payload = self._json(body) or {}
            updated = db.update_message(self.conn, message_id, payload)
            if updated is None:
                return self._error(404, "未找到该消息", "PGRST116")
            return 200, [updated], self._representation_headers(headers)

        if method == "DELETE":
            db.delete_message(self.conn, message_id)
            return 204, None, {}

        return self._error(405, "Method not allowed", "405")

    @staticmethod
    def _representation_headers(headers: dict[str, str]) -> dict[str, str]:
        # PostgREST 只在 Prefer: return=representation 时返回被写入的行；
        # 这里始终返回，前端拿到内容总比拿不到好。
        return {}

    # ---------- /rest/v1/sections（栏目） ----------

    def _handle_sections(
        self,
        method: str,
        query: dict[str, list[str]],
        headers: dict[str, str],
        body: bytes,
    ) -> tuple[int, Any, dict[str, str]]:
        """栏目：同学只读，写操作必须带有效登录态（与 Supabase 的 RLS 一致）。"""
        filters = self._filters(query)
        section_id = filters.get("id")

        if method == "GET":
            if section_id:
                row = db.get_section(self.conn, section_id)
                return 200, ([row] if row else []), {}
            return 200, db.list_sections(self.conn), {}

        # 以下都是写操作
        user_id = self._user_id(headers)
        if not user_id:
            return self._error(401, "未登录或登录已过期，请重新登录", "401")

        if method == "POST":
            payload = self._json(body) or {}
            created = db.create_section(self.conn, payload.get("name"))
            return 201, [created], self._representation_headers(headers)

        if section_id is None:
            return self._error(400, "缺少 id 参数", "400")

        if method == "PATCH":
            payload = self._json(body) or {}
            if "name" not in payload:
                return self._error(400, "没有要修改的字段", "400")
            updated = db.rename_section(self.conn, section_id, payload.get("name"))
            if updated is None:
                return self._error(404, "没有这个栏目", "PGRST116")
            return 200, [updated], self._representation_headers(headers)

        if method == "DELETE":
            # 返回字符串 = 不能删的原因（对应 Supabase 那边外键/约束造成的 409）
            reason = db.delete_section(self.conn, section_id)
            if reason == "没有这个栏目":
                return self._error(404, reason, "PGRST116")
            if reason:
                return self._error(409, reason, "23503")
            return 204, None, {}

        return self._error(405, "Method not allowed", "405")

    # ---------- /rest/v1/rpc/...（对应 Supabase 的 RPC 函数） ----------

    def _handle_rpc(
        self,
        method: str,
        path: str,
        body: bytes,
    ) -> tuple[int, Any, dict[str, str]]:
        if method != "POST":
            return self._error(405, "Method not allowed", "405")

        name = path.rstrip("/").split("/rpc/", 1)[-1]
        payload = self._json(body) or {}

        if name == "presence_heartbeat":
            session_id = str(payload.get("p_session", "") or "")
            db.presence_heartbeat(self.conn, session_id)
            return 204, None, {}

        if name == "presence_count":
            return 200, db.presence_count(self.conn), {}

        return self._error(404, f"没有这个函数：{name}", "404")

    # ---------- 小工具 ----------

    @staticmethod
    def _error(
        status: int,
        message: str,
        code: str,
        extra: dict[str, str] | None = None,
    ) -> tuple[int, Any, dict[str, str]]:
        return status, {"message": message, "code": code}, dict(extra or {})

    @staticmethod
    def _json(body: bytes) -> Any:
        if not body:
            return None
        return json.loads(body.decode("utf-8"))

    @staticmethod
    def _bearer(headers: dict[str, str]) -> str:
        value = headers.get("authorization", "")
        if value.lower().startswith("bearer "):
            return value[7:].strip()
        return ""

    def _user_id(self, headers: dict[str, str]) -> str | None:
        token = self._bearer(headers)
        if not token:
            return None
        return self.tokens.resolve_access(token)

    @staticmethod
    def _filters(query: dict[str, list[str]]) -> dict[str, str]:
        """把 PostgREST 的 `?id=eq.xxx` 解析成 {'id': 'xxx'}。"""
        result: dict[str, str] = {}
        for key, values in query.items():
            if not values or key in ("select", "order", "limit", "offset", "__raw_query__"):
                continue
            raw = values[-1]
            if raw.startswith("eq."):
                result[key] = raw[3:]
        return result
