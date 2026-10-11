# 接上 Supabase（约 10 分钟，免费）

做完这 5 步，同学就能用手机打开你的网址看公告了。

> 你也可以先跳过这一节：`python serve.py --seed` 能立刻在本机看到完整效果，
> 或者把 `web/js/config.js` 里的 `dataSource` 改成 `'memory'` 离线看界面。

---

## 第 1 步：注册 → 建 organization → 建项目

**1a. 注册**：打开 <https://supabase.com>，用 GitHub 或邮箱注册（免费版足够一个班级用）。

**1b. 建 organization**（第一次注册时会自动要求填这个表）：

| 字段 | 填什么 |
|---|---|
| **Name** | 随便，例如 `class-bulletin` |
| **Type** | `Personal` |
| **Plan** | `Free - $0/month` |

点 **Create organization**。

> 这是"建项目"之前的一步：Supabase 先要一个 organization（组织）来装你的项目。
> 名字填什么都不影响使用，改天也能改。

**1c. 建项目**：点 **New project**：

- **Name**：`class-bulletin`
- **Database Password**：点生成一个，**记下来**（后面基本用不到，但别丢）
- **Region**：选离同学最近的，例如 `Southeast Asia (Singapore)`。
  国内访问 Supabase 有时偏慢，可以多试几个区域。
- **Plan**：`Free`

点 **Create new project**，等 1～2 分钟创建完成。

### 这个页面上的其它选项怎么选

创建项目时如果展开了「高级配置」，会看到下面这些。**注意：这里有些设置创建后不能改，所以一次选对。**

| 选项 | 怎么选 | 为什么 |
|---|---|---|
| **地区 / Region** | 能展开就选 `Singapore (Southeast Asia)`；不能选就用 `亚太地区` 默认值 | 新加坡离国内最近，访问较快。Supabase 没有中国大陆节点 |
| **启用数据 API**（Enable Data API） | ✅ **必须勾上** | 网页就是通过这个 REST 接口读写公告的。不勾 → 整站打不开 |
| **自动暴露新表**（Automatically expose new tables） | ⬜ 可以**不勾**（推荐） | 不勾更安全。`schema.sql` 里已经用 `grant` 语句显式授权了，两种选择都能跑通 |
| **启用自动 RLS**（Enable automatic RLS） | ⬜ 勾不勾都行 | `schema.sql` 自己会执行 `enable row level security`，不依赖这个开关 |
| **Postgres 类型** | ⭕ 保持默认的 **`后期 (Postgres)`** | 另一个 `OrioleDB 的帖子（Alpha）` 官方明确"不建议用于生产"，别选 |

