/**
 * 首页逻辑：加载公告 → 筛选 → 排序 → 分成"当前 / 往期" → 渲染。
 *
 * 这里没有一行业务规则是写死的：
 *   能不能写、数据从哪来 → data/index.js
 *   什么算过期、时间怎么显示 → ui/time.js
 *   排序与筛选规则 → ui/filter.js
 *   卡片长什么样 → ui/message-card.js
 */

import { CONFIG, inspectApiKey, isConfigured } from './config.js';
import { exportBackup } from './data/backup.js';
import { isUrgentMessage } from './data/contract.js';
import { getDataSource } from './data/index.js';
import { clear, el, qs, toast } from './ui/dom.js';
import { filterMessages, hasActiveFilter, sortMessages } from './ui/filter.js';
import { renderFilterBar } from './ui/filter-bar.js';
import { icon } from './ui/icon.js';
import { renderMessageCard } from './ui/message-card.js';
import { startPresence } from './ui/presence.js';
import {
  emptyState,
  errorState,
  loadingState,
  notConfiguredState,
  unsafeKeyState,
} from './ui/states.js';
import { formatAbsolute, splitMessages } from './ui/time.js';

const dom = {
  title: qs('#site-title'),
  subtitle: qs('#site-subtitle'),
  status: qs('#status-line'),
  filters: qs('#filters'),
  main: qs('#main'),
  refresh: qs('#refresh'),
  footer: qs('#footer-note'),
  online: qs('#online-count'),
  downloadBackup: qs('#download-backup'),
  urgentFlag: qs('#urgent-flag'),
  toasts: qs('#toasts'),
};

/** 最近一次取到的数据；定时刷新过期状态时不必再联网 */
const cache = { all: /** @type {any[]|null} */ (null), loadedAt: 0 };

/** 当前的筛选条件 */
const filters = { keyword: '', from: /** @type {number|null} */ (null), to: /** @type {number|null} */ (null) };

/** 筛选栏的 setCount 回调，加载数据后才知道命中数 */
let filterBar = /** @type {null|{element: HTMLElement, setCount: Function}} */ (null);

/** 把 config.js 里的站点信息填到页面上 */
function applySiteChrome() {
  document.title = CONFIG.site.title || '班级公告栏';
  dom.title.textContent = CONFIG.site.title || '班级公告栏';

  if (CONFIG.site.className) {
    dom.subtitle.textContent = CONFIG.site.className;
    dom.subtitle.hidden = false;
  } else {
    dom.subtitle.hidden = true;
  }

  dom.footer.textContent = CONFIG.site.footer || '';
  dom.footer.hidden = !CONFIG.site.footer;
}

function setStatus(text) {
  dom.status.textContent = text || '';
}

/** 详情页地址：每条公告都有独立页面，避免首页被超长公告撑爆 */
function detailHref(message) {
  return `message.html?id=${encodeURIComponent(message.id)}`;
}

/** 共用渲染函数：同一条公告在首页、往期、搜索结果里的卡片一致 */
function card(message, now, extra = {}) {
  return renderMessageCard(message, {
    now,
    summaryLength: CONFIG.detail.summaryLength,
    detailHref: detailHref(message),
    ...extra,
  });
}

/**
 * 右下角的紧急标记。
 * 只在"已发布且未过期"的紧急公告存在时出现 —— 过期的紧急公告要自动撤销标记。
 */
function renderUrgentFlag(currentMessages) {
  const urgent = currentMessages.filter(isUrgentMessage);

  // 先清空再重建：不要用 textContent 赋值，否则会把图标一起抹掉
  clear(dom.urgentFlag);

  if (!urgent.length) {
    dom.urgentFlag.hidden = true;
    dom.urgentFlag.removeAttribute('href');
    return;
  }

  dom.urgentFlag.hidden = false;
  dom.urgentFlag.href = detailHref(urgent[0]);
  dom.urgentFlag.append(icon('urgent'));
  dom.urgentFlag.append(
    el('span', {
      text: urgent.length === 1 ? '紧急公告' : `紧急公告 · ${urgent.length} 条`,
    }),
  );
  dom.urgentFlag.setAttribute(
    'aria-label',
    urgent.length === 1
      ? `查看紧急公告：${urgent[0].title || '（无标题）'}`
      : `共有 ${urgent.length} 条紧急公告，点击查看最近一条`,
  );
}

/** 按当前时间与筛选条件重新渲染 */
function render() {
  const now = Date.now();
  clear(dom.main);

  if (!cache.all) return;

  const active = hasActiveFilter(filters);
  const matched = sortMessages(filterMessages(cache.all, filters));

  // 紧急标记反映的是"真实的当前公告"，不受筛选影响
  const { current } = splitMessages(cache.all, {
    now,
    thresholdDays: CONFIG.expiry.soonThresholdDays,
  });
  renderUrgentFlag(current);

  if (filterBar) {
    filterBar.setCount(active ? `找到 ${matched.length} 条` : '');
  }

  if (active) {
    renderSearchResults(matched, now);
    return;
  }

  renderGrouped(cache.all, now);
}

