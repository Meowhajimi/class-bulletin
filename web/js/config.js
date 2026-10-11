/**
 * ★ 全站唯一配置点。
 *
 * 想改站点名称、换数据源、接上你的 Supabase，都只改这个文件。
 * 其它任何文件都不需要为了"换个网址/换个名字"而修改。
 */

export const CONFIG = {
  /** 站点标题与班级信息（同学打开首页就能看到） */
  site: {
    title: '班级公告栏',
    className: '', // 例如 '2024 级计算机 1 班'；留空则不显示第二行
    footer: '', // 例如 '由学习委员维护'；留空则不显示
  },

  /**
   * 数据源选择：
   *   'supabase' —— 走 HTTP 接口。既可以是真 Supabase，也可以是本机
   *                 `python serve.py` 起的本地服务器（两者接口完全相同）。
   *   'memory'   —— 纯浏览器 localStorage，不联网。用来单独调界面样式。
   */
  dataSource: 'supabase',

  /** 接口地址与公开密钥 */
  supabase: {
    /**
     * 真 Supabase：https://你的项目编号.supabase.co  （结尾不要带 /）
     * 本地服务器：http://127.0.0.1:8787
     *
     * 同学用手机访问时，若走本地服务器，这里要填你电脑的局域网地址，
     * 例如 http://192.168.1.23:8787（`python serve.py --lan` 会直接打印出来）。
     */
    url: 'https://xzafymhzqlkolblugzgp.supabase.co',

    /**
     * Supabase 的「可发布 key」（旧称 anon key）。它本来就是公开的，放在前端是安全的，
     * 真正的权限由数据库的 GRANT + RLS 策略控制。
     *
     * 两种写法都支持：
     *   sb_publishable_...  —— 新版可发布 key（推荐，Supabase 现在默认给这个）
     *   eyJ...              —— 旧版 anon key（JWT）。新旧可以同时存在
     *
     * ✘ 绝对不要在这里填下面这两种：它们能绕过全部权限检查，
     *   等于把管理员万能钥匙印在传单上发给全校。
     *     sb_secret_...                 —— 新版机密 key
     *     eyJ...（角色是 service_role） —— 旧版 service_role key
     *   本项目任何地方都不需要它们。
     *
     * 本地服务器不校验这个值，留空即可。
     */
    anonKey: 'sb_publishable_7_R6JURyS8QGOOK1CHwPFw_6MMPUcnE',

    /**
     * 接口地址走的「同源前缀」。
     *
     * ★ 为什么需要它（实测确认，不是推测）
     *   在中国移动上，`*.supabase.co` 会被 **ERR_CONNECTION_RESET（连接被重置）**；
     *   而同一个网络、同一个浏览器里 `*.pages.dev` 完全正常。
     *   结果是：页面能打开，但**取不到公告数据**（显示"加载失败"）。
     *
     *   解决思路：让浏览器只跟站点自己说话（能通），由服务器在**服务端**
     *   再去请求 Supabase。三种环境各自接住这个前缀：
     *     · 公网主站（Cloudflare Pages）：functions/api/[[path]].js 转发
     *     · 本地预览（python serve.py）：服务器自己剥掉 /api 处理
     *     · 备用站（Netlify）：dist/_redirects 里的一条代理规则
     *
     *   于是浏览器只访问
     *     https://class-bulletin.pages.dev/api/rest/v1/messages
     *   这样的**同源**地址，绕开了那个被重置的主机名。
     *
     * 留空 = 直连 Supabase（本地调试、或不想用代理时）。
     */
    apiPath: '/api',
  },

  /** 过期相关行为 */
  expiry: {
    /** 距过期不足这个天数时，卡片上显示"即将过期" */
    soonThresholdDays: 3,
    /** 已过期消息默认收进"往期公告"折叠区 */
    collapseExpired: true,
  },

  /** 备份行为 */
  backup: {
    /**
     * 什么时候把公告存成 Word：
     *   'ask'  发布 / 修改成功后弹出对话框询问（默认）
     *   'auto' 不询问，直接下载
     *   'off'  不自动下载，只用手动按钮或 python tools/backup-to-word.py
     */
    mode: 'ask',
  },

  /** 详情页与摘要 */
  detail: {
    /**
     * 主界面每条公告最多显示多少字，超出显示「查看详情 →」。
     * 设为 0 表示不截断（公告都很短时可以这样）。
     */
    summaryLength: 140,
  },

  /** 网络行为 */
  request: {
    /**
     * 单次请求超时（毫秒）。
     *
     * 国内访问 Supabase 偶尔较慢，所以给得比较宽松。
     * 注意：超时后**会自动重试**（见下面的 retries），
     * 所以这里不必为了"等更久"调得很大 —— 对丢包型网络，
     * "快速失败 + 重试"比"一直等"更容易成功（重试会重新建连接，
     * 有机会走到一条好的线路上）。
     */
    timeoutMs: 10000,

    /**
     * 读取类请求（GET）失败时自动重试几次。
     *
     * 为什么需要：中国移动等网络到境外 Cloudflare 存在**丢包**，
     * 表现为"有时能开、有时加载失败"（同学反馈过这个现象）。
     * 丢包是概率性的，所以重试能显著提高成功率：
     * 单次 70% → 重试 2 次后约 97%。
     *
     * ⚠️ **只对 GET 重试**。发布（POST）、编辑（PATCH）、删除（DELETE）
     * 一律不重试 —— 万一第一次其实已经成功、只是回包丢了，
     * 重试会导致重复发布或重复删除。
     */
    retries: 2,

    /** 重试前的等待（毫秒），按次数递增（600ms、1200ms…） */
    retryDelayMs: 600,
  },

  /**
   * 登录验证码（Cloudflare Turnstile）。
   *
   * 为什么要它：Supabase 的地址和 anon key 是公开的，别人可以绕过我们的网页
   * 直接对登录接口试密码。**验证码在 Supabase 服务端校验**，是目前这套架构里
   * 唯一能真正让"自动爆破"变得不划算的手段。
   *
   * 怎么启用（两步，缺一不可）：
   *   1. Supabase 后台 → Authentication → Attack Protection →
   *      打开 Enable Captcha protection，选 Turnstile，填入 **Secret Key**，Save
   *   2. 把 Turnstile 的 **Site Key** 填到下面这里，然后重新部署网页
   *
   * ⚠️ 顺序很重要：只做第 1 步、没做第 2 步的话，管理员登录会失败
   *    （报错里会提到 captcha）。两处都填好才完整。
   *
   * 留空 = 不启用验证码（本地服务器本来也不需要它）。
   * 详细步骤见项目根目录的 安全设置.md。
   */
  captcha: {
    /** Turnstile 的 Site Key（可以公开，和 anon key 一样放在前端是安全的） */
    turnstileSiteKey: '0x4AAAAAAFTf-FpyRQ34S5W6',
  },
};

