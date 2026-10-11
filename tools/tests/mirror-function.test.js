/**
 * 备用镜像 Edge Function 的测试（supabase/functions/mirror/index.ts）。
 *
 * 为什么需要：
 *     Supabase Storage 会把 .html 降级成 `text/plain` 并加上
 *         Content-Security-Policy: default-src 'none'; sandbox
 *     这是它防钓鱼的有意设计，所以 Storage 直链**永远**不能当网页用。
 *     我们靠这个 Edge Function 把 Content-Type 改回 text/html。
 *
 *     而"改回 text/html"这件事一旦写错，只有在部署之后、同学打开页面时才会暴露。
 *     所以这里在本地把 Deno 与 fetch 都换成替身，直接验证函数的行为 ——
 *     尤其是"上游给 text/plain，我们必须要返回 text/html"这一条。
 *
 * 运行：node --test "tools/tests/*.test.js"
 */

import assert from 'node:assert/strict';
import test from 'node:test';

let handler = null;
const storageCalls = [];

// Deno 的替身：捕获 Deno.serve 注册的处理函数
globalThis.Deno = {
  serve: (fn) => {
    handler = fn;
  },
  env: {
    get: (name) => (name === 'SUPABASE_URL' ? 'https://demo.supabase.co' : undefined),
  },
};

/**
 * fetch 的替身 —— 关键点：**故意模仿 Storage 的真实行为**，
 * 无论请求什么文件都返回 text/plain + sandbox CSP。
 * 这样如果函数没有覆盖 Content-Type，测试就会失败。
 */
globalThis.fetch = async (url, options) => {
  const target = String(url);
  storageCalls.push({ url: target, method: options?.method });

  if (target.includes("not-in-mirror")) {
    return new Response("not found", {
      status: 404,
      headers: { "Content-Type": "text/plain" },
    });
  }

  return new Response("<!DOCTYPE html><html><body>镜像页面</body></html>", {
    status: 200,
    headers: {
      "Content-Type": "text/plain", // ← Storage 的真实行为
      "Content-Security-Policy": "default-src 'none'; sandbox", // ← 也是它加的
      "X-Content-Type-Options": "nosniff",
    },
  });
};

await import('../../supabase/functions/mirror/index.ts');

const ENTRY = 'https://demo.supabase.co/functions/v1/mirror';

/** 发一个请求给函数，返回 Response */
function call(path, init = {}) {
  return handler(new Request(`${ENTRY}${path}`, init));
}

/**
 * ★ 这里踩过一次坑：真实请求到达函数时，路径已经被网关改写过了。
 *   实测（2026-10）拿到的是 `/mirror/index.html` —— 网关剥掉了 `/functions/v1`，
 *   但**保留了函数名**。我最初只按"完整路径"写测试，所以本地全绿、线上 502
 *   （函数去桶里找 `mirror/index.html`，当然找不到）。
 *
 *   现在三种形状都测 —— 网关以后改行为也不会再漏掉。
 */
const URL_SHAPES = [
  { label: '网关保留函数名（线上实测形状）', make: (p) => `https://demo.supabase.co/mirror${p}` },
  { label: '完整路径 /functions/v1/mirror', make: (p) => `https://demo.supabase.co/functions/v1/mirror${p}` },
  { label: '已完全剥掉前缀', make: (p) => `https://demo.supabase.co${p}` },
];

function callShape(index, path, init = {}) {
  return handler(new Request(URL_SHAPES[index].make(path), init));
}

test('函数成功注册了请求处理入口', () => {
  assert.equal(typeof handler, 'function');
});

test('★ 三种 URL 形状下，入口都能拿到 index.html（不再 502）', async () => {
  for (let index = 0; index < URL_SHAPES.length; index += 1) {
    storageCalls.length = 0;
    const response = await callShape(index, '/');
    assert.equal(response.status, 200, `${URL_SHAPES[index].label} → HTTP ${response.status}`);
    assert.match(
      response.headers.get('content-type') || '',
      /text\/html/,
      `${URL_SHAPES[index].label} 的 Content-Type 是 ${response.headers.get('content-type')}`,
    );
    assert.equal(
      storageCalls[0]?.url,
      'https://demo.supabase.co/storage/v1/object/public/site/index.html',
      `${URL_SHAPES[index].label} 取错了文件：${storageCalls[0]?.url}`,
    );
  }
});

