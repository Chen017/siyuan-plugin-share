// Keep the reader stylesheet in sync with the shared stylesheet while omitting
// the contiguous administrator-only section. Shared reader rules follow it.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'php-site/assets/style.css'), 'utf8');
const begin = source.indexOf('/* Forms retained by the administrator-only site. */');
const end = source.indexOf('.sps-footnote-window {', begin);
if (begin < 0 || end < 0) throw new Error('Cannot identify administrator stylesheet section');
const reader = source.slice(0, begin) + source.slice(end);
const output = path.join(root, 'php-site/assets/reader-style.css');
if (process.argv.includes('--check')) {
  if (!fs.existsSync(output) || fs.readFileSync(output, 'utf8') !== reader) throw new Error('Run node scripts/build-reader-css.cjs');
} else fs.writeFileSync(output, reader);