/**
 * 是否要对登录使用验证码。
 *
 * 两个条件同时满足才启用：
 *   1. 配了 Site Key
 *   2. 不是在对本地服务器说话 —— 本地服务器不校验验证码，
 *      而且 Turnstile 只认已登记的域名，在 localhost 上会渲染失败。
 *      这样 `启动本地预览.bat` 永远能登录，不会被验证码卡住。
 */
export function shouldUseCaptcha() {
  if (!(CONFIG.captcha.turnstileSiteKey || '').trim()) return false;

  const target = resolveSupabaseUrl();
  if (!target) return false;
  try {
    const host = new URL(target).hostname;
    // 本地服务器（127.0.0.1 / localhost / ::1）不校验验证码
    return !/^(127\.0\.0\.1|localhost|\[::1\]|::1)$/.test(host);
  } catch {
    return false;
  }
}

/** 判断是否已经填写了可用的接口地址（供界面显示"未配置"引导） */
export function isConfigured() {
  if (CONFIG.dataSource === 'memory') return true;
  return Boolean(resolveSupabaseUrl());
}

/**
 * 当前是不是在对**本地服务器**说话。
 *
 * 用途：出错提示要分人群 ——
 *   · 同学（对云端）：提示"网络不稳定，点重试 / 换个网络"
 *   · 你自己（本地预览）：提示"本地服务器还在运行吗（python serve.py）"
 * 以前两种情况共用一句话，结果同学会看到"请确认本地服务器还在运行
 * （python serve.py）"，完全不知所云。
 */
export function isLocalTarget() {
  const target = resolveSupabaseUrl();
  if (!target) return false;
  try {
    return /^(127\.0\.0\.1|localhost|\[::1\]|::1)$/.test(new URL(target).hostname);
  } catch {
    return false;
  }
}

