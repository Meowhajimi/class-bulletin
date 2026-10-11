/**
 * ui/time.js 的单元测试 —— 过期判定是全站最容易改错的地方，
 * 所以给它配上测试，改完规则跑一下就知道有没有弄坏。
 *
 * 运行：node --test tools/tests/
 * （node 不在 PATH 时用完整路径，例如
 *   "C:\Program Files\nodejs\node.exe" --test tools/tests/）
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatAbsolute,
  formatExpiryNote,
  formatRelative,
  fromLocalInputValue,
  isExpired,
  isExpiringSoon,
  isPublished,
  parseTime,
  resolvePublishedAt,
  splitMessages,
  toLocalInputValue,
} from '../../web/js/ui/time.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 固定一个"现在"，避免测试受真实时间影响 */
const NOW = new Date(2025, 5, 15, 12, 0, 0).getTime();
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();

test('parseTime：能解析各种写法，解析不出来返回 null', () => {
  assert.equal(parseTime(iso(0)).getTime(), NOW);
  assert.equal(parseTime('2025-03-01T08:00:00+08:00').getTime(), new Date('2025-03-01T00:00:00Z').getTime());
  assert.equal(parseTime(new Date(NOW)).getTime(), NOW);
  assert.equal(parseTime(null), null);
  assert.equal(parseTime(''), null);
  assert.equal(parseTime(undefined), null);
  assert.equal(parseTime('不是时间'), null);
});

test('isExpired：没设过期时间就永不过期', () => {
  assert.equal(isExpired({ expires_at: null }, NOW), false);
  assert.equal(isExpired({}, NOW), false);
  assert.equal(isExpired({ expires_at: '' }, NOW), false);
  assert.equal(isExpired({ expires_at: '乱写' }, NOW), false);
});

test('isExpired：过去是过期，未来是没过期，刚好等于也算过期', () => {
  assert.equal(isExpired({ expires_at: iso(-1) }, NOW), true);
  assert.equal(isExpired({ expires_at: iso(HOUR) }, NOW), false);
  assert.equal(isExpired({ expires_at: iso(0) }, NOW), true);
});

test('isExpiringSoon：只在"还没过期且快到期"时为真', () => {
  const soon = { expires_at: iso(2 * DAY) };
  assert.equal(isExpiringSoon(soon, NOW, 3), true);
  assert.equal(isExpiringSoon(soon, NOW, 1), false);
  assert.equal(isExpiringSoon({ expires_at: iso(-HOUR) }, NOW, 3), false, '已过期的不能再算"即将过期"');
  assert.equal(isExpiringSoon({ expires_at: null }, NOW, 3), false);
  assert.equal(isExpiringSoon({ expires_at: iso(3 * DAY) }, NOW, 3), true, '边界：正好 3 天算即将过期');
  assert.equal(isExpiringSoon({ expires_at: iso(3 * DAY + 1000) }, NOW, 3), false);
});

test('isPublished：未来的发布时间 = 定时公告，同学看不到', () => {
  assert.equal(isPublished({ published_at: iso(-HOUR) }, NOW), true);
  assert.equal(isPublished({ published_at: iso(HOUR) }, NOW), false);
  assert.equal(isPublished({ published_at: iso(0) }, NOW), true);
  assert.equal(isPublished({}, NOW), true, '没有发布时间按已发布处理');
});

test('splitMessages：分成当前与往期，定时公告两边都不出现', () => {
  const messages = [
    { id: 'a', published_at: iso(-HOUR), expires_at: null },
    { id: 'b', published_at: iso(-2 * HOUR), expires_at: iso(-HOUR) },
    { id: 'c', published_at: iso(HOUR), expires_at: null },
    { id: 'd', published_at: iso(-3 * HOUR), expires_at: iso(DAY) },
  ];
  const { current, past } = splitMessages(messages, { now: NOW });
  assert.deepEqual(current.map((m) => m.id), ['a', 'd']);
  assert.deepEqual(past.map((m) => m.id), ['b']);
  assert.equal(current.length + past.length, 3, '定时公告 c 不应出现在首页');
});

test('splitMessages：空数据不报错', () => {
  assert.deepEqual(splitMessages(null, { now: NOW }), { current: [], past: [], thresholdDays: 3 });
  assert.deepEqual(splitMessages([], { now: NOW }).current, []);
});

