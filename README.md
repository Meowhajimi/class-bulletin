# 班级公告栏

一个班级公告网页：**同学只读浏览，学习委员一人发布**。
纯静态前端 + 可替换的数据源，没有构建步骤，不需要 `npm install`。

- 前端：原生 HTML / CSS / ES Module，直接部署到任何静态托管
- 数据：Supabase（免费云端，公网可访问）或本机 Python 服务器（零依赖，可局域网共享）
- 权限：写权限由数据库策略强制控制，同学即使改前端也发不了公告

---

## 一、30 秒看到效果

### 最省事：直接双击根目录里的 `.bat`

不用打开命令行、不用切目录、也不用管环境变量，双击就行：

| 双击这个 | 干什么 |
|---|---|
| **`启动本地预览.bat`** | 在本机起网站（同时支持同学用手机访问局域网） |
| **`打包上传.bat`** | 生成 `dist\` 与 `class-bulletin.zip`，准备上传 |
| **`发布到Cloudflare.bat`** | ★ 更新**主站**（Cloudflare Pages）—— 会跑一次打包并打开控制台 |
| **`备份公告到Word.bat`** | 把云端全部公告导出成 Word，存到 `backups\` |
| **`云端自检.bat`** | 检查线上是否正常：能读公告 / 注册已关 / 同学不能发布 |
| **`跑测试.bat`** | 改完代码跑一遍全部测试（9 个套件，**484 项**） |
| **`公开前体检.bat`** | 想把源码公开给同学之前跑一遍：查机密 key / 本机专用文件 / 个人信息 / 乱码 |
| **`推送到GitHub.bat`** | 改完网页后一键更新主站（打包 → 提交 → 推送，Cloudflare 自动部署） |

> 💡 **为什么都做成 `.bat`**：`.py` 文件双击会"一闪而过"（跑完立刻关窗，看不到结果），
> 而且不会设置 UTF-8 —— 中文会显示成乱码。`.bat` 会 `pause` 并设好编码，
> **所以请一律双击 `.bat`，不要直接双击 `.py`。**

> **主站地址**：<https://class-bulletin.pages.dev/>（Cloudflare Pages）
> **备用地址**：<https://class-bulletin-major.netlify.app>（Netlify）
>
> 为什么主站是 Cloudflare 而不是 Netlify：Netlify 落在 **AWS 新加坡且带 IPv6 记录**，
> 部分同学的手机直连打不开（`ERR_CONNECTION_CLOSED`）。Cloudflare 线路那位同学能通，
> 实测换过去就正常了。详见 [安全设置.md](安全设置.md) 的「同学打不开怎么办」。

> 它们内部会自动切到项目目录（`cd /d "%~dp0"`），所以**在任何位置双击都能正常跑**。

> 🔒 **本机专用安全页面**：网站跑起来后打开 <http://127.0.0.1:8787/security>
> 可以看到 IP 黑名单、谁被锁了、有没有人在扫描你的网站。
> **只有这台电脑能打开**（同学手机上访问是 404）。详见 [安全设置.md](安全设置.md)。

> ⚠️ **关于 `node` 命令**：这台电脑装了 Node（在 `C:\Program Files\nodejs\`），
> 但**没加进 PATH**，所以直接敲 `node xxx` 会报「不是内部或外部命令」。
> 两个解决办法：
> 1. **双击上面那两个 `.bat`**（推荐，它们会自己找到 node）
> 2. 或者用完整路径：`"C:\Program Files\nodejs\node.exe" tools\live-check.js --check-write`
>
> 想一劳永逸的话，把 `C:\Program Files\nodejs` 加进系统环境变量 `Path`，以后 `node` 就能直接用了。

### 功能一览

| 谁能用 | 功能 |
|---|---|
| **同学** | 看公告（紧急的排最前、红色标记）· **搜索关键词** · **按日期范围筛选** · 点进 **详情页** 看完整正文（适合超长通知）· 右上角刷新 · 页脚角落 **下载 Word 备份** · 页脚一行小字看**当前在线人数** |
| **你（学委）** | 登录后发布 / 修改 / 删除 · 可设 **发布时间**（补录过去或定时未来）· 可设 **过期时间** · 可勾选 **紧急公告** · 每条都有 **查看详情** 可预览 · 保存后**询问是否下载 Word 备份** · 随时导出全部（含定时未发布）· **本机安全页面**看黑名单 |

### 或者用命令行

**注意：命令要在项目目录里运行**，否则会报 `No such file or directory`：

```bat
cd /d "D:\learn web"
python serve.py
```

然后浏览器打开 <http://127.0.0.1:8787/>。

| 页面 | 地址 | 说明 |
|---|---|---|
| 同学看的公告页 | <http://127.0.0.1:8787/> | 只读 |
| 你的管理页 | <http://127.0.0.1:8787/admin.html> | 发布 / 修改 / 删除 |

**管理页账号**在 `local_config.json` 里（首次运行会自动生成并打印在屏幕上）。
默认是 `admin@class.local`，口令请改成你自己的。

要让同网络的同学用手机看：

```bat
python serve.py --lan
```

启动后会打印一个 `http://10.x.x.x:8787/` 或 `http://192.168.x.x:8787/` 形式的地址，
**把它发到班级群里给同学**（多网卡时可能打印多个，哪个能打开就用哪个）。

