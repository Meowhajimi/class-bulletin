/**
 * 管理页逻辑：登录 → 发布 / 编辑 / 删除 / 标记结束 → 退出。
 *
 * 权限不靠前端：即使有人把这里的按钮删掉，数据库那边也会拒绝写入。
 * 前端只是"给学委用的操作面板"。
 */

import { CONFIG, inspectApiKey, isConfigured } from './config.js';
import { isUrgentMessage, sectionOf } from './data/contract.js';
import { exportBackup } from './data/backup.js';
import { getDataSource } from './data/index.js';
import { askChoiceDialog, askDialog, askTextDialog } from './ui/dialog.js';
import { clear, el, qs, toast } from './ui/dom.js';
import { sortMessages } from './ui/filter.js';
import { renderMessageCard } from './ui/message-card.js';
import { countInSection, moveSectionMessages } from './ui/section-move.js';
import {
  emptyState,
  errorState,
  loadingState,
  notConfiguredState,
  unsafeKeyState,
} from './ui/states.js';
import { formatAbsolute, fromLocalInputValue, isExpired, isPublished, resolvePublishedAt, toLocalInputValue } from './ui/time.js';

const dom = {
  title: qs('#site-title'),
  subtitle: qs('#site-subtitle'),
  status: qs('#status-line'),
  main: qs('#main'),
  logout: qs('#logout'),
  toasts: qs('#toasts'),
};

/** 当前编辑中的消息 id；null 表示"新建" */
const state = {
  editingId: /** @type {string|null} */ (null),
  messages: /** @type {any[]} */ ([]),
  sections: /** @type {Array<{id: string, name: string}>} */ ([]),
  /** 数据库还没建栏目表时置为真，界面上会给出提示（但公告照常可管理） */
  sectionsUnavailable: false,
  /** 刚保存过的那条，给卡片加个「刚保存」徽章，方便在大列表里找到它 */
  justSavedId: /** @type {string|null} */ (null),
};

/** 栏目表不存在时的隐式栏目 id（与 app.js 里那个保持一致） */
const FALLBACK_SECTION_ID = '__fallback__';

/** 界面元素引用，登录成功后才存在 */
let ui = /** @type {null|Record<string, any>} */ (null);

/** 「每次保存后询问备份」开关的引用（管理页渲染后才存在） */
let backupAskToggle = /** @type {HTMLInputElement|null} */ (null);

/** 让界面上的开关反映本地保存的偏好 */
function syncBackupAskToggle() {
  if (backupAskToggle) backupAskToggle.checked = !isBackupAskSkipped();
}

function setStatus(text) {
  dom.status.textContent = text || '';
}

/* ============================ 顶部信息 ============================ */

function applySiteChrome() {
  const siteTitle = CONFIG.site.title || '班级公告栏';
  document.title = `公告管理 · ${siteTitle}`;
  dom.title.textContent = '公告管理';
  if (CONFIG.site.className) {
    dom.subtitle.textContent = `${siteTitle} · ${CONFIG.site.className}`;
    dom.subtitle.hidden = false;
  } else {
    dom.subtitle.textContent = siteTitle;
    dom.subtitle.hidden = false;
  }
}

/* =============================== 登录 =============================== */

