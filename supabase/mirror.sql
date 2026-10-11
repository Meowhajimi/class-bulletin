-- ============================================================
-- 备用镜像用的公开存储桶
-- ============================================================
--
-- 用途：把网站静态文件也放一份到 Supabase（它走 Cloudflare、且**纯 IPv4**）。
--       当同学的网络访问不了 Netlify（AWS 新加坡 + 有 IPv6）时，可以改用这个入口。
--
-- 为什么这样能解决问题：
--   Chromium 内核（Chrome / Edge / 微信）会**优先连 IPv6**。Netlify 有 AAAA 记录，
--   同学网络上的 IPv6 到 AWS 新加坡如果不通，浏览器就报 ERR_CONNECTION_CLOSED。
--   Supabase 没有 AAAA 记录，浏览器只能走 IPv4，绕开了这个坑。
--
-- 用法：Supabase 控制台 → SQL Editor → 粘贴本文件 → Run。可重复执行。
--
-- ⚠️ 这里刻意**只做一件事**（建桶）。原因：
--   storage 这个 schema 下的表属于另一个角色（supabase_storage_admin），
--   对它们执行 `comment on ...` 之类需要"所有者权限"的语句会报
--   `must be owner of table buckets`；而 SQL Editor 是把整个脚本当一个事务跑的，
--   一句失败会导致**整段回滚**，桶就建不成。所以只保留必需的最小语句。

insert into storage.buckets (id, name, public)
values ('site', 'site', true)
on conflict (id) do nothing;

-- 用一句查询确认结果：应当返回 1 行，public 为 true
select id, name, public from storage.buckets where id = 'site';

-- 说明：
--   · 桶设为 public = true → 任何人都能**读**里面的文件（这就是网站本身，本来就公开）
--   · **没有**给任何人写入权限：上传要用 service_role key 在你本机跑
--     `tools/publish-mirror.py`（那个 key 绝不进前端、不进部署包）
