// Behavioral regression for reader navigation, local resume, search races and modal focus.
// NODE_PATH=/path/to/jsdom/node_modules node tests/reader-ui.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM, VirtualConsole} = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '../php-site/assets/app.js'), 'utf8');
const delay = (ms = 35) => new Promise(resolve => setTimeout(resolve, ms));
const main = (title = '笔记本', welcome = false) => `<main class="kb-main"><section class="share-article"><h1 class="kb-title">${title}</h1>${welcome ? '<div data-notebook-welcome><button data-reader-show-tree>展开文档树</button><a data-reader-resume hidden><span></span></a></div>' : '<div class="markdown-body" data-sps-rendered="1"><h2 id="chapter">Chapter</h2></div>'}</section></main>`;
function page({mobile = false, reduced = false, record, welcome = true, scanner = false} = {}) {
  const dom = new JSDOM(`<body class="layout-share"><header><button data-share-drawer-open>导航</button><span data-reader-mobile-title>笔记本</span></header><div class="share-shell" data-share-doc-id="${welcome ? '' : 'a'}"><aside class="kb-sidebar" data-share-sidebar data-share-slug="book"><div data-share-search><input data-share-search-input><button data-share-search-clear hidden>清除</button><div data-share-search-results hidden></div></div><div data-share-tabs data-share-default="tree"><button data-share-tab="tree">文档树</button><button data-share-tab="toc">目录</button></div><div data-share-panel="tree"><div class="kb-side-body"><ul><li class="kb-tree-node is-collapsed" data-tree-key="doc:a"><button class="kb-tree-toggle" aria-expanded="false">展开</button><a class="kb-tree-item" href="/s/book/a" data-doc-id="a" data-share-nav="doc">课程 A</a><ul class="kb-tree-children"><li><a class="kb-tree-item" href="/s/book/b" data-doc-id="b" data-share-nav="doc">课程 B</a></li></ul></li></ul></div></div><div data-share-panel="toc" hidden></div></aside>${main(welcome ? '笔记本' : '课程 A', welcome)}</div><footer class="share-footer"></footer><div data-share-drawer-close></div><p data-reader-status role="status"></p></body>`, {url: 'https://reader.test/s/book', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole()});
  const w = dom.window, errors = [];
  w.console.error = e => errors.push(e);
  w.matchMedia = q => ({matches: q.includes('reduced-motion') ? reduced : q.includes('max-width: 960px') && mobile, addEventListener() {}});
  w.HTMLElement.prototype.scrollTo = () => {};
  w.HTMLElement.prototype.scrollIntoView = function(options) { w.lastScrollBehavior = options?.behavior; };
  w.scrollTo = options => { w.lastScroll = options; };
  w.fetch = async () => { throw new Error('Unexpected fetch'); };
  if (record) w.localStorage.setItem('sps:reading:book', JSON.stringify(record));
  w.document.body.insertAdjacentHTML('beforeend', '<button data-scroll-top>Top</button><button data-user-create-open>Create</button><div class="modal" data-user-create-modal hidden><div class="modal-card"><button data-modal-close>Close</button><form></form></div></div>');
  if (scanner) w.document.body.insertAdjacentHTML('beforeend', '<form data-scan-form action="/admin/scan"><input name="csrf" value="fixture"><button type="submit">Scan</button></form><section data-scan-progress hidden><div class="scan-progress__bar"><span data-scan-bar></span></div><p data-scan-status></p><div data-scan-log></div></section>');
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
    p.doc.querySelector('.reader-drawer-close').click();
    p.w.fetch = async () => payload('课程 B');
    p.doc.querySelector('[data-reader-resume]').click();
    await delay(140);
    assert.equal(p.w.location.pathname, '/s/book/b');
    assert.equal(p.w.lastScroll.top, 640, 'Explicit resume restores the saved reading position');
    assert.equal(p.doc.activeElement.textContent, '课程 B');
    assert.equal(p.doc.querySelector('.kb-main').hasAttribute('aria-busy'), false);
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
    pending[0](payload('课程 A'));
    await delay();
    assert.equal(racing.doc.querySelector('.kb-main').getAttribute('aria-busy'), 'true', 'Old request cleanup cannot clear newer loading state');
    pending[1](payload('课程 B'));
    await delay();
    assert.equal(racing.doc.querySelector('.kb-title').textContent, '课程 B');
    assert.equal(racing.doc.querySelectorAll('.is-pending').length, 0);
    assert.equal(racing.doc.querySelector('.kb-main').hasAttribute('aria-busy'), false);
  } finally { racing.close(); }

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
    assert.equal(search.errors.length, 0);
  } finally { search.close(); }
  for (const reduced of [false, true]) {
    const overlay = page({reduced});
    try {
      const modal = overlay.doc.querySelector('[data-user-create-modal]');
      const open = overlay.doc.querySelector('[data-user-create-open]');
      open.click();
      modal.querySelector('button').click();
      if (reduced) assert(modal.hidden, 'Reduced Motion closes immediately');
      else {
        assert(modal.classList.contains('is-dismissing'));
        open.click();
        await delay(220);
        assert(!modal.hidden, 'Reopening cancels a stale dismissal timer');
      }
    } finally { overlay.close(); }
  }
  const scan = page({scanner: true});
  try {
    scan.w.fetch = async url => ({ok: true, json: async () => ({code: 0, data: url.endsWith('/start') ? {total: 4} : {nextOffset: 4, done: true, hitCount: 0, logs: []}})});
    scan.doc.querySelector('[data-scan-form]').dispatchEvent(new scan.w.Event('submit', {bubbles: true, cancelable: true}));
    await delay(60);
    assert.equal(scan.doc.querySelector('[data-scan-bar]').style.transform, 'scaleX(1)', 'Completed scan fills the progress track');
    assert.equal(scan.doc.querySelector('[data-scan-bar]').style.width, '', 'Scan progress does not animate layout width');
  } finally { scan.close(); }
  console.log('Reader UI passed: local resume, stale records, drawer focus/inert, navigation races, search cancellation, keyboard results and same-tab navigation.');
})().catch(error => { console.error(error); process.exitCode = 1; });