⚠️ **手机打不开时，九成是下面两个原因：**

1. **别用 `127.0.0.1`** —— 手机上这个地址指的是手机自己，浏览器会显示
   `ERR_CONNECTION_REFUSED`（「拒绝连接」）。要用启动时打印的那个 `10.x` / `192.168.x` 地址。
2. **手机必须连同一个 Wi-Fi** —— 手机用流量（5G/4G）永远打不开局域网地址。
   看手机状态栏：要显示 Wi-Fi 图标，而不是「5G」。

> 只需要 Python 3.10+，不装任何第三方库。上面看到的示例公告是
> `python serve.py --seed` 生成的，想清空就删掉 `server/class_bulletin.db`。

---

## 二、目录结构：想改什么就找哪个文件

```
learn web\
├─ 更新流程.md              ★更新/部署的完整步骤（照着打勾）
├─ 稳定性评估.md            ★站点稳不稳、会不会挂、挂了怎么办（含故障速查表）
├─ SECURITY.md              公开仓库的安全说明：哪些绝不能提交、怎么报告问题
├─ 安全设置.md              ★安全防护：公网怎么做、本地怎么做、做不到什么
├─ serve.py                 一路命令启动本地网站（静态页面 + 接口 + 安全防护）
├─ local_config.json        本地管理员账号（自动生成，不要上传）
├─ package.json             只为跑测试；type:module，没有任何依赖
│
├─ server\                  本地后端：用标准库实现和 Supabase 一样的接口
│  ├─ db.py                 SQLite 表结构与增删改查（含 online 人数表）
│  ├─ local_api.py          /auth/v1、/rest/v1 两个接口 + 登录锁定
│  ├─ security.py           ★安全防护：失败锁定、递增解锁、风控评分、IP 黑名单
│  ├─ ip_blacklist.json     黑名单（运行时生成，不进版本库）
│  └─ static_site.py        静态文件服务（保证 .js 的 MIME 正确）
│
├─ web\                     ★ 最终要上传到公网的就是这个目录
│  ├─ index.html            同学看的页面（含搜索/筛选栏、右下角紧急标记）
│  ├─ message.html          单条公告的详情页（?id=xxx）
│  ├─ styleguide.html       ★样式预览页：一页看完所有组件状态，改配色后自己先看这个
│  ├─ admin.html            你的管理页面
│  ├─ css\
│  │  ├─ tokens.css         ★主题：颜色、字号、间距、深色模式
│  │  ├─ base.css           重置与排版
│  │  ├─ layout.css         整体布局与响应式
│  │  └─ components.css     卡片、按钮、表单、对话框等组件外观
│  └─ js\
│     ├─ config.js          ★唯一配置点：站名、数据源、备份方式、摘要长度
│     ├─ app.js             首页逻辑（加载 → 筛选 → 排序 → 分组渲染）
│     ├─ message.js         详情页逻辑
│     ├─ admin.js           管理页逻辑（登录 → 增删改 → 询问备份）
│     ├─ data\              ★数据层：换后端只动这里
│     │  ├─ contract.js     接口契约（7 个方法）+ 错误类型 + 紧急判断
│     │  ├─ supabase.js     连 Supabase / 本地服务器（纯 fetch）
│     │  ├─ memory.js       离线模式（存在浏览器里）
│     │  ├─ backup.js       把公告整理成 Word 内容
│     │  ├─ session.js      登录态保存与续期
│     │  └─ index.js        数据源工厂（决定用哪一个）
│     └─ ui\                界面零件
│        ├─ dom.js          创建元素的工具（全站不用 innerHTML）
│        ├─ time.js         ★过期判定、时间显示、发布时间校验（有单元测试）
│        ├─ filter.js       ★排序与筛选/搜索规则（纯函数，有单元测试）
│        ├─ filter-bar.js   首页的搜索与筛选栏
│        ├─ message-card.js ★消息卡片模板（紧急徽章、摘要、详情链接）
│        ├─ icon.js         极简 SVG 图标（用 createElementNS，不引入图标库）
│        ├─ docx.js         零依赖生成 Word 文件
│        ├─ dialog.js       模态询问框
│        └─ states.js       加载中 / 空 / 出错 / 未配置（都带图标）
│
├─ supabase\
│  ├─ schema.sql            建表 + 升级迁移 + 权限策略（贴进 Supabase 跑一次）
│  └─ SETUP.md              申请 Supabase 的分步教程
└─ tools\                   备份脚本、打包脚本、自检工具、测试
```

---

## 三、三种运行方式

改的永远是 `web/js/config.js` 里的 `dataSource` 和 `supabase.url` 两项。