> 💡 如果你把「自动暴露新表」**勾上了**，也没问题：`schema.sql` 里的 `grant` 语句是重复授权，不会报错。
> 反过来，如果**没勾**又忘了跑那几条 `grant`，打开网页会看到
> `permission denied for table messages`（Postgres 错误码 42501）。
> 这正是 [官方 42501 排错文档](https://supabase.com/docs/guides/troubleshooting/database-api-42501-errors)里说的情况。

> ⚠️ **免费版会在"连续 7 天几乎没有访问"时自动暂停项目**，暂停期间网页会打不开。
> 一般来说同学每天打开几次网页就足以保活（[官方说明](https://supabase.com/docs/guides/platform/free-project-pausing)）。
> 寒暑假长期没人看的时候可能被暂停 —— 这时登录 Supabase 后台，
> 在项目上点 **Resume project** 就能恢复，数据都在，暂停后 1 年内都能恢复。
> 暂停前 Supabase 会发预警邮件，留意邮箱即可。

## 第 2 步：建表

1. 左侧点 **SQL Editor** → **New query**。
2. 打开本仓库的 [`schema.sql`](./schema.sql)，**全部复制**粘贴进去。
3. 点 **Run**（或按 Ctrl+Enter）。
4. 看到 `Success. No rows returned` 就成功了。
5. 左侧 **Table Editor** 里应该能看到 **`messages`** 和 **`sections`** 两张表。
   （`sections` 是**栏目**表；里面会有一行默认栏目「学习委员通知」，可以随时在管理页改名。）

## 第 3 步：关闭公开注册（很重要，别跳过）

不关掉的话，**任何人发现你的网址后都能自己注册账号，然后往公告栏里发内容**
（因为写策略允许"登录用户创建自己名下的公告"，而读策略是公开的，同学都会看到）。

1. 左侧 **Authentication** → **Sign In / Providers**（旧版叫 Providers → Email）。
2. 找到 **Allow new users to sign up**，**关掉**它。
3. 保存。

**怎么确认真的关掉了？** 不用靠肉眼找开关，跑一条命令就行：

```
"C:\Program Files\nodejs\node.exe" tools\live-check.js
```

它会去读 Supabase 的公开设置，并明确打印：

- ✅ `公开注册已关闭：别人无法自己注册账号` ← 这样才对
- ❌ `公开注册【仍然开着】！别人可以自己注册账号` ← 回去把开关关掉

> 关掉之后只有你能创建账号，也就是下一件事。
> 你自己在 **Users** 页面手工添加的账号**不受这个开关影响**，所以先关还是先建都行。

## 第 4 步：创建你自己唯一的管理员账号

你现在看到的 Users 页面应该显示 `No users in your project`，这是正常的 —— 还没建账号。

1. 右上角点 **Add user** → 下拉里选 **Create new user**
   （不要选 "Send invitation"，那会发邮件，还得去邮箱点链接）。
2. 填你的邮箱和密码。
3. ⚠️ **务必勾选 `Auto Confirm User`** —— 这是最容易漏、也最难查的一步。
   不勾的话账号会停在"待验证"状态，登录时你会一直以为是自己密码打错了。
4. 点 **Create user**。建好后用户列表里应该出现这一行，状态不是 "Waiting for verification"。
5. **记下这个邮箱和密码**，它就是管理页（`admin.html`）的登录口令。

> 这个"后台手工添加"的入口不受第 3 步注册开关的影响，
> 所以先关注册、还是先建账号都可以。

### 口令忘了 / 查不到怎么办

Supabase 存的是 bcrypt 单向哈希，**后台和 SQL 都读不回密码原文**，只能重设。两条路：

**A. 还没有发过任何公告 → 直接删了重建（最简单）**

Users 页面删掉该用户 → 重新 **Add user → Create new user**，这次把口令记在便签或密码管理器里。

**B. 已经发过公告 → 用 SQL 改口令，绝对不要删账号**

因为建表语句里写了 `created_by ... on delete set null`：
删掉账号会让老公告的 `created_by` 变成 `NULL`，而 RLS 策略靠 `auth.uid() = created_by`
判断"这条是不是你写的" —— 结果就是你**再也改不了、删不掉自己以前发的公告**。

在 SQL Editor 里执行：

```sql
update auth.users
set encrypted_password = crypt('你的新口令', gen_salt('bf'))
where email = '你的邮箱@example.com';

-- 确认账号处于"已确认"状态
select email, email_confirmed_at from auth.users;

-- 若上面查出来是空的，补这一句
update auth.users set email_confirmed_at = now()
where email = '你的邮箱@example.com' and email_confirmed_at is null;
```

> 对比一下：**本地服务器**（`python serve.py`）的管理员口令是明文存在
> `local_config.json` 里的，随时能看；**云端** Supabase 的则永远看不到。
> 这是两套完全独立的账号，别搞混。

## 第 5 步：把地址和密钥填进 config.js

1. 左侧 **Project Settings**（齿轮）→ **API Keys**
   （新版面板里没有单独的 "API" 页了，所有 key 都在 **API Keys** 这一处；
   也可以直接点右上角绿色的 **Connect** 按钮，它会显示地址和可发布 key）。
2. 复制这两个值：

   | Supabase 里叫什么 | 填到 `web/js/config.js` 的哪一项 |
   |---|---|
   | **Project URL**（`https://xxxx.supabase.co`） | `supabase.url` |
   | **Publishable key**（`sb_publishable_...`）或旧版 **anon** key（`eyJ...`） | `supabase.anonKey` |

   不要带结尾的 `/`。

3. 打开 [web/js/config.js](../web/js/config.js) 填进去（两种 key 都可以）：

   ```js
   supabase: {
     // 新版可发布 key
     url: 'https://abcdefgh.supabase.co',
     anonKey: 'sb_publishable_xxxxxxxxxxxx',
   },
   // 或者旧版 anon key（JWT 形式）
   // anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6...',
   ```

4. **一条命令自检（不用打开浏览器）**：

   ```
   "C:\Program Files\nodejs\node.exe" tools\live-check.js
   ```

   它会用真实代码去读一次你的云端，并明确告诉你通没通、key 类型对不对。

5. 本机再验证一次：

   ```
   python serve.py
   ```

   浏览器打开 <http://127.0.0.1:8787/admin.html>，用第 4 步的邮箱密码登录，
   发一条公告；再打开 <http://127.0.0.1:8787/> 看是否显示。

6. 本地通了以后，把 `web/` 目录整个上传到任意静态托管（见下），网址就能发给同学了。

---

## ⚠️ key 不是密码（这一步最容易搞混）

**登录用的是"邮箱 + 密码"**，也就是第 4 步在 Users 页面建的那个账号。
**任何 key 都不能当密码用** —— 把 `service_role` 或 `sb_secret_` 粘到登录框里，
系统只会告诉你密码错误，因为它根本不是密码。

Supabase 现在有四种 key，[官方说明](https://supabase.com/docs/guides/getting-started/api-keys)：

| key | 格式 | 权限 | 能放进 `config.js` 吗 |
|---|---|---|---|
| **Publishable key**（推荐） | `sb_publishable_...` | 低，受 RLS 限制 | ✅ **就填这个** |
| 旧版 `anon` key | `eyJ...` 的 JWT | 低，受 RLS 限制 | ✅ 也支持 |
| Secret key | `sb_secret_...` | **绕过全部 RLS** | ❌ 绝对不行 |
| 旧版 `service_role` key | `eyJ...`（角色 service_role） | **绕过全部 RLS** | ❌ 绝对不行 |

后两种是"管理员万能钥匙"，只能待在你自己的服务器代码里。
本项目的网页前端**不需要它们中的任何一个**。

> 万一你不小心把 secret / service_role key 填进了 `config.js`：
> 网页会**拒绝运行**并弹红字提示（不会把这个 key 发出去），
> 「云端自检.bat」 也会直接拦住。补救办法是到
> **Settings → API Keys** 删掉那个 key（它会提示你轮换），再改填 publishable key。

---

## 关于 key 会不会泄露

公开的 key 泄露**不会造成破坏**，这正是它的设计用途：

- publishable / anon key 本来就随网页公开，**只能读**；写权限由第 2 步的 GRANT + RLS 策略把守。
- ❌ **绝对不要把 secret / `service_role` key 写进 `config.js`** —— 那个能绕过全部权限检查。
  本项目任何地方都不需要它。

---

## ⚠️ 在国内：先选对托管平台（实测结论）

**这一步别选错，否则部署成功了你和同学也打不开。**
以下是 2026-10 在**国内校园网**实测的结果（探针方法：连接一个不存在的子域名，
拿到 HTTP 状态码说明网络通，超时说明被墙）：

| 平台 | 分配给你的域名 | 国内实测 | 结论 |
|---|---|---|---|
| **Cloudflare Pages** | `xxx.pages.dev` | **HTTP 200，0.39 s**（2026-10 复测） | ✅ **能用，走 Cloudflare 线路** |
| **Netlify** | `xxx.netlify.app` | 部分网络不通（AWS 新加坡 + 有 IPv6） | ⚠️ 作备用 |
| Cloudflare Workers | `xxx.workers.dev` | DNS 被污染成 `...:face:b00c:...` | ❌ 被墙 |
| Vercel | `xxx.vercel.app` | DNS 被污染 | ❌ 被墙 |
| GitHub Pages | `xxx.github.io` | `github.com` 本身超时 | ❌ 不可靠 |

> ⚠️ **这张表之前把 `pages.dev` 和 `workers.dev` 一起写成"被墙"，那是错的。**
> 2026-10 复测：`pages.dev` 解析到真实 Cloudflare IP（`104.18.20.135` / `172.66.x.x`），
> 实际请求返回 **HTTP 200**。被墙的只有 `workers.dev`。
> 这个错误结论导致后来的排查绕了一大圈，详见项目根目录 `安全设置.md`。

典型症状：部署显示成功，但打开网址是 **`ERR_CONNECTION_TIMED_OUT`（响应时间太长）**
—— 注意这**不是 404**。404 说明网络通、只是文件没找到；
超时说明你的网络根本到不了那台服务器。

> 天真的排查方向是"是不是我传错了文件"，其实不是。
> 判断办法：`Resolve-DnsName <你的域名>`，如果返回的 IP 不是该平台真实的
> IP 段（Cloudflare 是 `104.16~104.18.x.x` / `172.64.x.x`），那就是被污染了。

**所以本项目推荐用 Netlify。** 如果哪天 Netlify 也被墙了，
因为前端只是纯静态文件（数据都在 Supabase），换平台只要重新传一次 zip 即可，
**不需要改任何代码** —— 这就是当初把数据源和部署解耦的好处。

### 国内平台为什么不能直接用？（重要）

很多人第一反应是"那就换国内托管"，但**国内没有免备案、免费用、还能直接发给全班的组合**。
实测 + 官方文档依据如下：

| 平台 | 默认域名解析到 | 预热延迟 | 能不能直接发给同学？ |
|---|---|---|---|
| 腾讯云 **CloudBase** | **中国大陆**（`175.12.x` / `121.204.x`） | **89 ms** | ❌ **不能**，见下 |
| 腾讯 **EdgeOne Pages** | 境外（`43.168.x`） | 398 ms | ⚠️ 能用，但没比 Netlify 快 |
| **Netlify** | 新加坡（`52.74.x`） | 89 ms | ✅ 可以 |

CloudBase 虽然节点在国内、延迟最低，但[官方文档](https://docs.cloudbase.net/service/alias)明确写：

> 默认域名**仅建议用于开发测试，严禁用于正式生产环境或分发给大规模用户**。
> 浏览器直接访问会先展示"访问提示中间页"（需点「确定访问」），
> 平台对访问量实时监控，异常时保留**禁止访问**的权利。
> 移除中间页的唯一合规途径是配置**自定义域名** —— 而自定义域名**必须完成 ICP 备案**。

也就是说：**想在国内正式上线，就要买域名 + ICP 备案**（需身份证实名，通常要等几个工作日到几周）。
备案完成后，可以绑自定义域名到 EdgeOne / CloudBase 走国内节点，速度会明显提升。
本文档第 5 节的自定义域名部分有说明。

> 结论：**先用 Netlify 把网站发出去**（89 ms 实测并不慢），
> 等确实需要国内加速时再走"买域名 + 备案"这条路。
> 因为前端是纯静态、数据在 Supabase，整套迁移**不用改任何代码**，只是重新传一次文件。

---

## 部署到公网

先去项目根目录打包一次：

```
python tools/package-web.py
```

它会生成两样东西：

- **`class-bulletin.zip`** —— 直接丢给托管平台，最省事（推荐）
- `dist/` 目录 —— 想拖文件夹时用

同时它会检查"有没有把机密 key 打进去"。如果打印出 `[危险]`，
说明 `config.js` 里的 key 填错了，**先改好再上传**。

> ⚠️ **不要上传整个 `D:\learn web` 目录** —— 里面有 `local_config.json`（本地管理员口令）。
> 用上面生成的 zip 就不会有这个风险。

### 方案 A：Netlify（国内首选 ✅）

1. 打开 <https://app.netlify.com/drop>。
2. 把 **`class-bulletin.zip`** 直接拖进页面的上传框。
3. 等十几秒，它会给你一个 `https://随机名.netlify.app` 网址 —— **先打开确认能看到公告**。
4. 想长期保留这个站点，需要注册认领它：
   - ⚠️ **请用「邮箱」注册，不要点 GitHub 登录** —— GitHub 在国内这个网络上是连不上的。
5. 部署好后可以改个好记的站点名（`Site configuration → Change site name`），
   例如改成 `class-bulletin-2024`，网址就是 `https://class-bulletin-2024.netlify.app`。
6. 用手机再打开一次确认排版，然后发到班级群。

### 方案 B：Cloudflare Pages ★ 推荐（免费，且国内实测可用）

**2026-10 复测结论**：`pages.dev` 在国内**能够访问**（HTTP 200 / 0.39 s），
走的是 Cloudflare 线路。之前"被墙"的结论是**错的**（被墙的只有 `workers.dev`）。

好处：
- 免费，不用买域名、不用备案
- Cloudflare 线路，和同学们一直能正常访问的 Supabase 属于同一个网络

部署（全程在浏览器里，不用装工具）：

1. 打开 <https://dash.cloudflare.com> → 左侧 **Workers & Pages** → **Create**
2. 选 **Pages** → **Upload assets**
3. 项目名填 `class-bulletin`（会成为 `class-bulletin.pages.dev`）
4. 把 `D:\learn web\dist\` **里面的内容**拖进上传区
   （或者双击 `打包上传.bat` 后拖 `class-bulletin.zip`）
5. 点 **Deploy site**，等十几秒

> `_headers` 文件在 Cloudflare Pages 上**同样有效**（格式一样），
> 所以安全响应头会一起带过去，不用改。

> 检查 DNS 是否被污染的办法：`Resolve-DnsName <你的域名>`。
> Cloudflare 真实 IP 段是 `104.16~104.20.x.x` / `172.64~172.67.x.x`。
> 如果看到 `...:face:b00c:...` 这类 IPv6，那就是被污染了（`workers.dev` 就是这样）。

> 用 zip 的好处：`index.html` 已经在压缩包最外层，
> 不会出现"套了一层目录导致同学打开成 `/dist/index.html`"这种翻车。

### ⚠️ 升级到新版本时：先改数据库，再传网页

> 📋 完整步骤（含验证清单与回滚）见 [`更新流程.md`](../更新流程.md)。

版本更新可能会给数据库新增字段（例如「紧急公告」用的 `is_urgent`）。
**顺序搞错会完全发不出公告**，所以按这个顺序来：

| 顺序 | 做什么 | 说明 |
|---|---|---|
| **① 先** | Supabase → **SQL Editor** → New query → 把 `schema.sql` **整个重跑一遍** → Run | 文件末尾有 `alter table ... add column if not exists ...`，可重复执行，**已有公告一条都不会丢** |
| **② 后** | 双击 `打包上传.bat`，把新的 `class-bulletin.zip` 更新到 Netlify 项目 | 详见上面「以后更新」 |

如果忘了 ① 就直接传了网页，发布公告时会看到：

```
数据库里缺少字段（Could not find the 'is_urgent' column of 'messages' in the schema cache）
```

**这不是网页坏了** —— 按 ① 把 SQL 跑一遍即可，网页不用重传。

> 本地数据库（`server/class_bulletin.db`）会自动升级：`serve.py` 启动时检测缺列并补上，
> 老公告照旧可读（新字段按默认值 false 处理）。

### ★ 以后更新：两种更新，别搞混

**第一种：发/改/删公告 —— 完全不用重新部署**

公告内容存在 Supabase 里，不在这份静态文件里。
所以你只要打开管理页发布，同学刷新就能看到，**跟部署没有任何关系**。

**第二种：改了代码 / 样式 / 加了功能 —— 要重新部署，而且能保留原网址**

```bat
python tools/package-web.py        :: 或双击 打包上传.bat
```

然后**注意别用错入口**：

| 入口 | 结果 |
|---|---|
| ❌ `app.netlify.com/drop` | **会新建一个站点**，网址变成新的随机名，你得重新发链接给同学 |
| ✅ 进入**你那个项目** → **Deploys** 页面 → 拖进更新区 | **原地更新，网址不变** |

更新已有项目的步骤：

1. 打开 <https://app.netlify.com>，进到你的项目（例如 `class-bulletin-major`）
2. 左侧点 **Deploys**
3. 页面往下找「**Need to update your site? Drag and drop your site output folder here**」那块
4. 把 `class-bulletin.zip` 拖进去（如果那一块只收文件夹，就把 `dist\` **里面**的内容拖进去）
5. 等十几秒，**网址不变**，直接就是新版

> 缓存不用担心：Netlify 对这些文件用的是 `max-age=0, must-revalidate` + ETag，
> 浏览器每次都会核对，所以更新后同学刷新一下就是新版本。

> 换平台也一样：只要重新拖一次文件，**不用改任何代码**。

## 出问题时怎么查

| 现象 | 原因与处理 |
|---|---|
| 首页提示"还没有连接到服务器" | `config.js` 里的 `url` 没填，或填错了 |
| 登录时把某个 key 粘进去当密码 | key **不是密码**。登录用第 4 步那个账号的**邮箱 + 密码** |
| 登录提示"邮箱或口令不正确" | 邮箱/密码不对；确认第 4 步勾了 Auto Confirm User |
| 登录提示"账号还没激活" | 第 4 步漏勾了 `Auto Confirm User`。删掉该用户重建并勾上，或在 Users 页面把用户确认 |
| 网页弹红字说"key 填错了，已停止运行" | 你把 secret / `service_role` key 填进了 `config.js`。到 Settings → API Keys 删掉它（并轮换），改填 publishable key |
| 登录成功但发布报"没有写入权限" | 第 3 步没关注册，或 RLS 没跑成功；重跑一遍 `schema.sql` |
| **跑 SQL 报 `ERROR 42703: column "xxx" ... does not exist`** | 脚本里引用某列的语句排在了加这一列之前（v2 早期 `schema.sql` 的顺序 bug）。用修好的版本重跑；`python tools/tests/schema_order_test.py` 会检查这个顺序 |
| 报 `permission denied for table messages`（42501） | 缺 GRANT。重跑 `schema.sql`（里面第 2 节就是授权语句） |
| 首页一直转圈然后超时 | 网络到 Supabase 不通。换个 Region 重建项目，或先用本地服务器方案 |
| 同学打开是空白 | 部署时拖错了目录，要拖 `web/` **里面**的文件 |
| 改了 CSS/JS 网页没变 | 强制刷新（手机 iOS Safari 上：设置 → 清除历史记录，或用无痕窗口） |

> 拿不准是哪一步出问题时，**双击项目根目录的 `云端自检.bat`**：
> 它会一次性检查 key 类型、接口地址，并真的去读一次云端，最后给出结论。
>
> ⚠️ 本项目文档里 Node 相关的操作都用 `.bat` 快捷方式 ——
> 因为这台电脑的 Node 没加进 PATH，直接敲 `node` 会报「不是内部或外部命令」。

## 想换成别的后端？

前端只认 [web/js/data/contract.js](../web/js/data/contract.js) 里那 7 个方法。
照着 `supabase.js` 写一个新的，在 `data/index.js` 里加一行分支即可，
界面代码完全不用动 —— 详见 README 的「换数据源」一节。