function renderLogin() {
  ui = null;
  dom.logout.hidden = true;
  clear(dom.main);

  const email = el('input', {
    class: 'input',
    id: 'login-email',
    type: 'email',
    required: true,
    autocomplete: 'username',
    placeholder: '你的管理员邮箱',
  });
  const password = el('input', {
    class: 'input',
    id: 'login-password',
    type: 'password',
    required: true,
    autocomplete: 'current-password',
    placeholder: '口令',
  });
  const submit = el('button', { class: 'btn btn--primary btn--block', type: 'submit', text: '登录' });

  const form = el(
    'form',
    { class: 'form', id: 'login-form' },
    el(
      'div',
      { class: 'field' },
      el('label', { class: 'field__label', for: 'login-email', text: '管理员邮箱' }),
      email,
    ),
    el(
      'div',
      { class: 'field' },
      el('label', { class: 'field__label', for: 'login-password', text: '口令' }),
      password,
    ),
    submit,
    el('p', {
      class: 'field__hint',
      text: '口令就是你在 Supabase 里创建的管理员账号密码。本地服务器则在 local_config.json 中。',
    }),
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;
    submit.textContent = '登录中…';
    try {
      await getDataSource().signIn(email.value.trim(), password.value);
      toast(dom.toasts, '登录成功', 'success');
      renderAdmin();
    } catch (error) {
      toast(dom.toasts, (error && error.message) || '登录失败', 'error');
      submit.disabled = false;
      submit.textContent = '登录';
    }
  });

  dom.main.append(
    el(
      'section',
      { class: 'panel', style: 'max-width: 420px; margin: 0 auto;' },
      el('h2', { class: 'panel__title', text: '学习委员登录' }),
      form,
    ),
  );
}

/* ============================= 管理界面 ============================= */

function buildForm() {
  const title = el('input', { class: 'input', id: 'edit-title', type: 'text', maxlength: '200', placeholder: '例如：周三交实验报告' });
  const body = el('textarea', { class: 'textarea', id: 'edit-body', placeholder: '正文内容，可以换行。' });
  const published = el('input', {
    class: 'input',
    id: 'edit-published',
    type: 'datetime-local',
    required: true,
    value: toLocalInputValue(Date.now()),
  });

  // 「现在」快捷按钮：补录后想改回当前时间时，不用在日历里点回来
  const publishedNow = el('button', {
    type: 'button',
    class: 'btn btn--small btn--ghost',
    text: '现在',
    onclick: () => {
      ui.published.value = toLocalInputValue(Date.now());
    },
  });
  const expires = el('input', { class: 'input', id: 'edit-expires', type: 'datetime-local' });

  // 紧急公告：勾选后会排在栏目最前，并汇总到首页顶部「总栏目」
  const urgent = el('input', { type: 'checkbox', id: 'edit-urgent' });

  // 所属栏目：下拉里由 fillSectionOptions() 填当前栏目列表
  const section = el('select', { class: 'input', id: 'edit-section' });

  const modeRadios = ['none', 'at', 'now'].map((value, index) =>
    el(
      'label',
      { class: 'radio-pill' },
      el('input', { type: 'radio', name: 'expiry-mode', value, checked: index === 0 }),
      { none: '永不过期', at: '指定时间', now: '立即结束' }[value],
    ),
  );

  const expiresField = el(
    'div',
    { class: 'field', hidden: true },
    el('label', { class: 'field__label', for: 'edit-expires', text: '过期时间' }),
    expires,
  );

  for (const radio of modeRadios) {
    radio.addEventListener('change', () => {
      const mode = currentExpiryMode();
      expiresField.hidden = mode !== 'at';
      if (mode === 'at' && !expires.value) {
        // 默认给一个"7 天后 23:59"的合理值，省得每次都要手选
        const later = new Date();
        later.setDate(later.getDate() + 7);
        later.setHours(23, 59, 0, 0);
        expires.value = toLocalInputValue(later);
      }
    });
  }

  const submit = el('button', { class: 'btn btn--primary btn--block', type: 'submit', text: '发布公告' });
  const cancel = el('button', { class: 'btn btn--ghost btn--block', type: 'button', text: '取消编辑', hidden: true });

  const form = el(
    'form',
    { class: 'form' },
    el('div', { class: 'field' }, el('label', { class: 'field__label', for: 'edit-title', text: '标题' }), title),
    el('div', { class: 'field' }, el('label', { class: 'field__label', for: 'edit-body', text: '正文' }), body),
    el(
      'div',
      { class: 'field' },
      el('label', { class: 'field__label', for: 'edit-section', text: '所属栏目' }),
      section,
      el('p', {
        class: 'field__hint',
        text: '栏目可以在下面的「栏目管理」里新增和改名；同学只能查看，不能修改。',
      }),
    ),
    el(
      'div',
      { class: 'field' },
      el('label', { class: 'field__label', for: 'edit-published', text: '发布时间' }),
      el('div', { class: 'field__row' }, published, publishedNow),
      el('p', {
        class: 'field__hint',
        text: '可以选比现在早的时间（补录旧通知）；填未来的时间 = 定时公告，到点前同学看不到。',
      }),
    ),
    el(
      'div',
      { class: 'field' },
      el('span', { class: 'field__label', text: '是否过期' }),
      el('div', { class: 'radio-row' }, ...modeRadios),
    ),
    expiresField,
    el(
      'label',
      { class: 'check-row', for: 'edit-urgent' },
      urgent,
      el('span', { text: '设为紧急公告（排在栏目最前，并汇总到顶部「总栏目」）' }),
    ),
    submit,
    cancel,
  );

  form.addEventListener('submit', onSubmit);
  cancel.addEventListener('click', () => resetForm());

  ui = { title, body, section, published, expires, expiresField, urgent, submit, cancel, form };
  return form;
}