test('★ 三种形状下，子路径也都映射正确（不会带上函数名）', async () => {
  for (let index = 0; index < URL_SHAPES.length; index += 1) {
    storageCalls.length = 0;
    await callShape(index, '/js/ui/dom.js');
    assert.equal(
      storageCalls[0]?.url,
      'https://demo.supabase.co/storage/v1/object/public/site/js/ui/dom.js',
      `${URL_SHAPES[index].label} 取错了文件：${storageCalls[0]?.url}`,
    );
  }
});

test('★ 根路径返回 text/html（这是这个函数存在的全部理由）', async () => {
  const response = await call('/');
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get('content-type') || '',
    /text\/html/,
    `上游给的是 text/plain，函数必须改成 text/html，实际是 ${response.headers.get('content-type')}`,
  );
});

test('不带结尾斜杠也要给首页', async () => {
  const response = await call('');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/html/);
});

test('★ 不会把 Storage 的 sandbox CSP 透传给浏览器', async () => {
  const response = await call('/');
  const csp = response.headers.get('content-security-policy') || '';
  assert.ok(
    !csp.includes("default-src 'none'"),
    `上游那个会锁死页面的 CSP 被透传了：${csp}`,
  );
});

test('函数确实是从公开桶取的文件', async () => {
  storageCalls.length = 0;
  await call('/js/app.js');
  assert.equal(storageCalls.length, 1);
  assert.equal(
    storageCalls[0].url,
    'https://demo.supabase.co/storage/v1/object/public/site/js/app.js',
  );
});

test('.html 一律改成 text/html，并带 UTF-8 声明', async () => {
  for (const path of ['/index.html', '/admin.html', '/message.html']) {
    const response = await call(path);
    const ctype = response.headers.get('content-type') || '';
    assert.match(ctype, /text\/html/, `${path} 的类型是 ${ctype}`);
    assert.match(ctype, /charset=utf-8/, `${path} 缺少 charset，中文会乱码`);
  }
});

test('.js 返回 text/javascript（ES 模块对 MIME 很挑）', async () => {
  const response = await call('/js/app.js');
  assert.match(response.headers.get('content-type') || '', /text\/javascript/);
});

test('.css 返回 text/css', async () => {
  const response = await call('/css/tokens.css');
  assert.match(response.headers.get('content-type') || '', /text\/css/);
});

test('.svg 返回 image/svg+xml', async () => {
  const response = await call('/assets/favicon.svg');
  assert.match(response.headers.get('content-type') || '', /image\/svg\+xml/);
});

test('认不出的扩展名不会乱猜成 text/html（避免被利用）', async () => {
  const response = await call('/奇怪的东西.bin');
  const ctype = response.headers.get('content-type') || '';
  assert.match(ctype, /application\/octet-stream/);
  assert.ok(!ctype.includes('text/html'), '未知类型不能当成 HTML 执行');
});

test('带了 nosniff，浏览器不会自己去猜类型', async () => {
  const response = await call('/');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('只允许读取：POST / PUT / DELETE 一律 405', async () => {
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const response = await call('/', { method });
    assert.equal(response.status, 405, `${method} 应当被拒绝`);
  }
});

test('挡掉路径穿越（包括编码形式 %2e%2e）', async () => {
  for (const path of ['/%2e%2e%2f%2e%2e%2fetc%2fpasswd', '/a%2fb%2e%2e%2fsecret']) {
    const response = await call(path);
    assert.equal(response.status, 400, `${path} 应当被拒绝，实际 ${response.status}`);
  }
});

test('文件不在镜像里时给 404，并提示怎么上传', async () => {
  const response = await call('/not-in-mirror.html');
  assert.equal(response.status, 404);
  const text = await response.text();
  assert.match(text, /404|不在镜像里/);
});

test('上游 200 时函数也返回 200，并把内容透传出去', async () => {
  const response = await call('/');
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /镜像页面/, '内容应当原样透传');
});

test('给浏览器缓存 60 秒，不至于每次刷新都回源', async () => {
  const response = await call('/');
  assert.match(response.headers.get('cache-control') || '', /max-age=60/);
});