test('formatRelative：刚刚 / 分钟 / 小时 / 天 / 更早显示日期', () => {
  assert.equal(formatRelative(iso(-30 * 1000), NOW), '刚刚');
  assert.equal(formatRelative(iso(-5 * MINUTE), NOW), '5 分钟前');
  assert.equal(formatRelative(iso(-3 * HOUR), NOW), '3 小时前');
  assert.equal(formatRelative(iso(-2 * DAY), NOW), '2 天前');
  assert.equal(formatRelative(new Date(2024, 0, 2, 8, 0).toISOString(), NOW), '2024-01-02 08:00');
  assert.equal(formatRelative('', NOW), '');
});

test('formatRelative：未来时间显示"后"', () => {
  assert.equal(formatRelative(iso(30 * MINUTE), NOW), '30 分钟后');
  assert.equal(formatRelative(iso(2 * DAY), NOW), '2 天后');
});

test('formatAbsolute：补零，且用本地时区显示', () => {
  assert.equal(formatAbsolute(new Date(2025, 2, 1, 8, 5).toISOString()), '2025-03-01 08:05');
  assert.equal(formatAbsolute(''), '');
});

test('formatExpiryNote：过期与快过期的说法', () => {
  assert.match(formatExpiryNote({ expires_at: iso(-HOUR) }, NOW), /已.*过期/);
  assert.equal(formatExpiryNote({ expires_at: iso(30 * MINUTE) }, NOW), '30 分钟后过期');
  assert.equal(formatExpiryNote({ expires_at: iso(5 * HOUR) }, NOW), '5 小时后过期');
  assert.equal(formatExpiryNote({ expires_at: iso(DAY + HOUR) }, NOW), '明天过期');
  assert.equal(formatExpiryNote({ expires_at: iso(5 * DAY) }, NOW), '5 天后过期');
  assert.equal(formatExpiryNote({ expires_at: null }, NOW), '');
});

test('datetime-local 的取值与回填能来回转换（不受时区影响）', () => {
  const local = '2025-03-01T08:05';
  const isoValue = fromLocalInputValue(local);
  assert.equal(toLocalInputValue(isoValue), local);

  assert.equal(fromLocalInputValue(''), null);
  assert.equal(fromLocalInputValue('乱写'), null);
  assert.equal(toLocalInputValue(null), '');
});

/* ==================== 发布时间解析（曾经的真实 bug） ==================== */
// 旧实现是 fromLocalInputValue(值) || new Date().toISOString()，
// 于是输入框为空或格式不对时，用户选的时间会被悄悄换成"现在"。

test('resolvePublishedAt：选了过去的时间，必须原样保留，不能被换成现在', () => {
  const past = '2025-03-01T08:05';
  const result = resolvePublishedAt(past, new Date(NOW));

  assert.equal(result.ok, true);
  assert.equal(result.usedNow, false, '不能用"现在"顶替');
  assert.equal(result.iso, fromLocalInputValue(past), '要保留用户选的时间');
  // 关键：解析结果确实早于"现在"
  assert.ok(new Date(result.iso).getTime() < NOW, '选的时间应当早于现在');
});

test('resolvePublishedAt：空值才按"现在"处理，并明确标记 usedNow', () => {
  for (const empty of ['', '   ', null, undefined]) {
    const now = new Date(NOW);
    const result = resolvePublishedAt(empty, now);
    assert.equal(result.ok, true);
    assert.equal(result.usedNow, true, '应显式告知用了默认值');
    assert.equal(result.iso, now.toISOString());
  }
});

test('resolvePublishedAt：格式不对时明确报错，绝不静默替换成现在', () => {
  for (const bad of ['乱写', '2025/03/01 08:05', 'not-a-date', '2025-13-45T99:99']) {
    const result = resolvePublishedAt(bad, new Date(NOW));
    assert.equal(result.ok, false, `「${bad}」应当被判定为不合法`);
    assert.match(result.error, /发布时间/);
    assert.equal(result.iso, undefined, '失败时不能给出任何时间，否则又会被静默使用');
  }
});

test('resolvePublishedAt：未来时间（定时公告）也能正常解析', () => {
  const future = toLocalInputValue(new Date(NOW + 3 * DAY));
  const result = resolvePublishedAt(future, new Date(NOW));
  assert.equal(result.ok, true);
  assert.equal(result.usedNow, false);
  assert.ok(new Date(result.iso).getTime() > NOW);
});