function currentExpiryMode() {
  const checked = document.querySelector('input[name="expiry-mode"]:checked');
  return checked ? checked.value : 'none';
}

function setExpiryMode(mode) {
  for (const radio of document.querySelectorAll('input[name="expiry-mode"]')) {
    radio.checked = radio.value === mode;
  }
  if (ui && ui.expiresField) ui.expiresField.hidden = mode !== 'at';
}

function resetForm() {
  if (!ui) return;
  state.editingId = null;
  ui.title.value = '';
  ui.body.value = '';
  ui.published.value = toLocalInputValue(Date.now());
  ui.expires.value = '';
  ui.urgent.checked = false;
  // 栏目回到第一个（默认栏目）——新公告默认发到默认栏目
  if (ui.section && state.sections[0]) ui.section.value = state.sections[0].id;
  setExpiryMode('none');
  ui.submit.textContent = '发布公告';
  ui.cancel.hidden = true;
  document.querySelector('.panel__form-title').textContent = '发布新公告';
}

function startEdit(message) {
  if (!ui) return;
  state.editingId = message.id;
  ui.title.value = message.title || '';
  ui.body.value = message.body || '';
  ui.published.value = toLocalInputValue(message.published_at) || toLocalInputValue(Date.now());
  ui.urgent.checked = isUrgentMessage(message);

  // 选中这条公告原本所属的栏目（栏目可能已被改名，用 id 匹配）
  if (ui.section) {
    const wanted = String(message.section_id || '');
    const exists = state.sections.some((item) => item.id === wanted);
    ui.section.value = exists ? wanted : (state.sections[0] ? state.sections[0].id : '');
  }

  if (message.expires_at) {
    ui.expires.value = toLocalInputValue(message.expires_at);
    setExpiryMode('at');
  } else {
    ui.expires.value = '';
    setExpiryMode('none');
  }

  ui.submit.textContent = '保存修改';
  ui.cancel.hidden = false;
  document.querySelector('.panel__form-title').textContent = '编辑公告';
  ui.form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  ui.title.focus();
}

function setBusy(busy) {
  if (!ui) return;
  ui.submit.disabled = busy;
  for (const radio of document.querySelectorAll('input[name="expiry-mode"]')) radio.disabled = busy;
}

