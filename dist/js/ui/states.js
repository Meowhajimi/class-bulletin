/**
 * 各种状态占位：加载中 / 空 / 出错 / 未配置。
 *
 * 有了它们，同学在任何情况下看到的都是"人话"，
 * 而不是一片白屏或者一串看不懂的报错。
 *
 * 每个状态都配一个极简图标（ui/icon.js）：纯文字的占位页看起来很"空"，
 * 一个 48px 的小图标就能让页面显得是"设计过的"。
 */

import { el } from './dom.js';
import { icon } from './icon.js';

/** 图标外面那圈浅色圆底 */
function iconBox(name) {
  const graphic = icon(name);
  if (!graphic) return null;
  const box = el('div', { class: 'state__icon' });
  box.append(graphic);
  return box;
}

/** 骨架屏，加载时先占位，避免页面跳动 */
export function loadingState() {
  const wrap = el('div', { class: 'state', 'aria-busy': 'true' });
  for (let index = 0; index < 2; index += 1) {
    wrap.append(
      el(
        'div',
        { class: 'skeleton card' },
        el('div', { class: 'skeleton__line skeleton__line--title' }),
        el('div', { class: 'skeleton__line' }),
        el('div', { class: 'skeleton__line skeleton__line--short' }),
      ),
    );
  }
  return wrap;
}

/**
 * @param {string} [title]
 * @param {string} [hint]
 */
export function emptyState(title = '暂时还没有公告', hint = '等学习委员发布之后，这里就会出现内容。') {
  return el(
    'div',
    { class: 'state state--empty' },
    iconBox('empty'),
    el('p', { class: 'state__title', text: title }),
    el('p', { class: 'state__hint', text: hint }),
  );
}

/**
 * 出错：一定要给出"下一步怎么办"，并提供一个重试按钮。
 * @param {string} message
 * @param {() => void} [onRetry]
 */
export function errorState(message, onRetry) {
  const wrap = el(
    'div',
    { class: 'state state--error', role: 'alert' },
    iconBox('error'),
    el('p', { class: 'state__title', text: '加载失败' }),
    el('p', { class: 'state__hint', text: message }),
  );
  if (onRetry) {
    wrap.append(el('button', { type: 'button', class: 'btn', text: '重试', onclick: onRetry }));
  }
  return wrap;
}

/** 还没填接口地址时，直接告诉你怎么填 */
export function notConfiguredState() {
  return el(
    'div',
    { class: 'state state--notice' },
    iconBox('notice'),
    el('p', { class: 'state__title', text: '这个公告栏还没有连接到服务器' }),
    el('p', { class: 'state__hint', text: '请打开 web/js/config.js，填写 supabase.url 与 supabase.anonKey。' }),
    el('p', {
      class: 'state__hint',
      text: '详细的申请与填写步骤见 supabase/SETUP.md；也可以先用 dataSource: "memory" 离线看效果。',
    }),
  );
}

/**
 * config.js 里填了不该填的 key（机密 key / service_role）时的拦截页。
 * 这种情况下宁可不工作，也不能把这个 key 发出去。
 * @param {string} message
 */
export function unsafeKeyState(message) {
  return el(
    'div',
    { class: 'state state--error', role: 'alert' },
    iconBox('error'),
    el('p', { class: 'state__title', text: 'config.js 里的 key 填错了，为安全起见已停止运行' }),
    el('p', { class: 'state__hint', text: message }),
    el('p', {
      class: 'state__hint',
      text: '应该填的是「可发布 key」（sb_publishable_...）或旧版 anon key。'
        + '改好 web/js/config.js 后刷新本页即可。',
    }),
  );
}

/**
 * @param {string} title
 * @param {string} text
 */
export function noticeState(title, text) {
  return el(
    'div',
    { class: 'state state--notice' },
    iconBox('notice'),
    el('p', { class: 'state__title', text: title }),
    el('p', { class: 'state__hint', text }),
  );
}
