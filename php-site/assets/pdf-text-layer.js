/* Unicode selection/search layer aligned to the browser's rendered text.
 * Page artwork stays in the existing image. Transparent Type 3 glyph boxes
 * provide ToUnicode mappings and measurable selection areas without visible ink.
 */
(() => {
  'use strict';
  // Animation frames stop in background tabs; a timer keeps batch exports moving.
  const pause = () => new Promise((resolve) => setTimeout(resolve, 0));
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
      if (!parent || parent.closest('.markdown-source, .katex-mathml, script, style, svg title, svg desc')) continue;
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

  function protectFontMetrics(container) {
    const families = new Set();
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.data.trim() && node.parentElement) families.add(getComputedStyle(node.parentElement).fontFamily);
    }
    const style = document.createElement('style');
    const probe = document.createElement('span');
    const selector = 'body.pdf-export-preview > div[style*="visibility: hidden"]';
    // html2canvas creates font probes outside the formula/paragraph, then reads
    // their offsets synchronously. Protect exactly the font each probe requests;
    // changing only .katex leaves these probes vulnerable to extension CSS.
    style.textContent = Array.from(families, (family) => {
      probe.style.fontFamily = family;
      const requested = CSS.escape(`font-family: ${probe.style.fontFamily};`);
      return `${selector}[style*=${requested}] { font-family: ${family} !important; }`;
    }).join('\n') + `\n${selector}[style*="font-family:"] > span { font-family: inherit !important; }`;
    document.head.append(style);
    return () => style.remove();
  }

  // Use actual text boxes, not an arbitrary pixel row, as page boundaries.
  // The same offsets drive both image cropping and selectable text placement.
  function paginate(records, height, pageHeight, protectedRanges = [], forcedBreaks = []) {
    let lastInk = 0;
    const bands = new Map();
    const addRange = (top, bottom, padding = 1) => {
      lastInk = Math.max(lastInk, bottom);
      // Oversized objects may span pages; their individual text lines still
      // participate, so a long code block or table can break between lines.
      if (bottom - top + 2 * padding > pageHeight) return;
      top = Math.max(0, top - padding);
      // Most glyphs in a line share the same top. Coalesce before sorting to
      // avoid allocating/sorting another full array of character records.
      bands.set(top, Math.max(bands.get(top) || 0, bottom + padding));
    };
    for (const record of records) addRange(record.y, record.y + record.height);
    // Adjacent table rows share an edge: inflating them would join the entire
    // table into one unbreakable range. Text boxes retain their own 1px guard.
    for (const range of protectedRanges) addRange(range.top, range.bottom, 0);
    const intervals = Array.from(bands, ([top, bottom]) => ({ top, bottom }));
    intervals.sort((a, b) => a.top - b.top || a.bottom - b.bottom);
    const merged = [];
    for (const interval of intervals) {
      const previous = merged[merged.length - 1];
      if (previous && interval.top < previous.bottom) previous.bottom = Math.max(previous.bottom, interval.bottom);
      else merged.push({ ...interval });
    }
    const breaks = forcedBreaks.filter((value) => value > 0 && value < height).sort((a, b) => a - b);
    const pages = [];
    const contentHeight = Math.max(1, Math.min(Math.ceil(height), Math.ceil(lastInk + 2)));
    for (let start = 0; start < contentHeight;) {
      let end = Math.min(start + pageHeight, contentHeight);
      const forced = breaks.find((value) => value > start + 1 && value < end);
      if (forced !== undefined) end = Math.ceil(forced);
      if (end < contentHeight) {
        let low = 0, high = merged.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (merged[middle].top < end) low = middle + 1;
          else high = middle;
        }
        const crossing = merged[low - 1];
        if (crossing && crossing.bottom > end && crossing.top > start + 1) end = Math.floor(crossing.top);
      }
      pages.push({ start, end });
      start = end;
    }
    return pages;
  }

  function pageAt(pages, y) {
    let low = 0, high = pages.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (pages[middle].start <= y) low = middle + 1;
      else high = middle;
    }
    return low - 1;
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
      let page = Math.floor((record.y + record.height / 2) / geometry.pixelHeight);
      if (geometry.pages) page = pageAt(geometry.pages, record.y + record.height / 2);
      if (page < 0 || page >= pdf.getNumberOfPages()) continue;
      pdf.setPage(page + 1);
      const glyph = glyphs.get(record.text);
      const fontId = ids[Math.floor(glyph / 255)];
      const x = (14 + record.x * mmPerPixel) * unit;
      const start = geometry.pages ? geometry.pages[page].start : page * geometry.pixelHeight;
      const y = pageHeight - (16 + (record.y - start + record.height) * mmPerPixel) * unit;
      const size = record.height * mmPerPixel * unit;
      pdf.saveGraphicsState();
      pdf.setGState(transparent);
      pdf.internal.write(`BT /${fontId} ${number(size)} Tf 0 Tr ${number(record.width / record.height * 100)} Tz 1 0 0 1 ${number(x)} ${number(y)} Tm <${hex(glyph % 255 + 1, 2)}> Tj ET`);
      pdf.restoreGraphicsState();
    }
  }
  globalThis.SPSPdfTextLayer = { capture, protectFontMetrics, paginate, pageAt, write };
})();