async function onSubmit(event) {
  event.preventDefault();
  if (!ui) return;

  const title = ui.title.value.trim();
  if (!title) {
    toast(dom.toasts, '请先填写标题', 'error');
    ui.title.focus();
    return;
  }

  const mode = currentExpiryMode();
  let expiresAt = null;
  if (mode === 'now') {
    expiresAt = new Date().toISOString();
  } else if (mode === 'at') {
    if (!ui.expires.value) {
      toast(dom.toasts, '请选择过期时间，或改选「永不过期」', 'error');
      ui.expires.focus();
      return;
    }
    expiresAt = fromLocalInputValue(ui.expires.value);
  }

  // ★ 这里以前是 fromLocalInputValue(...) || new Date().toISOString()，
  //   输入不合法时会把你选的时间悄悄换成"现在"，看起来就像"不能用过去的时间发布"。
  //   现在解析不了就明确报错并停下。
  const published = resolvePublishedAt(ui.published.value);
  if (!published.ok) {
    toast(dom.toasts, published.error, 'error');
    ui.published.focus();
    return;
  }

  const payload = {
    title,
    body: ui.body.value,
    section_id: ui.section.value,
    published_at: published.iso,
    expires_at: expiresAt,
    is_urgent: ui.urgent.checked,
  };

  const wasEditing = Boolean(state.editingId);
  const source = getDataSource();
  setBusy(true);
  try {
    let savedId = '';
    if (wasEditing) {
      await source.updateMessage(state.editingId, payload);
      savedId = String(state.editingId);
      toast(dom.toasts, `已保存修改${describePublishTime(published.iso)}`, 'success');
    } else {
      const created = await source.createMessage(payload);
      savedId = String(created && created.id ? created.id : '');
      toast(dom.toasts, `已发布${describePublishTime(published.iso)}`, 'success');
    }
    state.justSavedId = savedId || null;
    resetForm();
    await loadMessages();
    // 每发布/修改一条，就落一份 Word 存档（可在 config.js 关掉）
    autoBackup();
  } catch (error) {
    toast(dom.toasts, (error && error.message) || '保存失败', 'error');
    if (error && error.isAuthError) {
      await Promise.resolve(source.signOut()).catch(() => {});
      renderShell();
      return;
    }
  } finally {
    setBusy(false);
  }
}

/* ========================== 发布时间的提示 ========================== */

/**
 * 把"实际生效的发布时间"写进保存提示里。
 *
 * 为什么需要：过去时间是完全合法的（补录旧通知），但公告是按发布时间排序的，
 * 补录的公告不会出现在列表最上面。以前提示只说"已发布"，
 * 看起来就像没发成功 —— 这里把生效时间和排位讲清楚。
 *
 * @param {string} iso
 */
function describePublishTime(iso) {
  const label = formatAbsolute(iso) || '未知';
  const diffMinutes = (Date.now() - new Date(iso).getTime()) / 60000;

  if (diffMinutes > 1) {
    return `：发布时间 ${label}（过去时间，会按此时间排在列表中，不在最上面）`;
  }
  if (diffMinutes < -1) {
    return `：发布时间 ${label}（未来时间 = 定时公告，到点前同学看不到）`;
  }
  return `：发布时间 ${label}`;
}

/* ============================== 列表 ============================== */

function renderAdmin() {
  clear(dom.main);

  const formPanel = el(
    'section',
    { class: 'panel admin-panel' },
    el('h2', { class: 'panel__title panel__form-title', text: '发布新公告' }),
    buildForm(),
    el('p', { class: 'panel__hint', text: '发布后同学打开首页即可看到。过期后会自动收进「往期公告」。' }),
  );

  const listContainer = el('div', { class: 'admin-list' });

  // 栏目管理面板：新增 / 重命名 / 删除栏目（同学那边看不到任何入口）
  const sectionPanel = el('section', { class: 'panel admin-panel' });

  // 「每次保存后询问是否备份」开关：关掉对话框后还能从这里打开
  backupAskToggle = el('input', { type: 'checkbox', id: 'ask-backup-after-save' });
  backupAskToggle.addEventListener('change', () => {
    setBackupAskSkipped(!backupAskToggle.checked);
  });
  syncBackupAskToggle();

  const modeHint = {
    ask: '每次保存后会询问你是否要下载一份 Word 备份。',
    auto: '每次保存后会自动下载一份 Word 备份（config.js 里 backup.mode = "auto"）。',
    off: '自动备份已关闭（config.js 里 backup.mode = "off"）。随时可以点右边按钮手动导出。',
  }[CONFIG.backup.mode || 'ask'] || '';

  const listPanel = el(
    'section',
    { class: 'panel' },
    el(
      'div',
      { class: 'panel__head' },
      el('h2', { class: 'panel__title', text: '已发布的公告' }),
      el('button', {
        type: 'button',
        class: 'btn btn--small',
        text: '导出 Word 备份',
        onclick: () => downloadBackup(true),
      }),
    ),
    el('p', { class: 'panel__hint', text: modeHint }),
    el(
      'label',
      { class: 'check-row check-row--muted', for: 'ask-backup-after-save' },
      backupAskToggle,
      el('span', { text: '每次保存后询问是否下载 Word 备份' }),
    ),
    listContainer,
  );

  ui.listContainer = listContainer;
  ui.sectionPanel = sectionPanel;
  dom.main.append(
    el('div', { class: 'admin-grid' }, formPanel, el('div', { class: 'admin-side' }, sectionPanel, listPanel)),
  );
  dom.logout.hidden = false;

  loadMessages();
}

