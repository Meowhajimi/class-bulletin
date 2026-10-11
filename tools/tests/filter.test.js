/**
 * ui/filter.js 的单元测试。
 *
 * 这里是最容易写错边界的地方（尤其是"时间范围"和"紧急优先"），
 * 所以关键点都覆盖：区间含边界当天、只给一端、非法输入、紧急排序稳定性。
 *
 * 运行：node --test "tools/tests/*.test.js"
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { isUrgentMessage } from '../../web/js/data/contract.js';
import {
  filterMessages,
  hasActiveFilter,
  matchesKeyword,
  normalizeKeyword,
  rangeFromDateInputs,
  sortMessages,
} from '../../web/js/ui/filter.js';

const message = (over = {}) => ({
  id: over.id || Math.random().toString(36).slice(2),
  title: '标题',
  body: '正文',
  published_at: '2026-05-10T04:00:00+00:00', // 北京时间 12:00
  expires_at: null,
  is_urgent: false,
  ...over,
});

/* ============================ 关键词搜索 ============================ */

test('normalizeKeyword：去空格、转小写', () => {
  assert.equal(normalizeKeyword('  Hello  '), 'hello');
  assert.equal(normalizeKeyword(null), '');
  assert.equal(normalizeKeyword(undefined), '');
});

test('matchesKeyword：空关键词一律命中', () => {
  assert.equal(matchesKeyword(message(), ''), true);
  assert.equal(matchesKeyword(message(), '   '), true);
});

test('matchesKeyword：标题和正文都能搜到', () => {
  const item = message({ title: '周五交实验报告', body: '交到学习通平台' });
  assert.equal(matchesKeyword(item, '实验'), true);
  assert.equal(matchesKeyword(item, '学习通'), true, '正文也要能搜到');
  assert.equal(matchesKeyword(item, '不存在的词'), false);
});

test('matchesKeyword：大小写不敏感（英文）', () => {
  const item = message({ title: 'Python 作业', body: 'Homework 1' });
  assert.equal(matchesKeyword(item, 'python'), true);
  assert.equal(matchesKeyword(item, 'HOMEWORK'), true);
  assert.equal(matchesKeyword(item, 'PYTHON 作业'), true);
});

test('matchesKeyword：缺少标题或正文也不会崩', () => {
  assert.equal(matchesKeyword({}, 'x'), false);
  assert.equal(matchesKeyword({ title: null, body: undefined }, 'x'), false);
  assert.equal(matchesKeyword({ title: 'abc' }, 'abc'), true);
});

/* ============================== 时间范围 ============================== */

test('rangeFromDateInputs：结束日期要算到当天最后一刻（含边界当天）', () => {
  const { from, to } = rangeFromDateInputs('2026-05-01', '2026-05-01');

  const start = new Date(from);
  const end = new Date(to);
  assert.equal(start.getHours(), 0);
  assert.equal(end.getHours(), 23);
  assert.equal(end.getMinutes(), 59);
  assert.ok(end.getTime() > start.getTime());
});

test('rangeFromDateInputs：选同一天必须能查到当天的公告', () => {
  const day = '2026-05-10';
  const { from, to } = rangeFromDateInputs(day, day);
  const found = filterMessages([message({ published_at: '2026-05-10T04:00:00+00:00' })], { from, to });
  assert.equal(found.length, 1, '同一天的边界不能把自己排除掉');
});

test('rangeFromDateInputs：空值或乱填都当作"没这个条件"', () => {
  assert.deepEqual(rangeFromDateInputs('', ''), { from: null, to: null });
  assert.deepEqual(rangeFromDateInputs('乱写', '2026/05/01'), { from: null, to: null });
  assert.deepEqual(rangeFromDateInputs(null, undefined), { from: null, to: null });
});

test('hasActiveFilter：任一条件生效即为真', () => {
  assert.equal(hasActiveFilter({ keyword: '', from: null, to: null }), false);
  assert.equal(hasActiveFilter({}), false);
  assert.equal(hasActiveFilter({ keyword: '   ' }), false, '只有空格不算条件');
  assert.equal(hasActiveFilter({ keyword: 'a' }), true);
  assert.equal(hasActiveFilter({ from: 1 }), true);
  assert.equal(hasActiveFilter({ to: 1 }), true);
});

/* ============================== 筛选 ============================== */

test('filterMessages：关键词与时间范围是"与"的关系', () => {
  const items = [
    message({ id: 'a', title: '实验报告', published_at: '2026-05-10T04:00:00+00:00' }),
    message({ id: 'b', title: '实验报告', published_at: '2026-01-01T04:00:00+00:00' }),
    message({ id: 'c', title: '调课通知', published_at: '2026-05-10T04:00:00+00:00' }),
  ];
  const { from, to } = rangeFromDateInputs('2026-05-01', '2026-05-31');

  const found = filterMessages(items, { keyword: '实验', from, to });
  assert.deepEqual(found.map((item) => item.id), ['a']);
});

