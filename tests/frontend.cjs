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
  const compression = new JSDOM(`<body class="layout-app"><form class="settings-form"><input name="draft" value="saved"></form><section id="image-compression" data-status-url="/admin/images/status"><progress id="bg-task-progress-bar"></progress><p id="bg-task-progress-text"></p><p id="image-compression-connection"></p><span id="img-stat-total"></span><span id="img-stat-compressed"></span><span id="img-stat-pending"></span><span id="img-stat-saved"></span><button>Stop optimization</button></section></body>`, {url:'https://reader.test/admin',runScripts:'outside-only',pretendToBeVisual:true});
  try {
    const w = compression.window, polls = [], nativeTimeout = w.setTimeout.bind(w);
    w.setTimeout = (callback, delay, ...args) => delay === 3000 ? (polls.push(callback), 0) : nativeTimeout(callback, delay, ...args);
    let requests = 0, release;
    w.fetch = async (_url, options) => {
      requests++;
      assert.equal(options.cache,'no-store');
      return new Promise(resolve => {release=resolve;});
    };
    w.eval(app);
    const draft=w.document.querySelector('[name=draft]');draft.value='unsaved draft';draft.focus();
    assert.equal(polls.length,1);polls.shift()();assert.equal(requests,1);assert.equal(polls.length,0,'A slow request cannot overlap another poll');
    const status = state => ({ok:true,json:async()=>({data:{total_images:2,compressed_images:1,pending_images:1,saved_bytes:100,background_task:{status:state,total:2,checked:1}}})});
    release(status('running'));
    await waitFor(()=>polls.length===1,'running compression progress');
    assert(w.document.querySelector('#bg-task-progress-text').textContent.includes('Reviewed 1 / 2'));
    assert.equal(w.document.querySelector('#img-stat-saved').textContent,'100 bytes');
    w.fetch=async()=>{throw new Error('offline');};polls.shift()();
    await waitFor(()=>polls.length===1,'compression retry after network error');
    assert(w.document.querySelector('#image-compression-connection').textContent.includes('temporarily unavailable'));
    w.fetch=async()=>status('completed');polls.shift()();
    await waitFor(()=>w.document.querySelector('#bg-task-progress-text').textContent.includes('completed'),'terminal compression state');
    assert.equal(polls.length,0,'Completed tasks stop polling');
    assert.equal(draft.value,'unsaved draft');assert.equal(w.document.activeElement,draft,'Progress preserves settings and focus');
  } finally {compression.window.close();}

  const plain = await page('# 中文标题\n\nHello 0123 **bold** $x^2$ and [a link](https://example.com).\n\nFootnote[^1]\n\n[^1]: Details');
  try {
    assert.deepEqual(plain.requests, [], 'Ordinary math notes do not load diagram engines');
    assert(plain.w.document.querySelector('.katex'), 'Math still renders');
    assert(plain.w.document.querySelector('.katex math'), 'Generated mathematical semantics survive sanitization');
    assert(plain.w.document.querySelector('.katex annotation').textContent.includes('x^2'));
    assert.equal(plain.w.document.querySelector('.image-viewer').getAttribute('aria-modal'), 'true');
    assert.equal(plain.w.document.querySelector('[data-share-tab]').getAttribute('aria-pressed'), 'true');
    assert.equal(plain.w.document.querySelector('[data-share-tab]').hasAttribute('aria-selected'), false);
    const heading = plain.w.document.querySelector('.markdown-body h1');
    assert.equal(heading.id, '中文标题');
    assert.equal(heading.tabIndex, -1);
    plain.w.document.querySelector('.share-toc-link').click();
    assert.equal(plain.w.document.activeElement, heading, 'TOC moves keyboard focus to its real target');
    assert.equal(plain.w.document.querySelector('[data-viewer-download]').tagName, 'BUTTON');
    const picture = plain.w.document.createElement('img');
    picture.alt = 'Keyboard image'; picture.src = '/image.png';
    plain.w.document.querySelector('.markdown-body').append(picture);
    await delay(20);
    assert.equal(picture.tabIndex, 0);
    picture.focus();
    picture.dispatchEvent(new plain.w.KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
    const viewer = plain.w.document.querySelector('.image-viewer');
    const close = viewer.querySelector('button[data-viewer-close]');
    assert.equal(viewer.hidden, false);
    assert.equal(plain.w.document.activeElement, close);
    assert.equal(close.parentElement.className, 'image-viewer-ui');
    assert(viewer.querySelector('details [data-viewer-rotate-cw]'));
    assert.equal(viewer.querySelector('.image-viewer-thumb').getAttribute('aria-pressed'), 'true');
    const last = viewer.querySelector('.image-viewer-thumb'); last.focus();
    last.dispatchEvent(new plain.w.KeyboardEvent('keydown', {key: 'Tab', bubbles: true, cancelable: true}));
    assert.equal(plain.w.document.activeElement, close);
    close.click();
    await delay(250);
    assert.equal(plain.w.document.activeElement, picture);
    assert.equal(viewer.hidden, true);
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

  const boldMath = await page('## Plain heading\n\n## **Bold heading**\n\n- **$p_0 \\in x(A)$**: condition\n- **$x$**，next\n- **text $x$**: next\n- `$x$` and \\*\\*$x$\\*\\*');
  try {
    const body = boldMath.w.document.querySelector('.markdown-body');
    const items = body.querySelectorAll('li');
    for (const item of Array.from(items).slice(0, 3)) {
      assert(item.querySelector('strong .katex'), 'Bold math renders inside emphasis');
      assert(!item.textContent.includes('**'), 'Emphasis markers are not displayed');
    }
    assert(body.querySelector('code').textContent.includes('$x$'), 'Code remains literal');
    assert(body.lastElementChild.textContent.includes('**'), 'Escaped markers remain literal');
  } finally { boldMath.close(); }

  const curlyMath = await page(String.raw`The frame satisfies $\begin{cases}e_1'=\kappa e_2\\e_2'=-\kappa e_1+\tau e_3\\e_3'=-\tau e_2\end{cases}$.`);
  try {
    const body=curlyMath.w.document.querySelector('.markdown-body');
    const delimiter=body.querySelector('.delimsizing.mult');
    assert.equal(delimiter.querySelectorAll('svg').length,1,'Markdown sanitization keeps the single curly SVG');
    assert(delimiter.querySelector('path').getAttribute('d').endsWith(' Z'),'The complete continuous outline survives sanitization');
    assert(!delimiter.querySelector('.delimsizinginner'),'No font pieces remain in the large brace');
    assert(curlyMath.w.document.querySelector('.markdown-source').value.includes('cases'),'The original formula source remains intact');
  } finally { curlyMath.close(); }

  const images = await page([
    '<img src="/assets/sized.png" style="width: 400px; height: 300px" onerror="alert(1)">',
    '<img src="/assets/width.png" style="width: 280px">',
    '<img src="/assets/small.png" width="120">',
    '<img src="/assets/relative.png" style="width: 50%; height: 200px">',
    '![square](/assets/square.png)',
    '![emoji](/emojis/smile.png)',
  ].join('\n\n'));
  try {
    const image = name => images.w.document.querySelector(`.markdown-body img[src$="/${name}.png"]`);
    const sized = image('sized');
    assert.equal(sized.style.width, '400px');
    assert.equal(sized.style.height, '300px');
    assert.equal(sized.style.aspectRatio, '400 / 300');
    assert(!sized.hasAttribute('onerror'), 'Image event handlers are removed');
    assert(sized.hasAttribute('data-sps-sized-pair'));
    assert(image('width').hasAttribute('data-sps-sized-image'));
    assert(image('small').hasAttribute('data-sps-sized-image'));
    assert(!image('relative').hasAttribute('data-sps-sized-pair'), 'Relative sizes are not treated as pixel pairs');
    assert(!image('square').hasAttribute('data-sps-sized-image'), 'Unsized images keep their default styling');
    assert(!image('smile').hasAttribute('data-sps-sized-image'), 'Emoji keep their own styling');
    image('width').dispatchEvent(new images.w.Event('error'));
    assert.equal(images.w.document.querySelector('.missing-attachment').textContent, 'Attachment not found');
    assert(!image('width'), 'A broken image is replaced by a quiet notice');
    image('square').click();
    assert.equal(images.w.document.querySelector('[data-viewer-img]').src, 'https://reader.test/assets/square.png', 'Viewer uses the original image');
    await images.navigate('<img src="/assets/new.png" style="width: 240px">');
    const next = image('new');
    assert(next.hasAttribute('data-sps-sized-image'), 'Newly navigated notes preserve their explicit sizes');
  } finally { images.close(); }

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
  const untrustedMath = await page('<math><mtext>UNTRUSTED_MATH</mtext></math>\n\n<span data-sps-trusted-math="fake">FAKE_PLACEHOLDER</span>\n\n$x^2$');
  try {
    assert.equal(untrustedMath.w.document.querySelectorAll('math').length, 1, 'Only generated mathematical content enters the page');
    assert(!untrustedMath.w.document.querySelector('.markdown-body').textContent.includes('FAKE_PLACEHOLDER'));
    assert.equal(untrustedMath.w.document.querySelector('.katex math').querySelector('annotation').textContent, 'x^2');
  } finally { untrustedMath.close(); }
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
