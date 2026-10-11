/**
 * ui/dom.js 的测试。
 *
 * 为什么需要：这类错误**不会让测试变红，也不会报错**，只会在页面上
 * 显示出一行 "[object Object]" —— 用户看到了才有人知道。
 * 真实事故：备份询问框里的「以后不再询问」复选框，标签文字被写成了
 * `{ text: rememberLabel }` 当成子节点传进去，于是显示成 [object Object]。
 *
 * Node 里没有 DOM，所以用 tools/tests/fake-dom.js 里的最小替身
 * （render.test.js 也用同一份）。
 *
 * 运行：node --test "tools/tests/*.test.js"
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { installFakeDom } from './fake-dom.js';

installFakeDom();

const { el, append } = await import('../../web/js/ui/dom.js');

/* ================================ 正常用法 ================================ */

test('el：text 放第二个参数时正常渲染', () => {
  const node = el('span', { text: '紧急公告' });
  assert.equal(node.textContent, '紧急公告');
  assert.equal(node.text(), '紧急公告');
});

test('el：子节点可以是元素、字符串、数字', () => {
  const node = el('p', {}, el('span', { text: '标题' }), ' —— ', 42);
  assert.equal(node.text(), '标题 —— 42');
});

test('el：null / undefined / false / true 会被安全跳过（方便写条件渲染）', () => {
  const node = el('div', {}, null, undefined, false, true, '正文');
  assert.equal(node.text(), '正文');
  assert.equal(node.children.length, 1);
});

test('el：数组会被展平', () => {
  const node = el('ul', {}, [el('li', { text: 'a' }), el('li', { text: 'b' })] );
  assert.equal(node.text(), 'ab');
});

test('el：class / dataset / onclick / 普通属性都设置正确', () => {
  let clicked = 0;
  const node = el('button', {
    class: 'btn',
    dataset: { messageId: 'm1' },
    type: 'button',
    disabled: true,
    onclick: () => {
      clicked += 1;
    },
  });

  assert.equal(node.className, 'btn');
  assert.equal(node.dataset.messageId, 'm1');
  assert.equal(node.attributes.type, 'button');
  assert.equal(node.attributes.disabled, '');
  node.listeners.click();
  assert.equal(clicked, 1);
});

/* ====================== 真实事故：{ text } 当成子节点 ====================== */

test('el：把 { text: ... } 当子节点传时，显示文字而不是 [object Object]', () => {
  const originalWarn = console.warn;
  let warned = '';
  console.warn = (...args) => {
    warned += args.map(String).join(' ');
  };

  try {
    const node = el(
      'label',
      { class: 'dialog__remember' },
      el('input', { type: 'checkbox' }),
      { text: '以后不再询问' },
    );

    const rendered = node.text();
    assert.equal(rendered, '以后不再询问');
    assert.doesNotMatch(rendered, /\[object Object\]/, '绝不能再出现 [object Object]');
    assert.match(warned, /text/, '应当在控制台留下警告，提示调用处要修正');
  } finally {
    console.warn = originalWarn;
  }
});

test('el：完全无法识别的东西会被跳过并报警，而不是渲染成 [object Object]', () => {
  const originalWarn = console.warn;
  let warned = 0;
  console.warn = () => {
    warned += 1;
  };

  try {
    const fake = { nothing: 'useful' };
    const node = el('div', {}, fake, '正常文字');
    assert.equal(node.text(), '正常文字');
    assert.doesNotMatch(node.text(), /\[object Object\]/);
    assert.equal(warned, 1, '应当报警一次');
  } finally {
    console.warn = originalWarn;
  }
});

test('append：返回父节点，方便链式调用', () => {
  const parent = el('div');
  assert.equal(append(parent, ['a', 'b']), parent);
  assert.equal(parent.text(), 'ab');
});
