/**
 * web/js/data/supabase.js 的单元测试。
 *
 * 这里用一个 Node 内置 http 起的假后端，专门验证适配器自己的逻辑：
 *   - 请求头是否正确（apikey / Authorization / Prefer）
 *   - 401 时会不会自动续期并重试
 *   - 各种错误有没有变成同学看得懂的提示
 * 真实的接口语义由 tools/tests/api_smoke.py 对着真服务器验证，两边互补。
 *
 * 运行：node --test "tools/tests/*.test.js"
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { CONFIG, resolveSupabaseUrl, shouldUseCaptcha } from '../../web/js/config.js';

// Node 里没有 localStorage，先补一个假的，再导入适配器
const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
  clear: () => store.clear(),
};

const { createSupabaseSource } = await import('../../web/js/data/supabase.js');
const { DataError } = await import('../../web/js/data/contract.js');

const FRESH_TOKEN = 'fresh-token';
const STALE_TOKEN = 'stale-token';

/** 每个测试用到的假后端行为开关 */
const backend = {
  /** 写入接口是否强制要求 FRESH_TOKEN（用来验证自动续期） */
  strictToken: false,
  /** 非 0 时，写入接口直接返回这个状态码（用来验证 403 提示） */
  writeStatus: 0,
  /** 为真时登录接口返回 captcha_failed（用来验证验证码失败提示） */
  captchaFailure: false,
  /** 非 0 时，栏目接口直接返回这个状态码（409 重名 / 403 等） */
  sectionWriteStatus: 0,
  /** 栏目写失败时用的错误码：23505 重名 / 23503 外键限制 */
  sectionWriteCode: '23505',
  requests: /** @type {Array<{method: string, path: string, headers: any, body: any}>} */ ([]),
  refreshCalls: 0,
  messages: [
    { id: 'm1', title: '第一条', body: '正文', published_at: '2025-03-01T00:00:00+00:00', expires_at: null },
  ],
  sections: [
    { id: 'sec-study', name: '学习委员通知', created_at: '2025-01-01T00:00:00+00:00' },
    { id: 'sec-class', name: '班级事务', created_at: '2025-02-01T00:00:00+00:00' },
  ],
};

/** 只挑发往栏目接口的请求 */
function sectionRequests(method) {
  return backend.requests.filter(
    (item) => item.method === method && item.path === '/rest/v1/sections',
  );
}

/** 只挑发往公告接口的请求，避免把登录请求也算进来 */
function messageRequests(method) {
  return backend.requests.filter(
    (item) => item.method === method && item.path === '/rest/v1/messages',
  );
}

/** 取登录请求（挂在 /auth/v1/token 上，所以不能用上面那个） */
function loginRequests() {
  return backend.requests.filter((item) => item.path.startsWith('/auth/v1/token'));
}

function readBody(request) {
  return new Promise((resolve) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : null);
      } catch {
        resolve(raw);
      }
    });
  });
}

