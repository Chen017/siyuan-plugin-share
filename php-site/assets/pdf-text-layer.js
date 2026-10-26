/* Unicode selection/search layer aligned to the browser's rendered text.
 * Page artwork stays in the existing image. Transparent Type 3 glyph boxes
 * provide ToUnicode mappings and measurable selection areas without visible ink.
 */
(() => {
  'use strict';
  const pause = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const hex = (number, width) => number.toString(16).padStart(width, '0');
  const utf16 = (text) => Array.from({ length: text.length }, (_, index) => hex(text.charCodeAt(index), 4)).join('');

  async function capture(container) {
    const origin = container.getBoundingClientRect();
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const segmenter = globalThis.Intl?.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
    const range = document.createRange();
    const records = [];
    let node;
    let measured = 0;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (!parent || parent.closest('.markdown-source, .pdf-doc-print, .katex-mathml, script, style, svg title, svg desc')) continue;
      const style = getComputedStyle(parent);
      if (style.visibility !== 'visible' || style.display === 'none') continue;
      const pieces = segmenter ? segmenter.segment(node.data) : Array.from(node.data, (segment) => ({ segment }));
      let offset = 0;
      for (const piece of pieces) {
        const text = piece.segment;
        range.setStart(node, offset);
        offset += text.length;
        range.setEnd(node, offset);
        const rect = range.getBoundingClientRect();
        if (!/[\r\n\t]/.test(text) && rect.width > 0.01 && rect.height > 0.01) {
          records.push({ text, x: rect.left - origin.left, y: rect.top - origin.top, width: rect.width, height: rect.height });
        }
        if (++measured % 1000 === 0) await pause();
      }
    }
    return records;
  }

  function write(pdf, records, geometry, registrationFont) {
    const glyphs = new Map();
    for (const record of records) if (!glyphs.has(record.text)) glyphs.set(record.text, glyphs.size);
    const values = Array.from(glyphs.keys());
    const fonts = new Map();
    // Reuse the small installed TTF for jsPDF registration. Its outline program
    // is replaced below, so body characters require no additional font download.
    pdf.addFileToVFS('pdf-selection.ttf', registrationFont);
    for (let start = 0; start < values.length; start += 255) {
      const name = `ShareSelectable${start / 255}`;
      pdf.addFont('pdf-selection.ttf', name, 'normal', 'StandardEncoding');
      const font = pdf.getFont(name, 'normal');
      fonts.set(font.id, values.slice(start, start + 255));
    }
    const ids = Array.from(fonts.keys());
    pdf.internal.events.subscribe('putFont', ({ font, newObject, out, putStream }) => {
      const chars = fonts.get(font.id);
      if (!chars) return;
      const emptyGlyph = newObject();
      // PDFium ignores empty glyphs during selection. A real glyph box with a
      // transparent text graphics state works in Chrome/Edge and other readers.
      putStream({ data: '1000 0 0 0 1000 1000 d1 0 0 1000 1000 re f' });
      out('endobj');
      const cmap = newObject();
      const mappings = [];
      for (let index = 0; index < chars.length; index += 100) {
        const group = chars.slice(index, index + 100);
        mappings.push(`${group.length} beginbfchar\n${group.map((char, offset) => `<${hex(index + offset + 1, 2)}> <${utf16(char)}>`).join('\n')}\nendbfchar`);
      }
      putStream({ data: `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /${font.id}-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<00> <FF>\nendcodespacerange\n${mappings.join('\n')}\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend` });
      out('endobj');
      font.objectNumber = newObject();
      out(`<< /Type /Font /Subtype /Type3 /Name /${font.id} /FontBBox [0 0 1000 1000] /FontMatrix [0.001 0 0 0.001 0 0] /FirstChar 0 /LastChar ${chars.length} /Widths [${Array(chars.length + 1).fill(1000).join(' ')}] /Encoding << /Type /Encoding /Differences [0 /.notdef ${chars.map((_, index) => `/g${index + 1}`).join(' ')}] >> /CharProcs << /.notdef ${emptyGlyph} 0 R ${chars.map((_, index) => `/g${index + 1} ${emptyGlyph} 0 R`).join(' ')} >> /Resources << >> /ToUnicode ${cmap} 0 R >>`);
      out('endobj');
      font.isAlreadyPutted = true;
    });
    const unit = pdf.internal.scaleFactor;
    pdf.__private__.setPdfVersion('1.4'); // Transparency and XMP metadata.
    const transparent = new pdf.GState({ opacity: 0, 'stroke-opacity': 0 });
    const mmPerPixel = geometry.width / geometry.pixelWidth;
    const pageHeight = pdf.internal.pageSize.getHeight() * unit;
    const number = (value) => value.toFixed(4);
    for (const record of records) {
      const page = Math.floor((record.y + record.height / 2) / geometry.pixelHeight);
      if (page < 0 || page >= pdf.getNumberOfPages()) continue;
      pdf.setPage(page + 1);
      const glyph = glyphs.get(record.text);
      const fontId = ids[Math.floor(glyph / 255)];
      const x = (14 + record.x * mmPerPixel) * unit;
      const y = pageHeight - (16 + (record.y - page * geometry.pixelHeight + record.height) * mmPerPixel) * unit;
      const size = record.height * mmPerPixel * unit;
      pdf.saveGraphicsState();
      pdf.setGState(transparent);
      pdf.internal.write(`BT /${fontId} ${number(size)} Tf 0 Tr ${number(record.width / record.height * 100)} Tz 1 0 0 1 ${number(x)} ${number(y)} Tm <${hex(glyph % 255 + 1, 2)}> Tj ET`);
      pdf.restoreGraphicsState();
    }
  }
  globalThis.SPSPdfTextLayer = { capture, write };
})();
