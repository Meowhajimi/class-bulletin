/**
 * Pages Function 代理的测试（functions/api/[[path]].js）
 *
 * 为什么需要：
 *   中国移动上 `*.supabase.co` 会被 ERR_CONNECTION_RESET，而 `*.pages.dev` 正常。
 *   所以我们让浏览器只访问同源的 `/api/*`，由这个 Function 在服务端转发到 Supabase。
 *
 *   这个转发一旦写错，后果是**全班都看不到公告** —— 比"部分同学打不开"严重得多。
 *   所以这里把 fetch 换成替身，逐条验证：
 *     · 路径拼得对不对（/api 有没有剥掉、query 有没有丢）
 *     · 鉴权头有没有原样带过去（丢了就是 401）
 *     · 请求体有没有转发（丢了就发不出公告）
 *     · 响应状态码与内容有没有原样返回（吞掉 400 会让用户以为成功）
 *     · 有没有变成"通用开放代理"（只放行 /rest/v1 与 /auth/v1）
 *
 * 运行：node --test "tools/tests/*.test.js"
 */

import assert from 'node:assert/strict';
import test from 'node:test';

const { onRequest } = await import('../../functions/api/[[path]].js');

/** 记录被替身 fetch 收到的请求 */
const calls = [];

/** 装一个假的 fetch，返回可控的上游响应 */
function stubFetch(handler) {
  const real = globalThis.fetch;
  calls.length = 0;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  return () => {
    globalThis.fetch = real;
  };
}

/** 默认上游：回一段 JSON */
function defaultUpstream(status = 200, payload = [{ id: 'm1', title: '公告' }]) {
  return () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json', 'Content-Length': '999', 'Content-Encoding': 'gzip' },
    });
}

function call(path, init = {}) {
  return onRequest({
    request: new Request(`https://class-bulletin.pages.dev${path}`, init),
    env: {},
  });
}

test('导出的是一个可用的请求处理函数', () => {
  assert.equal(typeof onRequest, 'function');
});

test('★ /api 前缀被剥掉，转发到 Supabase 的正确路径', async () => {
  const restore = stubFetch(defaultUpstream());
  try {
    const response = await call('/api/rest/v1/messages');
    assert.equal(response.status, 200);
    assert.equal(
      calls[0].url,
      'https://xzafymhzqlkolblugzgp.supabase.co/rest/v1/messages',
      `转发地址不对：${calls[0].url}`,
    );
  } finally {
    restore();
  }
});

test('★ 查询参数完整保留（筛选/排序都靠它）', async () => {
  const restore = stubFetch(defaultUpstream());
  try {
    await call('/api/rest/v1/messages?select=*&order=published_at.desc&id=eq.abc-123');
    assert.equal(
      calls[0].url,
      'https://xzafymhzqlkolblugzgp.supabase.co/rest/v1/messages?select=*&order=published_at.desc&id=eq.abc-123',
      `参数丢了：${calls[0].url}`,
    );
  } finally {
    restore();
  }
});

test('★ apikey 与 Authorization 原样带过去（丢了会 401）', async () => {
  const restore = stubFetch(defaultUpstream());
  try {
    await call('/api/rest/v1/messages', {
      headers: { apikey: 'sb_publishable_xxx', Authorization: 'Bearer user-token' },
    });
    const sent = new Headers(calls[0].init.headers);
    assert.equal(sent.get('apikey'), 'sb_publishable_xxx');
    assert.equal(sent.get('authorization'), 'Bearer user-token');
  } finally {
    restore();
  }
});

test('★ 不会把 host 等头透传过去（透传会破坏请求）', async () => {
  const restore = stubFetch(defaultUpstream());
  try {
    await call('/api/rest/v1/messages');
    const sent = new Headers(calls[0].init.headers);
    assert.equal(sent.get('host'), null, 'host 头不该被透传');
  } finally {
    restore();
  }
});

test('★ Prefer 头要带上（发布公告靠它返回新行）', async () => {
  const restore = stubFetch(defaultUpstream(201));
  try {
    await call('/api/rest/v1/messages', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ title: '新公告' }),
    });
    const sent = new Headers(calls[0].init.headers);
    assert.equal(sent.get('prefer'), 'return=representation');
    assert.equal(calls[0].init.method, 'POST');
  } finally {
    restore();
  }
});