| 方式 | config.js 怎么填 | 用在哪 |
|---|---|---|
| **云端（正式发布）** | `dataSource: 'supabase'`、`url: 'https://xxx.supabase.co'`、填好 `anonKey` | 发给同学的公网网址 |
| **本机服务器** | `dataSource: 'supabase'`、`url` **留空** | 本地预览、局域网共享。留空时会自动指向正在访问的那台服务器 |
| **离线演示** | `dataSource: 'memory'` | 断网调界面样式，数据只存在你自己浏览器里 |

> `url` 留空 + 用 `python serve.py` 打开 → 自动连本地服务器；
> `url` 留空 + 部署到公网 → 页面会显示"还没有连接到服务器"的提示，不会白屏。

---

## 四、发布到公网

详细步骤见 **[supabase/SETUP.md](supabase/SETUP.md)**，概览：

1. 注册 Supabase → 建 organization（组织）→ 在它下面建项目（免费）
2. SQL Editor 里粘贴 `supabase/schema.sql` 并运行
3. **关闭"允许新用户注册"**（关键，否则任何人都能注册后往公告栏发东西）
4. 手动创建你唯一的管理员账号（邮箱 + 密码，勾 `Auto Confirm User`）
5. 把 Project URL 和 **publishable key**（`sb_publishable_...`，旧版叫 anon key）填进 `web/js/config.js`
6. 跑一次自检，确认云端通了、且**两项安全检查都是 ✅**：

   ```
   "C:\Program Files\nodejs\node.exe" tools\live-check.js --check-write
   ```

   它会检查：能否读到公告、**公开注册是否已关闭**、**未登录能不能发布**。
   第 3 步没做的话，这里会明确报出来。

7. 打包（同时会扫描有没有把机密 key 打进去）：

   ```
   python tools/package-web.py
   ```

   成功后会生成两样东西：`class-bulletin.zip` 和 `dist/` 目录。

8. 上传到静态托管（**推荐直接丢 zip**，比拖文件夹不容易出错）：
   **国内实测（2026-10 复测过，之前有一次结论是错的）**：

   | 平台 | 域名 | 国内实测 | 备注 |
   |---|---|---|---|
   | **Netlify** | `xxx.netlify.app` | ⚠️ 部分网络不通 | 落在 **AWS 新加坡 + 有 IPv6**；有同学报 `ERR_CONNECTION_CLOSED` |
   | **Cloudflare Pages** | `xxx.pages.dev` | ✅ **HTTP 200 / 0.39s** | 走 Cloudflare（`104.18.x` / `172.66.x`）。**能用，而且免费** |
   | Cloudflare Workers | `xxx.workers.dev` | ❌ DNS 被污染 | 解析出 `...:face:b00c:...`，GFW 污染的典型特征 |
   | Vercel | `xxx.vercel.app` | ❌ DNS 被污染 | |
   | GitHub Pages | `xxx.github.io` | ❌ `github.com` 本身超时 | |

   > ⚠️ **之前这张表把 `pages.dev` 和 `workers.dev` 一起写成"被墙"，那是错的。**
   > 2026-10 复测：`pages.dev` 解析正常（真 Cloudflare IP），实际请求 **HTTP 200**；
   > 被墙的只有 `workers.dev`。这个错误结论让排查绕了一大圈（详见 `安全设置.md`）。

   **结论**：优先用 **Cloudflare Pages**（免费、Cloudflare 线路），Netlify 作为备用。
   前端只是纯静态文件，**换平台只要重新上传一次 `dist/`，不用改代码**。

上传的是 `dist/` **里面的**文件（`index.html` 要在最外层），不是整个仓库。
用 zip 的话这一层已经打好了，不会套错目录。
`dist/` 和 `class-bulletin.zip` 都是临时产物，可以随时删掉重新生成，已在 `.gitignore` 里。

> ⚠️ **别把整个 `D:\learn web` 目录传上去** —— 里面有 `local_config.json`（本地管理员口令）。
> 用 `python tools/package-web.py` 生成 zip 就不会碰到这个问题。

### ★ 以后更新：两种更新，别搞混

> 📋 **完整的更新步骤（含升级、验证清单、回滚）见 [更新流程.md](更新流程.md)**，
> 可以照着逐项打勾。下面只是要点。

| 你要做的事 | 要不要重新部署？ |
|---|---|
| **发 / 改 / 删公告** | ❌ **不用**。公告存在 Supabase 里，打开 `/admin` 发布，同学刷新就看到了 |
| 改样式、改代码、加功能 | ✅ 要。双击 `打包上传.bat`，然后**进项目更新**（见下） |

**更新已有站点时，千万别用 `app.netlify.com/drop`** —— 那是"新建站点"入口，
会给你一个新网址，之前发给同学的链接就作废了。正确做法：

