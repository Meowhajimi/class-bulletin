/**
 * 多栏目（栏目 / 总栏目）的规则测试。
 *
 * 这里覆盖的都是"最容易悄悄出错"的地方：
 *   · 公告 → 栏目的归属（含 section_id 为空、指向已删栏目这两种老数据情况）
 *   · 总栏目 = 所有栏目的紧急公告（不多、不少、不重复计数）
 *   · 栏目内"先紧急后普通"
 *   · 栏目名的规范化与长度上限（要和 SQL / Python 三处一致）
 *
 * 运行：node --test "tools/tests/*.test.js"
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SECTION_NAME_MAX,
  normalizeSectionName,
  sectionOf,
} from '../../web/js/data/contract.js';
import {
  AGGREGATE_SECTION_ID,
  aggregateMessages,
  messagesOfSection,
  sectionUrgentCounts,
  splitUrgentFirst,
} from '../../web/js/ui/filter.js';

const SECTIONS = [
  { id: 'sec-study', name: '学习委员通知' },
  { id: 'sec-class', name: '班级事务' },
  { id: 'sec-sport', name: '体育委员' },
];

const message = (over = {}) => ({
  id: over.id || Math.random().toString(36).slice(2),
  title: '标题',
  body: '正文',
  published_at: '2026-05-10T04:00:00+00:00',
  expires_at: null,
  is_urgent: false,
  section_id: 'sec-study',
  ...over,
});

/* ============================ 归属规则 ============================ */

test('sectionOf：正常命中自己的栏目', () => {
  assert.equal(sectionOf(message({ section_id: 'sec-class' }), SECTIONS).name, '班级事务');
});

test('sectionOf：section_id 为空时回退到第一个栏目（老数据没迁移）', () => {
  assert.equal(sectionOf(message({ section_id: '' }), SECTIONS).id, 'sec-study');
  assert.equal(sectionOf(message({ section_id: null }), SECTIONS).id, 'sec-study');
  assert.equal(sectionOf({}, SECTIONS).id, 'sec-study');
});

test('★ sectionOf：指向一个已经删掉的栏目时也回退，公告不会凭空消失', () => {
  assert.equal(sectionOf(message({ section_id: 'sec-deleted' }), SECTIONS).id, 'sec-study');
});

test('sectionOf：没有栏目（数据库还没建表）时返回 null，交给界面降级', () => {
  assert.equal(sectionOf(message(), []), null);
  assert.equal(sectionOf(message(), null), null);
  assert.equal(sectionOf(message(), undefined), null);
});

test('sectionOf：section_id 是数字也能比（本地 SQLite 可能给出非字符串）', () => {
  const sections = [{ id: 7, name: '七号栏目' }];
  assert.equal(sectionOf({ section_id: '7' }, sections).name, '七号栏目');
});

/* ============================ 标签下看到什么 ============================ */

test('messagesOfSection：普通栏目只出自己的公告', () => {
  const list = [
    message({ id: 'a', section_id: 'sec-study' }),
    message({ id: 'b', section_id: 'sec-class' }),
    message({ id: 'c', section_id: 'sec-study', is_urgent: true }),
  ];
  const ids = messagesOfSection(list, 'sec-study', SECTIONS).map((item) => item.id);
  assert.deepEqual(ids, ['a', 'c']);
});

test('★ messagesOfSection：总栏目 = 所有栏目的紧急公告（跨栏目汇总）', () => {
  const list = [
    message({ id: 'a', section_id: 'sec-study' }),
    message({ id: 'b', section_id: 'sec-class', is_urgent: true }),
    message({ id: 'c', section_id: 'sec-study', is_urgent: true }),
    message({ id: 'd', section_id: 'sec-sport', is_urgent: true }),
  ];
  const ids = messagesOfSection(list, AGGREGATE_SECTION_ID, SECTIONS).map((item) => item.id);
  assert.deepEqual(ids, ['b', 'c', 'd']);
});

