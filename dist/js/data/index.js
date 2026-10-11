/**
 * 数据源工厂 —— 全站唯一决定"数据从哪来"的地方。
 *
 * 加一个新后端的步骤：
 *   1) 在 data/ 下新建 xxx.js，实现 contract.js 里列出的 7 个方法；
 *   2) 在下面 import 并在 createDataSource() 里加一个 case；
 *   3) 改 config.js 的 dataSource。
 * 界面代码完全不用动。
 */

import { CONFIG, isConfigured } from '../config.js';
import { createSupabaseSource } from './supabase.js';
import { createMemorySource } from './memory.js';

/** @type {import('./contract.js').DataSource|null} */
let cached = null;

function createDataSource() {
  switch (CONFIG.dataSource) {
    case 'memory':
      return createMemorySource();
    case 'supabase':
      return createSupabaseSource();
    default:
      throw new Error(
        `config.js 里的 dataSource 只能是 'supabase' 或 'memory'，现在是 '${CONFIG.dataSource}'`,
      );
  }
}

/** @returns {import('./contract.js').DataSource} */
export function getDataSource() {
  if (!cached) cached = createDataSource();
  return cached;
}

/** 换数据源后（例如改完 config.js 再调用）清掉缓存 */
export function resetDataSource() {
  cached = null;
}

export { isConfigured };
