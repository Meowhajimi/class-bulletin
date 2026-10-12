/**
 * 总栏目上方的「也显示普通公告」开关。
 *
 * 背景：总栏目默认只汇总各栏目的**紧急**公告（这是最初的设定）。
 * 但有时同学想"一屏看完所有公告"，所以给一个开关。
 *
 * 设计取舍：
 *   · **每个同学自己勾** —— 选择存在他自己的浏览器里（localStorage），
 *     换个人打开是默认状态，互不影响。
 *   · 默认关闭：保持"总栏目 = 紧急汇总"这个清晰含义。
 *   · 存 localStorage 而不是 sessionStorage：这是个内容偏好，
 *     关掉浏览器再回来还应该记得。
 */

import { el } from './dom.js';

const SHOW_ALL_KEY = 'class-bulletin.aggregate-show-all';

/** 读上次的选择；读不到（或隐私模式）就当 false */
export function isAggregateShowAll() {
  try {
    return localStorage.getItem(SHOW_ALL_KEY) === '1';
  } catch {
    return false;
  }
}

/** 记住选择 */
export function setAggregateShowAll(value) {
  try {
    if (value) localStorage.setItem(SHOW_ALL_KEY, '1');
    else localStorage.removeItem(SHOW_ALL_KEY);
  } catch {
    // 隐私模式下写不了，这一次仍然生效，只是下次打开会回到默认
  }
}

/**
 * 渲染那个开关。
 *
 * @param {{checked: boolean, onChange: (checked: boolean) => void}} options
 * @returns {{element: HTMLElement, input: HTMLInputElement}}
 */
export function renderAggregateToggle({ checked, onChange }) {
  const input = el('input', { type: 'checkbox', id: 'aggregate-show-all' });
  input.checked = Boolean(checked);

  input.addEventListener('change', () => {
    onChange(Boolean(input.checked));
  });

  const element = el(
    'div',
    { class: 'aggregate-toggle' },
    el(
      'label',
      { class: 'check-row check-row--muted', for: 'aggregate-show-all' },
      input,
      el('span', { text: '也显示普通公告' }),
    ),
  );

  return { element, input };
}
