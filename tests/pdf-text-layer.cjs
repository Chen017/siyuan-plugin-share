/* Exercise the production PDF writer; PDFium independently checks its output. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { jsPDF } = require('jspdf');
const output = process.argv[2];
fs.mkdirSync(output, { recursive: true });
const api = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../php-site/assets/pdf-text-layer.js'), 'utf8'), { globalThis: api, Intl });
const lineRecords = [{ y: 20, height: 18 }, { y: 980, height: 25 }, { y: 1060, height: 18 }];
const planned = api.SPSPdfTextLayer.paginate(lineRecords, 1100, 1000);
assert.equal(planned[0].end, 979);
assert.equal(api.SPSPdfTextLayer.pageAt(planned, 992), 1);
for (const page of planned.slice(0, -1)) {
  assert.ok(lineRecords.every((record) => record.y >= page.end || record.y + record.height <= page.end), 'Never split a text line');
}
const objectPages = api.SPSPdfTextLayer.paginate([{ y: 20, height: 18 }], 1200, 1000, [{ top: 850, bottom: 1050 }]);
assert.equal(objectPages[0].end, 850, 'Keep a page-sized object together');
const rows = Array.from({ length: 12 }, (_, index) => ({ top: index * 120, bottom: (index + 1) * 120 }));
const tablePages = api.SPSPdfTextLayer.paginate([], 1440, 1000, rows);
assert.equal(tablePages[0].end, 960, 'Break long tables between adjacent rows');
const pdf = new jsPDF({ compress: true });
pdf.text('Visible reference', 14, 16);
fs.writeFileSync(path.join(output, 'baseline.pdf'), Buffer.from(pdf.output('arraybuffer')));
const samples = ['Selectable 中文 φ ψ p q 🙂 e\u0301', Array.from({ length: 320 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join(''), 'LAST_TEXT_MARKER'];
const records = [];
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
let row = 0;
for (const sample of samples) {
  let column = 0;
  for (const { segment } of segmenter.segment(sample)) {
    if (column === 50) { row++; column = 0; }
    records.push({ text: segment, x: column++ * 12, y: 30 + row * 28, width: 12, height: 20 });
  }
  row++;
}
api.SPSPdfTextLayer.write(pdf, records, { width: 182, pixelWidth: 687, pixelHeight: 1000 }, fs.readFileSync(path.join(__dirname, '../php-site/assets/vendor/fonts/pdf-provenance.ttf')).toString('base64'));
fs.writeFileSync(path.join(output, 'selectable.pdf'), Buffer.from(pdf.output('arraybuffer')));
fs.writeFileSync(path.join(output, 'expected.json'), JSON.stringify(samples));
