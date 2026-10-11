/**
 * 在线人数（首页页脚那行小字）。
 *
 * 隐私设计：上报的只有一个**浏览器本地随机生成的会话号** ——
 * 没有 IP、没有账号、没有设备信息，服务端也只存这个号和心跳时间。
 * 会话号存在 sessionStorage：关掉标签页就没了，不同标签页算不同的人。
 *
 * 心跳规则：
 *   · 页面可见时每 30 秒报一次
 *   · 页面切到后台就停（人不看了就不算"在线"，数字更真实）
 *   · 服务端把 90 秒内有心跳的算在线
 */

const SESSION_KEY = 'class-bulletin.presence-id';

/** 心跳间隔：30 秒（服务端 90 秒判离线，允许丢两次心跳） */
export const HEARTBEAT_MS = 30 * 1000;

/** 纯函数：生成会话号，便于测试 */
export function createSessionId(random = Math.random) {
  const chunk = () => Math.floor(random() * 0xffffffff).toString(36);
  return `${Date.now().toString(36)}-${chunk()}-${chunk()}`;
}

/** 纯函数：把人数变成要显示的文字；人数不合法时返回空串（界面就不显示） */
export function formatOnlineCount(count) {
  const value = Number(count);
  if (!Number.isFinite(value) || value <= 0) return '';
  return `当前在线 ${Math.trunc(value)} 人`;
}

function readSessionId() {
  try {
    const existing = sessionStorage.getItem(SESSION_KEY);
    if (existing) return existing;
    const created = createSessionId();
    sessionStorage.setItem(SESSION_KEY, created);
    return created;
  } catch {
    // 隐私模式禁用存储时，退化成"每次刷新算一个新会话"，仍然能用
    return createSessionId();
  }
}

/**
 * 启动在线人数：立刻报一次心跳并取回人数，然后按间隔重复。
 *
 * @param {{
 *   source: import('../data/contract.js').DataSource,
 *   onCount: (text: string) => void,
 *   intervalMs?: number,
 *   documentRef?: Document,
 * }} options
 * @returns {() => void} 停止函数（离开页面时调用）
 */
export function startPresence(options) {
  const {
    source,
    onCount,
    intervalMs = HEARTBEAT_MS,
    documentRef = document,
  } = options;

  const sessionId = readSessionId();
  let timer = 0;
  let stopped = false;

  // 接口异常时静默处理：在线人数只是锦上添花，绝不能因此打扰同学
  const tick = async () => {
    if (stopped) return;
    try {
      await source.presenceHeartbeat(sessionId);
      const count = await source.presenceCount();
      onCount(formatOnlineCount(count));
    } catch {
      onCount('');
    }
  };

  const start = () => {
    if (timer || stopped) return;
    tick();
    timer = setInterval(tick, intervalMs);
  };

  const stop = () => {
    if (timer) {
      clearInterval(timer);
      timer = 0;
    }
  };

  const onVisibility = () => {
    if (documentRef.hidden) {
      stop();
    } else {
      start();
    }
  };

  if (!documentRef.hidden) start();
  documentRef.addEventListener('visibilitychange', onVisibility);

  return () => {
    stopped = true;
    stop();
    documentRef.removeEventListener('visibilitychange', onVisibility);
  };
}
