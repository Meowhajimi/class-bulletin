/**
 * 联网自检：用 config.js 里的地址与 key，真的去读一次公告。
 *
 * 用途：部署到公网前、或者"昨天还能用今天不行了"的时候，一条命令看清问题在哪。
 * 它只做只读操作，不会发布或修改任何内容。
 *
 * 运行：
 *   node tools/live-check.js
 *   （node 不在 PATH 时用完整路径，例如
 *     "C:\Program Files\nodejs\node.exe" tools/live-check.js）
 *
 * 想顺便测本地服务器？先在另一个窗口 `python serve.py`，再运行本命令。
 */

// supabase.js 会用到 localStorage（存登录态），Node 里没有，先补一个空的
globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const { CONFIG, inspectApiKey, resolveSupabaseUrl } = await import(
  new URL('../web/js/config.js', import.meta.url)
);
const { createSupabaseSource } = await import(
  new URL('../web/js/data/supabase.js', import.meta.url)
);

const ok = (text) => console.log(`  ✅ ${text}`);
const bad = (text) => console.log(`  ❌ ${text}`);
const info = (text) => console.log(`     ${text}`);

console.log('\n=== 班级公告栏 · 联网自检 ===\n');

console.log('1. 配置');
info(`数据源：${CONFIG.dataSource}`);

const keyCheck = inspectApiKey();
const keyLabel = {
  empty: '（留空 —— 本地服务器不需要 key）',
  publishable: '新版可发布 key（推荐）',
  anon: '旧版 anon key（仍然有效）',
  unknown: '无法识别的格式（先按通过处理）',
}[keyCheck.kind] || keyCheck.kind;
info(`key 类型：${keyLabel}`);

if (!keyCheck.ok) {
  bad('key 不能用于前端！');
  info(keyCheck.message);
  process.exit(1);
}

const url = resolveSupabaseUrl();
if (!url) {
  bad('没有可用的接口地址（config.js 里 supabase.url 是空的，且本页不是本地服务器）');
  process.exit(1);
}
ok(`接口地址：${url}`);

if (/supabase\.co$/.test(url) && keyCheck.kind === 'empty') {
  info('提醒：连真 Supabase 却没填 key，接下来会返回 401。');
}

console.log('\n2. 联网读取公告（只读，不会改任何东西）');

try {
  const started = Date.now();
  const messages = await createSupabaseSource().listMessages();
  const elapsed = Date.now() - started;

  ok(`连接成功，耗时 ${elapsed} ms`);
  ok(`读到 ${messages.length} 条公告`);

  if (messages.length === 0) {
    info('一条都没有是正常的 —— 可能你还没发布过公告。');
    info('如果确认发过了却读到 0 条，检查 RLS 的读策略（schema.sql 第 3 节）。');
  } else {
    info('最近 3 条：');
    for (const message of messages.slice(0, 3)) {
      info(`· ${message.title}  (${message.published_at})`);
    }
  }

  console.log('\n结论：云端一切正常，可以把 web/ 部署到公网了。\n');
} catch (error) {
  bad(error && error.message ? error.message : String(error));
  const detail = String((error && error.cause && JSON.stringify(error.cause)) || '');
  if (/42501|permission denied/i.test(detail) || /permission denied/i.test(String(error.message))) {
    info('这是缺 GRANT：把 supabase/schema.sql 重新完整跑一遍（里面有 grant 语句）。');
  }
  if (error && error.status === 404) {
    info('表不存在：schema.sql 还没跑成功。到 SQL Editor 里跑一遍。');
  }
  console.log('\n结论：云端还没接通，先按上面的提示处理。\n');
  process.exit(1);
}

// ============================================================
// 3. 安全检查（一）：公开注册有没有关掉
// ============================================================
console.log('\n3. 安全检查（一）：公开注册有没有关掉');

/**
 * Supabase 有个公开的只读接口 /auth/v1/settings，它的 disable_signup
 * 直接回答"路人能不能自己注册账号"。只读，没有任何副作用。
 */
async function readSignupSetting(base, key) {
  const response = await fetch(`${base}/auth/v1/settings`, {
    headers: key ? { apikey: key } : {},
  });
  if (!response.ok) return null;
  return response.json();
}

try {
  const settings = await readSignupSetting(url, CONFIG.supabase.anonKey.trim());
  if (!settings) {
    info('读不到这项设置（多半是连的本地服务器，本地服务器没有这个接口）—— 跳过');
  } else if (settings.disable_signup === true) {
    ok('公开注册已关闭：别人无法自己注册账号');
  } else {
    bad('公开注册【仍然开着】！别人可以自己注册账号');
    info('风险：发现你网址的人能自己注册，然后往公告栏里发内容（同学都看得到）。');
    info('修法：Supabase 后台 → Authentication → Sign In / Providers');
    info('      把「Allow new users to sign up」关掉并保存，然后重跑本命令确认。');
    info('（你自己在 Authentication → Users 里手工加的账号不受这个开关影响。）');
  }
} catch (error) {
  info(`跳过这项检查：${(error && error.message) || error}`);
}

// ============================================================
// 4. 安全检查（二）：未登录能不能偷偷发布
// ============================================================
console.log('\n4. 安全检查（二）：写入权限有没有被限制住');

if (!process.argv.includes('--check-write')) {
  info('默认跳过（因为要往数据库发一次请求）。想验证就运行：');
  info('  node tools/live-check.js --check-write');
} else {
  info('正在以"未登录的访客"身份尝试发布一条公告……');
  try {
    // 故意用空标题：万一 RLS 失效，也会被数据库的 CHECK 约束拦下，
    // 不会往你的公告栏里留下任何垃圾数据。
    await createSupabaseSource().createMessage({
      title: '',
      body: '这是一次权限自检，不应该被写入。',
    });
    bad('未登录居然发布成功了！');
    info('说明写入权限没有被限制。请检查 supabase/schema.sql 里的 RLS 策略是否跑成功。');
    info('（这条空标题记录应该已被数据库约束拦下，但仍请到后台确认一下。）');
  } catch (error) {
    if (error && (error.isAuthError || error.isPermissionError)) {
      ok(`未登录发布被拒绝（HTTP ${error.status}）`);
      ok('权限正确：同学只能看公告，不能发布或修改。');
    } else if (error && error.status === 400) {
      bad('请求进到了数据库层（返回 400 校验错误），说明 RLS 可能没拦住。');
      info('请重跑 supabase/schema.sql，确认三条写策略都存在。');
    } else {
      info(`试探结果：${(error && error.message) || error}`);
    }
  }
}

console.log('');

