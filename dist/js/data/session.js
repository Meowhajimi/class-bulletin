/**
 * 登录态的保存与刷新。
 *
 * 只放在浏览器 localStorage 里：同学的浏览器永远不会写入登录信息，
 * 所以他们的页面始终是只读的。
 */

/** @typedef {import('./contract.js').Session} Session */

const STORAGE_KEY = 'class-bulletin.session.v1';

/** 提前 60 秒就当作过期，避免"刚好过期"的边界问题 */
const EXPIRY_MARGIN_MS = 60 * 1000;

/**
 * @returns {Session|null}
 */
export function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.accessToken || !parsed.refreshToken) return null;
    return /** @type {Session} */ (parsed);
  } catch {
    // localStorage 被禁用或内容损坏，都当作未登录
    return null;
  }
}

/**
 * @param {Session} session
 */
export function save(session) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // 隐私模式下写不进去也不影响本次会话
  }
}

export function clear() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 忽略
  }
}

/**
 * access_token 是否快过期了。
 * @param {Session|null} session
 */
export function isExpiring(session) {
  if (!session) return true;
  if (!session.expiresAt) return false;
  return Date.now() + EXPIRY_MARGIN_MS >= session.expiresAt;
}
