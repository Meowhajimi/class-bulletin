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
import { isUrgentMessage, sectionOf } from './data/contract.js';
import { getDataSource } from './data/index.js';
import { clear, el, qs, toast } from './ui/dom.js';
import {
  AGGREGATE_SECTION_ID,
  filterMessages,
  hasActiveFilter,
  messagesOfSection,
  sectionUrgentCounts,
  sortMessages,
  splitUrgentFirst,
} from './ui/filter.js';
import { renderFilterBar } from './ui/filter-bar.js';
import { icon } from './ui/icon.js';
import { renderMessageCard } from './ui/message-card.js';
import { startPresence } from './ui/presence.js';
import { resetSectionTabs } from './ui/section-tabs.js';
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
  repo: qs('#repo-link'),
  tabs: qs('#section-tabs'),
  urgentFlag: qs('#urgent-flag'),
  toasts: qs('#toasts'),
};

/** 最近一次取到的数据；定时刷新过期状态时不必再联网 */
const cache = {
  all: /** @type {any[]|null} */ (null),
  sections: /** @type {Array<{id: string, name: string}>} */ ([]),
  loadedAt: 0,
};

/** 当前选中的标签：总栏目，或某个栏目的 id */
let activeSectionId = AGGREGATE_SECTION_ID;

/** 栏目表还不存在时的降级标记（提醒站长去跑 schema.sql） */
let sectionsUnavailable = false;

/** 降级时那个隐式栏目的 id（故意不长得像 uuid，避免和真栏目撞车） */
const FALLBACK_SECTION_ID = '__fallback__';

/** 标签行控制器 */
let sectionTabs = /** @type {null|{element: HTMLElement, setActive: Function, setCounts: Function}} */ (null);

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

  // 源码仓库链接：地址只在 config.js 里配，留空就整条不显示
  const repoUrl = (CONFIG.site.repoUrl || '').trim();
  if (dom.repo && repoUrl) {
    dom.repo.href = repoUrl;
    dom.repo.hidden = false;
  } else if (dom.repo) {
    dom.repo.hidden = true;
  }
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

/** 按当前时间、当前标签与筛选条件重新渲染 */
function render() {
  const now = Date.now();
  clear(dom.main);

  if (!cache.all) return;

  // 紧急标记（右下角）反映的是"全部栏目的真实当前公告"，不受标签和筛选影响
  const { current } = splitMessages(cache.all, {
    now,
    thresholdDays: CONFIG.expiry.soonThresholdDays,
  });
  renderUrgentFlag(current);
  renderTabs();

  const active = hasActiveFilter(filters);
  const inTab = messagesOfSection(cache.all, activeSectionId, cache.sections);
  const matched = sortMessages(filterMessages(inTab, filters));

  if (filterBar) {
    filterBar.setCount(active ? `找到 ${matched.length} 条` : '');
  }

  if (active) {
    renderSearchResults(matched, now);
    return;
  }

  if (activeSectionId === AGGREGATE_SECTION_ID) {
    renderAggregate(inTab, now);
    return;
  }

  renderGrouped(inTab, now);
}

/** 标签行：栏目列表变化时才重建 DOM，否则只更新选中态与数字 */
function renderTabs() {
  if (!dom.tabs) return;

  const sections = cache.sections;
  const urgentTotal = (cache.all || []).filter(isUrgentMessage).length;

  if (!sectionTabs) {
    sectionTabs = resetSectionTabs(dom.tabs, {
      sections,
      aggregateName: CONFIG.sections.aggregateName,
      activeId: activeSectionId,
      onSelect: (id) => {
        if (id === activeSectionId) return;
        activeSectionId = id;
        rememberSection(id);
        render();
      },
    });
  } else {
    sectionTabs.setActive(activeSectionId);
  }
  sectionTabs.setCounts(sectionUrgentCounts(cache.all || [], sections), urgentTotal);
}

/** 把当前标签记进 sessionStorage，刷新后还在原来那一栏 */
function rememberSection(id) {
  try {
    sessionStorage.setItem('class-bulletin.section.v1', id);
  } catch {
    // 隐私模式下写不了，无所谓
  }
}

/** 读取上次停留的标签；?section=xxx 优先（详情页"回到该栏目"用） */
function initialSectionId() {
  try {
    const fromQuery = new URLSearchParams(location.search).get('section');
    if (fromQuery) return fromQuery;
  } catch {
    // location 不可用（测试环境）就忽略
  }
  try {
    return sessionStorage.getItem('class-bulletin.section.v1') || AGGREGATE_SECTION_ID;
  } catch {
    return AGGREGATE_SECTION_ID;
  }
}

/**
 * 总栏目：把**所有栏目**的紧急公告汇总在一起。
 * 每条卡片带一个所属栏目的小徽章，点进去还是那条公告自己的详情页。
 */
