"""SQLite 存储层。

列名与语义和 `supabase/schema.sql` 完全一致，
所以前端无论连哪个后端，拿到的数据结构都一样。
"""

from __future__ import annotations

import os
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

# 与 supabase/schema.sql 一一对应（见该文件的注释）
SCHEMA = """
create table if not exists messages (
  id           text primary key,
  title        text not null,
  body         text not null default '',
  published_at text not null,
  expires_at   text,
  is_urgent    integer not null default 0,
  section_id   text,
  created_by   text,
  created_at   text not null,
  updated_at   text not null
);
create index if not exists messages_published_at_idx on messages (published_at desc);
-- ⚠️ 不要在这里给 section_id 建索引！老库的 messages 表还没有这一列，
--    而这一段是**先于 _migrate() 执行**的 —— 会直接报 no such column: section_id，
--    连补列的机会都没有。所以那个索引放在 _migrate() 里建（补完列之后）。
--    （这个坑真的踩过，被 api_smoke.py 的"老库迁移"用例抓到。）

-- 栏目（多栏目功能）：同学只能读，管理员能增删改。
-- name 唯一 —— 与 supabase/schema.sql 的 unique 约束对应。
create table if not exists sections (
  id         text primary key,
  name       text not null unique,
  created_at text not null
);
create index if not exists sections_created_at_idx on sections (created_at asc);

-- 在线人数：只存一个随机会话号和最后心跳时间，不含任何个人信息
-- （与 supabase/schema.sql 的第 5 节对应）
create table if not exists presence (
  session_id text primary key,
  last_seen  text not null
);
create index if not exists presence_last_seen_idx on presence (last_seen desc);
"""

TITLE_MAX = 200
# 与 supabase/schema.sql 的 check(char_length(btrim(name)) between 1 and 40)
# 以及前端 admin.js 的 maxlength="40" 三处保持一致（有测试盯着）
SECTION_NAME_MAX = 40
# 与 supabase/schema.sql 里 insert 的默认栏目名一致
DEFAULT_SECTION_NAME = "学习委员通知"


class ValidationError(ValueError):
    """字段不合法，会被转成 HTTP 400。"""


class DuplicateError(ValidationError):
    """唯一约束冲突（栏目重名）。

    单独一个类型是为了能映射成 HTTP 409 —— 与真 Supabase 的行为一致：
    PostgREST 遇到 Postgres 的 23505 unique_violation 返回的就是 409，
    而不是 400。前端因此只需要一套判断逻辑。
    """


def utcnow() -> str:
    """当前时间，统一用带时区的 ISO8601（例：2025-01-01T08:00:00+00:00）。

    全站只使用这一种时间格式：字符串按字典序比较即等于按时间先后比较，
    因此数据库可以直接用 ORDER BY published_at 排序。
    """
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def normalize_ts(value: Any, field: str) -> str | None:
    """把任意可解析的时间输入规范化成上面的统一格式。

    支持 '2025-01-01'、'2025-01-01T08:00'、带 Z 或带时区偏移的写法。
    空值（None / ''）返回 None，表示"不设该时间"。
    """
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValidationError(f"{field} 不是合法的时间格式：{value!r}") from exc
    if parsed.tzinfo is None:
        # 前端传的多是本地时间，按本地时区解释后再转成 UTC 存储
        parsed = parsed.astimezone()
    return parsed.astimezone(timezone.utc).isoformat(timespec="seconds")


