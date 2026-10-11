/**
 * Supabase 适配器 —— 直接用 fetch 调 REST/Auth 接口，不引入任何第三方库。
 *
 * 为什么不装 supabase-js？
 *   1) 少一个依赖，避免 CDN 出问题时整站白屏；
 *   2) 接口就那么几个，自己写的代码你读得懂、改得动；
 *   3) 同一份代码连真 Supabase 和本地 `python serve.py` 都行（接口一致）。
 *
 * 涉及的接口（与 server/local_api.py 完全对应）：
 *   POST /auth/v1/token?grant_type=password        登录
 *   POST /auth/v1/token?grant_type=refresh_token   续期
 *   POST /auth/v1/logout                           退出
 *   GET/POST/PATCH/DELETE /rest/v1/messages        公告的增删改查
 */

import { CONFIG, inspectApiKey, isLocalTarget, resolveSupabaseUrl } from '../config.js';
import { DataError, NOT_CONFIGURED_HINT, readErrorMessage, toRows } from './contract.js';
import * as sessionStore from './session.js';
import { captchaTokenForSignIn } from '../ui/captcha.js';

const MESSAGES_PATH = '/rest/v1/messages';
const SELECT_ALL = 'select=*&order=published_at.desc';

/**
 * 把地址和 key 一起做一次安全检查。
 * 除了界面会拦截，这里再拦一道：哪怕界面漏了，也绝不会把机密 key 发出去。
 *
 * @param {string} [override] 指定这一次请求用哪个地址（换地址兜底时会传进来）
 */
function baseUrl(override) {
  const keyCheck = inspectApiKey();
  if (!keyCheck.ok) {
    throw new DataError(keyCheck.message, { code: 'UNSAFE_KEY' });
  }

  const url = override || preferredBase || resolveSupabaseUrl();
  if (!url) throw new DataError(NOT_CONFIGURED_HINT, { code: 'NOT_CONFIGURED' });
  return url;
}

/**
 * 带超时的 fetch：超时/断网都转成好读的中文提示。
 *
 * 提示语要分人群（同学 vs 你自己的本地预览）——
 * 以前两种情况共用一句"请确认本地服务器还在运行（python serve.py）"，
 * 同学看到这句完全不知所云（他没有 python，也没有服务器）。
 */
async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timeoutMs = CONFIG.request.timeoutMs;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const local = isLocalTarget();

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new DataError(
        local
          ? `请求超时（超过 ${Math.round(timeoutMs / 1000)} 秒）。本地服务器还在运行吗（python serve.py）？`
          : `网络太慢，等了 ${Math.round(timeoutMs / 1000)} 秒还没回应。` +
              `请点「重试」；如果一直这样，换个网络（流量 ↔ WiFi）再试。`,
        { code: 'NETWORK', cause: error },
      );
    }
    throw new DataError(
      local
        ? '连不上本地服务器。请确认它还在运行（python serve.py）。'
        : '连接不上服务器，多半是网络不稳定。' +
            '请点「重试」；如果一直这样，换个网络（流量 ↔ WiFi）或换个浏览器再试。',
      { code: 'NETWORK', cause: error },
    );
  } finally {
    clearTimeout(timer);
  }
}

/** 是不是可以重试的错误：只重试网络层失败，业务错误（401/403/400…）不重试 */
function isRetryableError(error) {
  return Boolean(error) && error.name === 'DataError' && error.code === 'NETWORK';
}

/** 等待若干毫秒 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 读取响应体：可能是 JSON，也可能为空 */
async function parseBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * 这个 200 响应其实是网页，不是 Supabase 的数据。
 *
 * ★ 为什么必须判断：Cloudflare Pages 对**未知路径会回落到 index.html**
 *   （200 + text/html）。所以当 `/api` 上没有 Function 时，我们拿到的
 *   不是 404，而是一个 200 的 HTML 页面 —— 如果只按状态码判断，
 *   就会把这个 HTML 当数据去解析，轻则显示"0 条公告"，重则各种奇怪的报错。
 *
 *   Supabase 的接口永远是 JSON，所以"200 但是 HTML"可以确定就是没有代理，
 *   应当当成 404 处理，好让 send() 退回直连。
 */
