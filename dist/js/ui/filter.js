/**
 * 公告的排序与筛选 —— 全部是纯函数，不碰 DOM，方便单测。
 *
 * 放在单独文件里的理由：
 *   · 排序规则只在这里定义一次，首页和管理页共用
 *   · 筛选逻辑（关键词 / 时间范围）是最容易写错边界的地方，必须能测
 */

import { isUrgentMessage } from '../data/contract.js';
import { parseTime } from './time.js';

/**
 * 全站统一的排序规则：
 *   1. 紧急公告排最前（这样主界面右下角的红色标记才有明确指向）
 *   2. 其余按发布时间倒序
 *
 * 现代 JS 的 sort 是稳定排序，所以同一时间的两条会保持传入顺序。
 *
 * @param {Array<object>} messages
 * @returns {Array<object>}
 */
export function sortMessages(messages) {
  return [...(messages || [])].sort((a, b) => {
    const urgentA = isUrgentMessage(a) ? 1 : 0;
    const urgentB = isUrgentMessage(b) ? 1 : 0;
    if (urgentA !== urgentB) return urgentB - urgentA;

    const timeA = parseTime(a && a.published_at);
    const timeB = parseTime(b && b.published_at);
    return (timeB ? timeB.getTime() : 0) - (timeA ? timeA.getTime() : 0);
  });
}

/* ============================== 关键词搜索 ============================== */

/** 统一大小写与首尾空格，空关键词返回空串 */
export function normalizeKeyword(text) {
  return String(text ?? '').trim().toLowerCase();
}

/**
 * 关键词是否命中这条公告（标题或正文包含即可）。
 * @param {{title?: string, body?: string}} message
 * @param {string} keyword
 */
export function matchesKeyword(message, keyword) {
  const needle = normalizeKeyword(keyword);
  if (!needle) return true;

  const title = (message && message.title) || '';
  const body = (message && message.body) || '';
  return `${title}\n${body}`.toLowerCase().includes(needle);
}

/* ============================== 时间范围 ============================== */

function startOfDay(value) {
  const text = String(value ?? '').trim();
  // 只接受 <input type="date"> 产出的 YYYY-MM-DD；其它输入一律当"没填"
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

function endOfDay(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  // ★ 结束日期要算到当天最后一毫秒：否则"开始=结束=同一天"会查不到任何东西
  const date = new Date(`${text}T23:59:59.999`);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

/**
 * 把两个日期输入框的值变成毫秒时间范围。
 * @param {string} fromDate 'YYYY-MM-DD' 或空
 * @param {string} toDate 'YYYY-MM-DD' 或空
 * @returns {{from: number|null, to: number|null}}
 */
export function rangeFromDateInputs(fromDate, toDate) {
  return { from: startOfDay(fromDate), to: endOfDay(toDate) };
}

/* ============================== 筛选主函数 ============================== */

/**
 * 是否有生效中的筛选条件。
 * @param {{keyword?: string, from?: number|null, to?: number|null}} [conditions]
 */
export function hasActiveFilter(conditions = {}) {
  const { keyword, from = null, to = null } = conditions;
  return Boolean(normalizeKeyword(keyword)) || from !== null || to !== null;
}

/**
 * 按关键词 + 发布时间范围筛选。
 *
 * 说明：把"发布时间为空/非法"的公告在有时间条件时排除掉 ——
 * 否则它会绕过时间筛选凭空出现在结果里。
 *
 * @param {Array<object>} messages
 * @param {{keyword?: string, from?: number|null, to?: number|null}} [conditions]
 */
export function filterMessages(messages, conditions = {}) {
  const { keyword = '', from = null, to = null } = conditions;
  const timeLimited = from !== null || to !== null;

  return (messages || []).filter((message) => {
    if (!matchesKeyword(message, keyword)) return false;
    if (!timeLimited) return true;

    const published = parseTime(message && message.published_at);
    if (!published) return false;

    const time = published.getTime();
    if (from !== null && time < from) return false;
    if (to !== null && time > to) return false;
    return true;
  });
}