test('★ 请求体被转发（丢了就发不出公告）', async () => {
  const restore = stubFetch(defaultUpstream(201));
  try {
    await call('/api/rest/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '新公告', body: '正文' }),
    });
    assert.ok(calls[0].init.body, '请求体没有转发');
  } finally {
    restore();
  }
});

test('GET/HEAD 不带 body（带了会被上游拒绝）', async () => {
  const restore = stubFetch(defaultUpstream());
  try {
    await call('/api/rest/v1/messages');
    assert.equal(calls[0].init.body, undefined);
  } finally {
    restore();
  }
});

test('★ 上游的状态码原样返回（401 必须还是 401，否则登录态判断会错）', async () => {
  for (const status of [400, 401, 403, 404, 429, 500]) {
    const restore = stubFetch(defaultUpstream(status, { message: 'err' }));
    try {
      const response = await call('/api/rest/v1/messages');
      assert.equal(response.status, status, `上游 ${status} 被改成了 ${response.status}`);
    } finally {
      restore();
    }
  }
});

test('★ 上游的响应内容原样返回（不能吞成空数组）', async () => {
  const restore = stubFetch(defaultUpstream(200, [{ id: 'm9', title: '重要通知' }]));
  try {
    const response = await call('/api/rest/v1/messages');
    const body = await response.json();
    assert.equal(body[0].title, '重要通知');
  } finally {
    restore();
  }
});

test('★ 丢掉 content-length / content-encoding（照抄会导致响应损坏）', async () => {
  const restore = stubFetch(defaultUpstream());
  try {
    const response = await call('/api/rest/v1/messages');
    assert.equal(response.headers.get('content-length'), null, 'content-length 不该透传');
    assert.equal(response.headers.get('content-encoding'), null, 'content-encoding 不该透传');
    assert.match(response.headers.get('content-type') || '', /application\/json/);
  } finally {
    restore();
  }
});

test('★ 只放行 /rest/v1 与 /auth/v1，不做通用开放代理', async () => {
  for (const path of ['/api/evil', '/api/https://example.com', '/api/storage/v1/object/x', '/api/']) {
    const restore = stubFetch(defaultUpstream());
    try {
      const response = await call(path);
      assert.equal(response.status, 404, `${path} 应当被拒绝，实际 ${response.status}`);
      assert.equal(calls.length, 0, `${path} 不该真的发出去`);
    } finally {
      restore();
    }
  }
});

test('登录接口 /auth/v1/token 可以转发（验证码 token 在请求体里）', async () => {
  const restore = stubFetch(defaultUpstream(200, { access_token: 't' }));
  try {
    await call('/api/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.c', password: 'x', gotrue_meta_security: { captcha_token: 'abc' } }),
    });
    assert.equal(
      calls[0].url,
      'https://xzafymhzqlkolblugzgp.supabase.co/auth/v1/token?grant_type=password',
    );
  } finally {
    restore();
  }
});

test('RPC（在线人数）可以转发', async () => {
  const restore = stubFetch(defaultUpstream(200, 3));
  try {
    await call('/api/rest/v1/rpc/presence_count', { method: 'POST', body: '{}' });
    assert.equal(calls[0].url, 'https://xzafymhzqlkolblugzgp.supabase.co/rest/v1/rpc/presence_count');
  } finally {
    restore();
  }
});

test('服务端取不到上游时返回 502，并说明是服务端网络问题', async () => {
  const restore = stubFetch(() => {
    throw new TypeError('fetch failed');
  });
  try {
    const response = await call('/api/rest/v1/messages');
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.match(body.message, /转发到 Supabase 失败/);
  } finally {
    restore();
  }
});

test('响应里带 CORS 头（备用域名 netlify 也能调用）', async () => {
  const restore = stubFetch(defaultUpstream());
  try {
    const response = await call('/api/rest/v1/messages');
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
  } finally {
    restore();
  }
});

test('响应不做缓存（公告要能立刻看到）', async () => {
  const restore = stubFetch(defaultUpstream());
  try {
    const response = await call('/api/rest/v1/messages');
    assert.match(response.headers.get('cache-control') || '', /no-store/);
  } finally {
    restore();
  }
});