function sendJson(response, status, payload) {
  const body = payload === null ? '' : JSON.stringify(payload);
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(body);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  const body = await readBody(request);
  backend.requests.push({
    method: request.method,
    path: url.pathname,
    search: url.search,
    headers: request.headers,
    body,
  });

  const bearer = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '');

  // ---- 登录 ----
  if (url.pathname === '/auth/v1/token') {
    const grant = url.searchParams.get('grant_type');
    if (grant === 'password') {
      // 模拟 Supabase 开了 CAPTCHA 但 token 不对时的真实返回结构
      if (backend.captchaFailure) {
        return sendJson(response, 400, {
          code: 400,
          error_code: 'captcha_failed',
          msg: 'captcha protection: request disallowed (invalid-input-response)',
        });
      }
      if (body && body.password === 'right-password') {
        return sendJson(response, 200, {
          access_token: STALE_TOKEN,
          refresh_token: 'refresh-1',
          expires_in: 3600,
          user: { id: 'u1', email: body.email },
        });
      }
      // 模拟"账号存在但没点确认"的真实返回结构
      if (body && body.password === 'unconfirmed-password') {
        return sendJson(response, 400, {
          code: 400,
          error_code: 'email_not_confirmed',
          msg: 'Email not confirmed',
        });
      }
      return sendJson(response, 400, {
        error: 'invalid_grant',
        error_description: 'Invalid login credentials',
      });
    }
    if (grant === 'refresh_token') {
      backend.refreshCalls += 1;
      return sendJson(response, 200, {
        access_token: FRESH_TOKEN,
        refresh_token: 'refresh-2',
        expires_in: 3600,
        user: { id: 'u1', email: 'admin@test.local' },
      });
    }
  }

  if (url.pathname === '/auth/v1/logout') return sendJson(response, 204, null);

  // ---- 公告 ----
  if (url.pathname === '/rest/v1/messages') {
    const writing = request.method !== 'GET';
    if (writing && backend.writeStatus) {
      return sendJson(response, backend.writeStatus, {
        message: backend.writeStatus === 400
          ? "Could not find the 'is_urgent' column of 'messages' in the schema cache"
          : 'new row violates row-level security policy',
        ...(backend.writeStatus === 400 ? { code: 'PGRST204' } : {}),
      });
    }
    if (writing) {
      const allowed = backend.strictToken ? FRESH_TOKEN : STALE_TOKEN;
      if (bearer !== allowed) {
        return sendJson(response, 401, { message: '未登录或登录已过期' });
      }
      if (request.method === 'DELETE') return sendJson(response, 204, null);
      if (request.method === 'POST') {
        const created = { id: 'new-1', ...body, created_at: '', updated_at: '' };
        backend.messages.push(created);
        return sendJson(response, 201, [created]);
      }
      if (request.method === 'PATCH') {
        return sendJson(response, 200, [{ id: 'm1', ...body }]);
      }
    }
    return sendJson(response, 200, backend.messages);
  }

  // ---- 栏目 ----
  if (url.pathname === '/rest/v1/sections') {
    const writing = request.method !== 'GET';

    if (writing && backend.sectionWriteStatus) {
      // 23505 = 重名，23503 = 外键限制（栏目里还有公告）
      const code = backend.sectionWriteCode || '23505';
      return sendJson(response, backend.sectionWriteStatus, {
        message:
          code === '23505'
            ? 'duplicate key value violates unique constraint "sections_name_key"'
            : 'update or delete on table "sections" violates foreign key constraint on table "messages"',
        code,
      });
    }

    if (writing) {
      if (bearer !== STALE_TOKEN) {
        return sendJson(response, 401, { message: '未登录或登录已过期' });
      }
      if (request.method === 'DELETE') return sendJson(response, 204, null);
      if (request.method === 'POST') {
        const created = { id: 'sec-new', name: body && body.name, created_at: '' };
        backend.sections.push(created);
        return sendJson(response, 201, [created]);
      }
      if (request.method === 'PATCH') {
        const id = (url.searchParams.get('id') || '').replace(/^eq\./, '');
        return sendJson(response, 200, [{ id, name: body && body.name, created_at: '' }]);
      }
    }
    return sendJson(response, 200, backend.sections);
  }

  return sendJson(response, 404, { message: 'not found' });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

/** 每个测试开头重置状态 */
function reset({ strictToken = false } = {}) {
  store.clear();
  backend.requests = [];
  backend.refreshCalls = 0;
  backend.strictToken = strictToken;
  backend.writeStatus = 0;
  backend.captchaFailure = false;
  backend.sectionWriteStatus = 0;
  backend.sectionWriteCode = '23505';
  backend.sections = [
    { id: 'sec-study', name: '学习委员通知', created_at: '2025-01-01T00:00:00+00:00' },
    { id: 'sec-class', name: '班级事务', created_at: '2025-02-01T00:00:00+00:00' },
  ];
  CONFIG.dataSource = 'supabase';
  CONFIG.supabase.url = base;
  CONFIG.supabase.anonKey = 'test-anon-key';
  // 验证码默认关掉：需要它的那几条测试会自己打开
  CONFIG.captcha = CONFIG.captcha || {};
  CONFIG.captcha.turnstileSiteKey = '';
}

test.after(() => {
  server.close();
});

test('没填地址时给出明确的未配置提示', async () => {
  reset();
  CONFIG.supabase.url = '';
  const source = createSupabaseSource();
  await assert.rejects(
    () => source.listMessages(),
    (error) => {
      assert.ok(error instanceof DataError);
      assert.equal(error.isNotConfigured, true);
      assert.match(error.message, /config\.js/);
      return true;
    },
  );
});