test('filterMessages：只给开始日期 / 只给结束日期都能用', () => {
  const items = [
    message({ id: 'old', published_at: '2026-01-01T04:00:00+00:00' }),
    message({ id: 'new', published_at: '2026-12-01T04:00:00+00:00' }),
  ];

  const afterMay = filterMessages(items, rangeFromDateInputs('2026-05-01', ''));
  assert.deepEqual(afterMay.map((item) => item.id), ['new']);

  const beforeMay = filterMessages(items, rangeFromDateInputs('', '2026-05-01'));
  assert.deepEqual(beforeMay.map((item) => item.id), ['old']);
});

test('filterMessages：没有任何条件时返回全部', () => {
  const items = [message({ id: 'a' }), message({ id: 'b' })];
  assert.equal(filterMessages(items, {}).length, 2);
  assert.equal(filterMessages(null, {}).length, 0);
});

test('filterMessages：有时间条件时，发布时间缺失的公告不参与匹配', () => {
  const items = [
    message({ id: 'ok', published_at: '2026-05-10T04:00:00+00:00' }),
    message({ id: 'broken', published_at: '' }),
    message({ id: 'garbage', published_at: '不是时间' }),
  ];
  const found = filterMessages(items, rangeFromDateInputs('2026-05-01', '2026-05-31'));
  assert.deepEqual(found.map((item) => item.id), ['ok']);
});

/* ============================== 排序 ============================== */

test('sortMessages：普通的按发布时间倒序', () => {
  const items = [
    message({ id: 'mid', published_at: '2026-05-01T00:00:00+00:00' }),
    message({ id: 'new', published_at: '2026-06-01T00:00:00+00:00' }),
    message({ id: 'old', published_at: '2026-04-01T00:00:00+00:00' }),
  ];
  assert.deepEqual(sortMessages(items).map((item) => item.id), ['new', 'mid', 'old']);
});

test('sortMessages：紧急公告排最前，其余仍按时间倒序', () => {
  const items = [
    message({ id: 'newest', published_at: '2026-06-01T00:00:00+00:00' }),
    message({ id: 'urgent-old', published_at: '2025-01-01T00:00:00+00:00', is_urgent: true }),
    message({ id: 'mid', published_at: '2026-05-01T00:00:00+00:00' }),
  ];
  assert.deepEqual(sortMessages(items).map((item) => item.id), ['urgent-old', 'newest', 'mid']);
});

test('sortMessages：多条紧急之间也按时间倒序', () => {
  const items = [
    message({ id: 'u1', published_at: '2026-01-01T00:00:00+00:00', is_urgent: true }),
    message({ id: 'u2', published_at: '2026-03-01T00:00:00+00:00', is_urgent: true }),
    message({ id: 'n1', published_at: '2026-06-01T00:00:00+00:00' }),
  ];
  assert.deepEqual(sortMessages(items).map((item) => item.id), ['u2', 'u1', 'n1']);
});

test('sortMessages：不改动传入的数组（保持纯函数）', () => {
  const items = [
    message({ id: 'a', published_at: '2026-01-01T00:00:00+00:00' }),
    message({ id: 'b', published_at: '2026-02-01T00:00:00+00:00' }),
  ];
  const snapshot = items.map((item) => item.id);
  sortMessages(items);
  assert.deepEqual(items.map((item) => item.id), snapshot);
});

test('sortMessages：空输入、缺失时间都不会崩', () => {
  assert.deepEqual(sortMessages(null), []);
  assert.deepEqual(sortMessages([]), []);
  const items = [message({ id: 'noTime', published_at: '' }), message({ id: 'hasTime' })];
  assert.equal(sortMessages(items).length, 2);
});

/* ===================== 紧急标记的判定（0/1 也要认） ===================== */

test('isUrgentMessage：布尔、0/1、字符串都能正确判断', () => {
  assert.equal(isUrgentMessage({ is_urgent: true }), true);
  assert.equal(isUrgentMessage({ is_urgent: false }), false);
  assert.equal(isUrgentMessage({ is_urgent: 1 }), true, '本地 SQLite 存的是 1');
  assert.equal(isUrgentMessage({ is_urgent: 0 }), false);
  assert.equal(isUrgentMessage({ is_urgent: 'true' }), true);
  assert.equal(isUrgentMessage({}), false);
  assert.equal(isUrgentMessage(null), false);
});