/* ============================ Word 备份 ============================ */

/** 管理页导出：包含全部（含定时未发布）公告 */
function downloadBackup({ announce = true } = {}) {
  const messages = state.messages || [];
  if (!messages.length) {
    if (announce) toast(dom.toasts, '现在还没有公告，没什么可备份的', 'error');
    return null;
  }

  try {
    const fileName = exportBackup(messages, { includeUnpublished: true, sections: state.sections });
    toast(dom.toasts, `Word 备份已保存：${fileName}`, 'success');
    return fileName;
  } catch (error) {
    toast(dom.toasts, `备份失败：${(error && error.message) || error}`, 'error');
    return null;
  }
}

/* 「以后不再询问」记在本地浏览器里；管理页有一个同名开关可以改回来 */
const BACKUP_SKIP_KEY = 'class-bulletin.backup-ask-skipped';

function isBackupAskSkipped() {
  try {
    return localStorage.getItem(BACKUP_SKIP_KEY) === '1';
  } catch {
    return false;
  }
}

function setBackupAskSkipped(skipped) {
  try {
    if (skipped) localStorage.setItem(BACKUP_SKIP_KEY, '1');
    else localStorage.removeItem(BACKUP_SKIP_KEY);
  } catch {
    // 隐私模式写不进去也不影响本次会话
  }
}

/** 每次保存成功后询问是否要留一份 Word（可在 config.js 改成 auto / off） */
async function maybeAskBackup() {
  const mode = CONFIG.backup.mode || 'ask';

  if (mode === 'auto') {
    downloadBackup();
    return;
  }
  if (mode !== 'ask' || isBackupAskSkipped()) return;

  const { confirmed, remember } = await askDialog({
    title: '公告已保存',
    text: '要现在下载一份 Word 备份吗？下载后即使网站或云端数据失效，你手上也留着内容。',
    confirmText: '下载 Word 备份',
    cancelText: '不用了',
    rememberLabel: '以后不再询问（可在右侧面板改回来）',
  });

  if (remember) setBackupAskSkipped(true);
  syncBackupAskToggle();
  if (confirmed) downloadBackup();
}

/** 内容变动后：按配置询问或自动备份 */
function autoBackup() {
  Promise.resolve(maybeAskBackup()).catch(() => {});
}

async function loadMessages() {
  if (!ui || !ui.listContainer) return;
  clear(ui.listContainer);
  ui.listContainer.append(loadingState());

  try {
    const source = getDataSource();
    // 公告和栏目一起取：栏目取不到也要让公告照常管理（降级，不整页报错）
    const [messages, sections] = await Promise.all([
      source.listMessages(),
      loadSectionsForAdmin(source),
    ]);
    state.messages = messages;
    state.sections = sections;
    fillSectionOptions();
    renderSections();
    renderList();
    setStatus(`共 ${messages.length} 条公告 · ${sections.length} 个栏目 · 上次刷新 ${formatAbsolute(Date.now())}`);
  } catch (error) {
    clear(ui.listContainer);
    ui.listContainer.append(errorState((error && error.message) || '加载失败', () => loadMessages()));
    setStatus('加载失败');
  }
}

/**
 * 管理页取栏目；取不到就降级成一个隐式栏目。
 *
 * 与首页 app.js 的 loadSections() 同一个道理：栏目功能要跑 schema.sql，
 * 忘了跑的时候不能让管理页整个罢工 —— 公告还是能发能改的。
 */
