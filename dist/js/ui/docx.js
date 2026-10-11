/**
 * 零依赖生成 Word (.docx) 文件。
 *
 * 原理：.docx 就是一个 ZIP 压缩包，里面装着几个 XML 文件。
 * 所以这里手写了一个最小 ZIP 写入器（用"不压缩"方式存储），
 * 不需要 jszip / docx 之类的第三方库。
 *
 * 产出的文件结构（Word 能直接打开）：
 *   [Content_Types].xml   声明包里有哪几种文件
 *   _rels/.rels           指向主文档
 *   word/document.xml     正文
 *
 * ★ 想改备份文档的排版，改下面的 BLOCK_STYLES 和 blocksToDocumentXml 即可。
 */

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const CONTENT_TYPES = `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;

const ROOT_RELS = `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

/**
 * 每种段落样式对应的 Word 排版。
 *
 * 单位说明：
 *   · sz   半磅（21 = 10.5 磅）
 *   · space/spaceBefore/line  twips（240 = 1 行）
 *   · indent  twips（567 ≈ 1 厘米，所以 284 ≈ 0.5 厘米）
 */
const BLOCK_STYLES = {
  title: { size: 36, bold: true, align: 'center', space: 240 },
  // 每条公告的标题：比正文明显，上方留白拉开条目
  heading: { size: 30, bold: true, align: 'left', spaceBefore: 240, space: 80 },
  meta: { size: 18, color: '808080', align: 'left', space: 40 },
  /** 「正文：」这类小标签，和 meta 一样是灰色小字 */
  label: { size: 18, color: '808080', align: 'left', space: 40, spaceBefore: 120 },
  /** 正文：左缩进 + 1.5 倍行距，和灰色元信息明显区分开 */
  body: { size: 21, align: 'left', space: 80, indent: 284, line: 360 },
  gap: { size: 21, align: 'left', space: 120 },
  /** 条目之间的细分隔线（空段落 + 下边框） */
  divider: { size: 2, align: 'left', space: 200, border: 'D8DCE4' },
};

const encoder = new TextEncoder();

