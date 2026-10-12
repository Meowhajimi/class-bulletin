/**
 * 离线适配器：把公告存在浏览器自己的 localStorage 里，完全不联网。
 *
 * 用途：断网、或者只想调界面样式时，不用连服务器就能看到完整效果。
 * 注意：数据只存在你这一台电脑的这一个浏览器里，同学看不到。
 *       正式发给同学看之前，请把 config.js 的 dataSource 改回 'supabase'。
 */

import { DataError, SECTION_NAME_MAX, normalizeSectionName } from './contract.js';

const MESSAGES_KEY = 'class-bulletin.local-messages.v1';
const SECTIONS_KEY = 'class-bulletin.local-sections.v1';
const SESSION_KEY = 'class-bulletin.local-session.v1';

/** 离线演示用两个栏目，方便看到"多栏目"的实际效果 */
const DEMO_SECTIONS = ['学习委员通知', '班级事务'];

const DEMO_MESSAGES = [
  {
    title: '【演示】紧急公告：明天临时调课',
    body:
      '勾选「紧急公告」发布后，它会排在本栏目的最前面，\n' +
      '也会汇总到顶部的「总栏目」里。\n\n' +
      '你现在看到的是离线演示数据，只存在你自己的浏览器里。',
    expires_at: null,
    is_urgent: true,
    sectionIndex: 0,
  },
  {
    title: '欢迎使用班级公告栏（离线演示）',
    body:
      '你现在看到的是离线演示数据，只存在你自己的浏览器里。\n\n' +
      '把 web/js/config.js 里的 dataSource 改成 supabase 并填好地址，' +
      '就能连上真正的服务器，同学也能看到了。',
    expires_at: null,
    sectionIndex: 0,
  },
  {
    title: '这条演示公告已过期',
    body: '过期的公告会自动收进下面的「往期公告」，点一下就能展开。',
    expires_at: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
    sectionIndex: 1,
  },
];

