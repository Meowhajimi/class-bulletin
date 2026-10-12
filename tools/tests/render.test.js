/**
 * 界面组件的"渲染冒烟测试"。
 *
 * 为什么需要：单元测试能证明纯函数正确，但证明不了"把界面拼出来时不出错"。
 * 真实事故：备份询问框里把 `{ text: rememberLabel }` 当成子节点传进去，
 * 结果页面上显示一行 `[object Object]` —— 不报错、测试也不红，只有用户看到。
 *
 * 这里的做法：把所有组件都真的渲染一遍，然后断言
 *   ★ 一条 console.warn 都没有
 *      （dom.js 遇到"不能当子节点的东西"会 warn，所以这条断言能抓住那类错误）
 *   ★ 关键文字出现在产出的 DOM 里
 *
 * 运行：node --test "tools/tests/*.test.js"
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { captureWarnings, installFakeDom } from './fake-dom.js';

installFakeDom();

const { renderMessageCard, summarize } = await import('../../web/js/ui/message-card.js');
const states = await import('../../web/js/ui/states.js');
const icons = await import('../../web/js/ui/icon.js');
const { renderFilterBar } = await import('../../web/js/ui/filter-bar.js');
const { AGGREGATE_SECTION_ID } = await import('../../web/js/ui/filter.js');
const { renderSectionTabs } = await import('../../web/js/ui/section-tabs.js');
const { askDialog, askChoiceDialog } = await import('../../web/js/ui/dialog.js');
const presence = await import('../../web/js/ui/presence.js');

/** 渲染一批组件，返回期间产生的所有 console.warn */
function renderAndCollectWarnings(callback) {
  const capture = captureWarnings();
  try {
    const result = callback();
    return { warnings: capture.messages, result };
  } finally {
    capture.restore();
  }
}

const baseMessage = {
  id: 'm1',
  title: '本周五交实验报告',
  body: '提交到学习通平台。',
  published_at: '2026-05-10T04:00:00+00:00',
  expires_at: null,
  is_urgent: false,
  created_at: '2026-05-10T04:00:00+00:00',
  updated_at: '2026-05-10T04:00:00+00:00',
};

/* ==================== 全部组件渲染都不该有警告 ==================== */

test('所有状态占位渲染时没有警告', () => {
  const { warnings } = renderAndCollectWarnings(() => [
    states.loadingState(),
    states.emptyState(),
    states.emptyState('自定义标题', '自定义说明'),
    states.errorState('出错了', () => {}),
    states.notConfiguredState(),
    states.noticeState('标题', '正文'),
    states.unsafeKeyState('key 填错了'),
  ]);
  assert.deepEqual(warnings, [], '组件渲染不该产生警告');
});

test('消息卡片的各种形态渲染时没有警告', () => {
  const { warnings } = renderAndCollectWarnings(() =>
    [
      renderMessageCard(baseMessage),
      renderMessageCard({ ...baseMessage, is_urgent: true }),
      renderMessageCard({ ...baseMessage, expires_at: '2020-01-01T00:00:00+00:00' }),
      renderMessageCard(
        { ...baseMessage, body: '很长的正文'.repeat(50) },
        { summaryLength: 20, detailHref: 'message.html?id=m1' },
      ),
      renderMessageCard(baseMessage, {
        extraBadges: [{ label: '未到发布时间', kind: 'accent' }],
        actions: [{ label: '编辑', onClick: () => {} }],
      }),
      renderMessageCard({ id: 'x', title: '', body: '' }),
    ],
  );
  assert.deepEqual(warnings, [], '组件渲染不该产生警告');
});

test('筛选栏渲染时没有警告', () => {
  const { warnings } = renderAndCollectWarnings(() => renderFilterBar({ onChange: () => {} }));
  assert.deepEqual(warnings, [], '组件渲染不该产生警告');
});

