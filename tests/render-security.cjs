/* Exercise the actual vendored renderers in isolated, time-bounded processes. */
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const vendor = path.join(__dirname, '../php-site/assets/vendor');

if (process.argv[2] === 'markdown') {
  const md = require(path.join(vendor, 'markdown-it.min.js'))({ html: true, linkify: true, typographer: true });
  md.render('a://'.repeat(100000));
  md.render('[a]: /u "' + 'x\n'.repeat(200000));
  assert.match(md.render('# 中文标题\n\n**bold** and https://example.com'), /<h1>中文标题<\/h1>/);
  console.log('MARKDOWN_HANDLED');
} else if (process.argv[2] === 'mermaid') {
  const fs = require('node:fs');
  const { JSDOM, VirtualConsole } = require('jsdom');
  const dom = new JSDOM('<body></body>', { runScripts: 'outside-only', virtualConsole: new VirtualConsole() });
  const w = dom.window;
  w.matchMedia = () => ({ matches: false });
  w.structuredClone = structuredClone;
  w.eval(fs.readFileSync(path.join(vendor, 'mermaid.min.js'), 'utf8'));
  w.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
  w.mermaid.mermaidAPI.getDiagramFromText('gantt\n excludes monday,tuesday,wednesday,thursday,friday,saturday,sunday\n DoS :2025-01-01, 1d')
    .then(diagram => {
      try { diagram.db.getTasks(); } catch { /* Rejecting impossible dates is also safe. */ }
      console.log('GANTT_HANDLED');
      dom.window.close();
    }).catch(error => { console.error(error); dom.window.close(); process.exitCode = 1; });
} else {
  for (const [mode, marker] of [['markdown', 'MARKDOWN_HANDLED'], ['mermaid', 'GANTT_HANDLED']]) {
    const result = spawnSync(process.execPath, [__filename, mode], { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.error?.code, undefined, `${mode}: ${result.error}`);
    assert.equal(result.status, 0, `${mode}: ${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, new RegExp(marker));
  }
  console.log('Renderer regressions passed: pathological Markdown and Gantt inputs terminate.');
}
