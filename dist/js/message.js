/**
 * 公告详情页：`message.html?id=<公告编号>`
 *
 * 为什么要有这个页面：公告正文可能很长，全部堆在首页会让同学翻很久。
 * 首页只显示摘要 + 「查看详情」，点进来才是完整正文。
 * 顺便每条公告有了自己的网址，同学之间可以直接转发。
 */

import { CONFIG, inspectApiKey, isConfigured } from './config.js';
import { isUrgentMessage } from './data/contract.js';
import { getDataSource } from './data/index.js';
import { clear, el, qs, toast } from './ui/dom.js';
import { renderMessageCard } from './ui/message-card.js';
import {
  errorState,
  loadingState,
  noticeState,
  notConfiguredState,
  unsafeKeyState,
} from './ui/states.js';
import { formatAbsolute, isExpired, isPublished } from './ui/time.js';

const dom = {
  title: qs('#site-title'),
  subtitle: qs('#site-subtitle'),
  status: qs('#status-line'),
  main: qs('#main'),
  toasts: qs('#toasts'),
  repo: qs('#repo-link'),
};

function applySiteChrome() {
  dom.title.textContent = CONFIG.site.title || '班级公告栏';
  if (CONFIG.site.className) {
    dom.subtitle.textContent = CONFIG.site.className;
    dom.subtitle.hidden = false;
  } else {
    dom.subtitle.hidden = true;
  }

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

function backHome(message) {
  return el(
    'p',
    { class: 'detail__back' },
    el('a', { class: 'card__more-link', href: 'index.html', text: '← 返回公告列表' }),
    message ? el('span', { class: 'detail__back-note', text: message }) : null,
  );
}

/** 拿不到 id / 找不到公告时的友好页面（不是白屏，也不是报错堆栈） */
function renderMissing(title, hint) {
  clear(dom.main);
  dom.main.append(noticeState(title, hint));
  dom.main.append(backHome());
  setStatus('没有找到公告');
}

async function load() {
  const keyCheck = inspectApiKey();
  if (!keyCheck.ok) {
    clear(dom.main);
    dom.main.append(unsafeKeyState(keyCheck.message));
    return;
  }

  if (!isConfigured()) {
    clear(dom.main);
    dom.main.append(notConfiguredState());
    return;
  }

  const id = new URLSearchParams(location.search).get('id');
  if (!id) {
    renderMissing('没有指定公告编号', '这个地址里缺少 id 参数。请从公告列表点进来。');
    return;
  }

  clear(dom.main);
  dom.main.append(loadingState());
  setStatus('正在加载…');

  try {
    const messages = await getDataSource().listMessages();
    const message = messages.find((item) => item.id === id);

    if (!message) {
      renderMissing(
        '这条公告可能已被删除',
        '也许学习委员把它撤掉了，或者链接复制得不完整。可以回列表看看其它公告。',
      );
      return;
    }

    const now = Date.now();
    const expired = isExpired(message, now);
    const pending = !isPublished(message, now);

    document.title = `${message.title || '公告'} · ${CONFIG.site.title || '班级公告栏'}`;

    const extraBadges = [];
    if (pending) extraBadges.push({ label: '尚未公开发布（仅通过链接可见）', kind: 'accent' });
    if (isUrgentMessage(message)) setStatus('紧急公告');

    clear(dom.main);
    // 不传 summaryLength ⇒ 显示完整正文
    dom.main.append(
      renderMessageCard(message, {
        now,
        showExpired: true,
        extraBadges,
      }),
    );
    dom.main.append(backHome());

    if (!pending) {
      setStatus(
        `${expired ? '已过期 · ' : ''}发布时间 ${formatAbsolute(message.published_at) || '未知'}`,
      );
    }
  } catch (error) {
    clear(dom.main);
    dom.main.append(
      errorState(error && error.message ? error.message : '加载失败', () => load()),
    );
    setStatus('加载失败');
  }
}

applySiteChrome();
load().catch((error) => {
  toast(dom.toasts, error && error.message ? error.message : '初始化失败', 'error');
});