async function loadSectionsForAdmin(source) {
  try {
    const sections = await source.listSections();
    if (sections.length) return sections;
    return [{ id: FALLBACK_SECTION_ID, name: CONFIG.sections.fallbackName || '公告', created_at: '' }];
  } catch (error) {
    const status = error && error.status;
    const code = String((error && error.code) || '');
    const text = `${(error && error.message) || ''}`;
    const missing =
      status === 404 ||
      ['PGRST205', '42P01'].includes(code) ||
      /does not exist|schema cache|relation .* not found/i.test(text);
    if (!missing) throw error;
    state.sectionsUnavailable = true;
    return [{ id: FALLBACK_SECTION_ID, name: CONFIG.sections.fallbackName || '公告', created_at: '' }];
  }
}

/** 把栏目列表填进"所属栏目"下拉；尽量保留当前选择 */
function fillSectionOptions() {
  if (!ui || !ui.section) return;
  const previous = ui.section.value;
  clear(ui.section);
  for (const section of state.sections) {
    ui.section.append(el('option', { value: section.id, text: section.name }));
  }
  const stillThere = state.sections.some((section) => section.id === previous);
  ui.section.value = stillThere ? previous : (state.sections[0] ? state.sections[0].id : '');
}

/* ============================ 栏目管理 ============================ */

/**
 * 渲染「栏目管理」面板。
 *
 * 只有登录后的管理页才有这块 —— 同学在首页看不到任何增删改入口，
 * 而且就算有人手动发请求，后端也会以 401 / RLS 拒绝（"普通成员无法修改栏目"）。
 */
function renderSections() {
  if (!ui || !ui.sectionPanel) return;
  clear(ui.sectionPanel);

  // ---- 新增 ----
  const nameInput = el('input', {
    class: 'input',
    id: 'new-section-name',
    type: 'text',
    maxlength: String(CONFIG.sections.nameMaxLength),
    placeholder: '新栏目名称，例如：班委通知',
  });
  const addButton = el('button', {
    type: 'button',
    class: 'btn btn--small',
    text: '添加栏目',
  });

  const submitNew = async () => {
    const name = nameInput.value.trim();
    if (!name) {
      toast(dom.toasts, '请先填栏目名称', 'error');
      nameInput.focus();
      return;
    }
    addButton.disabled = true;
    try {
      await getDataSource().createSection(name);
      nameInput.value = '';
      toast(dom.toasts, `已添加栏目「${name}」`, 'success');
      await loadMessages();
    } catch (error) {
      toast(dom.toasts, (error && error.message) || '添加失败', 'error');
    } finally {
      addButton.disabled = false;
    }
  };

  addButton.addEventListener('click', submitNew);
  nameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitNew();
    }
  });

  ui.sectionPanel.append(
    el('h2', { class: 'section__title', text: '栏目管理' }),
    el('p', {
      class: 'field__hint',
      text: '栏目显示在首页顶部；同学只能查看，不能修改。删除栏目要求栏目里已经没有公告。',
    }),
    el('div', { class: 'field__row' }, nameInput, addButton),
  );

  if (state.sectionsUnavailable) {
    ui.sectionPanel.append(
      el('p', {
        class: 'field__hint field__hint--warn',
        text: '⚠️ 数据库里还没有栏目表：请到 Supabase → SQL Editor 把 supabase/schema.sql 完整跑一遍。',
      }),
    );
  }

  // ---- 列表 ----
  const list = el('div', { class: 'section-admin__list' });
  for (const section of state.sections) {
    const used = countInSection(state.messages, section.id);
    const isFallbackOnly = section.id === FALLBACK_SECTION_ID;
    const isLast = state.sections.length <= 1;
    const canDelete = !isFallbackOnly && !isLast;

    const renameButton = el('button', {
      type: 'button',
      class: 'btn btn--small btn--ghost',
      text: '重命名',
      disabled: isFallbackOnly,
      onclick: () => renameSectionFlow(section),
    });
    // ★ 里面有公告时**不再禁用**：点下去会问"搬到哪个栏目"，搬完再删。
    //   以前禁用 + 只给 title 提示，手机上连提示都看不到，栏目就永远删不掉。
    const deleteButton = el('button', {
      type: 'button',
      class: 'btn btn--small btn--ghost btn--danger',
      text: used ? `删除（先搬 ${used} 条）` : '删除',
      disabled: !canDelete,
      title: isFallbackOnly
        ? '数据库里还没有栏目表，暂时不能管理栏目'
        : isLast
          ? '至少要保留一个栏目'
          : used
            ? `里面还有 ${used} 条公告：点删除会把它们搬到其它栏目，然后删掉本栏目`
            : '',
      onclick: () => deleteSectionFlow(section),
    });

    list.append(
      el(
        'div',
        { class: 'section-admin__row' },
        el('span', { class: 'section-admin__name', text: section.name }),
        el('span', { class: 'section-admin__count', text: `${used} 条公告` }),
        el('span', { class: 'section-admin__actions' }, renameButton, deleteButton),
      ),
    );
  }
  ui.sectionPanel.append(list);
}

