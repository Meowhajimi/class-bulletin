-- 班级公告栏 · 数据库结构
--
-- 用法：Supabase 控制台 → 左侧 SQL Editor → New query → 粘贴本文件全部内容 → Run。
-- 本文件可以重复执行，不会删掉已有数据（全部是 if not exists / drop policy if exists）。
--
-- 三个要点：
--   1. 同学可以读（公开读策略）；
--   2. 只有登录的管理员能写（owner 策略），即使有人改了前端代码也写不进去；
--   3. 想加字段就跟本地 server/db.py 一起加，保持两边列名一致。

-- ============================================================
-- 1. 表结构
-- ============================================================

create table if not exists public.messages (
  id           uuid primary key default gen_random_uuid(),
  title        text not null check (char_length(btrim(title)) between 1 and 200),
  body         text not null default '',
  published_at timestamptz not null default now(),
  expires_at   timestamptz,                                  -- 留空 = 永不过期
  is_urgent    boolean not null default false,               -- 紧急公告
  created_by   uuid references auth.users (id) on delete set null default auth.uid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ============================================================
-- 1b. 升级已有项目：★ 先补齐所有"后加的列"
-- ============================================================
-- `create table if not exists` 只在表**不存在**时建表；对已有的表它整段跳过，
-- 所以新字段必须在这里显式补一句。
--
-- ⚠️ 顺序很关键：这一段必须在所有 comment / index / 策略**之前**。
--    否则对老表来说，列还没建出来，后面的 `comment on column ...` 就会报
--    ERROR 42703: column "xxx" of relation "public.messages" does not exist，
--    整个脚本中断，真正补列的那句反而永远执行不到。
--
-- ★ 以后加字段就往这里加一句（重复执行安全，不会丢数据）：
--    alter table public.messages add column if not exists category text;

alter table public.messages add column if not exists is_urgent boolean not null default false;

-- ============================================================
-- 1c. 注释（放在 1b 之后，此时列一定存在）
-- ============================================================

comment on table  public.messages is '班级公告：同学只读，管理员可写';
comment on column public.messages.expires_at is '过期时间；为空表示永不过期';
comment on column public.messages.published_at is '发布时间；填未来时间即为定时公告';
comment on column public.messages.is_urgent is '紧急公告；为真时主界面右下角标红';

-- ============================================================
-- 1d. 索引
-- ============================================================

create index if not exists messages_published_at_idx
  on public.messages (published_at desc);

-- ============================================================
-- 2. 数据接口权限（GRANT）—— 少了这一段会报 "permission denied for table messages"
-- ============================================================
--
-- 建 Supabase 项目时如果"自动暴露新表"没勾（Supabase 现在推荐的默认值），
-- 新建的表不会自动授权给数据接口，后面第 3 节的 RLS 策略再好也没用 ——
-- 请求会直接以 42501 错误失败。所以这里显式授权。
--
-- 权限给得刚好够用：
--   anon          （未登录的访客，也就是同学）    只能读
--   authenticated （登录后的你，管理员）          能读能写
-- 真正"谁改哪条"仍由下面的 RLS 策略决定。

grant usage on schema public to anon, authenticated;
grant select on table public.messages to anon, authenticated;
grant insert, update, delete on table public.messages to authenticated;

-- ============================================================
-- 3. 行级安全（RLS）—— 决定"谁能动哪一行"
-- ============================================================

alter table public.messages enable row level security;

-- 同学（含未登录访客）可以读
drop policy if exists "public read messages" on public.messages;
create policy "public read messages"
  on public.messages
  for select
  to anon, authenticated
  using (true);

-- 只有消息的创建者（也就是你那个管理员账号）能发布
drop policy if exists "owner insert messages" on public.messages;
create policy "owner insert messages"
  on public.messages
  for insert
  to authenticated
  with check (auth.uid() = created_by);

-- 只有创建者能修改
drop policy if exists "owner update messages" on public.messages;
create policy "owner update messages"
  on public.messages
  for update
  to authenticated
  using (auth.uid() = created_by)
  with check (auth.uid() = created_by);

-- 只有创建者能删除
drop policy if exists "owner delete messages" on public.messages;
create policy "owner delete messages"
  on public.messages
  for delete
  to authenticated
  using (auth.uid() = created_by);

-- ============================================================
-- 4. 自动维护 updated_at
-- ============================================================

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists messages_touch_updated_at on public.messages;
create trigger messages_touch_updated_at
  before update on public.messages
  for each row
  execute function public.touch_updated_at();


-- ============================================================
-- 5. 在线人数（首页页脚那行小字）
-- ============================================================
--
-- 设计原则：**不收集任何个人信息**。
--   表里只有两列：一个浏览器随机生成的会话号 + 最后一次心跳时间。
--   没有 IP、没有账号、没有设备信息，也无法从会话号反推出是谁。
--   超过 5 分钟没心跳的记录会被自动清掉。

create table if not exists public.presence (
  session_id text primary key check (char_length(session_id) between 8 and 64),
  last_seen  timestamptz not null default now()
);

-- 升级已有项目时，后加的列补在这里（必须在所有 comment / index 之前）
-- alter table public.presence add column if not exists 示例列 text;

comment on table public.presence is '在线人数用的心跳表：只有随机会话号与时间，不含任何个人信息';

-- 不给任何人直接读写这张表：只通过下面两个函数访问，
-- 免得有人能随便翻别人的会话号或往表里灌垃圾。
alter table public.presence enable row level security;
revoke all on public.presence from anon, authenticated;

-- 心跳：登记自己在线，并顺手清理过期记录
create or replace function public.presence_heartbeat(p_session text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- 长度不合法就当没看见，不报错（前端不需要处理这种边界）
  if p_session is null or char_length(p_session) < 8 or char_length(p_session) > 64 then
    return;
  end if;

  insert into public.presence (session_id, last_seen)
  values (p_session, now())
  on conflict (session_id) do update set last_seen = now();

  delete from public.presence where last_seen < now() - interval '5 minutes';
end;
$$;

-- 在线人数：90 秒内有过心跳的算"在线"
create or replace function public.presence_count()
returns integer
language sql
security definer
set search_path = public
as $$
  select count(*)::integer
  from public.presence
  where last_seen > now() - interval '90 seconds';
$$;

grant execute on function public.presence_heartbeat(text) to anon, authenticated;
grant execute on function public.presence_count() to anon, authenticated;


-- ============================================================
-- 以后想加字段，照这个模板加（前后端要一起改，见 README 的"加一个字段"）
-- ============================================================
-- alter table public.messages add column if not exists category text;

-- 想加"分类标签"并允许按分类筛选时，再补一个索引：
-- create index if not exists messages_category_idx on public.messages (category);
