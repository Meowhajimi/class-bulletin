/**
 * 消息卡片模板 —— ★ 想改卡片长什么样、想加一个字段显示，只动这个文件。
 *
 * 例如以后加了"分类"字段，就在这里加一行徽章即可，
 * 数据层和管理页各自独立，不会互相牵连。
 */

import { CONFIG } from '../config.js';
import { isUrgentMessage } from '../data/contract.js';
import { el } from './dom.js';
import {
  formatAbsolute,
  formatExpiryNote,
  formatRelative,
  isExpired,
  isExpiringSoon,
} from './time.js';

/**
 * 把正文压成摘要：超长时截断并加省略号。
 * 用 Array.from 按"码点"切，避免把 emoji 剪成半个字符。
 * @param {string} text
 * @param {number} maxLength 0 或负数表示不截断
 */
export function summarize(text, maxLength) {
  const source = String(text ?? '');
  if (!maxLength || maxLength <= 0) return { text: source, truncated: false };

  const characters = Array.from(source);
  if (characters.length <= maxLength) return { text: source, truncated: false };
  return { text: `${characters.slice(0, maxLength).join('')}…`, truncated: true };
}

/**
 * @param {import('../data/contract.js').Message} message
 * @param {{now?: number, showExpired?: boolean,
 *          extraBadges?: Array<{label: string, kind?: string}>,
 *          actions?: Array<{label: string, kind?: string, onClick: Function}>,
 *          summaryLength?: number, detailHref?: string}} [options]
 * @returns {HTMLElement}
 */
export function renderMessageCard(message, options = {}) {
  const now = options.now ?? Date.now();
  const expired = isExpired(message, now);
  const soon = !expired && isExpiringSoon(message, now, CONFIG.expiry.soonThresholdDays);
  const urgent = isUrgentMessage(message);

  const badges = el('div', { class: 'card__badges' });
  // 紧急排在最前面显示，颜色最醒目
  if (urgent) badges.append(el('span', { class: 'badge badge--danger', text: '紧急' }));
  // 额外徽章由调用方决定（管理页用它显示"未到发布时间"）
  for (const badge of options.extraBadges || []) {
    badges.append(
      el('span', {
        class: `badge badge--${badge.kind || 'accent'}`,
        text: badge.label,
      }),
    );
  }
  if (expired) badges.append(el('span', { class: 'badge badge--muted', text: '已过期' }));
  else if (soon) badges.append(el('span', { class: 'badge badge--warn', text: '即将过期' }));
  if (!badges.childElementCount) badges.remove();

  const meta = el('p', { class: 'card__meta' });
  const published = el('time', {
    class: 'card__time',
    datetime: message.published_at || '',
    title: formatAbsolute(message.published_at),
    text: formatRelative(message.published_at, now) || '时间未知',
  });
  meta.append(published);

  const expiryNote = formatExpiryNote(message, now);
  if (expiryNote) {
    meta.append(el('span', { class: 'card__dot', text: '·' }));
    meta.append(el('span', { class: 'card__expiry', text: expiryNote }));
  }

  const body = el('div', {
    class: `card__body${urgent ? ' card__body--urgent' : ''}`,
    text: summarize(message.body, options.summaryLength).text,
  });

  // 摘要被截断时给出"查看详情"链接（用 <a> 而不是按钮：可以新标签打开、可以转发）
  const more = el('p', { class: 'card__more' });
  if (options.detailHref) {
    more.append(
      el('a', {
        class: 'card__more-link',
        href: options.detailHref,
        text: '查看详情 →',
      }),
    );
  }
  if (!more.childElementCount) more.remove();

  const actions = el('div', { class: 'card__actions' });
  for (const action of options.actions || []) {
    actions.append(
      el('button', {
        type: 'button',
        class: `btn btn--small ${action.kind === 'danger' ? 'btn--danger' : 'btn--ghost'}`,
        text: action.label,
        onclick: action.onClick,
      }),
    );
  }
  if (!actions.childElementCount) actions.remove();

  return el(
    'article',
    {
      class: `card${expired ? ' card--expired' : ''}${urgent ? ' card--urgent' : ''}`,
      dataset: { messageId: message.id },
    },
    el(
      'header',
      { class: 'card__head' },
      el('h2', { class: 'card__title', text: message.title || '（无标题）' }),
      badges,
    ),
    meta,
    body,
    more,
    actions,
  );
}
