/**
 * 数据源契约：任何后端只要实现下面这几个方法，前端就能用它。
 *
 * ★ 想接入自建后端、其它 BaaS、甚至是同桌写的接口：
 *   1) 新建 web/js/data/你的名字.js
 *   2) 照着 supabase.js 实现下面这些方法
 *   3) 在 data/index.js 里加一个分支
 *   界面代码（app.js / admin.js / ui/*）一行都不用改。
 *
 * @typedef {Object} Section
 *          栏目。管理员可以增删改名，同学只能查看。
 * @property {string} id
 * @property {string} name         1~40 字，不允许重名
 * @property {string} created_at
 *
 * @typedef {Object} Message
 * @property {string}      id
 * @property {string}      title
 * @property {string}      body
 * @property {string}      published_at  ISO8601，UTC
 * @property {string|null} expires_at    ISO8601，UTC；null 表示永不过期
 * @property {boolean}     is_urgent     紧急公告（主界面右下角标红）
 * @property {string}      section_id    所属栏目；老数据迁移后都有值
 * @property {string}      created_at
 * @property {string}      updated_at
 *
 * @typedef {Object} MessageInput
 * @property {string}      title
 * @property {string}      body
 * @property {string}      [section_id]
 * @property {string}      [published_at]
 * @property {string|null} [expires_at]
 * @property {boolean}     [is_urgent]
 *
 * @typedef {Object} Session
 * @property {string} accessToken
 * @property {string} refreshToken
 * @property {number} expiresAt   毫秒时间戳
 * @property {{ id: string, email: string }} user
 *
 * @typedef {Object} DataSource
 * @property {boolean} canWrite
 * @property {() => Promise<Message[]>} listMessages
 * @property {(input: MessageInput) => Promise<Message>} createMessage
 * @property {(id: string, patch: Partial<MessageInput>) => Promise<Message>} updateMessage
 * @property {(id: string) => Promise<void>} deleteMessage
 * @property {() => Promise<Section[]>} listSections
 * @property {(name: string) => Promise<Section>} createSection
 * @property {(id: string, name: string) => Promise<Section>} renameSection
 * @property {(id: string) => Promise<void>} deleteSection
 *           删除栏目。栏目里还有公告、或它是最后一个栏目时，后端会拒绝
 *           （抛 DataError，message 里是可直接展示的中文原因）
 * @property {(email: string, password: string) => Promise<Session>} signIn
 * @property {() => Promise<void>} signOut
 * @property {() => Session|null} getSession
 * @property {(sessionId: string) => Promise<void>} presenceHeartbeat
 *           登记"我在线"（只上报一个随机会话号，不含任何个人信息）
 * @property {() => Promise<number>} presenceCount
 *           当前在线人数
 */

/** 统一的错误类型：界面据此决定给同学看什么提示。 */
export class DataError extends Error {
  /**
   * @param {string} message 给用户看的中文提示
   * @param {{status?: number, code?: string, cause?: unknown}} [info]
   */
  constructor(message, info = {}) {
    super(message);
    this.name = 'DataError';
    this.status = info.status ?? 0;
    this.code = info.code ?? '';
    this.cause = info.cause ?? null;
  }

  /** 登录态问题，需要重新登录 */
  get isAuthError() {
    return this.status === 401;
  }

  /** 权限问题（多半是 Supabase 的 RLS 拦下了） */
  get isPermissionError() {
    return this.status === 403;
  }

  /** 还没填接口地址 */
  get isNotConfigured() {
    return this.code === 'NOT_CONFIGURED';
  }

  /** 网络不通 */
  get isNetworkError() {
    return this.code === 'NETWORK';
  }
}

/**
 * PostgREST 有时返回数组、有时返回单个对象，这里统一成数组。
 * @param {unknown} payload
 * @returns {any[]}
 */
export function toRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') return [payload];
  return [];
}

export const NOT_CONFIGURED_HINT =
  '还没有填写接口地址。请打开 web/js/config.js，把 supabase.url 填成你的 Supabase 地址或本地服务器地址。';

/**
 * 这条公告是不是紧急公告。
 *
 * 单独放一个函数是为了让"紧急"只有一个判断入口 ——
 * 云端返回的是 boolean，本地 SQLite 回来的可能是 0/1，
 * 都从这里统一，界面就不用各自处理了。
 *
 * @param {{is_urgent?: unknown}} message
 * @returns {boolean}
 */
export function isUrgentMessage(message) {
  const value = message && message.is_urgent;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  return false;
}

/** 栏目名的长度上限。与 supabase/schema.sql 的 check(... between 1 and 40)、
 *  server/db.py 的 SECTION_NAME_MAX、以及管理页输入框的 maxlength 保持一致
 *  （有测试盯着这四处）。 */
export const SECTION_NAME_MAX = 40;

/**
 * 栏目名的规范化：去掉首尾空格。
 *
 * 只做 trim —— 中文栏目名里"班委通知 "和"班委通知"显然是同一个，
 * 但没必要把英文缩写按大小写合并（那会让"Class"和"class"意外撞车）。
 *
 * @param {unknown} text
 * @returns {string}
 */
export function normalizeSectionName(text) {
  return String(text ?? '').trim();
}

/**
 * 找出某条公告所属的栏目。
 *
 * ★ 全站唯一的"公告 → 栏目"规则入口。三种情况都在这里收口：
 *   1. 正常：section_id 命中某个栏目
 *   2. 兜底：section_id 为空、或指向一个已经不存在的栏目
 *      （老库还没迁移、或数据被外部改过）→ 归到**第一个栏目**
 *   3. sections 为空（数据库还没建栏目表）→ 返回 null，由调用方决定怎么显示
 *
 * 之所以要兜底而不是报错：同学打开页面看到公告比看到"数据异常"重要得多。
 *
 * @param {{section_id?: unknown}} message
 * @param {Array<{id: string, name: string}>} sections
 * @returns {{id: string, name: string}|null}
 */
export function sectionOf(message, sections) {
  const list = Array.isArray(sections) ? sections.filter(Boolean) : [];
  if (!list.length) return null;

  const wanted = String((message && message.section_id) || '').trim();
  if (wanted) {
    const matched = list.find((item) => String(item.id) === wanted);
    if (matched) return matched;
  }
  return list[0];
}

/** Supabase 与本地服务器都会把错误放在这些字段里，逐个试一遍。 */
export function readErrorMessage(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const record = /** @type {Record<string, unknown>} */ (payload);
  for (const key of ['error_description', 'message', 'msg', 'error', 'hint']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}