function newId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `local-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

/* ============================== 栏目 ============================== */

function readSections() {
  try {
    const raw = localStorage.getItem(SECTIONS_KEY);
    if (!raw) {
      const seeded = DEMO_SECTIONS.map((name, index) => ({
        id: newId(),
        name,
        created_at: new Date(Date.now() + index).toISOString(),
      }));
      writeSections(seeded);
      return seeded;
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeSections(sections) {
  try {
    localStorage.setItem(SECTIONS_KEY, JSON.stringify(sections));
  } catch {
    throw new DataError('浏览器不允许保存数据（可能是隐私模式），离线模式无法使用。');
  }
}

function validateSectionName(name) {
  const text = normalizeSectionName(name);
  if (!text) throw new DataError('栏目名不能为空。');
  if (text.length > SECTION_NAME_MAX) {
    throw new DataError(`栏目名不能超过 ${SECTION_NAME_MAX} 个字符。`);
  }
  return text;
}

function read() {
  try {
    const raw = localStorage.getItem(MESSAGES_KEY);
    if (!raw) {
      const sections = readSections();
      const seeded = DEMO_MESSAGES.map((demo) => {
        const { sectionIndex, ...rest } = demo;
        return {
          id: newId(),
          published_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          ...rest,
          section_id: (sections[sectionIndex] || sections[0] || {}).id || '',
        };
      });
      write(seeded);
      return seeded;
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function write(messages) {
  try {
    localStorage.setItem(MESSAGES_KEY, JSON.stringify(messages));
  } catch {
    throw new DataError('浏览器不允许保存数据（可能是隐私模式），离线模式无法使用。');
  }
}

/** 和服务器一致的排序：发布时间倒序 */
function sorted(messages) {
  return [...messages].sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)));
}

/** @returns {import('./contract.js').DataSource} */
export function createMemorySource() {
  return {
    name: 'memory',
    canWrite: true,

    async listMessages() {
      return sorted(read());
    },

    async createMessage(input) {
      const title = String(input.title || '').trim();
      if (!title) throw new DataError('标题不能为空。');
      const sections = readSections();
      const wanted = String(input.section_id || '').trim();
      const section = sections.find((item) => item.id === wanted) || sections[0];
      const now = new Date().toISOString();
      const message = {
        id: newId(),
        title,
        body: String(input.body || ''),
        published_at: input.published_at ? new Date(input.published_at).toISOString() : now,
        expires_at: input.expires_at ? new Date(input.expires_at).toISOString() : null,
        is_urgent: Boolean(input.is_urgent),
        section_id: section ? section.id : '',
        created_at: now,
        updated_at: now,
      };
      write([...read(), message]);
      return message;
    },

    async updateMessage(id, patch) {
      const messages = read();
      const index = messages.findIndex((item) => item.id === id);
      if (index < 0) throw new DataError('这条消息可能已经被删除了，刷新看看。');

      const current = messages[index];
      const next = { ...current };
      if ('title' in patch) {
        const title = String(patch.title || '').trim();
        if (!title) throw new DataError('标题不能为空。');
        next.title = title;
      }
      if ('body' in patch) next.body = String(patch.body || '');
      if ('published_at' in patch && patch.published_at) {
        next.published_at = new Date(patch.published_at).toISOString();
      }
      if ('expires_at' in patch) {
        next.expires_at = patch.expires_at ? new Date(patch.expires_at).toISOString() : null;
      }
      if ('is_urgent' in patch) next.is_urgent = Boolean(patch.is_urgent);
      if ('section_id' in patch) {
        const wanted = String(patch.section_id || '').trim();
        if (wanted && !readSections().some((item) => item.id === wanted)) {
          throw new DataError('栏目不存在，请刷新页面重试。');
        }
        const sections = readSections();
        next.section_id = wanted || (sections[0] ? sections[0].id : '');
      }
      next.updated_at = new Date().toISOString();

      messages[index] = next;
      write(messages);
      return next;
    },

    async deleteMessage(id) {
      write(read().filter((item) => item.id !== id));
    },

    /* ---------------- 栏目 ---------------- */

    async listSections() {
      return readSections();
    },

    async createSection(name) {
      const text = validateSectionName(name);
      const sections = readSections();
      if (sections.some((item) => item.name === text)) {
        throw new DataError('已经有同名栏目了。换个名字，或者先给原来的栏目改名。');
      }
      const created = { id: newId(), name: text, created_at: new Date().toISOString() };
      writeSections([...sections, created]);
      return created;
    },

    async renameSection(id, name) {
      const text = validateSectionName(name);
      const sections = readSections();
      const index = sections.findIndex((item) => item.id === id);
      if (index < 0) throw new DataError('没有这个栏目，刷新看看。');
      if (sections.some((item) => item.name === text && item.id !== id)) {
        throw new DataError('已经有同名栏目了。换个名字，或者先给原来的栏目改名。');
      }
      sections[index] = { ...sections[index], name: text };
      writeSections(sections);
      return sections[index];
    },

    async deleteSection(id) {
      const sections = readSections();
      if (!sections.some((item) => item.id === id)) {
        throw new DataError('没有这个栏目，刷新看看。');
      }
      if (sections.length <= 1) {
        throw new DataError('至少要保留一个栏目。');
      }
      const used = read().filter((item) => item.section_id === id).length;
      if (used) {
        throw new DataError(
          `这个栏目里还有 ${used} 条公告，不能删除。请先把里面的公告改到别的栏目，或者逐条删除，然后再删栏目。`,
        );
      }
      writeSections(sections.filter((item) => item.id !== id));
    },

    /**
     * 离线模式的在线人数：本来是给一个人看的演示，
     * 所以固定返回 1（你自己），并顺手让界面能跑通。
     */
    async presenceHeartbeat(sessionId) {
      if (!sessionId) throw new DataError('缺少会话号');
    },

    async presenceCount() {
      return 1;
    },

    async signIn(email, password) {
      if (!email || !password) {
        throw new DataError('请填写邮箱和口令。');
      }
      // 离线模式不做真实校验，随便填即可进入管理页看效果
      const session = {
        accessToken: 'local-demo-token',
        refreshToken: 'local-demo-refresh',
        expiresAt: Date.now() + 24 * 3600 * 1000,
        user: { id: 'local-demo-user', email: String(email) },
      };
      try {
        localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      } catch {
        // 忽略
      }
      return session;
    },

    async signOut() {
      try {
        localStorage.removeItem(SESSION_KEY);
      } catch {
        // 忽略
      }
    },

    getSession() {
      try {
        const raw = localStorage.getItem(SESSION_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    },
  };
}