function isHtmlInsteadOfData(response, payload) {
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('text/html')) return true;
  return typeof payload === 'string' && /^\s*<(?:!doctype|html)/i.test(payload);
}

/**
 * 组装请求头：Supabase 需要 apikey，本地服务器会忽略它。
 *
 * ⚠️ 这里有个容易踩的坑，两种 key 的用法不一样：
 *   - 旧版 anon key（eyJ... 的 JWT）：放在 apikey 里，同时也放在
 *     Authorization: Bearer 里（这是历史写法）。
 *   - 新版可发布 key（sb_publishable_...）：它只是个短字符串、不是 JWT，
 *     **只能放在 apikey 里**；当成 Bearer 发出去会被判为无效令牌 → 401。
 * 登录之后有了真正的用户令牌，Authorization 一律用用户令牌。
 */
function headersFor(useSession, extra = {}) {
  const headers = { 'Content-Type': 'application/json', ...extra };
  const publicKey = (CONFIG.supabase.anonKey || '').trim();
  const isLegacyJwt = publicKey.startsWith('eyJ');

  if (publicKey) headers.apikey = publicKey;

  const session = useSession ? sessionStore.load() : null;
  if (session && session.accessToken) {
    headers.Authorization = `Bearer ${session.accessToken}`;
  } else if (isLegacyJwt) {
    // 同学浏览时用的就是公开 key，只能读
    headers.Authorization = `Bearer ${publicKey}`;
  }
  return headers;
}