/** 有条件时：单一列表，包含已过期项（查历史不该被隐藏） */
function renderSearchResults(matched, now) {
  if (!matched.length) {
    dom.main.append(
      emptyState('没有找到符合条件的公告', '试试换个关键词，或者把时间范围清空。'),
    );
    return;
  }

  dom.main.append(
    el(
      'section',
      { class: 'section' },
      el('h2', { class: 'section__title', text: `搜索结果 · ${matched.length} 条` }),
      el(
        'div',
        { class: 'list' },
        ...matched.map((message) => card(message, now, { showExpired: true })),
      ),
    ),
  );
}

/** 无条件时：当前公告 + 往期公告折叠区（原来的行为） */
function renderGrouped(messages, now) {
  const { current, past } = splitMessages(messages, {
    now,
    thresholdDays: CONFIG.expiry.soonThresholdDays,
  });

  if (!current.length && !past.length) {
    dom.main.append(emptyState());
    return;
  }

  if (current.length) {
    dom.main.append(
      el(
        'section',
        { class: 'section' },
        el('h2', { class: 'section__title', text: `当前公告 · ${current.length} 条` }),
        el('div', { class: 'list' }, ...current.map((message) => card(message, now))),
      ),
    );
  } else {
    dom.main.append(emptyState('暂时没有新的公告', '往期公告还在下面，点开可以回看。'));
  }

  if (past.length) {
    dom.main.append(
      el(
        'details',
        { class: 'past', open: !CONFIG.expiry.collapseExpired },
        el('summary', { class: 'past__summary', text: `往期公告 · ${past.length} 条（点击展开）` }),
        el(
          'div',
          { class: 'past__body' },
          ...past.map((message) => card(message, now, { showExpired: true })),
        ),
      ),
    );
  }
}

/** 去服务器取数据 */
async function load({ silent = false } = {}) {
  // 先做安全检查：config.js 里要是填了机密 key，宁可不工作也不能发出去
  const keyCheck = inspectApiKey();
  if (!keyCheck.ok) {
    clear(dom.main);
    dom.main.append(unsafeKeyState(keyCheck.message));
    setStatus('配置有安全问题，已停止运行');
    return;
  }

  if (!isConfigured()) {
    clear(dom.main);
    dom.main.append(notConfiguredState());
    setStatus('尚未连接服务器');
    return;
  }

  if (!silent) {
    clear(dom.main);
    dom.main.append(loadingState());
  }
  dom.refresh.disabled = true;

  try {
    const messages = await getDataSource().listMessages();
    cache.all = messages;
    cache.loadedAt = Date.now();
    render();

    const activeCount = splitMessages(messages, { now: Date.now() }).current.length;
    setStatus(`共 ${messages.length} 条 · 当前 ${activeCount} 条 · 更新于 ${formatAbsolute(cache.loadedAt)}`);
  } catch (error) {
    clear(dom.main);
    dom.main.append(
      errorState(error && error.message ? error.message : '出现了未知问题。', () => load()),
    );
    setStatus('加载失败');
  } finally {
    dom.refresh.disabled = false;
  }
}

function init() {
  applySiteChrome();

  // 搜索与筛选栏（同学用的功能）
  filterBar = renderFilterBar({
    onChange: (next) => {
      filters.keyword = next.keyword;
      filters.from = next.from;
      filters.to = next.to;
      if (cache.all) render();
    },
  });
  dom.filters.append(filterBar.element);

  dom.refresh.addEventListener('click', () => {
    load();
  });

  // 页脚的 Word 备份下载（角落里的次要入口，不打扰同学）
  dom.downloadBackup.addEventListener('click', () => {
    const published = (cache.all || []).filter((message) => {
      const time = message.published_at ? new Date(message.published_at).getTime() : 0;
      return !time || time <= Date.now();
    });

    if (!published.length) {
      toast(dom.toasts, '现在还没有可以备份的公告', 'error');
      return;
    }
    try {
      const fileName = exportBackup(published);
      toast(dom.toasts, `Word 备份已保存：${fileName}`, 'success');
    } catch (error) {
      toast(dom.toasts, `备份失败：${(error && error.message) || error}`, 'error');
    }
  });

  // 在线人数：页脚一行小字。失败就静默隐藏，绝不打扰同学。
  if (dom.online && isConfigured()) {
    startPresence({
      source: getDataSource(),
      onCount: (text) => {
        dom.online.textContent = text;
        dom.online.hidden = !text;
      },
    });
  }

  // 每 60 秒用本地数据重算一次过期状态：不用联网也能让"即将过期"变"已过期"
  setInterval(() => {
    if (cache.all) render();
  }, 60 * 1000);

  // 从后台切回页面时立刻校正时间显示
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && cache.all) render();
  });

  load().catch((error) => {
    toast(dom.toasts, error && error.message ? error.message : '初始化失败', 'error');
  });
}

init();
