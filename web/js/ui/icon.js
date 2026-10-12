/**
 * 极简图标：用 SVG 现画，不引入任何图标库，也不用图片文件。
 *
 * 为什么用 createElementNS 而不是 innerHTML：
 *   全站约定"不用 innerHTML 写内容"（见 ui/dom.js 顶部说明）。
 *   SVG 必须建在 SVG 命名空间里，所以这里用 createElementNS，
 *   既画出图形，又不破坏那条约定。
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * 画一个图标。
 * @param {Array<{tag: string, attrs?: Record<string, string|number>}>} shapes
 * @param {{size?: number, className?: string}} [options]
 * @returns {SVGSVGElement}
 */
function svg(shapes, options = {}) {
  const size = options.size || 24;
  const root = document.createElementNS(SVG_NS, 'svg');
  root.setAttribute('viewBox', '0 0 24 24');
  root.setAttribute('width', String(size));
  root.setAttribute('height', String(size));
  root.setAttribute('fill', 'none');
  root.setAttribute('stroke', 'currentColor');
  root.setAttribute('stroke-width', '1.8');
  root.setAttribute('stroke-linecap', 'round');
  root.setAttribute('stroke-linejoin', 'round');
  // 图标是纯装饰，读屏软件不用念它（旁边的文字才是内容）
  root.setAttribute('aria-hidden', 'true');
  root.setAttribute('focusable', 'false');
  if (options.className) root.setAttribute('class', options.className);

  for (const shape of shapes) {
    const node = document.createElementNS(SVG_NS, shape.tag);
    for (const [key, value] of Object.entries(shape.attrs || {})) {
      node.setAttribute(key, String(value));
    }
    root.append(node);
  }

  return root;
}

/** 空态：一张纸 */
export function emptyIcon() {
  return svg([
    { tag: 'path', attrs: { d: 'M6 3h8l4 4v14H6z' } },
    { tag: 'path', attrs: { d: 'M14 3v4h4' } },
    { tag: 'path', attrs: { d: 'M9 12h6M9 16h4' } },
  ]);
}

/** 出错：圆圈里的感叹号 */
export function errorIcon() {
  return svg([
    { tag: 'circle', attrs: { cx: 12, cy: 12, r: 9 } },
    { tag: 'path', attrs: { d: 'M12 7.5v5' } },
    { tag: 'path', attrs: { d: 'M12 16.2v.1' } },
  ]);
}

/** 提醒：一个小铃铛 */
export function noticeIcon() {
  return svg([
    { tag: 'path', attrs: { d: 'M18 15V10a6 6 0 1 0-12 0v5l-1.5 2.5h15z' } },
    { tag: 'path', attrs: { d: 'M10 20a2 2 0 0 0 4 0' } },
  ]);
}

/** 加载中：一个沙漏 */
export function loadingIcon() {
  return svg([
    { tag: 'path', attrs: { d: 'M7 3h10M7 21h10' } },
    { tag: 'path', attrs: { d: 'M8 3c0 4 8 5 8 9s-8 5-8 9' } },
    { tag: 'path', attrs: { d: 'M16 3c0 4-8 5-8 9s8 5 8 9' } },
  ]);
}

/** 紧急：实心感叹号圆（已删除 —— 右下角浮动标记移除后没人再用它了） */

/**
 * 按名字取图标；找不到就返回 null（调用方自己决定要不要显示）。
 *
 * 注：原来还有一个 urgent（右下角"紧急公告"浮动标记用的实心感叹号圆）。
 * 那个浮动标记已经移除 —— 紧急公告现在由顶部「总栏目」标签上的红色条数表示，
 * 于是这个图标也没有人用了，整个删掉（不留死代码）。
 * 想恢复右下角标记的话，git 里能找回这个图标函数。
 *
 * @param {'empty'|'error'|'notice'|'loading'} name
 */
export function icon(name) {
  const table = {
    empty: emptyIcon,
    error: errorIcon,
    notice: noticeIcon,
    loading: loadingIcon,
  };
  const factory = table[name];
  return factory ? factory() : null;
}
