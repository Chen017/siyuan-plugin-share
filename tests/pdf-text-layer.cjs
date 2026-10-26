/* Exercise the production PDF writer; PDFium independently checks its output. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { jsPDF } = require('jspdf');
const output = process.argv[2];
fs.mkdirSync(output, { recursive: true });
const api = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../php-site/assets/pdf-text-layer.js'), 'utf8'), { globalThis: api, Intl });
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
