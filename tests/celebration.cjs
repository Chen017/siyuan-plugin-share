// Behavioral regression for the 14-day celebration Easter egg (jsdom).
// NODE_PATH=/path/to/jsdom/node_modules node tests/celebration.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const celebrationJs = fs.readFileSync(path.join(__dirname, '../php-site/assets/celebration.js'), 'utf8');
const celebrationPhp = fs.readFileSync(path.join(__dirname, '../php-site/celebration.php'), 'utf8');

function extractNowdoc(php, fnName) {
  const escaped = fnName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = php.match(new RegExp(`function ${escaped}\\(\\): string \\{\\s*return <<<'MD'\\r?\\n([\\s\\S]*?)\\r?\\nMD;`));
  assert(match, `Missing Markdown nowdoc in ${fnName}`);
  return match[1];
}

function renderFixtureMarkdown(md) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  let html = '';
  let inList = false;
  const closeList = () => {
    if (inList) {
      html += '</ul>\n';
      inList = false;
    }
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      closeList();
      continue;
    }
    if (/^---+$/.test(line)) {
      closeList();
      html += '<hr />\n';
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.+)$/);
    if (h) {
      closeList();
      html += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>\n`;
      continue;
    }
    const li = line.match(/^[*+-]\s+(.+)$/);
    if (li) {
      if (!inList) {
        html += '<ul>\n';
        inList = true;
      }
      html += `<li>${inline(li[1])}</li>\n`;
      continue;
    }
    closeList();
    html += `<p>${inline(line)}</p>\n`;
  }
  closeList();
  return html;
}

const zhMarkdown = extractNowdoc(celebrationPhp, 'celebration_changelog_zh_markdown');
const enMarkdown = extractNowdoc(celebrationPhp, 'celebration_changelog_en_markdown');

function makePayload(overrides = {}) {
  return {
    campaignId: '2026-11-update',
    storageKey: 'sps:celebration:2026-11-update',
    cookieName: 'sps_celebration_202611',
    cookieMaxAge: 1209600,
    preview: false,
    range: '2026-10-22 – 2026-11-26',
    changelogZhHtml: renderFixtureMarkdown(zhMarkdown),
    changelogEnHtml: renderFixtureMarkdown(enMarkdown),
    ...overrides,
  };
}

function createDom({ payload = makePayload(), reduced = false, coarse = false, cookie = '', storageValue = null, mockCanvas = false, beforeEval } = {}) {
  const json = JSON.stringify(payload).replace(/</g, '\\u003C');
  const dom = new JSDOM(
    `<!doctype html><html lang="en"><body><header id="hdr"><button id="prev-focus">Nav</button></header><main id="main-content"><p>Hello</p></main><script type="application/json" id="sps-celebration-data">${json}</script></body></html>`,
    { url: 'https://reader.test/s/book', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole() },
  );
  const w = dom.window;
  const errors = [];
  w.console.error = (err) => errors.push(err);
  if (cookie) w.document.cookie = cookie;
  if (storageValue !== null) w.localStorage.setItem(payload.storageKey, storageValue);
  w.matchMedia = (q) => ({
    matches: (q.includes('reduced-motion') && reduced) || (q.includes('pointer: coarse') && coarse),
    addEventListener() {},
  });
  Object.defineProperty(w, 'innerWidth', { value: coarse ? 390 : 1280, configurable: true });
  Object.defineProperty(w, 'innerHeight', { value: 844, configurable: true });
  w.document.getElementById('prev-focus').focus();

  if (mockCanvas) {
    const noop = () => {};
    const fakeGrad = () => ({ addColorStop: noop });
    w.HTMLCanvasElement.prototype.getContext = function getContext() {
      return {
        setTransform: noop,
        clearRect: noop,
        save: noop,
        restore: noop,
        translate: noop,
        beginPath: noop,
        closePath: noop,
        moveTo: noop,
        lineTo: noop,
        quadraticCurveTo: noop,
        arc: noop,
        fill: noop,
        stroke: noop,
        createLinearGradient: fakeGrad,
        createRadialGradient: fakeGrad,
      };
    };
  }

  beforeEval?.(w);
  w.eval(celebrationJs);
  return { w, doc: w.document, errors, close: () => w.close() };
}

(() => {
  // 1. Server configuration constants & Markdown sources sanity
  assert.match(celebrationPhp, /CELEBRATION_START_AT\s*=\s*'2026-11-26 00:00:00'/);
  assert.match(celebrationPhp, /CELEBRATION_END_AT\s*=\s*'2026-12-10 23:59:59'/);
  assert.match(celebrationPhp, /CELEBRATION_COOKIE_MAX_AGE\s*=\s*1209600/);
  assert(zhMarkdown.includes('更新概览（2026-10-22 – 2026-11-26）'));
  assert(zhMarkdown.includes('128 个'));
  assert(zhMarkdown.includes('288 DPI 高清与可选文字'));
  assert(zhMarkdown.includes('### 5. 省略更多细节优化...'));
  assert(enMarkdown.includes('Update Overview (2026-10-22 – 2026-11-26)'));
  assert(enMarkdown.includes('128'));
  assert(enMarkdown.includes('288 DPI crisp rendering & selectable text'));
  assert(enMarkdown.includes('### 5. And many more subtle refinements...'));

  // 2. Reduced-motion / fallback enters Phase 2 immediately, verifies English UI, button order, inert isolation, and Continue dismissal
  {
    let timers = [];
    const env = createDom({
      reduced: true,
      beforeEval(w) {
        w.setTimeout = (fn) => {
          timers.push(fn);
          return timers.length;
        };
      },
    });
    try {
      const overlay = env.doc.querySelector('[data-sps-celebration]');
      assert(overlay, 'Overlay is mounted on first visit');
      assert(env.doc.documentElement.classList.contains('sps-celebration-open'));
      assert.equal(env.doc.getElementById('hdr').inert, true);
      assert.equal(env.doc.getElementById('main-content').inert, true);

      const card = overlay.querySelector('.sps-celebration-card');
      assert.equal(card.hidden, false);
      assert.equal(card.querySelector('.sps-celebration-title').textContent, 'Notes Site Updated');
      assert.equal(
        card.querySelector('.sps-celebration-desc').textContent,
        'After a month of updates, the notes site is now complete. Welcome to explore.',
      );

      const buttons = [...card.querySelectorAll('button')];
      assert.equal(buttons.length, 2);
      assert.equal(buttons[0].textContent, 'Continue (shown once)');
      assert(buttons[0].classList.contains('sps-celebration-btn--continue'));
      assert.equal(buttons[1].textContent, 'View changelog');
      assert(buttons[1].classList.contains('sps-celebration-btn--changelog'));
      for (const btn of buttons) {
        assert.doesNotMatch(btn.textContent, /[\u3400-\u9fff]/, 'Celebration buttons must remain English');
      }

      buttons[0].click();
      assert.equal(env.w.localStorage.getItem('sps:celebration:2026-11-update'), '1');
      assert(env.doc.cookie.includes('sps_celebration_202611=1'));
      assert.equal(env.doc.querySelector('[data-sps-celebration]'), null, 'Reduced motion dismisses immediately');
      assert.equal(env.doc.documentElement.classList.contains('sps-celebration-open'), false);
      assert.equal(env.doc.getElementById('hdr').inert, false);
      assert.equal(env.doc.getElementById('main-content').inert, false);
      assert.equal(env.doc.activeElement, env.doc.getElementById('prev-focus'));
      assert.deepEqual(env.errors, []);
    } finally {
      env.close();
    }
  }

  // 3. Deduplication prevents replay when localStorage OR cookie is present
  for (const state of [{ storageValue: '1' }, { cookie: 'sps_celebration_202611=1' }]) {
    const env = createDom(state);
    try {
      assert.equal(env.doc.querySelector('[data-sps-celebration]'), null, `Seen state skips celebration: ${JSON.stringify(state)}`);
      assert.equal(env.doc.documentElement.classList.contains('sps-celebration-open'), false);
      assert.deepEqual(env.errors, []);
    } finally {
      env.close();
    }
  }

  // 4. Phase 1 Starlight Canvas animation -> automatic Phase 2 transition + click-to-skip + clean RAF cancellation
  {
    const scheduled = [];
    const cleared = new Set();
    let rafQueue = [];
    let cancelledRafs = [];
    let nowMs = 1000;
    const env = createDom({
      mockCanvas: true,
      beforeEval(w) {
        w.performance.now = () => nowMs;
        w.requestAnimationFrame = (fn) => {
          rafQueue.push({ id: rafQueue.length + 1, fn });
          return rafQueue.length;
        };
        w.cancelAnimationFrame = (id) => cancelledRafs.push(id);
        w.setTimeout = (fn, ms) => {
          const id = scheduled.length + 1;
          scheduled.push({ id, fn, ms, at: nowMs + ms });
          return id;
        };
        w.clearTimeout = (id) => cleared.add(id);
      },
    });
    try {
      const overlay = env.doc.querySelector('[data-sps-celebration]');
      const card = overlay.querySelector('.sps-celebration-card');
      const canvas = overlay.querySelector('.sps-celebration-canvas');
      assert.equal(card.hidden, true, 'Phase 1 hides prompt card until animation finishes');
      assert(canvas.width > 0 && canvas.height > 0, 'Canvas initialized to viewport');

      // Pump a couple animation frames
      nowMs += 400;
      const frame1 = rafQueue.shift();
      frame1.fn(nowMs);
      assert(overlay.classList.contains('is-starfield'));

      // Fire the 2500ms Phase 1 -> Phase 2 timer
      const phase2Timer = scheduled.find((t) => t.ms === 2500 && !cleared.has(t.id));
      assert(phase2Timer, '2500ms phase transition timer scheduled');
      nowMs = phase2Timer.at;
      phase2Timer.fn();

      assert.equal(card.hidden, false, 'Phase 2 card appears after starfield fade');
      assert.equal(overlay.classList.contains('is-starfield'), false);
      assert(canvas.classList.contains('is-fading'));

      // Fire +750ms cleanup timer to stop RAF and release canvas
      const stopTimer = scheduled.find((t) => t.ms === 750 && !cleared.has(t.id));
      assert(stopTimer);
      stopTimer.fn();
      assert(cancelledRafs.length > 0, 'RAF cancelled after canvas fade');
      assert.equal(canvas.width, 0);
      assert.equal(canvas.height, 0);
      assert.deepEqual(env.errors, []);
    } finally {
      env.close();
    }
  }

  // 5. Phase 1 click fast-forwards to Phase 2
  {
    let nowMs = 0;
    const env = createDom({
      mockCanvas: true,
      beforeEval(w) {
        w.performance.now = () => nowMs;
        w.requestAnimationFrame = () => 1;
        w.cancelAnimationFrame = () => {};
        w.setTimeout = () => 1;
        w.clearTimeout = () => {};
      },
    });
    try {
      const overlay = env.doc.querySelector('[data-sps-celebration]');
      const card = overlay.querySelector('.sps-celebration-card');
      assert.equal(card.hidden, true);
      overlay.click();
      assert.equal(card.hidden, false, 'Clicking overlay during Phase 1 advances to Phase 2');
      assert.deepEqual(env.errors, []);
    } finally {
      env.close();
    }
  }

  // 6. Phase 3 Bilingual Markdown Changelog, order, drag-out guard, click-outside/hint dismissal, coarse pointer hint, Escape, and preview non-persistence
  {
    const timers = [];
    const env = createDom({
      reduced: true,
      coarse: true,
      payload: makePayload({ preview: true }),
      beforeEval(w) {
        w.setTimeout = (fn) => {
          timers.push(fn);
          return timers.length;
        };
      },
    });
    try {
      const overlay = env.doc.querySelector('[data-sps-celebration]');
      overlay.querySelector('[data-celebration-changelog]').click();

      // Preview mode must not write localStorage or cookie
      assert.equal(env.w.localStorage.getItem('sps:celebration:2026-11-update'), null);
      assert.equal(env.doc.cookie.includes('sps_celebration_202611=1'), false);

      const wrap = overlay.querySelector('.sps-celebration-changelog-wrap');
      const box = overlay.querySelector('.sps-celebration-changelog-box');
      const body = overlay.querySelector('.sps-celebration-changelog-body');
      const hint = overlay.querySelector('[data-celebration-dismiss-hint]');
      assert.equal(wrap.hidden, false);
      assert.equal(overlay.querySelector('.sps-celebration-card').hidden, true);
      assert.equal(hint.textContent, 'Tap anywhere outside to continue');

      const zh = body.querySelector('.sps-celebration-md[lang="zh-CN"]');
      const sep = body.querySelector('.sps-celebration-lang-sep');
      const en = body.querySelector('.sps-celebration-md[lang="en"]');
      assert(zh && sep && en);
      assert.equal(sep.textContent.trim(), 'English');
      assert(zh.compareDocumentPosition(sep) & env.w.Node.DOCUMENT_POSITION_FOLLOWING, 'Separator follows Chinese');
      assert(sep.compareDocumentPosition(en) & env.w.Node.DOCUMENT_POSITION_FOLLOWING, 'English follows separator');

      // Verify Markdown actually rendered into semantic HTML tags
      assert(zh.querySelectorAll('h3').length >= 5);
      assert(zh.querySelectorAll('ul > li').length >= 12);
      assert(zh.querySelector('strong'));
      assert(zh.querySelector('hr'));
      assert(en.querySelectorAll('h3').length >= 5);
      assert(en.querySelectorAll('ul > li').length >= 12);
      assert(en.querySelector('strong'));
      assert(en.querySelector('hr'));

      // Drag-out protection: pointerdown inside box -> click outside overlay must NOT close
      zh.dispatchEvent(new env.w.Event('pointerdown', { bubbles: true }));
      overlay.dispatchEvent(new env.w.MouseEvent('click', { bubbles: true }));
      assert(env.doc.querySelector('[data-sps-celebration]'), 'Dragging from inside box to outside must not dismiss');

      // Direct outside pointerdown + click on hint dismisses cleanly
      hint.dispatchEvent(new env.w.Event('pointerdown', { bubbles: true }));
      hint.dispatchEvent(new env.w.MouseEvent('click', { bubbles: true }));
      assert.equal(env.doc.querySelector('[data-sps-celebration]'), null, 'Clicking hint outside box dismisses');
      assert.equal(env.w.localStorage.getItem('sps:celebration:2026-11-update'), null, 'Preview dismiss does not persist');
      assert.deepEqual(env.errors, []);
    } finally {
      env.close();
    }
  }

  // 7. Non-preview View changelog -> blank-area click & Escape persistence
  {
    const env = createDom({ reduced: true });
    try {
      const overlay = env.doc.querySelector('[data-sps-celebration]');
      assert.equal(overlay.querySelector('[data-celebration-dismiss-hint]').textContent, 'Click anywhere outside to continue');
      overlay.querySelector('[data-celebration-changelog]').click();
      assert.equal(env.w.localStorage.getItem('sps:celebration:2026-11-update'), '1');
      assert(env.doc.cookie.includes('sps_celebration_202611=1'));
      overlay.dispatchEvent(new env.w.Event('pointerdown', { bubbles: true }));
      overlay.dispatchEvent(new env.w.MouseEvent('click', { bubbles: true }));
      assert.equal(env.doc.querySelector('[data-sps-celebration]'), null, 'Clicking blank backdrop dismisses');
      assert.deepEqual(env.errors, []);
    } finally {
      env.close();
    }
  }

  {
    const env = createDom({ reduced: true });
    try {
      env.doc.dispatchEvent(new env.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      assert.equal(env.doc.querySelector('[data-sps-celebration]'), null, 'Escape dismisses Phase 2');
      assert.equal(env.w.localStorage.getItem('sps:celebration:2026-11-update'), '1');
      assert(env.doc.cookie.includes('sps_celebration_202611=1'));
      assert.deepEqual(env.errors, []);
    } finally {
      env.close();
    }
  }

  console.log('Celebration regression passed: Phase 1 starlight canvas, Phase 2 English UI, Phase 3 bilingual Markdown changelog, drag-out guard, dedup & preview mode.');
})();
