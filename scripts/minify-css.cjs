/* Use the same clean-css engine as the former CLI without its unused glob/watch dependencies. */
const fs = require('node:fs');
const CleanCSS = require('clean-css');

for (const file of process.argv.slice(2)) {
  const result = new CleanCSS().minify([file]);
  for (const warning of result.warnings) console.warn(`${file}: ${warning}`);
  if (result.errors.length) throw new Error(`${file}: ${result.errors.join('; ')}`);
  fs.writeFileSync(file + '.min', result.styles);
  fs.renameSync(file + '.min', file);
}