1. 打开 <https://app.netlify.com>，进到**你已有的项目**（例如 `class-bulletin-major`）
2. 左侧点 **Deploys**
3. 往下找「**Need to update your site? Drag and drop your site output folder here**」
4. 把 `class-bulletin.zip` 拖进去（只收文件夹时，就拖 `dist\` **里面**的内容）
5. 等十几秒 —— **网址不变**，直接生效

> 缓存不用担心：实测线上是 `Cache-Control: max-age=0, must-revalidate` + ETag，
> 浏览器每次都会核对，所以同学刷新一下就是新版本，不会卡在旧文件上。

### ⚠️ 升级到新版本时：先改数据库，再传网页

**这次改动新增了数据库字段 `is_urgent`（紧急公告）。顺序搞错会完全发不出公告：**

| 顺序 | 做什么 | 为什么 |
|---|---|---|
| **① 先** | Supabase → **SQL Editor** → 把 `supabase/schema.sql` **整个重跑一遍** | 里面有 `alter table ... add column if not exists is_urgent`，可重复执行，**不会丢数据** |
| **② 后** | 双击 `打包上传.bat`，把新 zip 更新到 Netlify | 网页会开始提交 `is_urgent` 字段 |

如果顺序反了，网页提交时会报：
`数据库里缺少字段（Could not find the 'is_urgent' column...）` ——
这时不用慌，按 ① 跑一遍 SQL 就好了，网页不用重传。

> 本地数据库（`server/class_bulletin.db`）**不需要手动处理**：
> `serve.py` 启动时会自动检测并补列，老公告一条都不会丢。

---

## 五、★ 备份：把每一条公告都存成 Word

**为什么要做**：网站托管在别人家（Netlify）、数据也存在别人家（Supabase）。
万一哪天网站失效且无法挽回，你手上得有内容本身。

所以本项目有**三道保险**，每一条公告都会被写进 Word 文档：

| 保险 | 什么时候触发 | 产物 |
|---|---|---|
| ① **保存后询问**（默认） | 管理页**发布 / 保存修改**成功后弹对话框，你选「下载」还是「不用了」 | `班级公告栏备份-2026-10-10-2014.docx` |
| ② 手动导出 | 管理页右上角 **「导出 Word 备份」**（含定时未发布内容）<br>同学页页脚角落 **「下载 Word 备份」**（只含已发布内容） | 同上 |
| ③ 本地脚本（**网站挂了也能用**） | `python tools/backup-to-word.py` | `.docx` + `.json` 存到 `backups/` |

第 ③ 条最关键：它**直连 Supabase**，完全不经过网站。
所以即使 Netlify 上的网站彻底打不开，只要云端数据还在，你依然能导出全部公告。

**备份的三种模式**（改 `web/js/config.js` 里的 `backup.mode`）：

| 值 | 行为 |
|---|---|
| `'ask'` | **默认**。每次保存后弹出对话框询问 |
| `'auto'` | 不询问，直接下载（以前的行为） |
| `'off'` | 不自动下载，只用手动按钮或本地脚本 |

> 对话框里的「以后不再询问」会记住你的选择；想改回来，
> 管理页右侧有一个同名开关（**每次保存后询问是否下载 Word 备份**）。

```bat
:: 从云端导出（生成的 Word 在 backups\ 目录）
python tools/backup-to-word.py

:: 导出到指定目录（例如同步盘、U 盘）
python tools\backup-to-word.py --out-dir D:\班级备份