/** 重命名：弹一个输入框（不用 window.prompt —— 样式不一致，还可能被屏蔽） */
async function renameSectionFlow(section) {
  const next = await askTextDialog({
    title: `重命名栏目「${section.name}」`,
    label: '新名称',
    value: section.name,
    maxLength: CONFIG.sections.nameMaxLength,
    confirmText: '保存名称',
  });
  if (next === null) return;
  if (!next || next === section.name) return;
  try {
    await getDataSource().renameSection(section.id, next);
    toast(dom.toasts, `已改名为「${next}」`, 'success');
    await loadMessages();
  } catch (error) {
    toast(dom.toasts, (error && error.message) || '重命名失败', 'error');
  }
}

/**
 * 删除栏目。
 *
 * ★ 以前这里是个死胡同：栏目里还有公告时按钮直接禁用，只留一句 title 提示，
 *   手机上连提示都看不到，于是"栏目删不掉"。
 *   现在改成：只要里面还有公告，就问一句"要搬到哪个栏目"，
 *   搬完再删 —— 删栏目这件事终于能善始善终。
 */
async function deleteSectionFlow(section) {
  const used = countInSection(state.messages, section.id);
  const source = getDataSource();

  if (used) {
    const others = state.sections.filter((item) => item.id !== section.id);
    if (!others.length) {
      toast(dom.toasts, '至少要保留一个栏目，没法把公告搬走', 'error');
      return;
    }

    const target = await askChoiceDialog({
      title: `「${section.name}」里还有 ${used} 条公告`,
      text: '栏目不能连着公告一起删掉（免得误删通知）。选一个栏目把这些公告搬过去，然后删除本栏目。',
      options: others.map((item) => ({ value: item.id, label: item.name })),
      confirmText: '搬过去并删除栏目',
      cancelText: '不删了',
    });
    if (!target) return;

    const targetName = (others.find((item) => item.id === target) || {}).name || '目标栏目';
    try {
      const { moved, failed } = await moveSectionMessages(source, state.messages, section.id, target);
      if (failed.length) {
        toast(
          dom.toasts,
          `搬动了 ${moved.length} 条，${failed.length} 条失败（${failed[0].error && failed[0].error.message ? failed[0].error.message : '未知原因'}）。栏目先不删，请重试。`,
          'error',
        );
        await loadMessages();
        return;
      }
      toast(dom.toasts, `已把 ${moved.length} 条公告搬到「${targetName}」`, 'success');
    } catch (error) {
      toast(dom.toasts, (error && error.message) || '搬动公告失败', 'error');
      await loadMessages();
      return;
    }
    await loadMessages();
  }

  // 注意 askDialog 返回的是 { confirmed, remember }，不是布尔值
  const { confirmed } = await askDialog({
    title: `删除栏目「${section.name}」？`,
    text: '栏目会被删掉。公告已经在别的栏目里了，不受影响。',
    confirmText: '删除栏目',
    cancelText: '不删了',
  });
  if (!confirmed) return;
  try {
    await source.deleteSection(section.id);
    toast(dom.toasts, `已删除栏目「${section.name}」`, 'success');
    // 删掉的可能是当前选中的那个栏目，回到第一个
    if (ui && ui.section) ui.section.value = '';
    await loadMessages();
  } catch (error) {
    toast(dom.toasts, (error && error.message) || '删除失败', 'error');
  }
}

