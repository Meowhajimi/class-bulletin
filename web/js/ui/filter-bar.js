/**
 * 主界面的「搜索与筛选」栏。
 *
 * 只管三件事：关键词、开始日期、结束日期；筛选逻辑本身在 filter.js（纯函数、有测试）。
 * 任何一项变化都会回调 onChange，由 app.js 决定怎么渲染结果。
 */

import { el } from './dom.js';
import { rangeFromDateInputs } from './filter.js';

const TYPING_DEBOUNCE_MS = 150;

/**
 * @param {{onChange: (conditions: {keyword: string, from: number|null, to: number|null}) => void}} options
 * @returns {{element: HTMLElement, setCount: (text: string) => void}}
 */
export function renderFilterBar({ onChange }) {
  const keyword = el('input', {
    class: 'input',
    id: 'filter-keyword',
    type: 'search',
    autocomplete: 'off',
    placeholder: '搜索标题或正文',
  });
  const fromDate = el('input', { class: 'input', id: 'filter-from', type: 'date' });
  const toDate = el('input', { class: 'input', id: 'filter-to', type: 'date' });
  const clearButton = el('button', {
    type: 'button',
    class: 'btn btn--small btn--ghost',
    text: '清空',
  });
  const count = el('span', { class: 'filter-bar__count' });

  let debounceTimer = 0;

  const emit = () => {
    const { from, to } = rangeFromDateInputs(fromDate.value, toDate.value);
    onChange({ keyword: keyword.value, from, to });
  };

  // 打字时防抖，日期选择则立刻生效
  keyword.addEventListener('input', () => {
    window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(emit, TYPING_DEBOUNCE_MS);
  });
  fromDate.addEventListener('change', emit);
  toDate.addEventListener('change', emit);

  clearButton.addEventListener('click', () => {
    keyword.value = '';
    fromDate.value = '';
    toDate.value = '';
    emit();
    keyword.focus();
  });

  const element = el(
    'div',
    { class: 'filter-bar' },
    el('div', { class: 'filter-bar__row' }, keyword),
    el(
      'div',
      { class: 'filter-bar__row' },
      el('label', { class: 'filter-bar__label', for: 'filter-from', text: '从' }),
      fromDate,
      el('label', { class: 'filter-bar__label', for: 'filter-to', text: '到' }),
      toDate,
      clearButton,
    ),
    count,
  );

  return {
    element,
    setCount: (text) => {
      count.textContent = text || '';
      count.hidden = !text;
    },
  };
}