:: 云端也没了？用之前留下的 json 重新生成 Word
python tools\backup-to-word.py --from-json backups\班级公告栏备份-2026-10-10-2014.json
```

**关于文件名**：每次都带时间戳，**不会覆盖旧备份**，等于自动留下历史快照。

**如果网站真的没了怎么恢复**：

1. Word 文档是给人看的，内容可以直接复制粘贴到任何地方
2. `backups/*.json` 是给程序看的原始数据 —— 把里面的 `messages` 数组重新写入
   新的 Supabase（或本地 `python serve.py` 的数据库）即可完整恢复
3. 你的整个项目还在 `D:\learn web`，换一个托管平台重新拖一次 zip 就能重新上线

> 建议：把 `backups\` 目录定期复制到网盘或 U 盘。备份放在同一台电脑上，
> 电脑坏了就一起没了。

---

## 六、★ 以后想加功能，改哪里

### 5.1 对照表

| 想加的功能 | 要改的文件 | 说明 |
|---|---|---|
| 新增一个字段 | `supabase/schema.sql` → `server/db.py` → `contract.js` → `admin.js` 表单 → `message-card.js` 显示 | 5 处，都是独立文件，互不牵连 |
| 分类标签 | 同上 + `app.js`（分组）+ `components.css`（徽章颜色） | |
| 置顶 | schema 加 `pinned` + 管理页复选框 + `db.py` 排序 | 排序规则只在 `db.py` / 查询里定义一次 |
| 截止日期倒计时 | 已有 `expires_at`，`time.js` 里加一个 `formatCountdown()` 即可 | |
| 附件 / 外链 | schema 加 `attachments jsonb` + 管理页上传/填链接 + 卡片模板 | 文件可放静态托管的 `web/assets/uploads/` |
| 搜索与筛选 | **只改前端**：`app.js` 里过滤 + 加一个输入框 | 不用碰后端 |
| 已读 / 未读标记 | **只改前端**：新增 `ui/read-state.js` 用 localStorage | 不用碰后端 |
| 同学投稿 + 审核 | schema 加 `status` 列 + 改 RLS 策略 + 管理页加"待审核"页 | 唯一的权限模型升级路径 |
| 换数据库 / 自建后端 | 新增 `data/你的.js` 实现 7 个方法 + `data/index.js` 加一行 | **界面代码完全不动** |
| 换配色 / 深色模式 / 字号 | `css/tokens.css` | |
| 换卡片样式 | `ui/message-card.js` + `components.css` | |
| 换部署位置 | 不用改代码，`web/` 换个地方上传即可 | |

### 5.2 照抄：加一个字段（以"分类 category"为例）

**第 1 步** — `supabase/schema.sql` 末尾加一行，然后在 Supabase SQL Editor 跑一次：

```sql
alter table public.messages add column if not exists category text;
```

**第 2 步** — `server/db.py`：在 `SCHEMA` 里的 `is_urgent integer not null default 0,` 下面加 `category text,`，
并在 `_migrate()` 里补一句（**这步别省**）：

```python
    if "category" not in columns:
        conn.execute("alter table messages add column category text")
        conn.commit()
```

并在 `create_message()` 的 insert、`update_message()` 的赋值分支里加上这一列。

> ⚠️ 注意：SQLite 的 `create table if not exists` **不会给已有表加列**。
> 所以必须像 `is_urgent` 那样在 `_migrate()` 里显式补，否则老用户一升级就报
> `no such column: category`。删库重建只适合你本地测试，**线上同学们的数据不能删**。

**第 3 步** — `web/js/data/contract.js` 的结构注释里加：

```js
 * @property {string} category
```

**第 4 步** — `web/js/data/supabase.js` 的 `normalizeMessage()` 里加：

```js
    category: String(record.category || ''),
```

**第 5 步** — `web/js/admin.js` 的 `buildForm()` 里加一个输入框，并在 `onSubmit()` 的 `payload` 里带上 `category`。

**第 6 步** — `web/js/ui/message-card.js` 里加个徽章显示分类：

```js
  if (message.category) {
    badges.append(el('span', { class: 'badge badge--accent', text: message.category }));
  }
```

改完跑一下测试（第六节），确认没弄坏过期判断。

### 5.3 照抄：换一个数据源

前端只认 [web/js/data/contract.js](web/js/data/contract.js) 里的 7 个方法。
例如接一个自建后端：

```js
// web/js/data/myapi.js
import { DataError } from './contract.js';

export function createMyApiSource() {
  const base = 'https://你的后端地址';
  return {
    name: 'myapi',
    canWrite: true, // 设成 false 界面会自动变成只读

    async listMessages() {
      const response = await fetch(`${base}/messages`);
      if (!response.ok) throw new DataError(`读取失败（HTTP ${response.status}）`);
      return response.json();
    },
    async createMessage(input) {
      const response = await fetch(`${base}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!response.ok) throw new DataError('发布失败');
      return response.json();
    },
    async updateMessage(id, patch) { /* 同理 */ },
    async deleteMessage(id) { /* 同理 */ },
    async signIn(email, password) { /* 返回 Session 或抛 DataError */ },
    async signOut() { /* 清掉登录态 */ },
    getSession() { return null; },
  };
}
```

然后在 `web/js/data/index.js` 里加一个分支：

```js
import { createMyApiSource } from './myapi.js';
// switch 里加：
    case 'myapi':
      return createMyApiSource();