test('读取列表：带 apikey 头、能解析数组、缺字段会自动补全', async () => {
  reset();
  const source = createSupabaseSource();
  const messages = await source.listMessages();

  assert.equal(messages.length, 1);
  assert.equal(messages[0].title, '第一条');
  assert.equal(messages[0].expires_at, null);
  // 后端没返回的字段也要有值，界面才不会拿到 undefined
  assert.equal(typeof messages[0].body, 'string');
  assert.equal(typeof messages[0].updated_at, 'string');
  // 紧急字段缺失时要归一成布尔 false，不能是 undefined
  assert.equal(messages[0].is_urgent, false);

  const listRequest = backend.requests.find((item) => item.method === 'GET');
  assert.equal(listRequest.headers.apikey, 'test-anon-key');
  assert.match(listRequest.search, /order=published_at\.desc/);
});

test('is_urgent 会归一成布尔，且创建时带上该字段', async () => {
  reset();
  const source = createSupabaseSource();
  await source.signIn('admin@test.local', 'right-password');

  await source.createMessage({ title: '紧急通知', body: '', is_urgent: true });
  const posted = messageRequests('POST')[0];
  assert.equal(posted.body.is_urgent, true, '创建请求必须带上 is_urgent');

  await source.createMessage({ title: '普通通知', body: '' });
  const second = messageRequests('POST')[1];
  assert.equal(second.body.is_urgent, false, '没传时也要显式发 false');
});

test('数据库缺字段（PGRST204）时提示去重跑 schema.sql', async () => {
  reset();
  backend.writeStatus = 400; // 后端返回 PGRST204 + Could not find the column

  const source = createSupabaseSource();
  await source.signIn('admin@test.local', 'right-password');

  await assert.rejects(
    () => source.createMessage({ title: '会被拒绝', body: '' }),
    (error) => {
      assert.match(error.message, /缺少字段/, '要说清是数据库缺字段');
      assert.match(error.message, /schema\.sql/, '要给出可执行的下一步');
      return true;
    },
  );
});

test('新版可发布 key 只放 apikey，绝不能当 Bearer 发（否则 401）', async () => {
  reset();
  CONFIG.supabase.anonKey = 'sb_publishable_abcdefghijklmnop';
  const source = createSupabaseSource();
  await source.listMessages();

  const request = backend.requests.find((item) => item.method === 'GET');
  assert.equal(request.headers.apikey, 'sb_publishable_abcdefghijklmnop');
  assert.equal(
    request.headers.authorization,
    undefined,
    '新版 key 是普通短字符串不是 JWT，当 Bearer 会被判为无效令牌',
  );
});

test('旧版 anon key（JWT）才同时放进 apikey 与 Authorization', async () => {
  reset();
  // 造一个 JWT 结构，payload 里 role 是 anon
  const payload = Buffer.from(JSON.stringify({ role: 'anon', iss: 'supabase' })).toString('base64url');
  const legacyJwt = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${payload}.signature`;
  CONFIG.supabase.anonKey = legacyJwt;

  const source = createSupabaseSource();
  await source.listMessages();

  const request = backend.requests.find((item) => item.method === 'GET');
  assert.equal(request.headers.apikey, legacyJwt);
  assert.equal(request.headers.authorization, `Bearer ${legacyJwt}`, '旧版写法要保持兼容');
});

test('填了 sb_secret_ 机密 key 时拒绝请求，绝不把它发出去', async () => {
  reset();
  CONFIG.supabase.anonKey = 'sb_secret_verysecretvalue';
  const source = createSupabaseSource();

  await assert.rejects(
    () => source.listMessages(),
    (error) => {
      assert.equal(error.code, 'UNSAFE_KEY');
      assert.match(error.message, /机密 key/);
      assert.match(error.message, /API Keys/, '要告诉他去哪儿改');
      return true;
    },
  );

  assert.equal(
    backend.requests.length,
    0,
    '一个请求都不该发出去 —— 机密 key 一旦离开浏览器就等于泄露',
  );
});

test('填了旧版 service_role JWT 时同样拒绝', async () => {
  reset();
  const payload = Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url');
  CONFIG.supabase.anonKey = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${payload}.signature`;
  const source = createSupabaseSource();

  await assert.rejects(
    () => source.listMessages(),
    (error) => {
      assert.equal(error.code, 'UNSAFE_KEY');
      assert.match(error.message, /service_role/);
      return true;
    },
  );
  assert.equal(backend.requests.length, 0);
});

test('发布：必须带上 Prefer 头与登录令牌（这是之前的真实 bug）', async () => {
  reset();
  const source = createSupabaseSource();
  await source.signIn('admin@test.local', 'right-password');

  const created = await source.createMessage({
    title: '新公告',
    body: '正文',
    published_at: '2025-04-01T00:00:00.000Z',
    expires_at: null,
  });

  assert.equal(created.id, 'new-1');
  const post = messageRequests('POST')[0];
  assert.ok(post, '应该有发往公告接口的 POST');
  assert.equal(post.headers.prefer, 'return=representation');
  assert.equal(post.headers.authorization, `Bearer ${STALE_TOKEN}`);
  assert.equal(post.body.title, '新公告');
  assert.equal(post.body.expires_at, null);
});

