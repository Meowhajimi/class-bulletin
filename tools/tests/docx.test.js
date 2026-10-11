/**
 * web/js/ui/docx.js 的测试。
 *
 * 为什么需要：.docx 的 zip 容器和里面的 XML 都是手写的，
 * 一旦字节布局写错，Word 会直接报「内容有问题打不开」。
 * 所以这里自己写了一个只读 STORE 方式的 ZIP 解析器，
 * 把生成出来的文件拆开逐个字段校验（含 CRC32）。
 *
 * 运行：node --test "tools/tests/*.test.js"
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  blocksToDocumentXml,
  buildDocxBytes,
  crc32,
  escapeXml,
} from '../../web/js/ui/docx.js';

const decoder = new TextDecoder();

/** 手写一个只认 STORE（不压缩）的 ZIP 读取器，用来独立校验生成结果 */
function readStoredZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let endOfCentral = -1;
  for (let index = bytes.length - 22; index >= 0; index -= 1) {
    if (view.getUint32(index, true) === 0x06054b50) {
      endOfCentral = index;
      break;
    }
  }
  assert.notEqual(endOfCentral, -1, '找不到「中央目录结束」标记');

  const total = view.getUint16(endOfCentral + 10, true);
  const directorySize = view.getUint32(endOfCentral + 12, true);
  const directoryOffset = view.getUint32(endOfCentral + 16, true);

  const entries = [];
  let cursor = directoryOffset;
  for (let index = 0; index < total; index += 1) {
    assert.equal(view.getUint32(cursor, true), 0x02014b50, '中央目录条目标记不对');

    const method = view.getUint16(cursor + 10, true);
    const expectedCrc = view.getUint32(cursor + 16, true);
    const size = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));

    assert.equal(view.getUint32(localOffset, true), 0x04034b50, '本地文件头标记不对');
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = bytes.subarray(dataStart, dataStart + size);

    entries.push({ name, method, expectedCrc, size, data });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return { entries, directorySize, directoryOffset, total };
}

/* ================================ CRC32 ================================ */

test('crc32 与标准测试值一致', () => {
  // "123456789" 的 CRC32 是业界标准校验值 0xCBF43926
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array([])), 0);
});

/* ============================== XML 转义 ============================== */

test('escapeXml 转义特殊字符', () => {
  assert.equal(escapeXml('<标题> & "引号" \'单引号\''), '&lt;标题&gt; &amp; &quot;引号&quot; &apos;单引号&apos;');
});

test('escapeXml 丢掉会让 Word 报错的控制字符', () => {
  const dirty = `正常\u0000文字\u0007带\u001B控制符`;
  const cleaned = escapeXml(dirty);
  assert.equal(cleaned, '正常文字带控制符');
});

test('escapeXml 处理 null / undefined 不报错', () => {
  assert.equal(escapeXml(null), '');
  assert.equal(escapeXml(undefined), '');
});

/* ============================ 生成 docx 字节 ============================ */

test('生成的 docx 是一个结构正确的 zip', () => {
  const bytes = buildDocxBytes([
    { text: '班级公告栏', style: 'title' },
    { text: '正文内容', style: 'body' },
  ]);

  const { entries, total } = readStoredZip(bytes);

  assert.equal(total, 3, '应该正好三个部件');
  assert.deepEqual(
    entries.map((entry) => entry.name).sort(),
    ['[Content_Types].xml', '_rels/.rels', 'word/document.xml'].sort(),
  );

  for (const entry of entries) {
    assert.equal(entry.method, 0, `${entry.name} 应该是 STORE（不压缩）`);
    assert.equal(entry.data.length, entry.size, `${entry.name} 长度字段对不上`);
    assert.equal(
      crc32(entry.data),
      entry.expectedCrc,
      `${entry.name} 的 CRC32 对不上，说明字节写错了`,
    );
  }
});

test('三个部件的内容各自正确', () => {
  const { entries } = readStoredZip(buildDocxBytes([{ text: '标题', style: 'title' }]));
  const byName = Object.fromEntries(entries.map((entry) => [entry.name, decoder.decode(entry.data)]));

  assert.match(byName['[Content_Types].xml'], /wordprocessingml\.document\.main\+xml/);
  assert.match(byName['_rels/.rels'], /Target="word\/document\.xml"/);
  assert.match(byName['word/document.xml'], /<w:document /);
  assert.match(byName['word/document.xml'], /<w:body>/);
  assert.match(byName['word/document.xml'], /<w:sectPr>/);
  assert.match(byName['word/document.xml'], /<w:t xml:space="preserve">标题<\/w:t>/);
});

test('正文里的换行会拆成多个段落', () => {
  const xml = blocksToDocumentXml([{ text: '第一行\n第二行\n第三行', style: 'body' }]);
  assert.equal((xml.match(/<w:p>/g) || []).length, 3);
  assert.match(xml, /第一行/);
  assert.match(xml, /第三行/);
});

test('公告内容里的尖括号不会破坏 XML 结构', () => {
  const bytes = buildDocxBytes([{ text: '标题里写 <script> 和 & 符号', style: 'heading' }]);
  const { entries } = readStoredZip(bytes);
  const documentXml = decoder.decode(entries.find((e) => e.name === 'word/document.xml').data);

  assert.match(documentXml, /&lt;script&gt;/);
  assert.match(documentXml, /&amp; 符号/);
  assert.doesNotMatch(documentXml, /<script>/);
});

test('空文档也能生成（不会崩）', () => {
  const bytes = buildDocxBytes([]);
  const { entries } = readStoredZip(bytes);
  assert.equal(entries.length, 3);
});

test('各种样式都会带上对应的排版属性', () => {
  const xml = blocksToDocumentXml([
    { text: '大标题', style: 'title' },
    { text: '小标题', style: 'heading' },
    { text: '灰色说明', style: 'meta' },
    { text: '正文', style: 'body' },
  ]);

  assert.match(xml, /<w:jc w:val="center"\/>/, 'title 应该居中');
  assert.match(xml, /<w:b\/>/, '标题应该加粗');
  assert.match(xml, /<w:color w:val="808080"\/>/, 'meta 应该是灰色');
  assert.equal((xml.match(/<w:b\/>/g) || []).length, 2, '只有 title 和 heading 加粗');
});