test('messagesOfSection：总栏目在没有紧急公告时返回空数组', () => {
  const list = [message({ id: 'a' }), message({ id: 'b', section_id: 'sec-class' })];
  assert.deepEqual(messagesOfSection(list, AGGREGATE_SECTION_ID, SECTIONS), []);
});

test('messagesOfSection：总栏目也认 0/1 形式的紧急标记（本地 SQLite）', () => {
  const list = [message({ id: 'a', is_urgent: 1 }), message({ id: 'b', is_urgent: 0 })];
  assert.deepEqual(
    messagesOfSection(list, AGGREGATE_SECTION_ID, SECTIONS).map((item) => item.id),
    ['a'],
  );
});

test('messagesOfSection：空输入不崩', () => {
  assert.deepEqual(messagesOfSection(null, 'sec-study', SECTIONS), []);
  assert.deepEqual(messagesOfSection([], AGGREGATE_SECTION_ID, SECTIONS), []);
});

test('★ 总栏目的 id 不会和真实栏目 id 撞车', () => {
  // 真实 id 是 uuid 或本地 uuid 形式的 text，都带连字符且不含双下划线
  const realIds = [
    '00000000-0000-0000-0000-000000000001',
    '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    'local-1712345678901-42',
  ];
  for (const id of realIds) {
    assert.notEqual(id, AGGREGATE_SECTION_ID);
    assert.equal(id.includes('__'), false, `${id} 不该含双下划线`);
  }
});

/* ============================ 紧急 / 普通分段 ============================ */

test('splitUrgentFirst：紧急在前、普通在后，且各自保持原顺序', () => {
  const list = [
    message({ id: 'n1' }),
    message({ id: 'u1', is_urgent: true }),
    message({ id: 'n2' }),
    message({ id: 'u2', is_urgent: true }),
  ];
  const { urgent, normal } = splitUrgentFirst(list);
  assert.deepEqual(urgent.map((item) => item.id), ['u1', 'u2']);
  assert.deepEqual(normal.map((item) => item.id), ['n1', 'n2']);
});

test('splitUrgentFirst：不丢条目（两边加起来等于原来那么多）', () => {
  const list = [message({ is_urgent: true }), message(), message(), message({ is_urgent: 1 })];
  const { urgent, normal } = splitUrgentFirst(list);
  assert.equal(urgent.length + normal.length, list.length);
});

test('splitUrgentFirst：空输入不崩', () => {
  assert.deepEqual(splitUrgentFirst(null), { urgent: [], normal: [] });
  assert.deepEqual(splitUrgentFirst([]), { urgent: [], normal: [] });
});

/* ============================ 标签上的数字 ============================ */

test('sectionUrgentCounts：每个栏目各算各的紧急条数', () => {
  const list = [
    message({ section_id: 'sec-study', is_urgent: true }),
    message({ section_id: 'sec-study', is_urgent: true }),
    message({ section_id: 'sec-class', is_urgent: true }),
    message({ section_id: 'sec-study' }),
  ];
  const counts = sectionUrgentCounts(list, SECTIONS);
  assert.equal(counts.get('sec-study'), 2);
  assert.equal(counts.get('sec-class'), 1);
  assert.equal(counts.get('sec-sport'), 0, '没有紧急公告的栏目也要出现，值为 0');
});

test('sectionUrgentCounts：普通公告不计入', () => {
  const counts = sectionUrgentCounts([message({ is_urgent: false })], SECTIONS);
  assert.equal(counts.get('sec-study'), 0);
});

