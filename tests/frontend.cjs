// Isolated DOM regression: no live notes, accounts, or network requests.
// NODE_PATH=/path/to/node_modules node tests/frontend.cjs (jsdom 26.1.0)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM, VirtualConsole} = require('jsdom');
const assets = path.join(__dirname, '../php-site/assets');
const app = fs.readFileSync(process.env.SPS_TEST_APP || path.join(assets, 'app.js'), 'utf8');
const escape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const core = ['markdown-it.min.js', 'markdown-it-task-lists.min.js',
  'markdown-it-emoji.min.js', 'markdown-it-footnote.min.js',
  'markdown-it-deflist.min.js', 'markdown-it-mark.min.js',
  'markdown-it-sub.min.js', 'markdown-it-sup.min.js', 'markdown-it-abbr.min.js',
  'markdown-it-ins.min.js', 'markdown-it-container.min.js',
  'markdown-it-anchor.min.js', 'katex.min.js', 'highlight.min.js'];
const main = raw => `<div class="kb-main" role="main"><div class="markdown-body" data-md-id="doc"></div><textarea class="markdown-source" data-md-id="doc">${escape(raw)}</textarea></div>`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(condition, message) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${message}`);
    await delay(20);
  }
}

async function page(raw, {failMermaid = false, slowGraphviz = false} = {}) {
  const dom = new JSDOM(`<body class="layout-share"><div class="share-shell"><aside data-share-sidebar><div data-share-tabs data-share-default="toc"><button data-share-tab="toc">目录</button></div><div data-share-panel="toc"><div data-share-toc="doc"></div></div></aside>${main(raw)}</div><a data-share-nav="doc" href="/s/test?doc=next">Next</a><script src="https://reader.test/assets/app.js?v=fixture"></script></body>`, {
    url: 'https://reader.test/s/test', runScripts: 'outside-only',
    pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
  });
  const w = dom.window;
  const errors = [];
  w.console.error = error => errors.push(error);
  w.scrollTo = () => {};
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.HTMLElement.prototype.scrollTo = () => {};
  w.matchMedia = () => ({matches: false, addEventListener() {}, addListener() {}});
  w.requestIdleCallback = fn => w.setTimeout(fn, 0);
  w.SVGElement.prototype.getBBox = () => ({x: 0, y: 0, width: 100, height: 50});
  for (const file of core) w.eval(fs.readFileSync(path.join(assets, 'vendor', file), 'utf8'));
  let renders = 0;
  const originalMd = w.markdownit;
  w.markdownit = function(...args) {
    const md = originalMd(...args), render = md.render.bind(md);
    md.render = (...params) => { renders++; return render(...params); };
    return md;
  };
  w.markdownit.prototype = originalMd.prototype;
  const requests = [];
  const events = [];
  const append = w.document.head.appendChild.bind(w.document.head);
  const svg = () => w.document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  w.document.head.appendChild = node => {
    const result = append(node);
    if (node.tagName !== 'SCRIPT') return result;
    const url = new URL(node.src), file = url.pathname.split('/').pop();
    assert.equal(url.origin, 'https://reader.test');
    assert.equal(url.searchParams.get('v'), 'fixture');
    requests.push(file);
    w.setTimeout(() => {
      switch (file) {
        case 'mermaid.min.js': w.mermaid = {initialize() {}, render: async () => { if (failMermaid) throw new Error('Synthetic renderer failure'); return {svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>diagram</text></svg>'}; }}; break;
        case 'pako.min.js': w.pako = {deflate: () => new Uint8Array([1, 2, 3])}; break;
        case 'echarts.min.js': w.echarts = {init: () => ({setOption() { events.push('echarts-rendered'); }, resize() {}})}; break;
        case 'abcjs-basic-min.js': w.ABCJS = {renderAbc: id => w.document.getElementById(id).appendChild(svg())}; break;
        case 'viz.js': w.Viz = function() {this.renderSVGElement = async () => svg();}; break;
        case 'full.render.js': events.push('graphviz-loaded'); assert(w.Viz, 'Viz wrapper loads first'); w.Viz.render = () => {}; w.Viz.Module = () => {}; break;
        case 'raphael.min.js': w.Raphael = () => {}; break;
        case 'flowchart.min.js': assert(w.Raphael, 'Raphael loads first'); w.flowchart = {parse: () => ({drawSVG: id => w.document.getElementById(id).appendChild(svg())})}; break;
        default: throw new Error(`Unexpected remote script: ${file}`);
      }
      node.onload();
    }, slowGraphviz && file === 'full.render.js' ? 250 : 0);
    return result;
  };
  w.eval(app);
  await waitFor(() => w.document.querySelector('.markdown-body')?.dataset.spsRendered === '1', 'initial note enhancement');
  return {w, requests, errors, events, renders: () => renders, close: () => w.close(),
    async navigate(next) {
      const before = renders;
      w.fetch = async () => ({ok: true, json: async () => ({code: 0, data: {html: main(next), title: 'Next note', docId: 'next'}})});
      w.document.querySelector('[data-share-nav]').click();
      await waitFor(() => renders > before &&
        w.document.querySelector('.markdown-body')?.dataset.spsRendered === '1', 'navigated note enhancement');
    }};
}

(async () => {
  const plain = await page('# 中文标题\n\nHello 0123 **bold** $x^2$ and [a link](https://example.com).\n\nFootnote[^1]\n\n[^1]: Details');
  try {
    assert.deepEqual(plain.requests, [], 'Ordinary math notes do not load diagram engines');
    assert(plain.w.document.querySelector('.katex'), 'Math still renders');
    assert.equal(plain.w.document.querySelector('[data-share-tab]').getAttribute('aria-pressed'), 'true');
    assert.equal(plain.w.document.querySelector('[data-share-tab]').hasAttribute('aria-selected'), false);
    const heading = plain.w.document.querySelector('.markdown-body h1');
    assert.equal(heading.id, '中文标题');
    assert.equal(heading.tabIndex, -1);
    plain.w.document.querySelector('.share-toc-link').click();
    assert.equal(plain.w.document.activeElement, heading, 'TOC moves keyboard focus to its real target');
    assert.equal(plain.w.document.querySelector('[data-viewer-download]').tagName, 'BUTTON');
    assert.equal(plain.renders(), 1);
    plain.w.dispatchEvent(new plain.w.Event('load'));
    plain.w.dispatchEvent(new plain.w.Event('sps:markdown-ready'));
    await delay(40);
    assert.equal(plain.renders(), 1, 'Late load events do not rebuild the note');
    await plain.navigate('```dot\ndigraph { A -> B }\n```');
    assert.deepEqual(plain.requests, ['viz.js', 'full.render.js']);
    assert(plain.w.document.querySelector('.md-diagram svg'), 'Diagram on a later note renders');
    await plain.navigate('```dot\ndigraph { C -> D }\n```');
    assert.equal(plain.requests.length, 2, 'Libraries are reused after navigation');
    assert.equal(plain.errors.length, 0, String(plain.errors));
  } finally { plain.close(); }

  const cases = [
    ['mermaid', 'graph LR\nA-->B', ['mermaid.min.js']],
    ['', 'graph LR\nA-->B', ['mermaid.min.js']],
    ['mindmap', '- Root\n  - Child', ['mermaid.min.js']],
    ['echarts', '{"series":[{"type":"bar","data":[1,2]}]}', ['echarts.min.js']],
    ['abc', 'X:1\nT:Test\nM:4/4\nK:C\nCDEF|', ['abcjs-basic-min.js']],
    ['graphviz', 'digraph { A -> B }', ['viz.js', 'full.render.js']],
    ['flowchart', 'st=>start: Start\ne=>end: End\nst->e', ['raphael.min.js', 'flowchart.min.js']],
    ['plantuml', '@startuml\nAlice -> Bob: hello\n@enduml', []],
  ];
  for (const [language, source, expected] of cases) {
    const fixture = await page('```' + language + '\n' + source + '\n```');
    try {
      assert.deepEqual(fixture.requests, expected, language || 'unlabelled Mermaid');
      assert.equal(fixture.renders(), 1);
      assert.equal(fixture.errors.length, 0, String(fixture.errors));
      assert(fixture.w.document.querySelector('.md-diagram, .mermaid'), `${language} is enhanced`);
      assert(Array.from(fixture.w.document.querySelectorAll('img')).every(image => !image.getAttribute('src') || image.src.startsWith('data:') || new URL(image.src).origin === fixture.w.location.origin), `${language}: diagram source never enters an external image URL`);
      if (language === 'plantuml') assert(fixture.w.document.querySelector('.md-diagram').textContent.includes(source));
    } finally { fixture.close(); }
  }
  const mixed = await page('```echarts\n{"series":[]}\n```\n\n```dot\ndigraph { A -> B }\n```', {slowGraphviz: true});
  try {
    assert(mixed.events.indexOf('echarts-rendered') >= 0);
    assert(mixed.events.indexOf('echarts-rendered') < mixed.events.indexOf('graphviz-loaded'), 'A slow graph library does not hold up ECharts');
    assert(mixed.w.document.querySelector('.md-diagram--graphviz svg'), 'Graphviz still completes');
  } finally { mixed.close(); }

  const failed = await page('```mermaid\ngraph LR\nA-->B\n```', {failMermaid: true});
  try {
    await waitFor(() => failed.w.document.querySelector('.md-diagram--mermaid pre'), 'local Mermaid failure fallback');
    assert(failed.w.document.querySelector('.md-diagram--mermaid').textContent.includes('A-->B'));
    assert.equal(failed.w.document.querySelector('.md-diagram--mermaid').querySelectorAll('img').length, 0);
  } finally { failed.close(); }
  // Validate the real bundled Graphviz exports as well as the loader fixtures.
  // This build attaches render/Module to Viz, not to the window object.
  const graphvizDom = new JSDOM('<body></body>', {runScripts: 'outside-only'});
  try {
    const w = graphvizDom.window;
    for (const file of ['viz.js', 'full.render.js']) w.eval(fs.readFileSync(path.join(assets, 'vendor', file), 'utf8'));
    assert.equal(typeof w.Viz.render, 'function');
    const svg = await new w.Viz().renderSVGElement('digraph { A -> B }');
    assert.equal(svg.tagName.toLowerCase(), 'svg');
  } finally { graphvizDom.window.close(); }
  console.log('Frontend passed: core math, Chinese TOC focus, button semantics, download control, single rendering, navigation, eight diagram loading cases and real Graphviz SVG rendering.');
})().catch(error => { console.error(error); process.exitCode = 1; });