/** 把 HTTP 错误翻译成同学/你自己看得懂的提示 */
function errorFromResponse(response, payload, { context } = {}) {
  const detail = readErrorMessage(payload);
  const status = response.status;
  const hasSession = Boolean(sessionStore.load());
  let message;

  // 账号存在但没激活：Supabase 会返回 email_not_confirmed，
  // 这时如果提示"口令不正确"会让人一直在密码上打转，所以单独判断。
  const errorCode = String((payload && payload.error_code) || '');
  const unconfirmed =
    errorCode === 'email_not_confirmed' || /email[_ ]?not[_ ]?confirmed/i.test(detail);

  // 数据库缺字段（PGRST204）：多半是升级后忘了跑 schema.sql 的迁移语句。
  // 这个错误会让人完全无法发布，所以给出明确的下一步。
  const missingColumn =
    errorCode === 'PGRST204' ||
    /could not find the ['"]?\w+['"]? column|column .* does not exist|schema cache/i.test(detail);

  // 验证码没通过：Supabase 开了 CAPTCHA 之后，token 缺失或不正确都会落到这里。
  // 必须排在"口令不正确"之前判断，否则会被误报成密码错，让人一直改密码。
  const captchaFailed = /captcha/i.test(detail) || /captcha/i.test(errorCode);

  if (missingColumn) {
    message =
      `数据库里缺少字段（${detail || 'PGRST204'}）。` +
      '这通常是升级后还没执行建表脚本的迁移语句。' +
      '请到 Supabase → SQL Editor，把 supabase/schema.sql 重新完整跑一遍（可重复执行，不会丢数据）。';
  } else if (captchaFailed) {
    message =
      '验证码没有通过。请重新点一次登录；如果一直失败，按顺序检查：' +
      '① Supabase 里的 Captcha secret 与 web/js/config.js 里的 turnstileSiteKey ' +
      '是否来自同一个 Turnstile 站点；' +
      '② Turnstile 里登记的 Hostnames 是否包含你当前访问的域名' +
      '（用 localhost 预览时要另外把 localhost 加进去）；' +
      '③ 实在进不去：到 Supabase 后台 Authentication → Attack Protection 临时关掉验证码 —— ' +
      '后台登录和本站管理员登录是两套独立凭据，一定进得去。';
  } else if (unconfirmed) {
    message =
      '这个账号还没激活，所以登录不了（不是口令的问题）。' +
      '请到 Supabase 后台 Authentication → Users：要么把该用户确认，' +
      '要么删掉重建并在添加时勾选「Auto Confirm User」。';
  } else if (status === 400 && /invalid login|invalid_grant/i.test(detail)) {
    message = '邮箱或口令不正确，请重新输入。';
  } else if (status === 401 && context === 'signin') {
    message = '邮箱或口令不正确，请重新输入。';
  } else if (status === 401) {
    message = hasSession
      ? '登录已过期，请重新登录。'
      : '读取失败（401）。请检查 web/js/config.js 里的 anonKey 是否填写正确。';
  } else if (status === 403) {
    message =
      '没有写入权限。请在 Supabase 里确认：已关闭"允许新用户注册"，' +
      '并且你登录的是自己创建的管理员账号（详见 supabase/SETUP.md）。';
  } else if (status === 404) {
    message = '这条消息可能已经被删除了，刷新看看。';
  } else if (status === 429) {
    message = '操作太频繁了，等一会儿再试。';
  } else if (status >= 500) {
    message = `服务器暂时出错了（HTTP ${status}），请稍后再试。`;
  } else {
    message = detail || `请求失败（HTTP ${status}）。`;
  }

  return new DataError(message, {
    status,
    code: String(payload && payload.code ? payload.code : ''),
    cause: payload,
  });
}

/** 把接口返回的登录结果转成我们统一使用的 Session */
function sessionFromAuth(payload, fallback = null) {
  if (!payload || !payload.access_token) {
    throw new DataError('登录失败：服务器没有返回登录凭据。', { status: 0, cause: payload });
  }
  const user = payload.user || fallback || {};
  const previous = sessionStore.load();
  return {
    accessToken: String(payload.access_token),
    // 续期接口没返回新的 refresh_token 时继续用旧的
    refreshToken: String(payload.refresh_token || (previous && previous.refreshToken) || ''),
    expiresAt: payload.expires_in ? Date.now() + Number(payload.expires_in) * 1000 : 0,
    user: {
      id: String((user && user.id) || ''),
      email: String((user && user.email) || ''),
    },
  };
}

/**
 * 会话内记住哪个接口地址是通的，避免每次都先去试那个不通的。
 * 例如部署环境没有 /api 代理时，第一次试完就会固定走直连。
 */
let preferredBase = null;

/** 候选接口地址：同源代理优先，直连兜底（两者相同就只有一个） */
function apiBaseCandidates() {
  const primary = resolveSupabaseUrl();
  const direct = (CONFIG.supabase.url || '').trim().replace(/\/+$/, '');
  const known = [primary, direct].filter(Boolean);
  const list = [];
  // 只认"当前配置里确实存在的"地址 —— 配置改了（例如换了环境）就不该再用旧记忆
  if (preferredBase && known.includes(preferredBase)) list.push(preferredBase);
  for (const candidate of known) {
    if (!list.includes(candidate)) list.push(candidate);
  }
  return list;
}

/**
 * 明确表示"这个地址上没有转发器"的状态码。
 *
 * 为什么要包含 405：Cloudflare Pages 上如果**没有** /api 这个 Function，
 * 对静态资源发 POST 会回 **405 Method Not Allowed**（实测）。
 * 而 Supabase 对我们的这些已知路径（/rest/v1/messages、/auth/v1/token）
 * 不会回 405/501/404，所以这三个码可以安全地判定为"代理不存在"。
 */
const NO_PROXY_STATUSES = [404, 405, 501];

/**
 * 这个失败值不值得换个接口地址再试一次。
 *
 * 规则（很重要，直接关系到会不会重复发布）：
 *   · 404 / 405 / 501 —— 说明**代理不存在**，请求根本没到 Supabase，
 *     所以换地址重试是安全的（**写入也安全**）。
 *   · 只有 GET 才允许在网络错误后换地址（读是幂等的，多试无害）。
 *     写入遇到网络错误**绝不**换地址 —— 万一第一次其实已经成功、
 *     只是回包丢了，换地址重试会造成重复发布。
 */
function isFallbackWorthy(error, method) {
  const status = error && error.status;
  if (NO_PROXY_STATUSES.includes(status)) return true;
  return method === 'GET' && isRetryableError(error);
}

/**
 * 统一发请求。
 *
 * 三层保护，顺序是：换地址 → 同地址重试 → 报错。
 *   1. **换地址**：部署环境可能没有 /api 代理（比如还没配 Functions），
 *      这时自动退回直连 Supabase。所以启用代理**不会**让原本能用的环境变坏。
 *   2. **重试**：网络丢包时（国内到境外常见）自动重试几次，见 config.request.retries。
 *   3. **写入不重试**：POST/PATCH/DELETE 不自动重试，避免重复发布/重复删除。
 */
async function send(path, options = {}) {
  const { method = 'GET' } = options;
  const candidates = apiBaseCandidates();
  if (!candidates.length) return sendOnce('', path, options);

  let lastError;
  for (const base of candidates) {
    try {
      const result = await sendWithRetry(base, path, options);
      preferredBase = base; // 记住这条能通的路，后续请求直接用
      return result;
    } catch (error) {
      lastError = error;
      if (!isFallbackWorthy(error, method)) throw error;
    }
  }
  throw lastError;
}

/** 对同一个地址做"自动重试"（只对 GET 生效） */
async function sendWithRetry(base, path, options = {}) {
  const { method = 'GET' } = options;
  const retries = options.retry === false ? 0 : method === 'GET' ? (CONFIG.request.retries ?? 0) : 0;

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await sendOnce(base, path, options);
    } catch (error) {
      lastError = error;
      if (!isRetryableError(error) || attempt === retries) throw error;
      // 递增等待：600ms、1200ms…（给网络一点恢复时间）
      await sleep((CONFIG.request.retryDelayMs ?? 600) * (attempt + 1));
    }
  }
  throw lastError;
}

