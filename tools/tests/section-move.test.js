/**
 * 「把栏目里的公告搬到另一个栏目」的测试（删栏目之前那一步）。
 *
 * 为什么要有这一块：删栏目要求栏目里没有公告（后端 409、数据库还有外键兜底），
 * 但光"拒绝"会让学习委员卡死 —— 他想删栏目却不知道怎么办。
 * 于是有了"搬完再删"。搬运是逐条 update，最怕的是：
 *   · 搬错对象（把别的栏目的公告也搬走了）
 *   · 搬一半失败却当成成功（用户以为删干净了，其实有几条留在原地）
 * 所以这两点都要有测试。
 *
 * 运行：node --test "tools/tests/*.test.js"
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { countInSection, moveSectionMessages } from '../../web/js/ui/section-move.js';

/** 假数据源：记录每次 update，也能按需让某几条失败 */
function fakeSource({ failOn = [] } = {}) {
  const calls = [];
  return {
    calls,
    async updateMessage(id, patch) {
      calls.push({ id, patch });
      if (failOn.includes(id)) throw new Error(`假装 ${id} 保存失败`);
      return { id, ...patch };
    },
  };
}

const MESSAGES = [
  { id: 'a', section_id: 'sec-temp' },
  { id: 'b', section_id: 'sec-study' },
  { id: 'c', section_id: 'sec-temp' },
  { id: 'd', section_id: '' },
];

test('countInSection：只数属于该栏目的', () => {
  assert.equal(countInSection(MESSAGES, 'sec-temp'), 2);
  assert.equal(countInSection(MESSAGES, 'sec-study'), 1);
  assert.equal(countInSection(MESSAGES, 'sec-none'), 0);
  assert.equal(countInSection(null, 'sec-temp'), 0);
});

test('★ moveSectionMessages：只搬源栏目的，不碰别的', async () => {
  const source = fakeSource();
  const { moved, failed } = await moveSectionMessages(source, MESSAGES, 'sec-temp', 'sec-study');

  assert.deepEqual(moved, ['a', 'c']);
  assert.deepEqual(failed, []);
  assert.equal(source.calls.length, 2, '只该更新两条');
  for (const call of source.calls) {
    assert.deepEqual(call.patch, { section_id: 'sec-study' });
  }
  assert.equal(
    source.calls.some((call) => call.id === 'b' || call.id === 'd'),
    false,
    '别的栏目的公告不该被动到',
  );
});

test('★ moveSectionMessages：搬一半失败要如实报告，不能假装成功', async () => {
  const source = fakeSource({ failOn: ['c'] });
  const { moved, failed } = await moveSectionMessages(source, MESSAGES, 'sec-temp', 'sec-study');

  assert.deepEqual(moved, ['a']);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].id, 'c');
  assert.match(String(failed[0].error && failed[0].error.message), /保存失败/);
});

test('moveSectionMessages：源栏目没公告时什么都不做', async () => {
  const source = fakeSource();
  const { moved, failed } = await moveSectionMessages(source, MESSAGES, 'sec-none', 'sec-study');
  assert.deepEqual(moved, []);
  assert.deepEqual(failed, []);
  assert.equal(source.calls.length, 0);
});

test('moveSectionMessages：源和目标相同就直接返回（防止无意义的一堆请求）', async () => {
  const source = fakeSource();
  const { moved } = await moveSectionMessages(source, MESSAGES, 'sec-temp', 'sec-temp');
  assert.deepEqual(moved, []);
  assert.equal(source.calls.length, 0);
});

test('moveSectionMessages：参数不合法时不崩', async () => {
  const source = fakeSource();
  assert.deepEqual(await moveSectionMessages(source, MESSAGES, '', 'sec-study'), { moved: [], failed: [] });
  assert.deepEqual(await moveSectionMessages(source, MESSAGES, 'sec-temp', ''), { moved: [], failed: [] });
  assert.deepEqual(await moveSectionMessages(null, MESSAGES, 'a', 'b'), { moved: [], failed: [] });
  assert.deepEqual(await moveSectionMessages(source, null, 'a', 'b'), { moved: [], failed: [] });
});

test('moveSectionMessages：section_id 为空/为 null 的老数据不会被误搬', async () => {
  const source = fakeSource();
  const list = [
    { id: 'x', section_id: null },
    { id: 'y' },
    { id: 'z', section_id: 'sec-temp' },
  ];
  const { moved } = await moveSectionMessages(source, list, 'sec-temp', 'sec-study');
  assert.deepEqual(moved, ['z']);
});
