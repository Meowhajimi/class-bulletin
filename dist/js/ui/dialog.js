/**
 * 模态对话框。
 *
 * 用浏览器原生的 <dialog> 元素（showModal()），因为它自带：
 *   · 焦点锁定在对话框内
 *   · Esc 关闭
 *   · 其余内容对读屏软件隐藏
 * 这些如果自己实现很容易漏，交给浏览器更省事也更可靠。
 */

import { el } from './dom.js';

/**
 * 弹出一个询问框，返回用户的选择。
 *
 * @param {{
 *   title: string,
 *   text?: string,
 *   confirmText?: string,
 *   cancelText?: string,
 *   rememberLabel?: string,
 * }} options
 * @returns {Promise<{confirmed: boolean, remember: boolean}>}
 */
export function askDialog(options) {
  const {
    title,
    text = '',
    confirmText = '确定',
    cancelText = '取消',
    rememberLabel = '',
  } = options;

  return new Promise((resolve) => {
    const rememberInput = el('input', { type: 'checkbox', id: 'dialog-remember' });

    const confirmButton = el('button', {
      type: 'button',
      class: 'btn btn--primary btn--block',
      text: confirmText,
    });
    const cancelButton = el('button', {
      type: 'button',
      class: 'btn btn--ghost btn--block',
      text: cancelText,
    });

    const dialog = el(
      'dialog',
      { class: 'dialog' },
      el(
        'div',
        { class: 'dialog__body' },
        el('p', { class: 'dialog__title', text: title }),
        text ? el('p', { class: 'dialog__text', text }) : null,
        rememberLabel
          ? el(
              'label',
              { class: 'dialog__remember', for: 'dialog-remember' },
              rememberInput,
              // 注意：文字必须包在元素里传进来。
              // 直接写 { text: ... } 会被当成普通子节点，经 String() 变成 [object Object]。
              el('span', { text: rememberLabel }),
            )
          : null,
        el('div', { class: 'dialog__actions' }, confirmButton, cancelButton),
      ),
    );

    let remember = false;

    const finish = (confirmed) => {
      remember = Boolean(rememberInput.checked);
      // 关闭动画/收尾交给浏览器，先从 DOM 摘掉再 resolve
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve({ confirmed, remember });
    };

    confirmButton.addEventListener('click', () => finish(true));
    cancelButton.addEventListener('click', () => finish(false));
    // 点遮罩或按 Esc 都算"取消"
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      finish(false);
    });

    document.body.append(dialog);
    dialog.showModal();
    // 默认焦点给"确认"，这样直接回车就能备份
    confirmButton.focus();
  });
}

/**
 * 弹出一个"从几个选项里挑一个"的对话框（删栏目时用来选搬去哪个栏目）。
 *
 * @param {{
 *   title: string,
 *   text?: string,
 *   options: Array<{value: string, label: string}>,
 *   confirmText?: string,
 *   cancelText?: string,
 * }} options
 * @returns {Promise<string|null>} 确认时返回选中的 value；取消返回 null
 */
export function askChoiceDialog(options) {
  const {
    title,
    text = '',
    options: choices = [],
    confirmText = '确定',
    cancelText = '取消',
  } = options;

  return new Promise((resolve) => {
    if (!choices.length) {
      resolve(null);
      return;
    }

    const select = el('select', { class: 'input', id: 'dialog-choice' });
    for (const choice of choices) {
      select.append(el('option', { value: choice.value, text: choice.label }));
    }

    const confirmButton = el('button', {
      type: 'button',
      class: 'btn btn--primary btn--block',
      text: confirmText,
    });
    const cancelButton = el('button', {
      type: 'button',
      class: 'btn btn--ghost btn--block',
      text: cancelText,
    });

    const dialog = el(
      'dialog',
      { class: 'dialog' },
      el(
        'div',
        { class: 'dialog__body' },
        el('p', { class: 'dialog__title', text: title }),
        text ? el('p', { class: 'dialog__text', text }) : null,
        el(
          'div',
          { class: 'field' },
          el('label', { class: 'field__label', for: 'dialog-choice', text: '搬到' }),
          select,
        ),
        el('div', { class: 'dialog__actions' }, confirmButton, cancelButton),
      ),
    );

    const finish = (value) => {
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve(value);
    };

    confirmButton.addEventListener('click', () => finish(select.value));
    cancelButton.addEventListener('click', () => finish(null));
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      finish(null);
    });

    document.body.append(dialog);
    dialog.showModal();
    confirmButton.focus();
  });
}

/**
 * 弹出一个"输入一行文字"的对话框（例如给栏目改名）。
 *
 * 为什么不直接用 window.prompt：
 *   · 它是浏览器原生样式，和站内其它对话框完全不同，而且会被某些环境屏蔽
 *   · 无法限制长度、无法用我们自己的样式与无障碍标签
 *
 * @param {{
 *   title: string,
 *   label?: string,
 *   value?: string,
 *   maxLength?: number,
 *   confirmText?: string,
 *   cancelText?: string,
 * }} options
 * @returns {Promise<string|null>} 确认时返回去掉首尾空格的文本；取消返回 null
 */
export function askTextDialog(options) {
  const {
    title,
    label = '名称',
    value = '',
    maxLength = 40,
    confirmText = '确定',
    cancelText = '取消',
  } = options;

  return new Promise((resolve) => {
    const input = el('input', {
      class: 'input',
      id: 'dialog-text',
      type: 'text',
      value,
      maxlength: String(maxLength),
    });

    const confirmButton = el('button', {
      type: 'button',
      class: 'btn btn--primary btn--block',
      text: confirmText,
    });
    const cancelButton = el('button', {
      type: 'button',
      class: 'btn btn--ghost btn--block',
      text: cancelText,
    });

    const form = el(
      'form',
      { class: 'dialog__body', method: 'dialog' },
      el('p', { class: 'dialog__title', text: title }),
      el(
        'div',
        { class: 'field' },
        el('label', { class: 'field__label', for: 'dialog-text', text: label }),
        input,
      ),
      el('div', { class: 'dialog__actions' }, confirmButton, cancelButton),
    );

    const dialog = el('dialog', { class: 'dialog' }, form);

    const finish = (result) => {
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve(result);
    };

    // ★ 两条路都要接上，缺一条就会"点了没反应"：
    //   ① 点「保存名称」按钮 —— 它是 type="button"，**不会**触发表单的 submit
    //      （真实事故：只接了 submit，于是点按钮完全没反应，
    //        而按回车却有反应 —— 用户根本不知道还能按回车）
    //   ② 在输入框里按回车 —— 走表单的 submit
    confirmButton.addEventListener('click', () => finish(input.value.trim()));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      finish(input.value.trim());
    });
    // 取消按钮是 type="button"，本来就不会提交任何东西，不需要 preventDefault
    // （以前这里多写了一句 event.preventDefault()，在事件对象不完整的环境里会直接抛错）
    cancelButton.addEventListener('click', () => finish(null));
    dialog.addEventListener('cancel', (event) => {
      // 这个才是必须的：不拦住的话浏览器会自己关闭 <dialog>，我们就收不到结果了
      event.preventDefault();
      finish(null);
    });

    document.body.append(dialog);
    dialog.showModal();
    input.focus();
    // 光标放到末尾，方便直接改而不是全删重打
    try {
      input.setSelectionRange(input.value.length, input.value.length);
    } catch {
      // 某些环境不支持，忽略
    }
  });
}