function renderAggregate(messages, now) {
  const urgent = sortMessages(messages.filter(isUrgentMessage));

  if (!urgent.length) {
    dom.main.append(
      emptyState('现在没有紧急公告', CONFIG.sections.aggregateHint || '各栏目的紧急公告都会汇总到这里。'),
    );
    return;
  }

  dom.main.append(
    el(
      'section',
      { class: 'section' },
      el('h2', { class: 'section__title', text: `全部紧急 · ${urgent.length} 条` }),
      el(
        'div',
        { class: 'list' },
        ...urgent.map((message) =>
          card(message, now, {
            extraBadges: sectionBadges(message),
          }),
        ),
      ),
    ),
  );
}

/** 某条公告所属栏目的徽章（总栏目和详情页用；普通栏目内不必重复显示） */
function sectionBadges(message) {
  const section = sectionOf(message, cache.sections);
  if (!section) return [];
  return [{ label: section.name, kind: 'accent' }];
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

/**
 * 普通栏目：本栏目内**先紧急、后普通**，再往下是往期公告折叠区。
 *
 * 紧急只显示"未过期"的那些 —— 与右下角标记的口径一致：
 * 过期的紧急公告应当自动失效、收进往期，而不是一直霸占最上面。
 */
function renderGrouped(messages, now) {
  const { current, past } = splitMessages(messages, {
    now,
    thresholdDays: CONFIG.expiry.soonThresholdDays,
  });
  const { urgent, normal } = splitUrgentFirst(current);

  if (!urgent.length && !normal.length && !past.length) {
    dom.main.append(
      emptyState('这一栏暂时还没有公告', '可以点上面的其它栏目看看，或者稍后刷新。'),
    );
    return;
  }

  if (urgent.length) {
    dom.main.append(
      el(
        'section',
        { class: 'section section--urgent' },
        el('h2', { class: 'section__title', text: `紧急 · ${urgent.length} 条` }),
        el('div', { class: 'list' }, ...urgent.map((message) => card(message, now))),
      ),
    );
  }

  if (normal.length) {
    dom.main.append(
      el(
        'section',
        { class: 'section' },
        el('h2', { class: 'section__title', text: `当前公告 · ${normal.length} 条` }),
        el('div', { class: 'list' }, ...normal.map((message) => card(message, now))),
      ),
    );
  } else if (!urgent.length) {
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
    const source = getDataSource();
    // 公告和栏目一起取；栏目失败不影响公告 —— 详见下面的 catch
    const [messages, sections] = await Promise.all([
      source.listMessages(),
      loadSections(source),
    ]);

    cache.all = messages;
    cache.sections = sections;
    cache.loadedAt = Date.now();

    // 选中的标签可能已经不存在了（栏目被删）→ 退回总栏目
    if (
      activeSectionId !== AGGREGATE_SECTION_ID &&
      !sections.some((section) => section.id === activeSectionId)
    ) {
      activeSectionId = AGGREGATE_SECTION_ID;
    }
    sectionTabs = null; // 栏目列表可能变了，标签行重建一次

    render();

    const activeCount = splitMessages(messages, { now: Date.now() }).current.length;
    const base = `共 ${messages.length} 条 · 当前 ${activeCount} 条 · 更新于 ${formatAbsolute(cache.loadedAt)}`;
    setStatus(sectionsUnavailable ? `${base}　⚠️ 栏目功能还没启用（请跑一次 supabase/schema.sql）` : base);
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

/**
 * 取栏目列表；**取不到时降级，而不是让整页报错**。
 *
 * 为什么必须这样：栏目是本学期新加的功能，数据库那边要跑一次 schema.sql。
 * 如果站长忘了跑，表不存在（PostgREST 会返回 404 / PGRST205 / 42P01），
 * 这时绝不能让同学看到一个错误页 —— 公告本身还是好的。
 *
 * 降级做法：当作"只有一个栏目"，名字取 config 里的 fallbackName，
 * 所有公告都归到它下面；同时用 sectionsUnavailable 标记提醒站长。
 */
async function loadSections(source) {
  try {
    const sections = await source.listSections();
    sectionsUnavailable = false;
    if (sections.length) return sections;
    // 表存在但没有栏目（被删空了）：也给一个兜底栏目，界面不至于空白
    return [fallbackSection()];
  } catch (error) {
    if (!isMissingTableError(error)) throw error;
    sectionsUnavailable = true;
    return [fallbackSection()];
  }
}

/** 判断"表/列不存在"这类错误 —— 它和网络故障要区分对待 */
function isMissingTableError(error) {
  const status = error && error.status;
  const code = String((error && error.code) || '');
  if (status === 404) return true;
  if (['PGRST205', '42P01'].includes(code)) return true;
  const text = `${(error && error.message) || ''}`;
  return /does not exist|schema cache|relation .* not found/i.test(text);
}

/** 降级时用的隐式栏目（id 固定，不会和数据库里的 uuid 撞车） */
function fallbackSection() {
  return { id: FALLBACK_SECTION_ID, name: CONFIG.sections.fallbackName || '公告', created_at: '' };
}

function init() {
  applySiteChrome();

  // 上次停留的栏目（或从详情页"回到该栏目"带过来的 ?section=）
  activeSectionId = initialSectionId();

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
      const fileName = exportBackup(published, { sections: cache.sections });
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