/** 真正发一次请求（含 401 续期逻辑） */
async function sendOnce(
  base,
  path,
  {
    method = 'GET',
    body,
    useSession = true,
    allowRefresh = true,
    context = '',
    extraHeaders = {},
  } = {},
) {
  const response = await fetchWithTimeout(`${baseUrl(base)}${path}`, {
    method,
    headers: headersFor(useSession, extraHeaders),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await parseBody(response);

  // 200 但拿到的是网页 → 说明这个地址上没有 API 代理（Pages 回落到了 index.html）。
  // 当成 404 抛出去，好让 send() 换地址退回直连 Supabase。
  if (response.ok && isHtmlInsteadOfData(response, payload)) {
    throw new DataError('这个地址上没有 API 代理，将改用直连。', {
      status: 404,
      code: 'NO_PROXY',
    });
  }

  const session = sessionStore.load();
  if (response.status === 401 && useSession && allowRefresh && session && session.refreshToken) {
    await refreshSession();
    return sendOnce(base, path, { method, body, useSession, allowRefresh: false, context, extraHeaders });
  }

  if (!response.ok) throw errorFromResponse(response, payload, { context });
  return payload;
}

/** 用 refresh_token 换新的 access_token */
async function refreshSession() {
  const session = sessionStore.load();
  if (!session || !session.refreshToken) {
    throw new DataError('登录已过期，请重新登录。', { status: 401 });
  }
  const response = await fetchWithTimeout(`${baseUrl()}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: headersFor(false),
    body: JSON.stringify({ refresh_token: session.refreshToken }),
  });
  const payload = await parseBody(response);
  if (!response.ok) {
    sessionStore.clear();
    throw new DataError('登录已过期，请重新登录。', { status: 401, cause: payload });
  }
  const next = sessionFromAuth(payload, session.user);
  sessionStore.save(next);
  return next;
}

/** 补全字段，保证界面拿到的结构永远一致 */
function normalizeMessage(row) {
  const record = row || {};
  return {
    id: String(record.id || ''),
    title: String(record.title || ''),
    body: String(record.body || ''),
    published_at: String(record.published_at || ''),
    expires_at: record.expires_at ? String(record.expires_at) : null,
    is_urgent: Boolean(record.is_urgent),
    created_at: String(record.created_at || ''),
    updated_at: String(record.updated_at || ''),
  };
}

/**
 * @param {{captchaTokenProvider?: () => Promise<string>}} [options]
 *        captchaTokenProvider 只在测试里注入，用来验证「验证码 token 有没有
 *        正确地放进请求体」。生产代码用默认的实现。
 * @returns {import('./contract.js').DataSource}
 */
export function createSupabaseSource(options = {}) {
  const getCaptchaToken = options.captchaTokenProvider || captchaTokenForSignIn;
  // 新的一次会话：清掉"上次哪条地址能通"的记忆，重新按当前配置判断
  preferredBase = null;

  return {
    name: 'supabase',
    canWrite: true,

    async listMessages() {
      const payload = await send(`${MESSAGES_PATH}?${SELECT_ALL}`);
      return toRows(payload).map(normalizeMessage);
    },

    async createMessage(input) {
      const payload = await send(MESSAGES_PATH, {
        method: 'POST',
        body: {
          title: input.title,
          body: input.body,
          published_at: input.published_at || new Date().toISOString(),
          expires_at: input.expires_at || null,
          is_urgent: Boolean(input.is_urgent),
        },
        // 让接口把写入后的整行返回，前端就不用再查一次
        extraHeaders: { Prefer: 'return=representation' },
      });
      const row = toRows(payload)[0];
      if (!row) throw new DataError('保存失败：服务器没有返回内容，请刷新确认。');
      return normalizeMessage(row);
    },

    async updateMessage(id, patch) {
      const payload = await send(`${MESSAGES_PATH}?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: patch,
        extraHeaders: { Prefer: 'return=representation' },
      });
      const row = toRows(payload)[0];
      if (!row) throw new DataError('保存失败：服务器没有返回内容，请刷新确认。');
      return normalizeMessage(row);
    },

    async deleteMessage(id) {
      await send(`${MESSAGES_PATH}?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
    },

    /**
     * 在线人数：只上报一个浏览器本地生成的随机会话号，
     * 不含 IP、账号或设备信息（服务端也只存这个号和心跳时间）。
     */
    async presenceHeartbeat(sessionId) {
      await send('/rest/v1/rpc/presence_heartbeat', {
        method: 'POST',
        body: { p_session: sessionId },
        useSession: false,
        allowRefresh: false,
      });
    },

    async presenceCount() {
      const payload = await send('/rest/v1/rpc/presence_count', {
        method: 'POST',
        body: {},
        useSession: false,
        allowRefresh: false,
      });
      const value = typeof payload === 'number' ? payload : Number(payload);
      return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
    },

    async signIn(email, password) {
      // 开了验证码的话，先拿一个 token 一起提交（Supabase 服务端会校验）。
      // 没配 Site Key、或在对本地服务器说话时，这一步返回空串，行为与以前完全一样。
      const captchaToken = await getCaptchaToken();

      const payload = await send('/auth/v1/token?grant_type=password', {
        method: 'POST',
        body: {
          email,
          password,
          // GoTrue 约定的字段名：验证码 token 放在 gotrue_meta_security 里
          ...(captchaToken
            ? { gotrue_meta_security: { captcha_token: captchaToken } }
            : {}),
        },
        useSession: false,
        allowRefresh: false,
        context: 'signin',
      });
      const session = sessionFromAuth(payload);
      sessionStore.save(session);
      return session;
    },

    async signOut() {
      const session = sessionStore.load();
      try {
        if (session && session.accessToken) {
          await send('/auth/v1/logout', {
            method: 'POST',
            body: {},
            useSession: true,
            allowRefresh: false,
          });
        }
      } catch {
        // 退出时网络失败也算退出成功，本地凭据一定要清掉
      } finally {
        sessionStore.clear();
      }
    },

    getSession() {
      return sessionStore.load();
    },
  };
}
