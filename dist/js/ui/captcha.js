/**
 * Cloudflare Turnstile 验证码（登录时用）。
 *
 * 为什么需要：Supabase 的地址和 anon key 是公开的，别人可以绕过我们的网页
 * 直接对登录接口试密码。验证码由 **Supabase 服务端**校验，是这套纯静态架构里
 * 唯一能真正拖慢自动爆破的手段。
 *
 * 设计要点：
 *   · 脚本按需加载 —— 只有真正要登录时才去下 Cloudflare 的 JS，
 *     不在首页加载，免得给同学多下一个 80 多 KB 的文件
 *   · 只在「配了 Site Key 且不是在跟本地服务器说话」时启用
 *     （判断逻辑在 config.js 的 shouldUseCaptcha，见那里的注释）
 *   · 拿不到 token 时给出人话错误，而不是让请求带着空 token 去撞墙
 */

import { CONFIG, shouldUseCaptcha } from '../config.js';
import { DataError } from '../data/contract.js';

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const SCRIPT_ID = 'cf-turnstile-script';
/** 等待用户完成验证的最长时间 */
const TOKEN_TIMEOUT_MS = 60000;

let scriptPromise = null;

/** 按需加载 Turnstile 脚本（同一个页面只会加载一次） */
function loadScript() {
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new DataError('当前环境不支持验证码。'));
      return;
    }
    if (window.turnstile) {
      resolve(window.turnstile);
      return;
    }

    const existing = document.getElementById(SCRIPT_ID);
    const script = existing || document.createElement('script');
    script.id = SCRIPT_ID;
    script.src = SCRIPT_URL;
    script.async = true;
    script.defer = true;

    script.addEventListener('load', () => {
      if (window.turnstile) resolve(window.turnstile);
      else reject(new DataError('验证码脚本加载了，但没能初始化。请刷新页面重试。'));
    });
    script.addEventListener('error', () => {
      // 国内网络下这个域名偶尔会慢或被拦
      reject(
        new DataError(
          '验证码加载失败（可能网络不通，或当前访问的域名没有登记在 Turnstile 里）。' +
            '刷新页面重试；如果一直失败，可以到 Supabase 后台 ' +
            'Authentication → Attack Protection 临时关掉验证码 —— ' +
            '后台登录和本网站的管理员登录是两套独立凭据，不会一起进不去。',
        ),
      );
    });

    if (!existing) document.head.append(script);
  });

  return scriptPromise;
}

/**
 * 弹出一个验证码，等用户点完，返回 token。
 *
 * @returns {Promise<string>} Turnstile 的 token（Supabase 会拿去校验）
 */
export function requestCaptchaToken() {
  const siteKey = (CONFIG.captcha.turnstileSiteKey || '').trim();
  if (!siteKey) {
    return Promise.reject(new DataError('还没有配置验证码 Site Key。'));
  }

  return loadScript().then(
    (turnstile) =>
      new Promise((resolve, reject) => {
        // 一个看不见的容器：Turnstile 的 "managed" 模式多数情况下会自动通过，
        // 需要人点时它自己会显示出交互界面
        const holder = document.createElement('div');
        holder.className = 'captcha-holder';
        document.body.append(holder);

        let settled = false;
        const finish = (fn, value) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          try {
            turnstile.remove(widgetId);
          } catch {
            // 已经没了就算了
          }
          holder.remove();
          fn(value);
        };

        const timer = window.setTimeout(() => {
          finish(
            reject,
            new DataError('验证码超时了。请刷新页面重新登录。'),
          );
        }, TOKEN_TIMEOUT_MS);

        let widgetId = '';
        try {
          widgetId = turnstile.render(holder, {
            sitekey: siteKey,
            callback: (token) => finish(resolve, token),
            'error-callback': () =>
              finish(reject, new DataError('验证码校验失败，请刷新页面重试。')),
            'timeout-callback': () =>
              finish(reject, new DataError('验证码超时，请重试。')),
          });
        } catch (error) {
          finish(reject, new DataError(`验证码无法显示：${(error && error.message) || error}`));
        }
      }),
  );
}

/**
 * 登录前拿 token：不需要验证码时返回空字符串。
 *
 * 把它单独抽出来是为了好测：适配器只依赖这个函数的行为，
 * 而不是在请求代码里散落 if。
 *
 * @returns {Promise<string>}
 */
export async function captchaTokenForSignIn() {
  if (!shouldUseCaptcha()) return '';
  return requestCaptchaToken();
}