/**
 * 实际生效的接口地址。
 *
 * 优先级（这个顺序很重要，改动前先想清楚）：
 *   1. **本地预览**：页面就跑在本地服务器上 → 用本地服务器（或配置的地址）。
 *      本地服务器和真 Supabase 的接口完全一致，所以不改配置就能调试。
 *   2. **云端且配了 apiPath**：用**同源**的 /api（由服务器转发到 Supabase）。
 *      这是为了绕开 `*.supabase.co` 在中国移动上被 ERR_CONNECTION_RESET 的问题。
 *   3. 其它情况：直连配置里的 supabase.url。
 */
export function resolveSupabaseUrl() {
  const configured = (CONFIG.supabase.url || '').trim().replace(/\/+$/, '');
  const onLocalHost =
    typeof location !== 'undefined' &&
    /^(127\.0\.0\.1|localhost|\[::1\]|::1)$/.test(location.hostname);

  // 2. 云端优先走同源的 /api 代理
  if (!onLocalHost) {
    const apiPath = (CONFIG.supabase.apiPath || '').trim();
    if (apiPath && typeof location !== 'undefined' && location.origin) {
      return location.origin + (apiPath.startsWith('/') ? apiPath : `/${apiPath}`);
    }
  }

  if (configured) return configured;
  return onLocalHost ? location.origin : '';
}

/**
 * 解析 JWT 中间的 payload 部分（旧版 key 是 JWT，新版不是）。
 * @param {string} segment
 * @returns {Record<string, unknown>|null}
 */
function decodeJwtPayload(segment) {
  try {
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    if (typeof atob === 'function') {
      const binary = atob(padded);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      return JSON.parse(new TextDecoder().decode(bytes));
    }
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/** 缓存检查结果，避免每个请求都重新解析一遍 */
let keyCheckCache = { raw: null, result: null };

/**
 * 检查 anonKey 是不是"可以公开的 key"。
 *
 * 用途：万一有人（包括一时糊涂的你）把「机密 key / service_role key」填进
 * config.js，它会绕过所有权限检查。这里提前识别出来并拒绝使用，
 * 避免这个 key 被浏览器发出去、或者被部署到公网。
 *
 * @param {string} [rawKey]
 * @returns {{ok: boolean, kind: string, message: string}}
 */
export function inspectApiKey(rawKey) {
  const key = String(rawKey ?? CONFIG.supabase.anonKey ?? '').trim();

  if (rawKey === undefined && keyCheckCache.raw === key && keyCheckCache.result) {
    return keyCheckCache.result;
  }

  const result = (() => {
    if (!key) {
      // 本地服务器不需要 key
      return { ok: true, kind: 'empty', message: '' };
    }
    if (key.startsWith('sb_secret_')) {
      return {
        ok: false,
        kind: 'secret',
        message:
          '你把「机密 key」(sb_secret_...) 填进了 config.js。它相当于管理员万能钥匙，' +
          '能绕过全部权限检查，绝不能出现在网页里。请立刻到 Supabase 的 ' +
          'Settings → API Keys 把这个 key 删除（它会提示你轮换），改成填「可发布 key」(sb_publishable_...)。',
      };
    }
    if (key.startsWith('sb_publishable_')) {
      return { ok: true, kind: 'publishable', message: '' };
    }
    if (key.startsWith('eyJ')) {
      const payload = decodeJwtPayload(key.split('.')[1] || '');
      const role = payload && typeof payload.role === 'string' ? payload.role : '';
      if (role === 'service_role') {
        return {
          ok: false,
          kind: 'service_role',
          message:
            '你把 service_role key 填进了 config.js。它相当于管理员万能钥匙，能绕过全部权限检查，' +
            '绝不能出现在网页里。请立刻到 Supabase 的 Settings → API Keys 删除它（并轮换 JWT 密钥），' +
            '改成填「可发布 key」(sb_publishable_...) 或旧版 anon key。',
        };
      }
      if (role === 'anon') {
        return { ok: true, kind: 'anon', message: '' };
      }
      return {
        ok: false,
        kind: 'other-jwt',
        message:
          `config.js 里的这个 key 角色是「${role || '未知'}」，不是给浏览器用的公开 key。` +
          '请改填「可发布 key」(sb_publishable_...) 或旧版 anon key。',
      };
    }
    // 认不出来的格式先放行，避免误拦
    return { ok: true, kind: 'unknown', message: '' };
  })();

  keyCheckCache = { raw: rawKey === undefined ? key : null, result };
  return result;
}
