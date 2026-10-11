/**
 * 公告的 Word 备份。
 *
 * 用途：网站（或云端数据库）彻底失效、无法挽回时，还能从这些 Word 文档里
 * 找回每一条公告内容。所以只要同学能看到的内容，都会被写进去。
 *
 * 触发时机（两道保险）：
 *   1. 管理页每次发布 / 修改 / 删除成功后，自动下载一份最新完整备份
 *   2. 管理页上的「导出 Word 备份」按钮，随时手动导出
 * 另外还有不依赖网站的一条路：tools/backup-to-word.py
 */

import { CONFIG, resolveSupabaseUrl } from '../config.js';
import { isUrgentMessage } from './contract.js';
import { buildDocxBlob, downloadBlob } from '../ui/docx.js';
import { formatAbsolute, formatExpiryNote, isExpired, isPublished } from '../ui/time.js';

/** 文件名里的时间戳：2026-10-10-2015 */
function stamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}`
  );
}

/**
 * 备份文件名。带时间戳，所以每份都是独立快照，不会被覆盖。
 * @param {Date} [date]
 */
export function backupFileName(date = new Date()) {
  return `班级公告栏备份-${stamp(date)}.docx`;
}

/**
 * 把公告列表转成 Word 文档的内容块。
 * ★ 想改备份文档的排版或增加字段，改这个函数就够了。
 *
 * @param {Array<object>} messages
 * @param {{now?: number}} [options]
 * @returns {Array<{text: string, style?: string}>}
 */
export function messagesToBlocks(messages, options = {}) {
  const now = options.now ?? Date.now();
  const apiUrl = resolveSupabaseUrl();

  // 同学看到的备份：只含已发布的公告（不含还没到时间的定时公告）
  const all = Array.isArray(messages) ? messages : [];
  const list = options.includeUnpublished ? all : all.filter((item) => isPublished(item, now));

  const blocks = [
    { text: CONFIG.site.title || '班级公告栏', style: 'title' },
    { text: '公告备份文档', style: 'meta' },
    { text: '', style: 'divider' },
    {
      text:
        `备份时间：${formatAbsolute(now)}　共 ${list.length} 条公告` +
        (apiUrl ? `\n数据来源：${apiUrl}` : ''),
      style: 'meta',
    },
    {
      text:
        '说明：本文档由「班级公告栏」导出，' +
        '用于网站或云端数据失效时找回内容。请与网站一起妥善保存。',
      style: 'meta',
    },
    { text: '', style: 'divider' },
  ];

  list.forEach((message, index) => {
    const expired = isExpired(message, now);
    const pending = !isPublished(message, now);
    const status = expired ? '已过期' : pending ? '未到发布时间' : '有效';
    const urgent = isUrgentMessage(message);

    blocks.push({
      text: `${index + 1}. ${urgent ? '【紧急】' : ''}${(message.title || '（无标题）').trim()}`,
      style: 'heading',
    });
    blocks.push({
      text: `发布时间：${formatAbsolute(message.published_at) || '未知'}　状态：${status}` +
        (urgent ? '　标记：紧急' : ''),
      style: 'meta',
    });

    const expiryNote = formatExpiryNote(message, now);
    if (expiryNote) {
      blocks.push({ text: `过期情况：${expiryNote}`, style: 'meta' });
    }

    // ★ 先给出「正文：」标签，再输出正文（带缩进）。
    //   以前正文直接跟在灰色元信息后面，一段短正文看起来像残留物，
    //   会被误以为"正文没有导出"。
    blocks.push({ text: '正文：', style: 'label' });
    blocks.push({ text: message.body || '（无正文）', style: 'body' });

    // 条目之间加一条细分隔线，方便打印后剪贴或归档
    blocks.push({ text: '', style: 'divider' });
  });

  blocks.push({
    text: `—— 备份结束（共 ${list.length} 条）——`,
    style: 'meta',
  });

  return blocks;
}

/**
 * 生成备份的 Blob（不触发下载）
 * @param {Array<object>} messages
 */
export function buildBackupBlob(messages, options = {}) {
  return buildDocxBlob(messagesToBlocks(messages, options));
}

/**
 * 生成并下载一份完整备份。
 * @param {Array<object>} messages
 * @returns {string} 下载的文件名
 */
export function exportBackup(messages, options = {}) {
  const name = backupFileName();
  downloadBlob(buildBackupBlob(messages, options), name);
  return name;
}
