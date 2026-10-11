// Supabase Edge Function：把 Storage 里的静态站点"正确地"提供出来
//
// 为什么需要它：
//   Supabase Storage 故意把 .html 文件降级成 `text/plain` 并加上
//     Content-Security-Policy: default-src 'none'; sandbox
//   —— 这是为了防止有人拿 Storage 当网站托管（钓鱼/XSS）。
//   所以直接访问 Storage 的公开 URL，浏览器只会把 HTML 当文本显示。
//
//   这个函数从 Storage 取原文件，然后**用正确的 Content-Type 重新返回**，
//   于是同一个桶就能当网站访问了。
//
// 部署（不需要装任何工具，全程在浏览器里）：
//   1. Supabase 后台 → 左侧 Edge Functions → Deploy a new function → Via Editor
//   2. 函数名填 `mirror`（必须叫这个，路径才对得上）
//   3. 把本文件内容整个粘进去，覆盖模板代码
//   4. 点 Deploy function，等十几秒
//
// 部署后的入口地址：
//   https://<你的项目>.supabase.co/functions/v1/mirror/
//
// 说明：
//   · 这个函数只做"读"：从公开桶读文件、换个 Content-Type 返回。不写任何数据。
//   · 桶是公开只读的，所以函数里不需要任何密钥。
//   · 它是备用入口：主站（Netlify）打不开时，同学可以用这个地址。

const BUCKET = "site";

// 需要还原成正确类型的扩展名。
// 其余类型 Storage 本来就返回对了（比如 .js → text/javascript），走下面的兜底。
const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  ico: "image/x-icon",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  woff2: "font/woff2",
};

// 这些是"入口 HTML"，路径以 / 结尾时要补上
const DEFAULT_DOCUMENT = "index.html";

function contentTypeFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

Deno.serve(async (request: Request) => {
  const url = new URL(request.url);

  // 取出"函数名之后"的那一段路径。
  //
  // ★ 这里是踩过的坑：真实请求到函数里时，路径已经被网关改写过了。
  //   实测（2026-10）拿到的是 `/mirror/index.html` —— 也就是网关剥掉了
  //   `/functions/v1`，但**保留了函数名**。我最初只考虑了"完整路径"和
  //   "完全剥掉"两种，结果把 `mirror/index.html` 当成文件名去桶里找，
  //   直接 502。所以这里把三种可能都处理掉，网关以后改行为也不怕。
  let path = url.pathname;
  path = path.replace(/^\/functions\/v1/, ""); // 情况 A：保留了 /functions/v1
  path = path.replace(/^\/mirror(?=\/|$)/, ""); // 情况 B：只保留函数名（实测就是这种）
  path = path.replace(/^\/+/, ""); // 情况 C：已经只剩文件路径

  // 访问入口（路径为空或以 / 结尾）时给首页
  if (!path || path.endsWith("/")) path += DEFAULT_DOCUMENT;

  // 只允许读取，别的 HTTP 方法一律拒绝（这个函数没有写入能力）
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  // 简单防护：不允许跳出桶。
  // 注意要把 %2e%2e 这类编码形式先解码再判断 —— new URL() 不会帮你解码。
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // 编码不合法就按原样判断，下面照样能拦住
  }
  if (decoded.includes("..") || decoded.includes("\\") || decoded.includes("\0")) {
    return new Response("Bad Request", {
      status: 400,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const target = `${supabaseUrl}/storage/v1/object/public/${BUCKET}/${path}`;

  const upstream = await fetch(target, { method: "GET" });
  if (!upstream.ok) {
    return new Response(
      `这个文件不在镜像里：${path}\n\n` +
        `如果你刚建好桶，请先在电脑上跑一次「发布备用镜像.bat」把文件传上去。`,
      {
        status: upstream.status === 404 ? 404 : 502,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      },
    );
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      // ★ 关键：这里用我们自己的 Content-Type，而不是 Storage 给的 text/plain
      "Content-Type": contentTypeFor(path),
      // 文件更新后一分钟内生效，够用又不至于每次都回源
      "Cache-Control": "public, max-age=60",
      // 告诉浏览器按 Content-Type 处理，别自己猜
      "X-Content-Type-Options": "nosniff",
    },
  });
});