/** 转义 XML 特殊字符，并丢掉 XML 不允许的控制字符 */
export function escapeXml(text) {
  return String(text ?? '')
    // 控制字符（除换行/制表）在 XML 里非法，会让 Word 报"内容有问题"
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 拼出 <w:pPr> 的内容。
 *
 * ⚠️ OOXML 规定 pPr 的子元素必须按固定顺序出现，否则 Word 可能报错或忽略样式。
 * 顺序（本函数用到的部分）：pBdr → spacing → ind → jc。
 */
function paragraphProperties(spec) {
  const parts = [];

  if (spec.border) {
    parts.push(
      `<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="${spec.border}"/></w:pBdr>`,
    );
  }

  const spacing = [];
  if (spec.spaceBefore) spacing.push(`w:before="${spec.spaceBefore}"`);
  if (spec.space) spacing.push(`w:after="${spec.space}"`);
  if (spec.line) {
    spacing.push(`w:line="${spec.line}"`);
    // auto = 倍数行距（240 为单倍，360 为 1.5 倍）
    spacing.push(`w:lineRule="${spec.lineRule || 'auto'}"`);
  }
  if (spacing.length) parts.push(`<w:spacing ${spacing.join(' ')}/>`);

  if (spec.indent) {
    parts.push(`<w:ind w:left="${spec.indent}" w:right="${spec.indent}"/>`);
  }

  if (spec.align && spec.align !== 'left') parts.push(`<w:jc w:val="${spec.align}"/>`);

  return parts.join('');
}

/**
 * 拼出 <w:rPr> 的内容。
 *
 * ⚠️ 同样有顺序要求，本函数用到的顺序：b → color → sz → szCs。
 */
function runProperties(spec) {
  return [
    spec.bold ? '<w:b/>' : '',
    spec.color ? `<w:color w:val="${spec.color}"/>` : '',
    `<w:sz w:val="${spec.size}"/><w:szCs w:val="${spec.size}"/>`,
  ].join('');
}

/** 把一段文字渲染成 <w:p>；文字里的换行会拆成多个段落 */
function textToParagraphs(text, style) {
  const spec = BLOCK_STYLES[style] || BLOCK_STYLES.body;
  const lines = String(text ?? '').split('\n');
  const properties = paragraphProperties(spec);
  const runs = runProperties(spec);

  return lines
    .map(
      (line) =>
        `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ''}` +
        `<w:r><w:rPr>${runs}</w:rPr>` +
        `<w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`,
    )
    .join('');
}

/**
 * @typedef {Object} DocBlock
 * @property {string} text
 * @property {'title'|'heading'|'meta'|'label'|'body'|'gap'|'divider'} [style]
 */

/**
 * 把内容块渲染成 word/document.xml
 * @param {DocBlock[]} blocks
 */
export function blocksToDocumentXml(blocks) {
  const body = (blocks || []).map((block) => textToParagraphs(block.text, block.style)).join('');
  return (
    `${XML_HEADER}<w:document xmlns:w="${W_NS}"><w:body>${body}` +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
    '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>' +
    '</w:body></w:document>'
  );
}

/* ============================ 最小 ZIP 写入器 ============================ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/** 标准 CRC32（ZIP 每个条目都要带） */
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 打包成 ZIP（不压缩 / store 方式）。docx 允许不压缩，Word 照常打开。
 * @param {Array<{name: string, text: string}>} files
 * @returns {Uint8Array}
 */
export function buildZip(files) {
  /** @type {Uint8Array[]} */
  const chunks = [];
  /** @type {Uint8Array[]} */
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const dataBytes = encoder.encode(file.text);
    const crc = crc32(dataBytes);

    const local = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true); // 本地文件头标记
    localView.setUint16(4, 20, true); // 解压所需版本
    localView.setUint16(6, 0x0800, true); // 标志位：文件名用 UTF-8
    localView.setUint16(8, 0, true); // 压缩方式：0 = 不压缩
    localView.setUint16(10, 0, true); // 修改时间
    localView.setUint16(12, 0x21, true); // 修改日期（1980-01-01）
    localView.setUint32(14, crc, true);
    localView.setUint32(18, dataBytes.length, true);
    localView.setUint32(22, dataBytes.length, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    chunks.push(local, dataBytes);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true); // 中央目录标记
    centralView.setUint16(4, 20, true); // 创建版本
    centralView.setUint16(6, 20, true); // 解压所需版本
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, 0, true);
    centralView.setUint16(14, 0x21, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, dataBytes.length, true);
    centralView.setUint32(24, dataBytes.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint16(30, 0, true); // 扩展字段长度
    centralView.setUint16(32, 0, true); // 注释长度
    centralView.setUint16(34, 0, true); // 所在磁盘
    centralView.setUint16(36, 0, true); // 内部属性
    centralView.setUint32(38, 0, true); // 外部属性
    centralView.setUint32(42, offset, true); // 本地头偏移
    central.set(nameBytes, 46);
    centralParts.push(central);

    offset += local.length + dataBytes.length;
  }

  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true); // 中央目录结束标记
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);

  const total = offset + centralSize + end.length;
  const output = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of [...chunks, ...centralParts, end]) {
    output.set(chunk, cursor);
    cursor += chunk.length;
  }
  return output;
}

/* ============================== 对外接口 ============================== */

/**
 * 生成 .docx 的字节内容
 * @param {DocBlock[]} blocks
 * @returns {Uint8Array}
 */
export function buildDocxBytes(blocks) {
  return buildZip([
    { name: '[Content_Types].xml', text: CONTENT_TYPES },
    { name: '_rels/.rels', text: ROOT_RELS },
    { name: 'word/document.xml', text: blocksToDocumentXml(blocks) },
  ]);
}

/**
 * 生成 .docx 的 Blob，可直接交给下载
 * @param {DocBlock[]} blocks
 * @returns {Blob}
 */
export function buildDocxBlob(blocks) {
  return new Blob([buildDocxBytes(blocks)], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
}

/**
 * 触发浏览器下载。
 * @param {Blob} blob
 * @param {string} filename
 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  // 稍后再撤销，避免部分浏览器还没开始下载就被回收
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