test('★ 栏目标签行渲染时没有警告，且总栏目在最前', () => {
  const sections = [
    { id: 'sec-study', name: '学习委员通知' },
    { id: 'sec-class', name: '班级事务' },
  ];

  const { warnings, result } = renderAndCollectWarnings(() =>
    renderSectionTabs({
      sections,
      aggregateName: '总栏目',
      activeId: AGGREGATE_SECTION_ID,
      onSelect: () => {},
    }),
  );
  assert.deepEqual(warnings, [], '组件渲染不该产生警告');

  const { element, setActive, setCounts } = result;
  // 用 text() 取"用户在页面上看到的文字"（文字挂在里面的 span 上）
  const labels = element.children.map((child) => child.text());
  assert.ok(labels[0].startsWith('总栏目'), `总栏目必须排第一，实际顺序 ${labels.join(' / ')}`);
  assert.deepEqual(labels.slice(1), ['学习委员通知', '班级事务']);

  // 计数：总栏目显示紧急总数，其它栏目各显示自己的
  setCounts(new Map([['sec-study', 2], ['sec-class', 0]]), 2);
  assert.deepEqual(warnings, [], '设置数字也不该产生警告');
  assert.equal(element.children[0].text(), '总栏目2', '总栏目要显示紧急总数');
  assert.equal(element.children[1].text(), '学习委员通知2');
  assert.equal(element.children[2].text(), '班级事务', '0 条时不显示数字');

  // 选中态
  setActive('sec-class');
  assert.equal(element.children[1].getAttribute('aria-selected'), 'false');
  assert.equal(element.children[2].getAttribute('aria-selected'), 'true');
  assert.equal(element.children[2].classList.contains('section-tabs__tab--active'), true);
});

test('栏目标签行：没有栏目（数据库还没建表）时只剩总栏目，不崩', () => {
  const { warnings, result } = renderAndCollectWarnings(() =>
    renderSectionTabs({ sections: [], activeId: AGGREGATE_SECTION_ID, onSelect: () => {} }),
  );
  assert.deepEqual(warnings, [], '组件渲染不该产生警告');
  assert.equal(result.element.children.length, 1);
});

test('栏目标签行：点击回调带上正确的 id', () => {
  const clicked = [];
  const { result } = renderAndCollectWarnings(() =>
    renderSectionTabs({
      sections: [{ id: 'sec-study', name: '学习委员通知' }],
      activeId: AGGREGATE_SECTION_ID,
      onSelect: (id) => clicked.push(id),
    }),
  );

  // 假 DOM 里事件通过 listeners + dispatch 触发
  result.element.children[0].dispatch('click', {});
  result.element.children[1].dispatch('click', {});
  assert.deepEqual(clicked, [AGGREGATE_SECTION_ID, 'sec-study']);
});

test('所有图标渲染时没有警告，且都带 aria-hidden（读屏软件不用念装饰图）', () => {
  const { warnings, result } = renderAndCollectWarnings(() =>
    ['empty', 'error', 'notice', 'loading'].map((name) => icons.icon(name)),
  );
  assert.deepEqual(warnings, [], '图标渲染不该产生警告');

  for (const graphic of result) {
    assert.ok(graphic, '每个图标都应该能创建出来');
    assert.equal(graphic.getAttribute('aria-hidden'), 'true');
    assert.ok(graphic.childNodes.length > 0, '图标里应当有图形');
  }
});