function renderList() {
  if (!ui || !ui.listContainer) return;
  clear(ui.listContainer);

  if (!state.messages.length) {
    ui.listContainer.append(emptyState('还没有发布过公告', '在左边填写标题和正文，点「发布公告」就行。'));
    return;
  }

  const now = Date.now();
  // 排序与首页保持一致：紧急优先，其余按发布时间倒序
  for (const message of sortMessages(state.messages)) {
    const expired = isExpired(message, now);
    const notPublished = !isPublished(message, now);

    const extraBadges = [];
    const section = sectionOf(message, state.sections);
    if (section) extraBadges.push({ label: section.name, kind: 'accent' });
    if (notPublished) extraBadges.push({ label: '未到发布时间', kind: 'accent' });
    if (state.editingId === message.id) extraBadges.push({ label: '编辑中', kind: 'success' });
    if (state.justSavedId === message.id) extraBadges.push({ label: '刚保存', kind: 'success' });

    ui.listContainer.append(
      renderMessageCard(message, {
        now,
        extraBadges,
        detailHref: `message.html?id=${encodeURIComponent(message.id)}`,
        actions: [
          { label: '编辑', onClick: () => startEdit(message) },
          expired
            ? { label: '恢复为有效', onClick: () => setExpiry(message, false) }
            : { label: '标记已结束', onClick: () => setExpiry(message, true) },
          { label: '删除', kind: 'danger', onClick: () => removeMessage(message) },
        ],
      }),
    );
  }
}

async function setExpiry(message, expired) {
  const source = getDataSource();
  try {
    await source.updateMessage(message.id, {
      expires_at: expired ? new Date().toISOString() : null,
    });
    toast(dom.toasts, expired ? '已标记为结束' : '已恢复为有效', 'success');
    await loadMessages();
    autoBackup();
  } catch (error) {
    toast(dom.toasts, (error && error.message) || '操作失败', 'error');
  }
}

async function removeMessage(message) {
  const confirmed = window.confirm(`确定删除「${message.title}」吗？删除后无法恢复。`);
  if (!confirmed) return;

  try {
    await getDataSource().deleteMessage(message.id);
    if (state.editingId === message.id) resetForm();
    toast(dom.toasts, '已删除', 'success');
    await loadMessages();
    autoBackup();
  } catch (error) {
    toast(dom.toasts, (error && error.message) || '删除失败', 'error');
  }
}

/* ============================== 外壳 ============================== */

function renderShell() {
  applySiteChrome();

  // 安全检查优先：填了机密 key 就什么都不做，绝不能把它发出去
  const keyCheck = inspectApiKey();
  if (!keyCheck.ok) {
    ui = null;
    dom.logout.hidden = true;
    clear(dom.main);
    dom.main.append(unsafeKeyState(keyCheck.message));
    setStatus('配置有安全问题，已停止运行');
    return;
  }

  if (!isConfigured()) {
    ui = null;
    dom.logout.hidden = true;
    clear(dom.main);
    dom.main.append(notConfiguredState());
    setStatus('尚未连接服务器');
    return;
  }

  const session = getDataSource().getSession();
  if (!session) {
    setStatus('请先用管理员账号登录');
    renderLogin();
    return;
  }

  setStatus(`已登录：${session.user && session.user.email ? session.user.email : '管理员'}`);
  renderAdmin();
}

dom.logout.addEventListener('click', async () => {
  try {
    await getDataSource().signOut();
    toast(dom.toasts, '已退出登录', 'success');
  } finally {
    state.editingId = null;
    dom.logout.hidden = true;
    renderShell();
  }
});

renderShell();
