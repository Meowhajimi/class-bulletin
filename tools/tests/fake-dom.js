/**
 * 给 Node 测试用的最小 DOM 替身。
 *
 * Node 里没有 DOM，而 `ui/` 下的组件是靠真实 DOM API 拼界面的。
 * 这个替身只实现项目真正用到的那几个方法，让组件能在 Node 里被渲染出来检查。
 *
 * 它不是完整的 DOM 实现，也**不用于生产代码**，只在测试里用。
 */

class FakeNode {
  constructor(tag) {
    this.tagName = tag;
    this.childNodes = [];
    this.parent = null;
    this.attributes = {};
    this.dataset = {};
    this.listeners = {};
    this.className = '';
    this.textContent = '';
    this.open = false;
    this.focused = false;
    this.checked = false;

    // 真实浏览器里每个元素都有 classList；组件（如栏目标签行）
    // 会用 classList.toggle 切换选中态，所以这里补一个最小实现。
    // 以前没有它时，渲染测试会直接抛 TypeError，而不是给出有用的断言信息。
    const node = this;
    this.classList = {
      add(...names) {
        const set = new Set(node.className.split(/\s+/).filter(Boolean));
        for (const name of names) set.add(name);
        node.className = [...set].join(' ');
      },
      remove(...names) {
        const drop = new Set(names);
        node.className = node.className
          .split(/\s+/)
          .filter((name) => name && !drop.has(name))
          .join(' ');
      },
      contains(name) {
        return node.className.split(/\s+/).includes(name);
      },
      toggle(name, force) {
        const has = this.contains(name);
        const want = force === undefined ? !has : Boolean(force);
        if (want) this.add(name);
        else this.remove(name);
        return want;
      },
    };
  }

  get children() {
    return this.childNodes;
  }

  get childElementCount() {
    return this.childNodes.length;
  }

  get firstChild() {
    return this.childNodes[0] || null;
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node instanceof FakeNode) node.parent = this;
      this.childNodes.push(node);
    }
  }

  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    if (index >= 0) {
      this.childNodes.splice(index, 1);
      node.parent = null;
    }
    return node;
  }

  remove() {
    if (this.parent) this.parent.removeChild(this);
  }

  setAttribute(key, value) {
    this.attributes[key] = value;
  }

  getAttribute(key) {
    return this.attributes[key];
  }

  addEventListener(type, handler) {
    this.listeners[type] = handler;
  }

  dispatch(type, event = {}) {
    if (this.listeners[type]) this.listeners[type](event);
  }

  focus() {
    this.focused = true;
  }

  showModal() {
    this.open = true;
  }

  close() {
    this.open = false;
  }

  /** 把子树里的文字拼起来，模拟"用户在页面上看到的内容" */
  text() {
    const inner = this.childNodes
      .map((child) => (child.text ? child.text() : String(child)))
      .join('');
    return (this.textContent || '') + inner;
  }

  /** 深度优先找出第一个满足条件的节点 */
  find(predicate) {
    if (predicate(this)) return this;
    for (const child of this.childNodes) {
      if (child instanceof FakeNode) {
        const hit = child.find(predicate);
        if (hit) return hit;
      }
    }
    return null;
  }

  findAll(predicate, out = []) {
    if (predicate(this)) out.push(this);
    for (const child of this.childNodes) {
      if (child instanceof FakeNode) child.findAll(predicate, out);
    }
    return out;
  }
}

class FakeText {
  constructor(text) {
    this.textContent = text;
    this.parent = null;
  }

  text() {
    return this.textContent;
  }
}

/** 装上假的 Node / document / window。测试开头调用一次即可。 */
export function installFakeDom() {
  const body = new FakeNode('body');
  const documentListeners = {};

  globalThis.Node = FakeNode;
  globalThis.document = {
    createElement: (tag) => new FakeNode(tag),
    // SVG 必须建在 SVG 命名空间里，所以 ui/icon.js 用的是 createElementNS
    createElementNS: (_namespace, tag) => new FakeNode(tag),
    createTextNode: (text) => new FakeText(String(text)),
    body,
    hidden: false,
    addEventListener: (type, handler) => {
      documentListeners[type] = handler;
    },
    removeEventListener: (type) => {
      delete documentListeners[type];
    },
    dispatch: (type) => {
      if (documentListeners[type]) documentListeners[type]();
    },
    hasListener: (type) => Boolean(documentListeners[type]),
  };
  globalThis.window = {
    setTimeout: (...args) => setTimeout(...args),
    clearTimeout: (...args) => clearTimeout(...args),
  };

  // 在线人数用 sessionStorage 存会话号；测试里用内存替身
  const store = new Map();
  globalThis.sessionStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
  };

  return { body, dispatchDocument: (type) => globalThis.document.dispatch(type) };
}

/**
 * 记录 console.warn 的调用。
 *
 * 用途：`ui/dom.js` 在收到"不能当子节点的东西"时会 warn 一声 ——
 * 组件渲染测试只要断言"一条警告都没有"，就能抓住
 * "把 { text } 当子节点传"这类只会显示成 [object Object] 的错误。
 */
export function captureWarnings() {
  const messages = [];
  const original = console.warn;
  console.warn = (...args) => {
    messages.push(args.map((arg) => String(arg)).join(' '));
  };
  return {
    messages,
    restore: () => {
      console.warn = original;
    },
  };
}

export { FakeNode, FakeText };
