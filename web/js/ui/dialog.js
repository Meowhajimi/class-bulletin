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