test('登录成功后会把登录态存起来', async () => {
  reset();
  const source = createSupabaseSource();
  const session = await source.signIn('ADMIN@test.local', 'right-password');
  assert.equal(session.accessToken, STALE_TOKEN);
  assert.equal(source.getSession().accessToken, STALE_TOKEN);
});

test('口令错误时提示"邮箱或口令不正确"', async () => {
  reset();
  const source = createSupabaseSource();
  await assert.rejects(
    () => source.signIn('admin@test.local', 'wrong'),
    (error) => {
      assert.equal(error.isAuthError, false);
      assert.match(error.message, /邮箱或口令不正确/);
      return true;
    },
  );
});

test('access token 过期时会自动续期并重试成功', async () => {
  reset({ strictToken: true });
  const source = createSupabaseSource();
  await source.signIn('admin@test.local', 'right-password');

  const created = await source.createMessage({ title: '续期后发布', body: '' });

  assert.equal(created.id, 'new-1');
  assert.equal(backend.refreshCalls, 1, '应该只续期一次');
  const posts = messageRequests('POST');
  assert.equal(posts.length, 2, '应该先失败一次再重试一次');
  assert.equal(posts[1].headers.authorization, `Bearer ${FRESH_TOKEN}`, '重试要用新令牌');
});

test('账号没激活时，提示去勾 Auto Confirm User，而不是说口令错', async () => {
  reset();
  const source = createSupabaseSource();
  await assert.rejects(
    () => source.signIn('admin@test.local', 'unconfirmed-password'),
    (error) => {
      assert.match(error.message, /还没激活/, '要说清是没激活，不是口令错');
      assert.match(error.message, /Auto Confirm User/, '要给出下一步怎么修');
      assert.doesNotMatch(error.message, /口令不正确/, '不能误导成口令错误');
      return true;
    },
  );
});

test('没有登录态时遇到 401，提示去检查 anonKey', async () => {
  reset({ strictToken: true });
  const source = createSupabaseSource();
  await assert.rejects(
    () => source.createMessage({ title: '没有登录', body: '' }),
    (error) => {
      assert.equal(error.isAuthError, true);
      assert.match(error.message, /anonKey/);
      return true;
    },
  );
});

test('连不上本地服务器时，提示指向 python serve.py（给站长的）', async () => {
  reset();
  CONFIG.supabase.url = 'http://127.0.0.1:1';
  const source = createSupabaseSource();
  await assert.rejects(
    () => source.listMessages(),
    (error) => {
      assert.equal(error.isNetworkError, true);
      assert.match(error.message, /本地服务器/);
      assert.match(error.message, /python serve\.py/);
      return true;
    },
  );
});

test('★ 连不上云端时，绝不提 python（同学看不懂），而是提示重试/换网络', async () => {
  reset();
  // 一个「不像本地」的地址：连不上但会被判为云端
  CONFIG.supabase.url = 'https://not-reachable.invalid';
  const source = createSupabaseSource();
  await assert.rejects(
    () => source.listMessages(),
    (error) => {
      assert.equal(error.isNetworkError, true);
      assert.ok(
        !/python/.test(error.message),
        `给同学的提示里不该出现 python：${error.message}`,
      );
      assert.match(error.message, /重试/);
      assert.match(error.message, /换个网络/);
      return true;
    },
  );
});

