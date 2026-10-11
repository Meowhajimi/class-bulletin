/**
 * 顶部的栏目标签行。
 *
 * 职责只有一件事：把「有哪些标签、现在选中哪个」画出来，并把点击回调出去。
 * 具体每个标签看到什么内容，由 app.js 调 filter.js 里的纯函数决定 ——
 * 界面不含业务规则，这是本项目的硬规矩。
 *
 * 标签顺序：**总栏目永远第一个**，后面按栏目的创建时间排。
 *
 * 无障碍：用 role="tablist" / role="tab" + aria-selected；
 * 标签多了会在手机上横向滚动（CSS 负责）。
 */

import { el, clear } from './dom.js';
import { AGGREGATE_SECTION_ID } from './filter.js';

/**
 * @param {{
 *   sections: Array<{id: string, name: string}>,
 *   aggregateName?: string,
 *   activeId: string,
 *   onSelect: (id: string) => void,
 * }} options
 * @returns {{element: HTMLElement, setActive: (id: string) => void, setCounts: (counts: Map<string, number>, total: number) => void}}
 */
export function renderSectionTabs({ sections, aggregateName = '总栏目', activeId, onSelect }) {
  const list = Array.isArray(sections) ? sections.filter(Boolean) : [];

  /** 标签按钮：id → button，用于后续只改状态、不重建 DOM */
  const buttons = new Map();

  const tab = (id, label, title) => {
    const button = el('button', {
      type: 'button',
      class: 'section-tabs__tab',
      role: 'tab',
      id: `tab-${id}`,
      'aria-selected': 'false',
      onclick: () => onSelect(id),
    });
    button.append(el('span', { class: 'section-tabs__label', text: label }));
    // 紧急条数：默认隐藏，setCounts 时再决定显不显示
    const count = el('span', { class: 'section-tabs__count', hidden: true });
    button.append(count);
    if (title) button.title = title;
    buttons.set(id, { button, count });
    return button;
  };

  const element = el('nav', {
    class: 'section-tabs',
    role: 'tablist',
    'aria-label': '栏目',
  });

  // 总栏目在最前
  element.append(
    tab(
      AGGREGATE_SECTION_ID,
      aggregateName,
      '各栏目的紧急公告都汇总在这里',
    ),
  );
  for (const section of list) {
    element.append(tab(section.id, section.name));
  }

  const setActive = (id) => {
    for (const [key, entry] of buttons) {
      const active = key === id;
      entry.button.classList.toggle('section-tabs__tab--active', active);
      entry.button.setAttribute('aria-selected', active ? 'true' : 'false');
    }
  };

  const setCounts = (counts, total) => {
    const aggregate = buttons.get(AGGREGATE_SECTION_ID);
    if (aggregate) {
      const value = Number(total) || 0;
      aggregate.count.textContent = value ? String(value) : '';
      aggregate.count.hidden = !value;
    }
    for (const [id, entry] of buttons) {
      if (id === AGGREGATE_SECTION_ID) continue;
      const value = (counts && counts.get(id)) || 0;
      entry.count.textContent = value ? String(value) : '';
      entry.count.hidden = !value;
    }
  };

  setActive(activeId);

  return { element, setActive, setCounts };
}

/** 标签行用得上的重绘：栏目列表变化后整块重建（栏目不会频繁变，重建最简单） */
export function resetSectionTabs(container, options) {
  clear(container);
  const tabs = renderSectionTabs(options);
  container.append(tabs.element);
  return tabs;
}