test('sectionUrgentCounts：所有栏目之和 = 总栏目的条数', () => {
  const list = [
    message({ section_id: 'sec-study', is_urgent: true }),
    message({ section_id: 'sec-class', is_urgent: 1 }),
    message({ section_id: 'sec-sport', is_urgent: true }),
    message({ section_id: 'sec-sport' }),
  ];
  const counts = sectionUrgentCounts(list, SECTIONS);
  const sum = [...counts.values()].reduce((total, value) => total + value, 0);
  assert.equal(sum, messagesOfSection(list, AGGREGATE_SECTION_ID, SECTIONS).length);
});

test('sectionUrgentCounts：空输入返回全 0 的表', () => {
  const counts = sectionUrgentCounts([], SECTIONS);
  assert.equal(counts.size, SECTIONS.length);
  assert.equal([...counts.values()].every((value) => value === 0), true);
});

/* ============================ 总栏目的范围 ============================ */

test('aggregateMessages：默认只给紧急公告（总栏目 = 紧急汇总）', () => {
  const list = [
    message({ id: 'a' }),
    message({ id: 'b', is_urgent: true }),
    message({ id: 'c', section_id: 'sec-class' }),
  ];
  assert.deepEqual(aggregateMessages(list, {}).map((item) => item.id), ['b']);
  assert.deepEqual(aggregateMessages(list).map((item) => item.id), ['b'], '不传参数也是只给紧急');
});

test('★ aggregateMessages：勾了「也显示普通公告」才把普通的一起带出来', () => {
  const list = [
    message({ id: 'a' }),
    message({ id: 'b', is_urgent: true }),
    message({ id: 'c', section_id: 'sec-class' }),
  ];
  const ids = aggregateMessages(list, { includeNormal: true }).map((item) => item.id);
  assert.deepEqual(ids, ['a', 'b', 'c'], '全部公告都要，排序交给 sortMessages');
});

test('aggregateMessages：0/1 形式的紧急标记也认（本地 SQLite）', () => {
  const list = [message({ id: 'a', is_urgent: 1 }), message({ id: 'b', is_urgent: 0 })];
  assert.deepEqual(aggregateMessages(list).map((item) => item.id), ['a']);
  assert.deepEqual(aggregateMessages(list, { includeNormal: true }).map((item) => item.id), ['a', 'b']);
});

test('★ 开不开开关，紧急条数都一致（开关不该影响紧急汇总）', () => {
  const list = [
    message({ id: 'a', is_urgent: true }),
    message({ id: 'b', is_urgent: true, section_id: 'sec-class' }),
    message({ id: 'c' }),
  ];
  const urgentOnly = aggregateMessages(list).filter((item) => item.is_urgent).length;
  const withNormal = aggregateMessages(list, { includeNormal: true }).filter((item) => item.is_urgent).length;
  assert.equal(urgentOnly, 2);
  assert.equal(withNormal, 2, '勾了开关也不会多出紧急公告');
});

test('aggregateMessages：空输入不崩', () => {
  assert.deepEqual(aggregateMessages(null), []);
  assert.deepEqual(aggregateMessages([], { includeNormal: true }), []);
});

/* ============================ 栏目名规范 ============================ */

test('normalizeSectionName：去首尾空格，保留中间空格', () => {
  assert.equal(normalizeSectionName('  班级事务  '), '班级事务');
  assert.equal(normalizeSectionName('班级 事务'), '班级 事务');
  assert.equal(normalizeSectionName(null), '');
  assert.equal(normalizeSectionName(undefined), '');
  assert.equal(normalizeSectionName(42), '42');
});

test('★ 栏目名长度上限三处一致（前端 / db.py / schema.sql）', () => {
  // 前端这一处
  assert.equal(SECTION_NAME_MAX, 40);

  // Python 那一处（由 python 测试负责比对，这里只固定住前端值）
  assert.equal(typeof SECTION_NAME_MAX, 'number');
});

test('normalizeSectionName：只 trim 不改大小写（中文场景没必要合并）', () => {
  assert.equal(normalizeSectionName('Class'), 'Class');
  assert.notEqual(normalizeSectionName('Class'), normalizeSectionName('class'));
});