test('★ 读取失败会自动重试，网络恢复后就能成功', async () => {
  reset();
  const source = createSupabaseSource();
  const realFetch = globalThis.fetch;
  let attempts = 0;
  // 前两次模拟丢包，第三次才真的发出去
  globalThis.fetch = async (...args) => {
    attempts += 1;
    if (attempts <= 2) throw new TypeError('fetch failed');
    return realFetch(...args);
  };
  try {
    const messages = await source.listMessages();
    assert.equal(attempts, 3, `应当试 3 次（2 次失败 + 1 次成功），实际 ${attempts} 次`);
    // 不断言条数：backend.messages 是跨测试共享的，前面的发布测试会往里加东西。
    // 这条测试只关心"重试后终于拿到结果"。
    assert.ok(Array.isArray(messages), '重试后应当拿到数组结果');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('★ 写入失败绝不自动重试（避免重复发布）', async () => {
  reset();
  const source = createSupabaseSource();
  await source.signIn('admin@test.local', 'right-password');

  const realFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    throw new TypeError('fetch failed');
  };
  try {
    await assert.rejects(() => source.createMessage({ title: '丢包时发布', body: '' }));
    assert.equal(attempts, 1, `写入只应尝试 1 次，实际 ${attempts} 次 —— 重试会导致重复发布`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('重试次数用完仍失败，就报错（不会一直转圈）', async () => {
  reset();
  CONFIG.request.retries = 2;
  const source = createSupabaseSource();
  const realFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    throw new TypeError('fetch failed');
  };
  try {
    await assert.rejects(() => source.listMessages());
    assert.equal(attempts, 3, `应当试 1+2=3 次，实际 ${attempts} 次`);
  } finally {
    globalThis.fetch = realFetch;
    reset();
    CONFIG.request.retries = 2;
  }
});

test('业务错误（401）不触发重试 —— 重试没有意义还浪费时间', async () => {
  reset({ strictToken: true });
  const source = createSupabaseSource();
  const realFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async (...args) => {
    attempts += 1;
    return realFetch(...args);
  };
  try {
    await assert.rejects(() => source.createMessage({ title: '没有登录', body: '' }));
    assert.equal(attempts, 1, `401 不该重试，实际试了 ${attempts} 次`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------------------------------------------------------------------------
// 换地址兜底：部署环境可能没有 /api 代理（比如还没配 Functions），
// 这时要自动退回直连 Supabase —— 所以"启用代理"绝不会让原本能用的环境变坏。
// ---------------------------------------------------------------------------

/** 假装页面跑在 Cloudflare Pages 上，这样主地址是 /api、直连是测试服务器 */
function pretendOnPages() {
  globalThis.location = {
    hostname: 'class-bulletin.pages.dev',
    origin: 'https://class-bulletin.pages.dev',
  };
  CONFIG.supabase.apiPath = '/api';
}

function stopPretending() {
  delete globalThis.location;
}

test('★ 没有 /api 代理时（404）自动退回直连，读取照常成功', async () => {
  reset();
  pretendOnPages();
  const realFetch = globalThis.fetch;
  const seen = [];
  // ★ 必须在任何请求之前装好替身，否则会真的去访问 pages.dev
  globalThis.fetch = async (url, init) => {
    seen.push(String(url));
    if (String(url).includes('/api/')) return new Response('not found', { status: 404 });
    return realFetch(url, init);
  };
  const source = createSupabaseSource();
  try {
    const messages = await source.listMessages();
    assert.ok(Array.isArray(messages), '退回直连后应当拿到数据');
    assert.ok(
      seen.some((url) => url.includes('/api/rest/v1/messages')),
      '应当先试同源代理',
    );
    assert.ok(
      seen.some((url) => url.startsWith(base) && url.includes('/rest/v1/messages')),
      '代理不可用后应当退回直连 Supabase',
    );
  } finally {
    globalThis.fetch = realFetch;
    stopPretending();
    reset();
  }
});

test('★ 代理不存在时 Pages 会回 405（实测），登录要能退回直连', async () => {
  reset();
  pretendOnPages();
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push(String(url));
    // Cloudflare Pages 上没有那个 Function 时，POST 静态资源就是 405
    if (String(url).includes('/api/')) return new Response('Method Not Allowed', { status: 405 });
    return realFetch(url, init);
  };
  const source = createSupabaseSource();
  try {
    const session = await source.signIn('admin@test.local', 'right-password');
    assert.ok(session.accessToken, '退回直连后应当能登录成功');
    assert.ok(
      seen.some((url) => url.startsWith(base) && url.includes('/auth/v1/token')),
      '登录应当退回直连 Supabase',
    );
  } finally {
    globalThis.fetch = realFetch;
    stopPretending();
    reset();
  }
});

test('★ 200 但返回的是网页（Pages 回落到 index.html）也要退回直连', async () => {
  // 这是实测遇到的真实情况：/api 上没有 Function 时，Pages 不是回 404，
  // 而是回 200 + text/html（整站首页）。只按状态码判断就会把 HTML 当数据。
  reset();
  pretendOnPages();
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push(String(url));
    if (String(url).includes('/api/')) {
      return new Response('<!DOCTYPE html>\n<html lang="zh-CN"><head>…</head></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }
    return realFetch(url, init);
  };
  const source = createSupabaseSource();
  try {
    const messages = await source.listMessages();
    assert.ok(Array.isArray(messages), '应当拿到真数据，而不是把 HTML 当数据');
    assert.ok(
      seen.some((url) => url.startsWith(base) && url.includes('/rest/v1/messages')),
      '应当退回直连 Supabase',
    );
  } finally {
    globalThis.fetch = realFetch;
    stopPretending();
    reset();
  }
});

test('★ 写入遇到 404（代理不存在）也退回直连 —— 请求根本没到 Supabase，不会重复发布', async () => {
  reset();
  pretendOnPages();
  const realFetch = globalThis.fetch;
  // 替身要先装好，登录本身也会走它
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/api/')) return new Response('not found', { status: 404 });
    return realFetch(url, init);
  };
  const source = createSupabaseSource();
  try {
    await source.signIn('admin@test.local', 'right-password');
    const created = await source.createMessage({ title: '退回直连发布', body: '正文' });
    assert.ok(created, '应当成功创建');
  } finally {
    globalThis.fetch = realFetch;
    stopPretending();
    reset();
  }
});

test('★ 写入遇到网络错误绝不换地址重试（可能已经发布成功，重试就会重复）', async () => {
  reset();
  // ★ 先"不在 Pages 上"登录（直连测试服务器），再假装在 Pages 上。
  //   否则登录会真的去访问线上 pages.dev —— 那会让测试依赖线上状态，
  //   代理上线前后结果不同（这个坑真的踩过一次）。
  const source = createSupabaseSource();
  await source.signIn('admin@test.local', 'right-password');

  pretendOnPages();
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    throw new TypeError('fetch failed');
  };
  try {
    await assert.rejects(() => source.createMessage({ title: '网络错误时发布', body: '' }));
    const writeAttempts = seen.filter((url) => url.includes('/rest/v1/messages')).length;
    assert.equal(
      writeAttempts,
      1,
      `写入只该试 1 个地址，实际试了 ${writeAttempts} 个 —— 换地址重试会重复发布`,
    );
  } finally {
    globalThis.fetch = realFetch;
    stopPretending();
    reset();
  }
});

test('★ 读取遇到网络错误会换地址（读是幂等的，多试无害）', async () => {
  reset();
  pretendOnPages();
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push(String(url));
    if (String(url).includes('/api/')) throw new TypeError('fetch failed');
    return realFetch(url, init);
  };
  const source = createSupabaseSource();
  try {
    const messages = await source.listMessages();
    assert.ok(Array.isArray(messages));
    assert.ok(
      seen.some((url) => url.startsWith(base) && url.includes('/rest/v1/messages')),
      '同源代理连不上时应当退回直连',
    );
  } finally {
    globalThis.fetch = realFetch;
    stopPretending();
    reset();
  }
});

test('删除会带上 id 过滤条件并返回空', async () => {
  reset();
  const source = createSupabaseSource();
  await source.signIn('admin@test.local', 'right-password');
  await source.deleteMessage('m1');
  const request = backend.requests.find((item) => item.method === 'DELETE');
  assert.match(request.search, /id=eq\.m1/);
});

test('登出后本地凭据会被清掉', async () => {
  reset();
  const source = createSupabaseSource();
  await source.signIn('admin@test.local', 'right-password');
  assert.ok(source.getSession());

  await source.signOut();
  assert.equal(source.getSession(), null);
});

test('登出时网络失败，本地凭据一样要清掉', async () => {
  reset();
  const source = createSupabaseSource();
  await source.signIn('admin@test.local', 'right-password');

  CONFIG.supabase.url = 'http://127.0.0.1:1';
  await source.signOut();
  assert.equal(source.getSession(), null);
});

test('写入失败返回 403 时，提示检查 Supabase 注册开关', async () => {
  reset();
  // 只让"写入公告"返回 403，登录接口保持正常
  backend.writeStatus = 403;

  const source = createSupabaseSource();
  await source.signIn('admin@test.local', 'right-password');
  await assert.rejects(
    () => source.createMessage({ title: '会被拒绝', body: '' }),
    (error) => {
      assert.equal(error.isPermissionError, true);
      assert.match(error.message, /没有写入权限/);
      return true;
    },
  );
});

/* ============================ 登录验证码 ============================ */

test('开了验证码时，token 必须放进 gotrue_meta_security.captcha_token', async () => {
  reset();
  const source = createSupabaseSource({
    captchaTokenProvider: async () => 'turnstile-token-abc',
  });
  await source.signIn('admin@test.local', 'right-password');

  const login = loginRequests()[0];
  assert.ok(login, '应当发出了登录请求');
  assert.deepEqual(
    login.body.gotrue_meta_security,
    { captcha_token: 'turnstile-token-abc' },
    '字段名写错的话 Supabase 会拒绝登录，所以这条要盯死',
  );
  assert.equal(login.body.email, 'admin@test.local');
  assert.equal(login.body.password, 'right-password');
});

test('没开验证码时，请求体里不能出现 gotrue_meta_security', async () => {
  reset();
  const source = createSupabaseSource({ captchaTokenProvider: async () => '' });
  await source.signIn('admin@test.local', 'right-password');

  const login = loginRequests()[0];
  assert.ok(login);
  assert.equal(
    'gotrue_meta_security' in login.body,
    false,
    '没开验证码时带上这个字段是多余的，也会让本地服务器困惑',
  );
});

test('验证码失败时给出可操作的提示，而不是误报成密码错误', async () => {
  reset();
  backend.captchaFailure = true;

  const source = createSupabaseSource({
    captchaTokenProvider: async () => 'bad-token',
  });

  await assert.rejects(
    () => source.signIn('admin@test.local', 'right-password'),
    (error) => {
      assert.match(error.message, /验证码/, '要说清是验证码的问题');
      assert.doesNotMatch(error.message, /口令不正确/, '不能误报成密码错，否则用户会一直改密码');
      assert.match(error.message, /turnstileSiteKey/, '要指出该去核对哪个配置');
      return true;
    },
  );
});

test('shouldUseCaptcha：没配 Site Key 时为假', async () => {
  reset();
  CONFIG.captcha = CONFIG.captcha || {};
  CONFIG.captcha.turnstileSiteKey = '';
  assert.equal(shouldUseCaptcha(), false);
});

test('shouldUseCaptcha：配了 Key 但目标是本地服务器时仍为假（本地必须能登录）', async () => {
  reset(); // 测试服务器就在 127.0.0.1
  CONFIG.captcha.turnstileSiteKey = 'site-key-123';
  assert.equal(shouldUseCaptcha(), false, '本地服务器不校验验证码，也不能被它卡住');
});

test('★ resolveSupabaseUrl：本地服务器上仍然直连它（不受 apiPath 影响）', async () => {
  reset();
  CONFIG.supabase.url = 'http://127.0.0.1:9999';
  CONFIG.supabase.apiPath = '/api';
  // Node 里没有 location，等价于"不在浏览器里"，应当回退到配置的地址
  assert.equal(resolveSupabaseUrl(), 'http://127.0.0.1:9999');
});

test('★ resolveSupabaseUrl：apiPath 留空时行为不变（直连 Supabase）', async () => {
  reset();
  CONFIG.supabase.url = 'https://example.supabase.co';
  CONFIG.supabase.apiPath = '';
  assert.equal(resolveSupabaseUrl(), 'https://example.supabase.co');
  CONFIG.supabase.apiPath = '/api';
});

test('★ config.js 里默认启用了同源 /api（这是绕开移动封锁的关键）', async () => {
  const raw = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../../web/js/config.js', import.meta.url), 'utf8'),
  );
  assert.match(
    raw,
    /apiPath:\s*'\/api'/,
    'apiPath 必须是 /api —— 浏览器直连 supabase.co 在中国移动上会被 ERR_CONNECTION_RESET',
  );
});

test('shouldUseCaptcha：配了 Key 且目标是云端时为真', async () => {
  reset();
  CONFIG.captcha.turnstileSiteKey = 'site-key-123';
  CONFIG.supabase.url = 'https://demo.supabase.co';
  assert.equal(shouldUseCaptcha(), true);
});

test('shouldUseCaptcha：localStorage 形式的 localhost 也算本地', async () => {
  reset();
  CONFIG.captcha.turnstileSiteKey = 'site-key-123';
  CONFIG.supabase.url = 'http://localhost:8787';
  assert.equal(shouldUseCaptcha(), false);
});

/* ============================== 栏目 ============================== */

test('listSections：GET /rest/v1/sections，按创建时间排序，字段被补全', async () => {
  reset();
  const sections = await createSupabaseSource().listSections();

  assert.equal(sections.length, 2);
  assert.deepEqual(sections[0], {
    id: 'sec-study',
    name: '学习委员通知',
    created_at: '2025-01-01T00:00:00+00:00',
  });

  const request = sectionRequests('GET')[0];
  assert.ok(request, '应该发出一次 GET /rest/v1/sections');
  assert.match(request.path, /\/rest\/v1\/sections/);
  assert.match(String(request.search || ''), /order=created_at/, '顺序由接口决定，前端不再排一遍');
});

test('listSections：缺 name 的脏数据给一个可读占位，不显示 undefined', async () => {
  reset();
  backend.sections = [{ id: 'sec-x', created_at: '' }];
  const sections = await createSupabaseSource().listSections();
  assert.equal(sections[0].name, '未命名栏目');
});

test('createSection：POST 带上 name 与 return=representation', async () => {
  reset();
  const source = createSupabaseSource();
  await source.signIn('admin@test.local', 'right-password');

  const created = await source.createSection('班委通知');

  assert.equal(created.name, '班委通知');
  const request = sectionRequests('POST')[0];
  assert.ok(request, '应该发出一次 POST /rest/v1/sections');
  assert.equal(request.body.name, '班委通知');
  assert.equal(request.headers.prefer, 'return=representation');
  assert.ok(request.headers.apikey, '要带 apikey');
});

test('★ 未登录时新增栏目会被拒（同学不能改栏目）', async () => {
  reset();
  const source = createSupabaseSource();

  await assert.rejects(
    () => source.createSection('偷偷加的栏目'),
    (error) => {
      assert.ok(error instanceof DataError);
      assert.equal(error.isAuthError, true, '应当是 401 登录态问题');
      return true;
    },
  );
});

test('renameSection：PATCH 到 ?id=eq.，并且 id 被转义', async () => {
  reset();
  const source = createSupabaseSource();
  await source.signIn('admin@test.local', 'right-password');

  const renamed = await source.renameSection('sec/weird id', '新名字');

  assert.equal(renamed.name, '新名字');
  const request = sectionRequests('PATCH')[0];
  assert.ok(request, '应该发出一次 PATCH');
  assert.match(String(request.search || ''), /id=eq\.sec%2Fweird%20id|id=eq\.sec\/weird/, 'id 要 URL 转义');
});

test('deleteSection：DELETE 到 ?id=eq.', async () => {
  reset();
  const source = createSupabaseSource();
  await source.signIn('admin@test.local', 'right-password');

  await source.deleteSection('sec-class');

  const request = sectionRequests('DELETE')[0];
  assert.ok(request, '应该发出一次 DELETE');
  assert.match(String(request.search || ''), /id=eq\.sec-class/);
});

test('★ 栏目重名（23505）给出中文提示，而不是原始数据库报错', async () => {
  reset();
  const source = createSupabaseSource();
  await source.signIn('admin@test.local', 'right-password');
  backend.sectionWriteStatus = 409;

  await assert.rejects(
    () => source.createSection('学习委员通知'),
    (error) => {
      assert.ok(error instanceof DataError);
      assert.match(error.message, /已经有同名栏目/);
      return true;
    },
  );
});

test('★ 栏目里还有公告时删除（23503）给出可操作的中文提示', async () => {
  reset();
  const source = createSupabaseSource();
  await source.signIn('admin@test.local', 'right-password');
  backend.sectionWriteStatus = 409;
  backend.sectionWriteCode = '23503';

  await assert.rejects(
    () => source.deleteSection('sec-study'),
    (error) => {
      assert.ok(error instanceof DataError);
      assert.match(error.message, /还有公告|不能删除/);
      return true;
    },
  );
});

test('createMessage：把 section_id 一起发给接口', async () => {
  reset();
  const source = createSupabaseSource();
  await source.signIn('admin@test.local', 'right-password');

  await source.createMessage({
    title: '发到班级事务',
    body: '正文',
    section_id: 'sec-class',
  });

  const request = messageRequests('POST')[0];
  assert.ok(request, '应该发出一次 POST');
  assert.equal(request.body.section_id, 'sec-class');
});

test('createMessage：没传 section_id 时发 null（由后端决定落到默认栏目）', async () => {
  reset();
  const source = createSupabaseSource();
  await source.signIn('admin@test.local', 'right-password');

  await source.createMessage({ title: '没有栏目', body: '' });

  const request = messageRequests('POST')[0];
  assert.equal(request.body.section_id, null);
});

test('normalizeMessage：返回的公告一定带 section_id 字段（哪怕是空串）', async () => {
  reset();
  const messages = await createSupabaseSource().listMessages();
  assert.equal(typeof messages[0].section_id, 'string');
  assert.equal(messages[0].section_id, '');
});

