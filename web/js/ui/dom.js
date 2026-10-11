/**
 * 极小的 DOM 工具。
 *
 * ★ 全站只通过 textContent 写入用户内容，从不拼接 innerHTML，
 *   所以就算有人在标题里写 <script> 也只会被当成普通文字显示。
 *   新增界面代码时请沿用这里的方法。
 */

/**
 * 创建元素。
 * @param {string} tag
 * @param {Object} [props] class / text / dataset / onclick 等
 * @param {...(Node|string|null|undefined|Array)} children
 * @returns {HTMLElement}
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }

  append(node, children);
  return node;
}

/** 把子节点（含数组、null）追加到父节点 */
export function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === true) continue;

    if (child instanceof Node) {
      parent.append(child);
      continue;
    }

    // 数字和字符串按文字处理
    if (typeof child === 'number' || typeof child === 'string') {
      parent.append(document.createTextNode(String(child)));
      continue;
    }

    // 踩过的坑：把 { text: '...' } 当成子节点传进来（应该包一层元素，
    // 或者放进 el() 的第二个参数）。以前会被 String() 成 "[object Object]"
    // 显示给用户，很难看出是代码写错了。这里改成取出 text 并留下警告。
    if (typeof child === 'object' && typeof child.text === 'string') {
      console.warn(
        '[dom] 子节点收到了对象 { text: ... }。正确写法是 el(\'span\', { text: ... })，' +
          '或者把 text 放进 el() 的第二个参数。已按文字显示，但请修正调用处。',
        child,
      );
      parent.append(document.createTextNode(child.text));
      continue;
    }

    // 其它奇怪的东西（普通对象、函数、Symbol…）一律不渲染，并明确报出来
    console.warn('[dom] 无法作为子节点渲染，已跳过：', child);
  }
  return parent;
}

/** @param {string} selector */
export function qs(selector, root = document) {
  const node = root.querySelector(selector);
  if (!node) throw new Error(`页面上找不到元素：${selector}`);
  return node;
}

/** 清空一个容器 */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** 安全地设置文本（永远走 textContent） */
export function setText(node, text) {
  node.textContent = text === null || text === undefined ? '' : String(text);
  return node;
}

/**
 * 显示一条短暂的提示（保存成功/失败都用它）。
 * @param {HTMLElement} container
 * @param {string} message
 * @param {'info'|'success'|'error'} [kind]
 * @param {{actionLabel?: string, onAction?: Function, durationMs?: number}} [options]
 *        可以带一个操作按钮（例如「下载备份」）
 */
export function toast(container, message, kind = 'info', options = {}) {
  const node = el('div', { class: `toast toast--${kind}`, role: 'status' });
  node.append(el('div', { text: message }));

  if (options.actionLabel && typeof options.onAction === 'function') {
    node.append(
      el('button', {
        type: 'button',
        class: 'toast__action',
        text: options.actionLabel,
        onclick: () => {
          options.onAction();
          node.remove();
        },
      }),
    );
  }

  container.append(node);
  const duration = options.durationMs ?? (kind === 'error' ? 8000 : 4000);
  setTimeout(() => node.remove(), duration);
  return node;
}