test('★ urgent 图标已随右下角浮动标记一起删除', () => {
  // 首页不再有那个浮动红色胶囊（功能被顶部「总栏目」标签取代），
  // 所以图标也不该再存在 —— 否则就是没人用的死代码。
  assert.equal(icons.icon('urgent'), null, 'urgent 图标应当已删除');

  const appSource = readFileSync(new URL('../../web/js/app.js', import.meta.url), 'utf8');
  assert.equal(/urgent-flag|urgentFlag/.test(appSource), false, 'app.js 里不该再有浮动标记的代码');
  assert.equal(
    /icon\(/.test(appSource),
    false,
    'app.js 不该再引用图标（浮动标记移除后没有别的图标用途）',
  );
});

test('★ 首页 HTML 里不该再有浮动紧急标记（CSS 的 display 会盖掉 hidden）', () => {
  const html = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
  assert.equal(/urgent-flag/.test(html), false, 'index.html 里不该再有 .urgent-flag');

  const css = readFileSync(new URL('../../web/css/components.css', import.meta.url), 'utf8');
  assert.equal(/\.urgent-flag/.test(css), false, 'components.css 里不该再有 .urgent-flag 样式');
});

test('未知图标名返回 null，而不是崩掉', () => {
  assert.equal(icons.icon('并不存在的图标'), null);
});

test('空态 / 错误态 / 提醒态都带图标', () => {
  for (const state of [
    states.emptyState(),
    states.errorState('出错了'),
    states.noticeState('标题', '正文'),
    states.notConfiguredState(),
    states.unsafeKeyState('key 不对'),
  ]) {
    const box = state.find((node) => node.className === 'state__icon');
    assert.ok(box, '状态占位里应当有图标容器');
    assert.ok(box.find((node) => node.tagName === 'svg'), '图标容器里应当有 svg');
  }
  // 加载骨架不需要图标（它自己就是占位图形）
  assert.equal(states.loadingState().find((node) => node.className === 'state__icon'), null);
});

/* ========================= 卡片内容是否正确 ========================= */

test('卡片显示标题、时间和正文摘要', () => {
  const card = renderMessageCard(baseMessage);
  const text = card.text();
  assert.match(text, /本周五交实验报告/);
  assert.match(text, /提交到学习通平台/);
});

test('紧急公告带「紧急」徽章，并且有独立的样式类', () => {
  const card = renderMessageCard({ ...baseMessage, is_urgent: true });
  assert.match(card.text(), /紧急/);
  assert.match(card.className, /card--urgent/, '应当带上 card--urgent 类');
});

test('普通公告不带紧急样式', () => {
  const card = renderMessageCard(baseMessage);
  assert.doesNotMatch(card.className, /card--urgent/);
});

test('已过期公告带「已过期」徽章和 card--expired 类', () => {
  const card = renderMessageCard(
    { ...baseMessage, expires_at: '2020-01-01T00:00:00+00:00' },
    { now: Date.parse('2026-05-10T04:00:00+00:00') },
  );
  assert.match(card.text(), /已过期/);
  assert.match(card.className, /card--expired/);
});

test('摘要截断：超长时截断并给出「查看详情」链接', () => {
  const long = '很长的正文'.repeat(50);
  const card = renderMessageCard(
    { ...baseMessage, body: long },
    { summaryLength: 10, detailHref: 'message.html?id=m1' },
  );

  const link = card.find((node) => node.tagName === 'a');
  assert.ok(link, '应当有一个链接');
  assert.equal(link.getAttribute('href'), 'message.html?id=m1');

  const text = card.text();
  assert.match(text, /查看详情/);
  assert.ok(!text.includes(long), '摘要不该把全文都放进来');
});

test('摘要不超长时不加「查看详情」链接', () => {
  const card = renderMessageCard(baseMessage, { summaryLength: 100 });
  assert.equal(card.find((node) => node.tagName === 'a'), null);
});

test('summarize：按码点截断，不会把 emoji 剪成半个', () => {
  assert.deepEqual(summarize('short', 100), { text: 'short', truncated: false });
  assert.deepEqual(summarize('abcdef', 3), { text: 'abc…', truncated: true });

  // '👍' 是一个码点但两个 UTF-16 码元，按码点切才安全
  const emoji = '👍👍👍';
  assert.equal(summarize(emoji, 2).text, '👍👍…');
  assert.equal(summarize('', 5).text, '');
  assert.equal(summarize('abc', 0).text, 'abc', '0 表示不截断');
});

test('编辑按钮会触发传入的回调', () => {
  let clicked = 0;
  const card = renderMessageCard(baseMessage, {
    actions: [{ label: '编辑', onClick: () => { clicked += 1; } }],
  });
  const button = card.find((node) => node.tagName === 'button' && node.textContent === '编辑');
  assert.ok(button);
  button.dispatch('click');
  assert.equal(clicked, 1);
});

/* ============================ 筛选栏交互 ============================ */

test('筛选栏：输入关键词后会回调（防抖后）', async () => {
  const received = [];
  const bar = renderFilterBar({ onChange: (conditions) => received.push(conditions) });
  const keyword = bar.element.find((node) => node.attributes.id === 'filter-keyword');
  assert.ok(keyword, '应当有关键词输入框');

  keyword.value = '实验';
  keyword.dispatch('input');
  await new Promise((resolve) => setTimeout(resolve, 250));

  assert.ok(received.length >= 1, '防抖结束后应当回调一次');
  assert.equal(received.at(-1).keyword, '实验');
});

test('筛选栏：点「清空」会回调空条件并清掉输入', () => {
  const received = [];
  const bar = renderFilterBar({ onChange: (conditions) => received.push(conditions) });

  const keyword = bar.element.find((node) => node.attributes.id === 'filter-keyword');
  const from = bar.element.find((node) => node.attributes.id === 'filter-from');
  const clearButton = bar.element.find((node) => node.tagName === 'button');

  keyword.value = 'abc';
  from.value = '2026-05-01';
  clearButton.dispatch('click');

  assert.equal(keyword.value, '');
  assert.equal(from.value, '');
  const last = received.at(-1);
  assert.equal(last.keyword, '');
  assert.equal(last.from, null);
  assert.equal(last.to, null);
});

/* ======================= 对话框（真实事故的回归测试） ======================= */

test('对话框：记住选项的文字正常显示，绝不能是 [object Object]', async () => {
  const capture = captureWarnings();
  let dialog;
  try {
    const promise = askDialog({
      title: '公告已保存',
      text: '要现在下载一份 Word 备份吗？',
      confirmText: '下载 Word 备份',
      cancelText: '不用了',
      rememberLabel: '以后不再询问（可在右侧面板改回来）',
    });

    dialog = globalThis.document.body.childNodes.at(-1);

    // 这就是出过问题的地方
    const label = dialog.find((node) => node.tagName === 'label');
    assert.ok(label, '应当有一个 label');
    assert.equal(label.text(), '以后不再询问（可在右侧面板改回来）');
    assert.doesNotMatch(label.text(), /\[object Object\]/);

    assert.match(dialog.text(), /公告已保存/);
    assert.match(dialog.text(), /要现在下载一份 Word 备份吗/);

    // 两个按钮都在
    const buttons = dialog.findAll((node) => node.tagName === 'button');
    assert.deepEqual(
      buttons.map((node) => node.textContent),
      ['下载 Word 备份', '不用了'],
    );

    // 勾上「以后不再询问」再点确认
    const checkbox = dialog.find((node) => node.attributes.type === 'checkbox');
    checkbox.checked = true;
    buttons[0].dispatch('click');

    const result = await promise;
    assert.deepEqual(result, { confirmed: true, remember: true });
  } finally {
    capture.restore();
  }

  assert.deepEqual(capture.messages, [], '对话框渲染不该产生警告');
});

test('对话框：点「不用了」返回取消，且不记住', async () => {
  const promise = askDialog({ title: '标题', confirmText: '好', cancelText: '算了' });
  const dialog = globalThis.document.body.childNodes.at(-1);

  const buttons = dialog.findAll((node) => node.tagName === 'button');
  buttons[1].dispatch('click');

  assert.deepEqual(await promise, { confirmed: false, remember: false });
});

test('对话框：按 Esc（cancel 事件）算作取消', async () => {
  const promise = askDialog({ title: '标题', confirmText: '好', cancelText: '算了' });
  const dialog = globalThis.document.body.childNodes.at(-1);

  dialog.dispatch('cancel', { preventDefault: () => {} });

  assert.deepEqual(await promise, { confirmed: false, remember: false });
});

test('对话框用完会从页面上移除', async () => {
  const promise = askDialog({ title: '标题', confirmText: '好', cancelText: '算了' });
  const dialog = globalThis.document.body.childNodes.at(-1);

  dialog.findAll((node) => node.tagName === 'button')[0].dispatch('click');
  await promise;

  assert.ok(
    !globalThis.document.body.childNodes.includes(dialog),
    '对话框应当被移除，不能一直留在页面上',
  );
});

/* ==================== 选择对话框（删栏目时选搬到哪） ==================== */

test('★ 选择对话框：渲染无警告，且确认时返回选中的栏目', async () => {
  const capture = captureWarnings();
  let result;
  try {
    const promise = askChoiceDialog({
      title: '「临时栏目」里还有 2 条公告',
      text: '选一个栏目把它们搬过去，然后删除本栏目。',
      options: [
        { value: 'sec-study', label: '学习委员通知' },
        { value: 'sec-class', label: '班级事务' },
      ],
      confirmText: '搬过去并删除栏目',
    });

    const dialog = globalThis.document.body.childNodes.at(-1);
    // 选中第二项再确认
    const select = dialog.find((node) => node.tagName === 'select');
    select.value = 'sec-class';
    dialog.findAll((node) => node.tagName === 'button')[0].dispatch('click');
    result = await promise;
  } finally {
    capture.restore();
  }

  assert.deepEqual(capture.messages, [], '选择对话框渲染不该产生警告');
  assert.equal(result, 'sec-class', '应当返回用户选中的栏目 id');
});

test('选择对话框：取消返回 null', async () => {
  const promise = askChoiceDialog({
    title: '标题',
    options: [{ value: 'a', label: 'A' }],
    cancelText: '不删了',
  });
  const dialog = globalThis.document.body.childNodes.at(-1);
  dialog.findAll((node) => node.tagName === 'button')[1].dispatch('click');
  assert.equal(await promise, null);
});

test('选择对话框：没有可选项时直接返回 null（不能弹一个空框）', async () => {
  assert.equal(await askChoiceDialog({ title: '标题', options: [] }), null);
});

test('选择对话框：用完也会从页面上移除', async () => {
  const promise = askChoiceDialog({
    title: '标题',
    options: [{ value: 'a', label: 'A' }],
  });
  const dialog = globalThis.document.body.childNodes.at(-1);
  dialog.findAll((node) => node.tagName === 'button')[0].dispatch('click');
  await promise;
  assert.ok(
    !globalThis.document.body.childNodes.includes(dialog),
    '对话框应当被移除，不能一直留在页面上',
  );
});

/* ============================ 在线人数 ============================ */

test('在线人数文案：只显示正数，0 或非法值返回空串（界面就不显示）', () => {
  assert.equal(presence.formatOnlineCount(3), '当前在线 3 人');
  assert.equal(presence.formatOnlineCount(1), '当前在线 1 人');
  assert.equal(presence.formatOnlineCount('7'), '当前在线 7 人');
  assert.equal(presence.formatOnlineCount(2.9), '当前在线 2 人');
  assert.equal(presence.formatOnlineCount(0), '');
  assert.equal(presence.formatOnlineCount(-1), '');
  assert.equal(presence.formatOnlineCount(null), '');
  assert.equal(presence.formatOnlineCount(undefined), '');
  assert.equal(presence.formatOnlineCount('abc'), '');
  assert.equal(presence.formatOnlineCount(NaN), '');
});

test('会话号：长度落在服务端接受的范围（8~64），且每次不同', () => {
  const seen = new Set();
  for (let index = 0; index < 50; index += 1) {
    const id = presence.createSessionId();
    assert.ok(id.length >= 8 && id.length <= 64, `长度不合法：${id}`);
    seen.add(id);
  }
  assert.equal(seen.size, 50, '每次生成都应当不同');
});

test('启动在线人数：立刻报心跳并显示人数', async () => {
  const heartbeats = [];
  const shown = [];
  const fakeSource = {
    presenceHeartbeat: async (id) => heartbeats.push(id),
    presenceCount: async () => 5,
  };

  const stop = presence.startPresence({
    source: fakeSource,
    onCount: (text) => shown.push(text),
    intervalMs: 100000, // 只测第一次，不等第二次
  });

  await new Promise((resolve) => setTimeout(resolve, 30));
  stop();

  assert.equal(heartbeats.length, 1, '启动时应当报一次心跳');
  assert.ok(heartbeats[0].length >= 8, '上报的会话号要合法');
  assert.deepEqual(shown, ['当前在线 5 人']);
});

test('接口出错时静默清空显示，不能把错误丢给同学', async () => {
  const shown = [];
  const brokenSource = {
    presenceHeartbeat: async () => {
      throw new Error('网络挂了');
    },
    presenceCount: async () => 0,
  };

  const stop = presence.startPresence({
    source: brokenSource,
    onCount: (text) => shown.push(text),
    intervalMs: 100000,
  });

  await new Promise((resolve) => setTimeout(resolve, 30));
  stop();

  assert.deepEqual(shown, [''], '出错时应当只是不显示人数');
});

test('页面切到后台就停止心跳（人不看了就不算在线）', async () => {
  let heartbeats = 0;
  const fakeSource = {
    presenceHeartbeat: async () => {
      heartbeats += 1;
    },
    presenceCount: async () => 1,
  };

  const stop = presence.startPresence({
    source: fakeSource,
    onCount: () => {},
    intervalMs: 20,
  });

  await new Promise((resolve) => setTimeout(resolve, 50));
  const whileVisible = heartbeats;
  assert.ok(whileVisible >= 2, `可见时应当持续心跳，实际 ${whileVisible}`);

  // 切到后台
  globalThis.document.hidden = true;
  globalThis.document.dispatch('visibilitychange');
  await new Promise((resolve) => setTimeout(resolve, 60));
  const afterHidden = heartbeats;
  assert.equal(afterHidden, whileVisible, '切到后台后不该再发心跳');

  // 切回前台
  globalThis.document.hidden = false;
  globalThis.document.dispatch('visibilitychange');
  await new Promise((resolve) => setTimeout(resolve, 20));

  stop();
  assert.ok(heartbeats > afterHidden, '切回前台后应当恢复心跳');
  assert.ok(!globalThis.document.hasListener('visibilitychange'), '停止后要摘掉监听');
});