```

最后把 `config.js` 的 `dataSource` 改成 `'myapi'`。**`app.js`、`admin.js`、所有 CSS 都不用动。**

### 5.4 照抄：换配色 / 加一个主题

只改 `web/css/tokens.css` 顶部的变量，例如主色从蓝改成绿：

```css
:root {
  --color-accent: #0a6c4a;
  --color-accent-soft: #e3f6ee;
}
```

深色模式在同一文件的 `@media (prefers-color-scheme: dark)` 里对应改一份。
想加一套"节日主题"，把变量抽成 `[data-theme="spring"]` 选择器即可。

### 5.5 搜索与筛选已经做好了，想扩展看这里

同学页已经有**关键词搜索 + 日期范围筛选**，代码分两层，扩展时别把逻辑写进 DOM：

| 文件 | 管什么 |
|---|---|
| `web/js/ui/filter.js` | **纯函数**：`sortMessages` / `matchesKeyword` / `rangeFromDateInputs` / `filterMessages` / `hasActiveFilter`（**有单测**） |
| `web/js/ui/filter-bar.js` | 只负责画界面、把变化回调出去 |
| `web/js/app.js` | 把条件存进 `filters`，`render()` 时调用 `filterMessages()` |

**举例：想再加一个"只看紧急公告"的开关**

1. 在 `filter.js` 里给 `filterMessages` 增加一个条件（保持纯函数）：

   ```js
   export function filterMessages(messages, conditions = {}) {
     const { keyword = '', from = null, to = null, urgentOnly = false } = conditions;
     // ...原有逻辑后面再加一句
     if (urgentOnly && !isUrgentMessage(message)) return false;
   ```

2. 在 `filter-bar.js` 里加一个复选框，`emit()` 时带上 `urgentOnly`
3. 在 `app.js` 的 `onChange` 里存进 `filters`
4. **在 `tools/tests/filter.test.js` 里补一条测试**，跑 「跑测试.bat」

排序也一样：规则只在 `sortMessages()` 里定义一次，首页和管理页共用 ——
不要在两处各写一份，否则两边顺序会不一致。

---

## 七、测试与自检

```bat
:: 前端逻辑 + 数据层 + DOM 渲染 + Word 生成（89 项）
"C:\Program Files\nodejs\node.exe" --test "tools/tests/*.test.js"

:: 后端接口端到端 + 老库迁移（44 项）
python tools/tests/api_smoke.py

:: 上传前的机密 key 检测器（15 项）
python tools/tests/package_scan_test.py

:: Word 备份生成器（36 项，含"正文标识"与"浏览器端产物"的交叉验证）
python tools/tests/backup_docx_test.py

:: schema.sql 的语句顺序（9 项，防止升级时报 42703）
python tools/tests/schema_order_test.py

:: 主题一致性（34 项）：CSS 变量有没有悬空、深色模式有没有漏、文字对比度够不够
python tools/tests/theme_test.py

:: 云端自检：用真实代码去读一次你的 Supabase（只读，不改任何东西）
"C:\Program Files\nodejs\node.exe" tools\live-check.js
:: 加上这个参数，会额外验证"同学不能偷偷发布"
"C:\Program Files\nodejs\node.exe" tools\live-check.js --check-write
```

> 合计 **484 项**。懒得一条条敲就**双击根目录的 `跑测试.bat`**，它会把上面 8 个套件依次跑完。

node 不在 PATH 时用完整路径：
`"C:\Program Files\nodejs\node.exe" --test "tools/tests/*.test.js"`

| 文件 | 覆盖内容 |
|---|---|
| `tools/tests/time.test.js` | 过期判定、定时发布、时间显示格式、**发布时间校验**（过去的/未来的/乱填的） |
| `tools/tests/filter.test.js` | 搜索关键词、日期范围筛选（**含边界当天**）、**紧急优先排序** |
| `tools/tests/dom.test.js` | DOM 工具：文字/数组/条件渲染，以及**子节点误传对象时不能显示成 `[object Object]`** |
| `tools/tests/render.test.js` | **渲染冒烟测试**：把所有组件（卡片/图标/状态/筛选栏/对话框）真的渲染一遍，断言**一条警告都没有** |
| `tools/tests/fake-dom.js` | 上面两个测试共用的最小 DOM 替身（不是测试文件，不会被当成测试跑） |
| `tools/tests/docx.test.js` | **Word 文件字节级校验**：zip 结构、CRC32、XML 转义、控制字符清理 |
| `tools/tests/supabase_adapter.test.js` | 请求头（含新旧 key 格式）、401 自动续期、机密 key 拦截、各种错误提示 |
| `tools/tests/api_smoke.py` | 登录、增删改查、未授权写入被拒、排序、静态文件 MIME |
| `tools/tests/package_scan_test.py` | 上传前的机密 key 检测（既不误报注释，也不漏报真 key） |
| `tools/tests/backup_docx_test.py` | Word 备份的内容与状态判断、**正文标识与缩进**、两套实现排版是否一致；并调 node 交叉验证浏览器端产物 |
| `tools/tests/theme_test.py` | **主题体检**：`var(--x)` 有没有悬空、深色模式有没有漏项、文字对比度是否达到 WCAG 4.5:1、字号阶梯是否递增 |
| `tools/tests/security_test.py` | **安全防护**（62 项）：锁定递增数学（10→30 分、20→60 分、30→90 分、31→永久）、攻击特征识别、**正常请求零误报**、黑名单持久化与损坏容错 |
| `tools/tests/mirror_tool_test.py` | 备用镜像发布工具（33 项）：**抓真实 HTTP 头**验证密钥该放 `apikey` 头，以及密钥形状校验、桶预检 |
| `tools/tests/mirror-function.test.js` | 备用镜像的 Edge Function（16 项）：**上游给 `text/plain`、函数必须返回 `text/html`**、不透传 Storage 的 sandbox CSP、路径穿越拦截、只允许读取 |
| `tools/tests/schema_order_test.py` | 检查 `schema.sql` 的语句顺序：**引用某列的语句不能早于加这一列**（曾因此报 42703，导致升级失败） |
| `tools/live-check.js` | **不测代码，测你的云端**：key 类型、地址、能否真的读到公告、**公开注册是否已关闭** |
| `tools/attack-check.py` | **模拟攻击演练**：用真实攻击手法打一遍自己的网站（26 项），验证防护是不是真的生效。**不在 `跑测试.bat` 里**，因为它会访问真实云端 |
| `tools/publish-mirror.py` | 把 `dist/` 上传到 Supabase Storage。**⚠️ 已证明无法产出可访问的网站**（Supabase 会把 `text/html` 强制降级为 `text/plain` 并加 sandbox CSP —— Storage 和 Edge Function 都一样）。保留仅作排查记录，见 `安全设置.md` |
| `supabase/mirror.sql` | 建备用镜像用的公开存储桶（跑一次即可） |
| `supabase/functions/mirror/index.ts` | 备用镜像的 Edge Function：从 Storage 取文件并用**正确的 Content-Type** 返回（Storage 自己会把 HTML 降级成 text/plain，所以必须有这一层） |
| `tools/package-web.py` | 打包 `class-bulletin.zip` 与 `dist/`，并扫描有没有把机密 key 打进去 |
| `tools/backup-to-word.py` | **不经过网站**直连云端，把全部公告导出成 Word + JSON |
| `web/_headers` | Netlify 安全响应头（防 MIME 嗅探、防点击劫持等）；放在发布目录根目录即生效，拖 zip 部署同样管用 |

> 「昨天还能用今天不行了」先跑 「云端自检.bat」，它会给出一句话结论。

**改动后建议至少跑一遍**，尤其是动了 `time.js` 或 `db.py` 之后。

---

## 八、遇到问题

| 现象 | 原因 / 处理 |
|---|---|
| 首页提示"还没有连接到服务器" | `config.js` 里 `supabase.url` 没填（本地跑请留空用 `python serve.py`） |
| **部署成功但打开报"响应时间太长"`ERR_CONNECTION_TIMED_OUT`** | 不是你的文件传错了，是**该平台域名在国内被墙**。Cloudflare `workers.dev`/`pages.dev`、Vercel、GitHub 都不通；**改用 Netlify**（实测可用）。判断方法：`Resolve-DnsName <你的域名>` 返回的 IP 不对就是被污染 |
| **站点报 401，响应体标题是 `Password Protection`** | Netlify 新项目**默认是私有（Private）**，没对公众开放。认领项目后到 **Project configuration → Access & security → Project visibility** 改成 **Public** |
| **手机 Chrome 打不开，换默认浏览器立刻正常** | 关掉 Chrome 的**「精简模式 / 数据节省」** —— 它会把手机流量绕道 Google 服务器，国内必然失败。实测：同一台手机、同一条 5G，默认浏览器正常，Chrome 报 `ERR_CONNECTION_CLOSED`／`ERR_CONNECTION_ABORTED`（连不存在的 netlify 站点也一样，所以不是缓存问题） |
| 公开注册还开着（别人能自己注册发帖） | Authentication → Sign In / Providers → 关掉 `Allow new users to sign up`；用 「云端自检.bat」 可复查 |
| 登录提示"邮箱或口令不正确" | 本地看 `local_config.json`；云端确认账号已创建且勾了 Auto Confirm |
| 把某个 key 当密码登录 | **key 不是密码**。登录用"邮箱 + 密码"（第 4 步建的账号）；`config.js` 只需 publishable key |
| 网页弹红字"key 填错了，已停止运行" | 你把 secret / `service_role` key 填进了 `config.js`。到 Settings → API Keys 删掉并轮换，改填 publishable key |
| 发布报"没有写入权限" | Supabase 没关闭注册，或 `schema.sql` 没跑成功 → 重跑一次 |
| **发布报"数据库里缺少字段"（PGRST204 / Could not find the column）** | 升级后没跑 SQL 迁移。到 Supabase → SQL Editor 把 `supabase/schema.sql` **整个重跑一遍**（可重复执行，不丢数据），网页不用重传 |
| **跑 SQL 报 `ERROR 42703: column ... does not exist`** | 脚本里"引用某列"的语句（如 `comment on column`）排在了"加这一列"的 `alter table` 之前 —— v2 早期的 `schema.sql` 有这个顺序 bug。用修好的版本重跑；`tools/tests/schema_order_test.py` 会盯着这个顺序 |
| 报 `permission denied for table messages`（42501） | 建项目时"自动暴露新表"没勾，表没授权给数据接口。重跑 `schema.sql`（里面已有 `grant` 语句） |
| **详情页打不开 / 点「查看详情」404** | 说明线上还是旧版本（没有 `message.html`）。重新打包并更新已有项目即可 |
| **筛选选同一天却查不到公告** | 已经处理过：结束日期会算到当天 23:59:59。若仍异常，看 `filter.js` 的 `endOfDay` 是否被改动（有单测盯着这个边界） |
| **看不到紧急标记** | ①公告是否**已过发布时间**且**未过期**（过期的紧急公告会自动撤销标记）②数据库是否有 `is_urgent` 字段 ③浏览器强制刷新 |
| 首页一直转圈然后超时 | 到 Supabase 的网络不通。换 Region，或改用本地服务器方案 |
| 昨天还能用，今天全打不开 | 免费版项目因长期没人访问被**自动暂停**了。登录 Supabase 后台，在项目上点 **Resume project**（数据不会丢，暂停后 1 年内都能恢复） |
| 同学打开是空白 | 部署时拖错了目录，要拖 `web/` **里面**的文件 |
| 手机报「拒绝连接」`ERR_CONNECTION_REFUSED` | 多半是手机上打了 `127.0.0.1`（那指手机自己）。改用启动时打印的 `10.x` / `192.168.x` 地址 |
| 手机打不开局域网地址 | ①手机要连**同一个 Wi-Fi**，不能用流量（5G/4G）②换启动时打印的其它地址试试 ③允许 Python 通过防火墙 |
| 想确认到底该用哪个地址 | 在电脑上执行 `Get-NetIPAddress -AddressFamily IPv4`，找 `InterfaceAlias` 是 `WLAN` 或 `以太网` 且状态为 Up 的那一行 |
| 电脑上也打不开 | 确认 `serve.py` 窗口还开着；端口被占用就 `python serve.py --port 8788` |
| 端口被占用 | `python serve.py --port 8788` |
| 改了 CSS/JS 页面没变 | 强制刷新（Ctrl+F5）；手机上加个 `?v=2` 再打开 |
| 想清空本地数据 | 删掉 `server/class_bulletin.db` 再重启 |
| 双击 `.bat` 报 `'ho' 不是内部或外部命令`、`'o.' 不是…` | **`.bat` 文件必须用 CRLF 换行**。用 LF 换行时 cmd 会把行拆错（`echo.` 被解析成 `ho`）。修复：`(Get-Content -Raw 文件) -replace "\`n","\`r\`n"`，并用**无 BOM** 的 UTF-8 保存 |
| `python tools/xxx.py` 报 `No such file or directory` | 命令要在**项目目录**里跑。先 `cd /d "D:\learn web"`，或直接双击根目录里的 `.bat` 快捷方式 |
| **敲 `node xxx` 报「`node` 不是内部或外部命令」** | 这台电脑的 Node **没加进 PATH**（`node.exe` 在 `C:\Program Files\nodejs\`）。双击 `云端自检.bat` / `跑测试.bat` 即可（它们会自己找 node）；或写完整路径 `"C:\Program Files\nodejs\node.exe" ...`；或把 `C:\Program Files\nodejs` 加进系统 `Path` |

---

## 九、设计约定（新增代码请遵守）

1. **不用 `innerHTML` 写用户内容**，一律用 `ui/dom.js` 的 `el()` / `textContent`。
   这样标题里写 `<script>` 也只会当普通文字显示。
2. **时间统一用带时区的 ISO 字符串**（`2025-03-01T08:00:00+00:00`）。
   存进数据库前都转成 UTC，显示时再用浏览器本地时区。
3. **排序规则只定义一次**：前端在 `ui/filter.js` 的 `sortMessages()`（首页与管理页共用），
   后端负责给一个稳定的默认顺序（云端 `order=published_at.desc`，本地 `ORDER BY`）。
   不要在页面里各写一份，否则两处顺序会不一致。
4. **界面不含业务规则**：什么算过期在 `ui/time.js`，排序与筛选在 `ui/filter.js`，数据从哪来在 `data/`。
5. **加新后端只需实现 7 个方法**，并在 `data/index.js` 注册。
6. **配置集中在 `config.js`**，不要在业务代码里写死地址或班级名。
7. **加数据库字段必须同时改三处**：`supabase/schema.sql`（含 `alter ... if not exists` 迁移）、
   `server/db.py` 的 `SCHEMA` **和 `_migrate()`**、以及 `data/contract.js` 的结构注释。
   `create table if not exists` 不会给已有表加列，漏了 `_migrate()` 老用户就会报
   `no such column`。`api_smoke.py` 里有一条专门测这个。
8. **新增 `.bat` 文件必须用 CRLF 换行 + 无 BOM 的 UTF-8**。
   用 LF 换行时 cmd.exe 会把行拆错（`echo.` 会被当成 `ho`），
   Windows 上双击就报 `'ho' 不是内部或外部命令`。
9. **生成 Word 的代码有两份**（`web/js/ui/docx.js` 给浏览器、`tools/backup-to-word.py` 给本地脚本），
   改排版时两边都要改；`python tools/tests/backup_docx_test.py` 会交叉验证浏览器端产物是否合格。
10. **同学能看到的内容，必须能导出成 Word**：给公告加新字段时，
    记得同步更新 `data/backup.js` 的 `messagesToBlocks()` 和 `tools/backup-to-word.py` 的
    `build_document_xml()`，否则备份会缺字段。