def connect(db_path: str) -> sqlite3.Connection:
    """打开（必要时创建）数据库，并保证表结构存在。"""
    directory = os.path.dirname(os.path.abspath(db_path))
    if directory:
        os.makedirs(directory, exist_ok=True)
    conn = sqlite3.connect(db_path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    conn.commit()
    _migrate(conn)
    return conn


def _migrate(conn: sqlite3.Connection) -> None:
    """给"已经存在的老数据库"补上新加的列。

    为什么必须有这一步：上面的 `create table if not exists` 只在表不存在时建表，
    对已有的库**不会**加列。所以新加的字段必须在这里显式补，
    否则老库一读就是 no such column。

    顺序与 supabase/schema.sql 保持一致：
      1. 先补列  2. 再建默认栏目  3. 最后回填（回填要靠默认栏目的 id）
    """
    columns = {row["name"] for row in conn.execute("pragma table_info(messages)")}

    if "is_urgent" not in columns:
        conn.execute("alter table messages add column is_urgent integer not null default 0")
        conn.commit()

    if "section_id" not in columns:
        conn.execute("alter table messages add column section_id text")
        conn.commit()

    # 索引必须在补列**之后**建（这一段之前 SCHEMA 已经跑过了）
    conn.execute(
        "create index if not exists messages_section_idx on messages (section_id, published_at desc)"
    )
    conn.commit()

    # 栏目表为空时建一个默认栏目（只在空表时插，可重复执行）
    ensure_default_section(conn)

    # 老公告归到最早创建的栏目
    default_id = default_section_id(conn)
    if default_id:
        conn.execute(
            "update messages set section_id = ? where section_id is null or section_id = ''",
            (default_id,),
        )
        conn.commit()


def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    """转成普通字典，并把 SQLite 的 0/1 还原成布尔，保持与云端返回一致。"""
    record = {key: row[key] for key in row.keys()}
    if "is_urgent" in record:
        record["is_urgent"] = bool(record["is_urgent"])
    return record


def _validate_title(title: Any) -> str:
    text = "" if title is None else str(title).strip()
    if not text:
        raise ValidationError("标题不能为空")
    if len(text) > TITLE_MAX:
        raise ValidationError(f"标题不能超过 {TITLE_MAX} 个字符")
    return text


def _as_bool(value: Any) -> bool:
    """把前端传来的各种"真值"统一成布尔（true / 1 / 'true' 都算真）。"""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return False


# ============================== 栏目 ==============================


def _validate_section_name(name: Any) -> str:
    """栏目名：去掉首尾空格后 1~40 字。

    只做 trim，不做大小写/全半角归一 —— 中文栏目名里"学习委员"和"学习委员 "
    是同一个，但"班委"和"班委"的英文缩写没必要被当成同一个。
    """
    text = "" if name is None else str(name).strip()
    if not text:
        raise ValidationError("栏目名不能为空")
    if len(text) > SECTION_NAME_MAX:
        raise ValidationError(f"栏目名不能超过 {SECTION_NAME_MAX} 个字符")
    return text


def list_sections(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    """全部栏目，按创建时间正序。排序只在这一个地方定义。"""
    rows = conn.execute(
        "select * from sections order by created_at asc, id asc"
    ).fetchall()
    return [{key: row[key] for key in row.keys()} for row in rows]


def get_section(conn: sqlite3.Connection, section_id: str) -> dict[str, Any] | None:
    row = conn.execute("select * from sections where id = ?", (section_id,)).fetchone()
    return {key: row[key] for key in row.keys()} if row else None


def default_section_id(conn: sqlite3.Connection) -> str | None:
    """最早的栏目 = 默认栏目（新公告和回填的老公告都归到这里）。"""
    row = conn.execute(
        "select id from sections order by created_at asc, id asc limit 1"
    ).fetchone()
    return str(row["id"]) if row else None


def ensure_default_section(conn: sqlite3.Connection) -> str | None:
    """栏目表为空时建一个默认栏目；否则返回现有的默认栏目 id。

    与 supabase/schema.sql 里那句
        insert into public.sections (name) select '学习委员通知'
        where not exists (select 1 from public.sections);
    行为一致。
    """
    existing = default_section_id(conn)
    if existing:
        return existing
    now = utcnow()
    section_id = str(uuid.uuid4())
    conn.execute(
        "insert into sections (id, name, created_at) values (?, ?, ?)",
        (section_id, DEFAULT_SECTION_NAME, now),
    )
    conn.commit()
    return section_id


def section_message_count(conn: sqlite3.Connection, section_id: str) -> int:
    row = conn.execute(
        "select count(*) as n from messages where section_id = ?", (section_id,)
    ).fetchone()
    return int(row["n"] if row else 0)


def create_section(conn: sqlite3.Connection, name: Any) -> dict[str, Any]:
    text = _validate_section_name(name)
    if _find_section_by_name(conn, text):
        raise DuplicateError("已经有同名栏目了")
    section_id = str(uuid.uuid4())
    conn.execute(
        "insert into sections (id, name, created_at) values (?, ?, ?)",
        (section_id, text, utcnow()),
    )
    conn.commit()
    created = get_section(conn, section_id)
    assert created is not None
    return created


def rename_section(
    conn: sqlite3.Connection, section_id: str, name: Any
) -> dict[str, Any] | None:
    if get_section(conn, section_id) is None:
        return None
    text = _validate_section_name(name)
    other = _find_section_by_name(conn, text)
    if other and other["id"] != section_id:
        raise DuplicateError("已经有同名栏目了")
    conn.execute("update sections set name = ? where id = ?", (text, section_id))
    conn.commit()
    return get_section(conn, section_id)


def delete_section(conn: sqlite3.Connection, section_id: str) -> str | None:
    """删除栏目。

    返回 None 表示成功；返回字符串表示"为什么不能删"（会被转成 HTTP 409）。

    两条拒绝规则：
      1. 栏目里还有公告 —— 不能连带删掉同学的公告（数据库那边还有外键兜底）
      2. 这是最后一个栏目 —— 否则会变成"一条公告都没有归属"
    """
    if get_section(conn, section_id) is None:
        return "没有这个栏目"

    total = conn.execute("select count(*) as n from sections").fetchone()
    if int(total["n"] if total else 0) <= 1:
        return "至少要保留一个栏目"

    used = section_message_count(conn, section_id)
    if used:
        return f"这个栏目里还有 {used} 条公告，请先移动或删除它们"

    conn.execute("delete from sections where id = ?", (section_id,))
    conn.commit()
    return None


def _find_section_by_name(conn: sqlite3.Connection, name: str) -> dict[str, Any] | None:
    row = conn.execute("select * from sections where name = ?", (name,)).fetchone()
    return {key: row[key] for key in row.keys()} if row else None


def _resolve_section_id(conn: sqlite3.Connection, value: Any, *, required: bool) -> str | None:
    """把前端传来的 section_id 校验成真实存在的栏目 id。

    没传时（required=False）用默认栏目；传了但不存在则报错，
    而不是静默改成默认栏目 —— 静默纠正会让人以为"发布成功了"。
    """
    text = "" if value is None else str(value).strip()
    if not text:
        if required:
            raise ValidationError("缺少栏目")
        return default_section_id(conn)
    if get_section(conn, text) is None:
        raise ValidationError("栏目不存在，请刷新页面重试")
    return text


def list_messages(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    """全部消息，按发布时间倒序。排序只在这一个地方定义。"""
    rows = conn.execute(
        "select * from messages order by published_at desc, created_at desc"
    ).fetchall()
    return [_row_to_dict(row) for row in rows]


def get_message(conn: sqlite3.Connection, message_id: str) -> dict[str, Any] | None:
    row = conn.execute("select * from messages where id = ?", (message_id,)).fetchone()
    return _row_to_dict(row) if row else None


def create_message(
    conn: sqlite3.Connection, data: dict[str, Any], user_id: str | None
) -> dict[str, Any]:
    now = utcnow()
    message_id = str(uuid.uuid4())
    title = _validate_title(data.get("title"))
    body = "" if data.get("body") is None else str(data.get("body"))
    published_at = normalize_ts(data.get("published_at"), "published_at") or now
    expires_at = normalize_ts(data.get("expires_at"), "expires_at")
    is_urgent = 1 if _as_bool(data.get("is_urgent")) else 0
    section_id = _resolve_section_id(conn, data.get("section_id"), required=False)

    conn.execute(
        """insert into messages
             (id, title, body, published_at, expires_at, is_urgent, section_id, created_by, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (message_id, title, body, published_at, expires_at, is_urgent, section_id, user_id, now, now),
    )
    conn.commit()
    created = get_message(conn, message_id)
    assert created is not None
    return created


def update_message(
    conn: sqlite3.Connection, message_id: str, patch: dict[str, Any]
) -> dict[str, Any] | None:
    """只更新 patch 里出现的字段；expires_at 允许显式传 null 来取消过期。"""
    current = get_message(conn, message_id)
    if current is None:
        return None

    updates: dict[str, Any] = {}
    if "title" in patch:
        updates["title"] = _validate_title(patch.get("title"))
    if "body" in patch:
        updates["body"] = "" if patch.get("body") is None else str(patch.get("body"))
    if "published_at" in patch:
        normalized = normalize_ts(patch.get("published_at"), "published_at")
        if normalized:
            updates["published_at"] = normalized
    if "expires_at" in patch:
        updates["expires_at"] = normalize_ts(patch.get("expires_at"), "expires_at")
    if "is_urgent" in patch:
        updates["is_urgent"] = 1 if _as_bool(patch.get("is_urgent")) else 0
    if "section_id" in patch:
        updates["section_id"] = _resolve_section_id(conn, patch.get("section_id"), required=True)

    if not updates:
        return current

    updates["updated_at"] = utcnow()
    assignments = ", ".join(f"{column} = ?" for column in updates)
    conn.execute(
        f"update messages set {assignments} where id = ?",
        (*updates.values(), message_id),
    )
    conn.commit()
    return get_message(conn, message_id)


def delete_message(conn: sqlite3.Connection, message_id: str) -> bool:
    cursor = conn.execute("delete from messages where id = ?", (message_id,))
    conn.commit()
    return cursor.rowcount > 0


# ============================== 在线人数 ==============================

# 90 秒内有过心跳算"在线"；与 supabase/schema.sql 里的 presence_count() 一致
PRESENCE_ONLINE_SECONDS = 90
PRESENCE_KEEP_SECONDS = 300


def _parse_iso(value: str) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def presence_heartbeat(conn: sqlite3.Connection, session_id: Any) -> bool:
    """登记一次心跳，并顺手清掉过期记录。

    会话号长度不合法就当作没看见（不报错），这样前端不用处理这种边界。
    """
    text = str(session_id or "").strip()
    if not (8 <= len(text) <= 64):
        return False

    now = utcnow()
    conn.execute(
        "insert into presence (session_id, last_seen) values (?, ?) "
        "on conflict (session_id) do update set last_seen = excluded.last_seen",
        (text, now),
    )
    cutoff = (
        datetime.now(timezone.utc) - timedelta(seconds=PRESENCE_KEEP_SECONDS)
    ).isoformat(timespec="seconds")
    conn.execute("delete from presence where last_seen < ?", (cutoff,))
    conn.commit()
    return True


def presence_count(conn: sqlite3.Connection) -> int:
    """当前在线人数（90 秒内有过心跳的会话数）。"""
    cutoff = (
        datetime.now(timezone.utc) - timedelta(seconds=PRESENCE_ONLINE_SECONDS)
    ).isoformat(timespec="seconds")
    row = conn.execute(
        "select count(*) as n from presence where last_seen > ?", (cutoff,)
    ).fetchone()
    return int(row["n"] if row else 0)


def seed_demo(conn: sqlite3.Connection) -> int:
    """插入几条示例公告，方便第一次打开就能看到界面效果。"""
    if list_messages(conn):
        return 0

    # 示例数据也顺便演示"多栏目"：默认栏目 + 一个额外的栏目
    default_id = ensure_default_section(conn)
    other = _find_section_by_name(conn, "班级事务")
    if other is None:
        other = create_section(conn, "班级事务")
    other_id = other["id"]

    now = datetime.now(timezone.utc)
    samples = [
        {
            "title": "【示例】紧急公告：明天临时调课",
            "body": "这条是「紧急公告」的示例：勾选紧急后，\n"
            "它会排在本栏目的最前面，\n"
            "也会汇总到顶部的「总栏目」里。",
            "published_at": now.isoformat(timespec="seconds"),
            "expires_at": None,
            "is_urgent": True,
            "section_id": default_id,
        },
        {
            "title": "欢迎使用班级公告栏",
            "body": "这里会放置需要大家查看的通知。\n\n"
            "同学打开网址即可查看，无需注册、无需登录。\n"
            "只有学习委员可以发布和修改内容。\n\n"
            "顶部可以切换栏目；「总栏目」把各栏目的紧急公告汇总在一起。",
            "published_at": now.isoformat(timespec="seconds"),
            "expires_at": None,
            "section_id": default_id,
        },
        {
            "title": "示例：这条通知带有截止时间",
            "body": "带有截止时间的通知，过期后会自动收进下方的"
            "「往期公告」折叠区。\n\n"
            "发布时可以选择「永不过期」「指定时间」或「立即结束」。",
            "published_at": (now.replace(microsecond=0)).isoformat(timespec="seconds"),
            "expires_at": (now.timestamp() + 2 * 86400),
            "section_id": default_id,
        },
        {
            "title": "【示例】班级事务栏目里的一条公告",
            "body": "这条属于「班级事务」栏目。\n\n"
            "在管理页可以新增、改名、删除栏目；"
            "同学只能查看，不能修改。",
            "published_at": now.isoformat(timespec="seconds"),
            "expires_at": None,
            "section_id": other_id,
        },
    ]
    count = 0
    for sample in samples:
        expires = sample["expires_at"]
        if isinstance(expires, float):
            sample["expires_at"] = datetime.fromtimestamp(
                expires, timezone.utc
            ).isoformat(timespec="seconds")
        create_message(conn, sample, user_id=None)
        count += 1
    return count
