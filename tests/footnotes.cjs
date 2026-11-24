// Hover intent, pointer travel, pinning, keyboard focus and navigation cleanup.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM, VirtualConsole} = require('jsdom');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async condition => {
  const deadline = Date.now() + 1000;
  while (!condition()) { assert(Date.now() < deadline, 'Preview layout became ready'); await delay(10); }
};
const source = fs.readFileSync(path.join(__dirname, '../php-site/assets/app.js'), 'utf8');
const dom = new JSDOM(`<body class="layout-share"><div class="share-shell"><main class="kb-main"><div class="markdown-body" data-sps-rendered="1"><p>A definition<sup class="footnote-ref"><a href="#fn1">[1]</a></sup></p><section class="footnotes"><ol><li id="fn1"><p>A short but useful explanation. <a href="#fnref1" class="footnote-backref">↩</a></p></li></ol></section></div></main></div><a data-share-nav="doc" href="/s/book/next">Next</a></body>`, {url: 'https://reader.test/s/book/doc', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole()});
const w = dom.window, d = w.document;
w.matchMedia = q => ({matches: q.includes('hover: hover'), addEventListener() {}});
w.scrollTo = () => {};
w.HTMLElement.prototype.scrollIntoView = () => {};
w.HTMLElement.prototype.scrollTo = () => {};
w.fetch = async () => ({ok: true, json: async () => ({code: 0, data: {docId: 'next', title: 'Next', html: '<main class="kb-main"><h1 class="kb-title">Next</h1><div class="markdown-body" data-sps-rendered="1"></div></main>'}})});
const pointer = (target, type, relatedTarget = null) => {
  const event = new w.MouseEvent(type, {bubbles: true, relatedTarget});
  Object.defineProperty(event, 'pointerType', {value: 'mouse'});
  target.dispatchEvent(event);
};
(async () => {
  w.eval(source);
  await delay(60);
  const action = d.querySelector('.sps-footnote-action');
  assert(action);
  pointer(action, 'pointerover');
  await delay(100);
  pointer(action, 'pointerout', d.body);
  await delay(380);
  assert.equal(d.querySelectorAll('.sps-footnote-window').length, 0, 'Passing over a reference does not open a card');
  pointer(action, 'pointerover');
  d.dispatchEvent(new w.KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
  await delay(380);
  assert.equal(d.querySelectorAll('.sps-footnote-window').length, 0, 'Escape also cancels a preview that has not opened yet');
  pointer(action, 'pointerover');
  await delay(380);
  let card = d.querySelector('.sps-footnote-window');
  assert(card?.textContent.includes('A short but useful explanation.'));
  await until(() => card.style.height === 'auto');
  assert.equal(action.getAttribute('aria-expanded'), 'true');
  assert.equal(d.activeElement, d.body, 'Hover never steals keyboard focus');
  assert.equal(card.style.height, 'auto', 'Short notes do not receive a large empty fixed-height window');
  pointer(action, 'pointerout', card);
  pointer(card, 'pointerover', action);
  await delay(300);
  assert(card.isConnected, 'The pointer can cross the gap into the card');
  action.click();
  assert.equal(d.querySelectorAll('.sps-footnote-window').length, 1, 'Click reuses a card already opened by hover');
  card.querySelector('[aria-label="Pin"]').click();
  pointer(card, 'pointerout', d.body);
  await delay(450);
  assert(card.isConnected, 'Pinned cards survive mouse leave');
  card.querySelector('[aria-label="Unpin"]').click();
  card.querySelector('[aria-label="Close"]').click();
  await delay(210);
  assert(!card.isConnected);
  assert.equal(d.activeElement, action, 'Keyboard close returns focus to the reference');
  pointer(action, 'pointerover');
  await delay(380);
  card = d.querySelector('.sps-footnote-window');
  pointer(action, 'pointerout', card);
  pointer(card, 'pointerover', action);
  pointer(card, 'pointerout', d.body);
  await delay(450);
  assert(!card.isConnected, 'An unpinned hover card dismisses after leaving');
  pointer(action, 'pointerover');
  d.querySelector('[data-share-nav]').click();
  await delay(400);
  assert.equal(d.querySelectorAll('.sps-footnote-window').length, 0, 'Navigation cancels a pending hover preview');

  // Same-document block references: anchor normalization, hover preview, section extraction,
  // jump-to-block highlighting, and same-doc popstate without reload.
  let fetchCount = 0;
  let scrollTops = [];
  const blockDom = new JSDOM(`<body class="layout-share"><div class="share-shell"><main class="kb-main"><h1 class="kb-title">Orientation</h1><div class="markdown-body" data-sps-rendered="1"><h3 id="definition"><strong>Definition</strong> <span id="20261119083945-cy31h7h" class="sps-block-anchor"></span></h3><p>An orientation of a regular surface.</p><h3><strong>Next Heading</strong></h3><p>Should not appear in Definition preview.</p><p><span id="20261119095000-math111" style="display: none;"></span></p><div class="katex-block">F(q)=1</div><p>By <a href="#20261119083945-cy31h7h">definition of orientation</a> and <a href="#20261119095000-math111">formula</a>.</p></div></main></div></body>`, {url: 'https://reader.test/s/book/doc', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole()});
  const bw = blockDom.window, bd = bw.document;
  bw.matchMedia = q => ({matches: q.includes('hover: hover'), addEventListener() {}});
  bw.scrollTo = (opts) => { scrollTops.push(opts?.top ?? 0); };
  bw.HTMLElement.prototype.scrollIntoView = () => {};
  bw.HTMLElement.prototype.scrollTo = () => {};
  bw.fetch = async () => { fetchCount++; return {ok: true, json: async () => ({code: 0, data: {docId: 'doc', title: 'Orientation', html: '<main class="kb-main"></main>'}})}; };
  const bPointer = (target, type, relatedTarget = null) => {
    const event = new bw.MouseEvent(type, {bubbles: true, relatedTarget});
    Object.defineProperty(event, 'pointerType', {value: 'mouse'});
    target.dispatchEvent(event);
  };
  try {
    bw.eval(source);
    await delay(60);
    const hiddenSpan = bd.getElementById('20261119095000-math111');
    assert.notEqual(hiddenSpan.style.display, 'none', 'display: none is stripped from block anchors');
    assert(hiddenSpan.parentElement.classList.contains('sps-block-anchor-wrapper'), 'Standalone anchor wrapper is marked');

    const defLink = bd.querySelector('a[href="#20261119083945-cy31h7h"]');
    const defAction = defLink.nextElementSibling;
    assert(defAction?.classList.contains('sps-block-ref-action'), 'Same-doc block ref gets preview action button');

    bPointer(defLink, 'pointerover');
    await delay(380);
    const blockCard = bd.querySelector('.sps-footnote-window');
    assert(blockCard, 'Hovering over same-doc block link opens floating preview');
    assert(blockCard.textContent.includes('An orientation of a regular surface.'), 'Heading section body is included in preview');
    assert(!blockCard.textContent.includes('Should not appear'), 'Section preview stops at the next same-level heading');
    assert.equal(blockCard.querySelectorAll('[id="20261119083945-cy31h7h"], [id="definition"]').length, 0, 'Cloned preview strips duplicate block/heading IDs');

    const jumpBtn = blockCard.querySelector('[aria-label="Jump to block"]');
    assert(jumpBtn, 'Block reference preview includes Jump to block button');
    jumpBtn.click();
    assert(bd.getElementById('definition').classList.contains('sps-block-jump-highlight'), 'Jump highlights target heading block');
    assert.equal(bw.location.hash, '#20261119083945-cy31h7h');

    const mathLink = bd.querySelector('a[href="#20261119095000-math111"]');
    mathLink.click();
    assert(bd.querySelector('.katex-block').classList.contains('sps-block-jump-highlight'), 'Clicking math block ref jumps and highlights the following katex-block');
    assert.equal(bw.location.hash, '#20261119095000-math111');
    assert(scrollTops.length >= 2, 'scrollTo called on block jumps');

    bw.history.replaceState({}, '', 'https://reader.test/s/book/doc#20261119083945-cy31h7h');
    bw.dispatchEvent(new bw.PopStateEvent('popstate'));
    await delay(30);
    assert.equal(fetchCount, 0, 'Same-document popstate hash navigation never triggers a document fetch reload');
  } finally {
    bw.close();
  }
  console.log('Footnotes passed: hover delay/cancellation, pointer travel, adaptive height, click reuse, pinning, focus return, same-doc block ref preview/jump and navigation cleanup.');
})().finally(() => w.close()).catch(error => {console.error(error); process.exitCode = 1;});
