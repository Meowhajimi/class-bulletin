"""检查 supabase/schema.sql 的语句顺序是否正确。

为什么需要这个测试（真实事故）：
    给 messages 表加 is_urgent 时，我把 `comment on column ... is_urgent` 写在了
    `alter table ... add column if not exists is_urgent` **前面**。
    对新项目没事（create table 里已经有这一列），但对**已有的表**：
    create table 整段被跳过 → 列不存在 → comment 报
    `ERROR 42703: column "is_urgent" of relation "public.messages" does not exist`
    → 脚本中断 → 真正补列的那句永远执行不到。
    而我没有这个项目的数据库密码，无法真的跑一遍 SQL 验证，所以只能靠静态检查。

本测试强制以下不变式：
    任何"引用某列"的语句（comment on column、create index），
    必须出现在该列**被定义之后** —— 定义要么在 create table 里，要么由
    更靠前的 `alter table ... add column if not exists` 补上。

运行：python tools/tests/schema_order_test.py
"""

from __future__ import annotations

import os
import re
import sys

BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SCHEMA_PATH = os.path.join(BASE_DIR, "supabase", "schema.sql")

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


def strip_public(name: str) -> str:
    return name.strip().strip('"').removeprefix("public.").strip('"')


def collect_defined_columns(sql: str) -> dict[tuple[str, str], int]:
    """收集每一列"最早被定义"的行号：来自 create table，或 alter ... add column。"""
    lines = sql.splitlines()
    defined: dict[tuple[str, str], int] = {}

    # create table 里声明的列
    in_create = False
    current_table = ""
    for index, raw in enumerate(lines, start=1):
        line = raw.strip()
        lowered = line.lower()

        if not in_create:
            match = re.match(r"create\s+table\s+if\s+not\s+exists\s+([\w.\"]+)\s*\(", lowered)
            if match:
                in_create = True
                current_table = strip_public(match.group(1))
            continue

        if lowered.startswith(");"):
            in_create = False
            current_table = ""
            continue
        if not line or line.startswith("--"):
            continue
        if lowered.startswith(("constraint ", "primary key", "unique ", "check ", "foreign key")):
            continue

        column = re.match(r'"?([a-zA-Z_][\w]*)"?\s+[a-zA-Z]', line)
        if column:
            defined[(current_table, column.group(1).lower())] = index

    # alter table ... add column if not exists（升级老表用）
    for index, raw in enumerate(lines, start=1):
        match = re.search(
            r"alter\s+table\s+([\w.\"]+)\s+add\s+column\s+if\s+not\s+exists\s+\"?([\w]+)\"?",
            raw,
            re.IGNORECASE,
        )
        if not match:
            continue
        table = strip_public(match.group(1))
        column = match.group(2).lower()
        existing = defined.get((table, column))
        defined[(table, column)] = min(existing, index) if existing else index

    return defined


def find_ordering_problems(sql: str) -> list[str]:
    """返回所有"引用早于定义"的问题描述；没有问题就返回空列表。"""
    defined = collect_defined_columns(sql)
    problems: list[str] = []

    def require(table: str, column: str, line_number: int, what: str) -> None:
        defined_at = defined.get((table, column.lower()))
        if defined_at is None:
            problems.append(
                f"第 {line_number} 行：{what} 引用了 {table}.{column}，但全文没有定义这一列"
            )
        elif defined_at > line_number:
            problems.append(
                f"第 {line_number} 行：{what} 引用了 {table}.{column}，"
                f"但这一列到第 {defined_at} 行才被加上 —— 老表执行到这里会报 42703"
            )

    for index, raw in enumerate(sql.splitlines(), start=1):
        line = raw.strip()
        if line.startswith("--"):
            continue

        comment = re.match(
            r"comment\s+on\s+column\s+([\w.\"]+)\s*\.\s*\"?([\w]+)\"?", line, re.IGNORECASE
        )
        if comment:
            require(strip_public(comment.group(1)), comment.group(2), index, "comment on column")

        # 索引引用了不存在的列同样会中断执行，所以一并检查
        index_stmt = re.match(
            r"create\s+index[^;]*?\son\s+([\w.\"]+)\s*\(([^)]*)\)", line, re.IGNORECASE
        )
        if index_stmt:
            table = strip_public(index_stmt.group(1))
            for piece in index_stmt.group(2).split(","):
                column = piece.strip().split()[0] if piece.strip() else ""
                # 表达式索引（带函数/括号）没法简单静态判断，跳过
                if column and re.fullmatch(r'"?[A-Za-z_][\w]*"?', column):
                    require(table, column.strip('"'), index, "create index")

    return problems


def main() -> int:
    if not os.path.isfile(SCHEMA_PATH):
        print(f"[错误] 找不到 {SCHEMA_PATH}")
        return 1

    with open(SCHEMA_PATH, "r", encoding="utf-8") as handle:
        sql = handle.read()

    print("\n一、先证明这个检查器真的能抓出问题（自检）")

    bad_sql = """
create table if not exists public.messages (
  id uuid primary key,
  title text not null
);
comment on column public.messages.is_urgent is '注释写在补列之前（这是错的）';
alter table public.messages add column if not exists is_urgent boolean not null default false;
"""
    bad_problems = find_ordering_problems(bad_sql)
    check(
        "能抓出「注释写在补列之前」",
        any("is_urgent" in problem and "42703" in problem for problem in bad_problems),
        str(bad_problems),
    )

    referencing_never_defined = """
create table if not exists public.messages (
  id uuid primary key
);
comment on column public.messages.category is '这一列全文都没定义';
"""
    check(
        "能抓出「引用了根本没定义的列」",
        any("没有定义" in problem for problem in find_ordering_problems(referencing_never_defined)),
    )

    good_sql = """
create table if not exists public.messages (
  id uuid primary key,
  is_urgent boolean not null default false
);
comment on column public.messages.is_urgent is '顺序正确';
"""
    check("顺序正确时不误报", find_ordering_problems(good_sql) == [], str(find_ordering_problems(good_sql)))

    alter_then_comment = """
create table if not exists public.messages (
  id uuid primary key
);
alter table public.messages add column if not exists is_urgent boolean not null default false;
comment on column public.messages.is_urgent is '先补列再注释，正确';
"""
    check(
        "先 alter 补列、再 comment 也不误报",
        find_ordering_problems(alter_then_comment) == [],
        str(find_ordering_problems(alter_then_comment)),
    )

    print("\n二、检查真实的 supabase/schema.sql")

    problems = find_ordering_problems(sql)
    check("没有「引用早于定义」的语句", problems == [], "；".join(problems))

    # 防止"检查器解析失败导致空过"：确认它真的读到了这些列
    defined = collect_defined_columns(sql)
    check(
        "解析器确实读到了 is_urgent 列",
        ("messages", "is_urgent") in defined,
        str(sorted(defined.keys())),
    )
    check(
        "解析器确实读到了 published_at / expires_at 列",
        ("messages", "published_at") in defined and ("messages", "expires_at") in defined,
    )

    check(
        "补列语句存在",
        bool(re.search(r"add\s+column\s+if\s+not\s+exists\s+is_urgent", sql, re.IGNORECASE)),
    )
    check(
        "补列语句出现在它的 comment 之前（这正是之前出错的地方）",
        sql.lower().index("add column if not exists is_urgent")
        < sql.lower().index("comment on column public.messages.is_urgent"),
    )

    print("\n" + "=" * 46)
    print(f"通过 {passed} 项，失败 {failed} 项")
    print("=" * 46)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
