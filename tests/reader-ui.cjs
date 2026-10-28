// Behavioral regression for reader navigation, local resume, search races and modal focus.
// NODE_PATH=/path/to/jsdom/node_modules node tests/reader-ui.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM, VirtualConsole} = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '../php-site/assets/app.js'), 'utf8');
const delay = (ms = 35) => new Promise(resolve => setTimeout(resolve, ms));
const main = (title = '笔记本', welcome = false) => `<main class="kb-main"><section class="share-article"><h1 class="kb-title">${title}</h1>${welcome ? '<div data-notebook-welcome><button data-reader-show-tree>展开文档树</button><a data-reader-resume hidden><span></span></a></div>' : '<button data-share-toggle aria-pressed="false"><svg aria-hidden="true"></svg><span data-share-toggle-label>Source</span></button><textarea class="markdown-source" readonly aria-label="Markdown source">## Chapter</textarea><div class="markdown-body" data-sps-rendered="1"><h2 id="chapter">Chapter</h2></div>'}</section></main>`;
function page({mobile = false, reduced = false, record, welcome = true, beforeEval} = {}) {
  const dom = new JSDOM(`<body class="layout-share"><header><button data-share-drawer-open>导航</button><span data-reader-mobile-title>笔记本</span></header><div class="reader-frame"><div class="share-shell" data-share-doc-id="${welcome ? '' : 'a'}"><aside class="kb-sidebar" data-share-sidebar data-share-slug="book"><div data-share-search><input data-share-search-input><button data-share-search-clear hidden>清除</button><div data-share-search-results hidden></div></div><div data-share-tabs data-share-default="tree"><button data-share-tab="tree">文档树</button><button data-share-tab="toc">目录</button></div><div data-share-panel="tree"><div class="kb-side-body"><ul><li class="kb-tree-node is-collapsed" data-tree-key="doc:a"><button class="kb-tree-toggle" aria-expanded="false">展开</button><a class="kb-tree-item" href="/s/book/a" data-doc-id="a" data-share-nav="doc">课程 A</a><ul class="kb-tree-children"><li><a class="kb-tree-item" href="/s/book/b" data-doc-id="b" data-share-nav="doc">课程 B</a></li></ul></li></ul></div></div><div data-share-panel="toc" hidden></div></aside>${main(welcome ? '笔记本' : '课程 A', welcome)}</div><footer class="share-footer"></footer></div><div data-share-drawer-close></div><p data-reader-status role="status"></p></body>`, {url: 'https://reader.test/s/book', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole()});
  const w = dom.window, errors = [];
  w.surfaceAnimations = [];
  w.HTMLElement.prototype.animate = function(frames, options) {
    const animation = {element: this, frames, options, cancel() { this.cancelled = true; this.oncancel?.(); }};
    w.surfaceAnimations.push(animation);
    return animation;
  };
  w.console.error = e => errors.push(e);
  w.matchMedia = q => ({matches: q.includes('reduced-motion') ? reduced : q.includes('min-width: 961px') ? !mobile : q.includes('max-width: 960px') && mobile, addEventListener() {}});
  w.HTMLElement.prototype.scrollTo = () => {};
  w.HTMLElement.prototype.scrollIntoView = function(options) { w.lastScrollBehavior = options?.behavior; };
  w.scrollTo = options => { w.lastScroll = options; };
  w.fetch = async () => { throw new Error('Unexpected fetch'); };
  if (record) w.localStorage.setItem('sps:reading:book', JSON.stringify(record));
  w.document.body.insertAdjacentHTML('beforeend', '<button data-scroll-top>Top</button>');
  beforeEval?.(w);
  w.eval(source);
  return {w, doc: w.document, errors, close: () => w.close()};
}
const payload = title => ({ok: true, json: async () => ({code: 0, data: {html: main(title), docId: title === '课程 A' ? 'a' : 'b', title}})});
(async () => {
  const p = page({mobile: true, record: {id: 'b', y: 640, time: Date.now()}});
  try {
    assert.equal(p.doc.querySelector('[data-reader-resume]').hidden, false);
    assert.equal(p.doc.querySelector('[data-reader-resume]').textContent.trim(), '课程 B');
    const sidebar = p.doc.querySelector('aside'), open = p.doc.querySelector('[data-share-drawer-open]');
    assert(sidebar.inert, 'Closed mobile navigation cannot receive focus');
    open.click();
    assert.equal(sidebar.getAttribute('aria-modal'), 'true');
    assert.equal(p.doc.activeElement.getAttribute('aria-label'), 'Close navigation');
    assert(p.doc.querySelector('.kb-main').inert, 'Modal drawer isolates the reading area');
    p.doc.dispatchEvent(new p.w.KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
    assert(sidebar.inert);
    assert.equal(p.doc.activeElement, open, 'Dismiss returns focus to its trigger');
    p.doc.querySelector('[data-reader-show-tree]').click();
    assert.equal(open.getAttribute('aria-expanded'), 'true');
    assert(p.doc.activeElement.matches('.kb-tree-item, .kb-tree-toggle'), 'Browse focuses the document tree');
    assert(!p.doc.activeElement.matches('[data-share-search-input]'));
    p.doc.querySelector('.reader-drawer-close').click();
    p.w.fetch = async () => payload('课程 B');
    p.doc.querySelector('[data-reader-resume]').click();
    await delay(140);
    assert.equal(p.w.location.pathname, '/s/book/b');
    assert.equal(p.w.lastScroll.top, 640, 'Explicit resume restores the saved reading position');
    assert.equal(p.doc.activeElement.textContent, '课程 B');
    assert.equal(p.doc.querySelector('.kb-main').hasAttribute('aria-busy'), false);
    assert.equal(p.doc.querySelector('[data-doc-id=b]').getAttribute('aria-current'), 'page');
    assert(!p.doc.querySelector('.share-shell').classList.contains('is-navigating'), 'Fast navigation never flashes a loading bar');
    assert.equal(p.doc.querySelector('[data-reader-mobile-title]').textContent, '课程 B');
    assert.equal(p.errors.length, 0);
  } finally { p.close(); }

  for (const record of [{id: 'missing', y: 0, time: Date.now()}, {id: 'a', y: 0, time: Date.now() - 31 * 86400000}]) {
    const stale = page({record});
    assert(stale.doc.querySelector('[data-reader-resume]').hidden, 'Deleted and expired reading records are ignored');
    stale.close();
  }
  const racing = page({welcome: false});
  try {
    const pending = [];
    racing.w.fetch = () => new Promise(resolve => pending.push(resolve));
    racing.doc.querySelector('[data-doc-id=a]').click();
    racing.doc.querySelector('[data-doc-id=b]').click();
    await delay(270);
    assert(racing.doc.querySelector('.share-shell').classList.contains('is-navigating'), 'Slow navigation gives visible feedback while retaining readable content');
    pending[0](payload('课程 A'));
    await delay();
    assert.equal(racing.doc.querySelector('.kb-main').getAttribute('aria-busy'), 'true', 'Old request cleanup cannot clear newer loading state');
    pending[1](payload('课程 B'));
    await delay();
    assert.equal(racing.doc.querySelector('.kb-title').textContent, '课程 B');
    assert.equal(racing.doc.querySelectorAll('.is-pending').length, 0);
    assert.equal(racing.doc.querySelector('.kb-main').hasAttribute('aria-busy'), false);
    assert(!racing.doc.querySelector('.share-shell').classList.contains('is-navigating'));
    const toggle = racing.doc.querySelector('[data-share-toggle]');
    toggle.click();
    assert.equal(toggle.getAttribute('aria-pressed'), 'true');
    assert.equal(toggle.textContent, 'Preview');
    assert(toggle.querySelector('svg'), 'Source switching preserves its icon');
    toggle.click();
    assert.equal(toggle.textContent, 'Source');
    assert.equal(toggle.getAttribute('aria-pressed'), 'false');
    assert(racing.w.surfaceAnimations.length > 0);
    assert(racing.w.surfaceAnimations.every(animation => animation.frames.every(frame => Object.keys(frame).every(key => ['opacity', 'transform'].includes(key)))), 'Surface motion does not animate layout dimensions');
  } finally { racing.close(); }

  let automaticPositions = 0;
  const lateRender = page({welcome:false, beforeEval(w) {
    const pane = w.document.querySelector('.kb-side-body');
    const link = pane.querySelector('.kb-tree-item'); link.classList.add('is-active');
    Object.defineProperty(pane, 'clientHeight', {value:200});
    pane.getBoundingClientRect = () => ({top:100,bottom:300});
    link.getBoundingClientRect = () => ({top:600,bottom:636});
    pane.scrollTo = options => { automaticPositions++; pane.scrollTop = options.top; assert.equal(options.behavior,'auto'); };
  }});
  try {
    assert.equal(automaticPositions,1,'Initial document is revealed without animation');
    const pane=lateRender.doc.querySelector('.kb-side-body'); pane.scrollTop=380;
    lateRender.w.dispatchEvent(new lateRender.w.Event('sps:markdown-ready'));
    await delay(70);
    assert.equal(automaticPositions,1,'Late Markdown readiness cannot recenter a manually scrolled document tree');
    assert.equal(pane.scrollTop,380);
  } finally { lateRender.close(); }

  const resize = page();
  try {
    const divider = resize.doc.querySelector('[data-reader-sidebar-resizer]');
    assert(divider && !divider.hidden);
    divider.dispatchEvent(new resize.w.KeyboardEvent('keydown', {key:'ArrowRight',bubbles:true}));
    assert(resize.doc.cookie.includes('sps_reader_sidebar_width=272'));
    assert.equal(resize.doc.querySelector('.reader-frame').style.getPropertyValue('--sidebar-width'),'272px');
    divider.dispatchEvent(new resize.w.KeyboardEvent('keydown', {key:'Home',bubbles:true}));
    assert(resize.doc.cookie.includes('sps_reader_sidebar_width=256'));
    divider.dispatchEvent(new resize.w.KeyboardEvent('keydown', {key:'ArrowLeft',bubbles:true}));
    assert(resize.doc.cookie.includes('sps_reader_sidebar_collapsed=1'));
    assert(resize.doc.querySelector('.kb-sidebar').inert);
    assert(divider.hidden);
    resize.doc.querySelector('[data-reader-sidebar-reopen]').click();
    assert(!resize.doc.querySelector('.kb-sidebar').inert);
    assert(!divider.hidden);
    assert(!resize.doc.cookie.includes('sps_reader_sidebar_collapsed'));
    divider.dispatchEvent(new resize.w.KeyboardEvent('keydown', {key:'Enter',bubbles:true}));
    assert(!resize.doc.cookie.includes('sps_reader_sidebar_width'));
    assert.equal(resize.doc.querySelector('.reader-frame').style.getPropertyValue('--sidebar-width'),'');
  } finally { resize.close(); }
  const search = page({mobile: true, reduced: true});
  try {
    const input = search.doc.querySelector('input'), results = search.doc.querySelector('[data-share-search-results]');
    let finish;
    search.w.fetch = () => new Promise(resolve => { finish = resolve; });
    input.value = 'primitive'; input.dispatchEvent(new search.w.Event('input', {bubbles: true}));
    await delay(330);
    search.doc.querySelector('[data-share-search-clear]').click();
    finish({ok: true, json: async () => ({code: 0, data: {results: [{title: 'Stale', snippet: '$x^2$', docId: 'a'}]}})});
    await delay();
    assert(results.hidden, 'Clearing search invalidates responses already in flight');
    assert.equal(results.textContent, '');
    search.w.fetch = async () => ({ok: true, json: async () => ({code: 0, data: {results: [{title: 'Primitive', snippet: 'Proof $x^2$ **text**', docId: 'a'}]}})});
    input.value = 'primitive'; input.dispatchEvent(new search.w.Event('input', {bubbles: true}));
    await delay(350);
    const link = results.querySelector('a');
    assert(link && !link.hasAttribute('target'), 'Results preserve current-tab navigation');
    assert(!link.textContent.includes('$x^2$'), 'Search snippets do not expose math delimiters');
    input.dispatchEvent(new search.w.KeyboardEvent('keydown', {key: 'ArrowDown', bubbles: true}));
    assert(link.classList.contains('is-keyboard-active'));
    search.w.fetch = async () => payload('课程 A');
    input.dispatchEvent(new search.w.KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
    await delay();
    assert.equal(search.doc.querySelector('.kb-title').textContent, '课程 A');
    assert.equal(search.w.location.search, '?highlight=primitive');
    search.doc.querySelector('[data-scroll-top]').click();
    assert.equal(search.w.lastScroll.behavior, 'auto', 'Reduced Motion also disables JavaScript smooth scrolling');
    assert.equal(search.w.surfaceAnimations.length, 0, 'Reduced Motion skips all custom surface animations');
    assert.equal(search.errors.length, 0);
  } finally { search.close(); }
  console.log('Reader UI passed: local resume, stale records, drawer focus/inert, navigation races, search cancellation, keyboard results and same-tab navigation.');
})().catch(error => { console.error(error); process.exitCode = 1; });
