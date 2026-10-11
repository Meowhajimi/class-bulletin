/**
 * Cloudflare Pages Function：把 /api/* 转发到 Supabase
 *
 * ★ 为什么需要它
 *   同学的反馈 + 实测确认：在中国移动上，`*.supabase.co` 会被
 *   **ERR_CONNECTION_RESET（连接被重置）**；而同一个网络、同一个浏览器里，
 *   `*.pages.dev` 却完全正常。所以页面能打开、但取不到公告数据。
 *
 *   这个函数让浏览器只跟 pages.dev 说话（能通），由 Cloudflare 在服务端
 *   再去请求 Supabase（服务端到服务端，不受那条干扰影响）。
 *
 *   客户端因此把接口地址写成同源的 `/api`，例如：
 *       https://class-bulletin.pages.dev/api/rest/v1/messages
 *   本函数剥掉 `/api`，转发到：
 *       https://<项目>.supabase.co/rest/v1/messages
 *
 * ★ 为什么不能用别的方式
 *   · Pages 的 `_redirects` 明确不支持代理外部域名（"You cannot proxy external domains"）
 *   · `/functions` 目录在"面板拖拽上传"模式下不生效，必须用 Git 集成部署
 *   所以这个文件要生效，Pages 项目必须是用 **Git 集成**创建的。
 *
 * ★ 安全性
 *   · 只做"转发"，不注入任何密钥：apikey / Authorization 都由浏览器原样带过来
 *   · 绝不使用 service_role key，所以权限完全由 Supabase 的 RLS 决定
 *     （和浏览器直连 Supabase 的权限一模一样，没有放大）
 *   · 只放行 /rest/v1/ 与 /auth/v1/ 两个前缀，不做通用开放代理
 */

/** Supabase 项目地址（与 web/js/config.js 里的 supabase.url 保持一致） */
const SUPABASE_ORIGIN = "https://xzafymhzqlkolblugzgp.supabase.co";

/** 只允许转发这些前缀，避免变成通用开放代理 */
const ALLOWED_PREFIXES = ["/rest/v1/", "/auth/v1/"];

/** 这些请求头不要透传（由 fetch 自己生成，透传会出错） */
const STRIPPED_REQUEST_HEADERS = ["host", "content-length", "connection", "cf-connecting-ip", "cf-worker"];

/** 这些响应头不要透传（长度/编码由运行时自己算，照抄会出错） */
const STRIPPED_RESPONSE_HEADERS = ["content-encoding", "content-length", "transfer-encoding", "connection"];

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  // /api/rest/v1/messages → /rest/v1/messages
  const upstreamPath = url.pathname.replace(/^\/api/, "");

  if (!ALLOWED_PREFIXES.some((prefix) => upstreamPath.startsWith(prefix))) {
    return jsonResponse(404, {
      message: "这个路径不在允许转发的范围内。只放行 /rest/v1/ 与 /auth/v1/。",
      path: upstreamPath,
    });
  }

  const target = `${SUPABASE_ORIGIN}${upstreamPath}${url.search}`;

  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (!STRIPPED_REQUEST_HEADERS.includes(name.toLowerCase())) headers.set(name, value);
  }

  let upstream;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
      redirect: "manual",
    });
  } catch (error) {
    return jsonResponse(502, {
      message: "转发到 Supabase 失败（服务端网络问题）。",
      detail: String((error && error.message) || error),
    });
  }

  const responseHeaders = new Headers();
  for (const [name, value] of upstream.headers) {
    if (!STRIPPED_RESPONSE_HEADERS.includes(name.toLowerCase())) responseHeaders.set(name, value);
  }
  // 同源调用其实用不到 CORS，但加上以后从备用域名（netlify）调用也能通
  responseHeaders.set("Access-Control-Allow-Origin", "*");
  responseHeaders.set("Cache-Control", "no-store");

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

/** 统一的中文错误响应（只有我们自己的错误才用它） */
function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
