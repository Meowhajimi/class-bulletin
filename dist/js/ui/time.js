/**
 * 时间工具 —— 全部是纯函数，不碰 DOM。
 *
 * 之所以单独拆出来，是因为"什么算过期""怎么显示时间"是最常改、
 * 也最该有测试的部分。改这里的规则后，跑 `node --test tools/tests/` 验证。
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * 把各种时间写法解析成 Date；解析不出来返回 null。
 * @param {string|number|Date|null|undefined} value
 * @returns {Date|null}
 */
export function parseTime(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * 是否已过期。expires_at 为空表示永不过期。
 * 刚好等于当前时刻也算过期（边界取 <=）。
 * @param {{expires_at?: string|null}} message
 * @param {number} [now]
 */
export function isExpired(message, now = Date.now()) {
  const expires = parseTime(message && message.expires_at);
  if (!expires) return false;
  return expires.getTime() <= now;
}

/**
 * 是否即将过期（还没过期，但只剩 thresholdDays 天以内）。
 * @param {{expires_at?: string|null}} message
 * @param {number} [now]
 * @param {number} [thresholdDays]
 */
export function isExpiringSoon(message, now = Date.now(), thresholdDays = 3) {
  const expires = parseTime(message && message.expires_at);
  if (!expires) return false;
  const remaining = expires.getTime() - now;
  return remaining > 0 && remaining <= thresholdDays * DAY;
}

/**
 * 是否已到发布时间。发布时间设在未来 = 定时公告，到点前同学看不到。
 * 没有 published_at 时按"已发布"处理，避免消息凭空消失。
 * @param {{published_at?: string|null}} message
 * @param {number} [now]
 */
export function isPublished(message, now = Date.now()) {
  const published = parseTime(message && message.published_at);
  if (!published) return true;
  return published.getTime() <= now;
}

/**
 * 把消息分成首页要显示的两组。
 *   当前公告：已到时间且未过期
 *   往期公告：已过期
 * 还没到发布时间的（定时公告）不会出现在首页。
 *
 * @param {Array<object>} messages
 * @param {{now?: number, thresholdDays?: number}} [options]
 */
export function splitMessages(messages, options = {}) {
  const now = options.now ?? Date.now();
  const thresholdDays = options.thresholdDays ?? 3;
  const current = [];
  const past = [];

  for (const message of messages || []) {
    if (!isPublished(message, now)) continue;
    if (isExpired(message, now)) past.push(message);
    else current.push(message);
  }

  return { current, past, thresholdDays };
}

/**
 * 相对时间，例：刚刚 / 5 分钟前 / 3 小时前 / 2 天后 / 2025-03-01
 * @param {string|number|Date|null|undefined} value
 * @param {number} [now]
 */
export function formatRelative(value, now = Date.now()) {
  const date = parseTime(value);
  if (!date) return '';

  const diff = date.getTime() - now;
  const abs = Math.abs(diff);
  const suffix = diff < 0 ? '前' : '后';

  if (abs < MINUTE) return diff < 0 ? '刚刚' : '马上';
  if (abs < HOUR) return `${Math.floor(abs / MINUTE)} 分钟${suffix}`;
  if (abs < DAY) return `${Math.floor(abs / HOUR)} 小时${suffix}`;
  if (abs < 7 * DAY) return `${Math.floor(abs / DAY)} 天${suffix}`;
  return formatAbsolute(value);
}

/**
 * 绝对时间，例：2025-03-01 08:00
 * @param {string|number|Date|null|undefined} value
 */
export function formatAbsolute(value) {
  const date = parseTime(value);
  if (!date) return '';
  const pad = (number) => String(number).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/**
 * 过期状态的一句话说明，显示在卡片上。
 * @param {{expires_at?: string|null}} message
 * @param {number} [now]
 */
export function formatExpiryNote(message, now = Date.now()) {
  const expires = parseTime(message && message.expires_at);
  if (!expires) return '';

  const remaining = expires.getTime() - now;
  if (remaining <= 0) return `已于 ${formatAbsolute(expires)} 过期`;
  if (remaining < HOUR) return `${Math.max(1, Math.floor(remaining / MINUTE))} 分钟后过期`;
  if (remaining < DAY) return `${Math.floor(remaining / HOUR)} 小时后过期`;
  if (remaining < 2 * DAY) return '明天过期';
  return `${Math.floor(remaining / DAY)} 天后过期`;
}

/**
 * 转成 <input type="datetime-local"> 需要的本地时间字符串（YYYY-MM-DDTHH:mm）。
 * 注意不能用 toISOString()，那会变成 UTC 从而显示错误的时间。
 * @param {string|number|Date|null|undefined} value
 */
export function toLocalInputValue(value) {
  const date = parseTime(value);
  if (!date) return '';
  const pad = (number) => String(number).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/**
 * 把 <input type="datetime-local"> 的值转成带时区的 ISO 字符串，交给后端。
 * 空值返回 null（表示"不设置该时间"）。
 * @param {string} value
 */
export function fromLocalInputValue(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/**
 * 把"发布时间"输入框里的值解析成可以提交的 ISO 时间。
 *
 * ★ 这个函数存在的意义：以前这里写的是
 *     fromLocalInputValue(值) || new Date().toISOString()
 * 于是当输入框的值是空的、或者浏览器没接受你输入的内容时，
 * 选好的时间会被**悄悄换成"现在"**，界面上毫无提示 ——
 * 表现就是"管理员没法用比现在早的时间发布公告"。
 * 现在改成：解析不出来就明确报错，绝不静默替换。
 *
 * @param {string} rawValue 输入框的原始值
 * @param {Date} [now] 当前时间（测试时固定用）
 * @returns {{ok: true, iso: string, usedNow: boolean} | {ok: false, error: string}}
 */
export function resolvePublishedAt(rawValue, now = new Date()) {
  const text = String(rawValue ?? '').trim();

  // 空值：按"现在发布"处理，但要让调用方知道这是默认值
  if (!text) {
    return { ok: true, iso: now.toISOString(), usedNow: true };
  }

  // <input type="datetime-local"> 只会产出这种形状：
  //   2026-10-10T20:15 或 2026-10-10T20:15:30
  // 这里先严格校验形状，再交给 Date 解析。
  // 为什么不能只靠 Date：new Date('2025/03/01 08:05') 这种"看起来像时间"的
  // 写法在浏览器里是能被解析的，容易把用户手写错的格式当成有效输入收下。
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(text)) {
    return {
      ok: false,
      error: '发布时间这个格式不对，请重新选择一次（或点右边的「现在」）。',
    };
  }

  const iso = fromLocalInputValue(text);
  if (!iso) {
    return {
      ok: false,
      error: '发布时间这个格式不对，请重新选择一次（或点右边的「现在」）。',
    };
  }

  return { ok: true, iso, usedNow: false };
}
