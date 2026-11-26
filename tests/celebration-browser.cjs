// Real-browser Playwright acceptance for the 14-day celebration Easter egg across light/dark and 320/390/1280px viewports.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.SIYUAN_PLAYWRIGHT_MODULE || 'playwright');

const ROOT = path.resolve(__dirname, '..');
const assetsDir = path.join(ROOT, 'php-site/assets');
const celebrationPhp = fs.readFileSync(path.join(ROOT, 'php-site/celebration.php'), 'utf8');

function extractNowdoc(php, fnName) {
  const match = php.match(new RegExp(`function ${fnName}\\(\\): string \\{\\s*return <<<'MD'\\r?\\n([\\s\\S]*?)\\r?\\nMD;`));
  if (!match) throw new Error(`Missing Markdown nowdoc in ${fnName}`);
  return match[1];
}

function renderFixtureMarkdown(md) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  let html = '';
  let inList = false;
  const closeList = () => { if (inList) { html += '</ul>\n'; inList = false; } };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { closeList(); continue; }
    if (/^---+$/.test(line)) { closeList(); html += '<hr />\n'; continue; }
    const h = line.match(/^(#{1,4})\s+(.+)$/);
    if (h) { closeList(); html += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>\n`; continue; }
    const li = line.match(/^[*+-]\s+(.+)$/);
    if (li) {
      if (!inList) { html += '<ul>\n'; inList = true; }
      html += `<li>${inline(li[1])}</li>\n`;
      continue;
    }
    closeList();
    html += `<p>${inline(line)}</p>\n`;
  }
  closeList();
  return html;
}

const zhHtml = renderFixtureMarkdown(extractNowdoc(celebrationPhp, 'celebration_changelog_zh_markdown'));
const enHtml = renderFixtureMarkdown(extractNowdoc(celebrationPhp, 'celebration_changelog_en_markdown'));

function buildHtml(preview) {
  const payload = JSON.stringify({
    campaignId: '2026-11-update',
    storageKey: 'sps:celebration:2026-11-update',
    cookieName: 'sps_celebration_202611',
    cookieMaxAge: 1209600,
    preview,
    range: '2026-10-22 – 2026-11-26',
    changelogZhHtml: zhHtml,
    changelogEnHtml: enHtml,
  }).replace(/</g, '\\u003C');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Celebration Acceptance</title>
  <link rel="stylesheet" href="/assets/reader-style.css">
  <link rel="stylesheet" href="/assets/celebration.css">
</head>
<body class="layout-share">
  <div class="share-page">
    <main class="kb-main" role="main">
      <h1 class="kb-title">Shared notebook</h1>
      <p>Welcome to the notes site.</p>
    </main>
  </div>
  <script type="application/json" id="sps-celebration-data">${payload}</script>
  <script defer src="/assets/celebration.js"></script>
</body>
</html>`;
}

const contrastAgainstBg = (fgColor, bgColor) => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d');
  const lum = (color) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const v = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).map((x) => {
      const c = x / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  };
  const f = lum(fgColor);
  const b = lum(bgColor);
  return (Math.max(f, b) + 0.05) / (Math.min(f, b) + 0.05);
};

(async () => {
  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url, 'http://127.0.0.1');
    if (reqUrl.pathname === '/assets/reader-style.css') {
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
      res.end(fs.readFileSync(path.join(assetsDir, 'reader-style.css')));
      return;
    }
    if (reqUrl.pathname === '/assets/celebration.css') {
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
      res.end(fs.readFileSync(path.join(assetsDir, 'celebration.css')));
      return;
    }
    if (reqUrl.pathname === '/assets/celebration.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end(fs.readFileSync(path.join(assetsDir, 'celebration.js')));
      return;
    }
    if (reqUrl.pathname === '/s/demo') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buildHtml(reqUrl.searchParams.get('celebration') === 'preview'));
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}/s/demo`;

  const browser = await chromium.launch({
    executablePath: process.env.SIYUAN_BROWSER_EXECUTABLE || undefined,
    headless: true,
  });

  const errors = [];
  try {
    // 1. Live Starlight Canvas animation -> automatic Phase 2 transition -> Continue -> Reload dedup
    {
      const context = await browser.newContext({ viewport: { width: 1280, height: 844 }, reducedMotion: 'no-preference' });
      context.on('page', (p) => p.on('pageerror', (e) => errors.push(e.message)));
      const page = await context.newPage();
      await page.goto(baseUrl);

      const overlay = page.locator('[data-sps-celebration]');
      await overlay.waitFor({ state: 'visible' });
      assert.equal(await page.locator('.sps-celebration-card').isVisible(), false, 'Phase 1 displays starfield before card');

      await page.waitForFunction(() => {
        const c = document.querySelector('.sps-celebration-canvas');
        if (!c || c.width === 0 || c.height === 0) return false;
        const probe = document.createElement('canvas');
        probe.width = 160;
        probe.height = 100;
        const pctx = probe.getContext('2d');
        pctx.drawImage(c, 0, 0, probe.width, probe.height);
        const data = pctx.getImageData(0, 0, probe.width, probe.height).data;
        let lit = 0;
        for (let i = 3; i < data.length; i += 4) {
          if (data[i] > 10) lit++;
        }
        return lit >= 8;
      }, null, { timeout: 3000 });

      await page.locator('.sps-celebration-card.is-visible').waitFor({ state: 'visible', timeout: 5000 });
      await page.locator('[data-celebration-continue]').click();
      await overlay.waitFor({ state: 'detached', timeout: 2000 });
      assert.equal(await page.evaluate(() => localStorage.getItem('sps:celebration:2026-11-update')), '1');

      await page.reload();
      await page.waitForLoadState('networkidle');
      assert.equal(await page.locator('[data-sps-celebration]').count(), 0, 'Does not replay after reload');

      await page.goto(baseUrl + '?celebration=preview');
      await page.locator('[data-sps-celebration]').waitFor({ state: 'visible' });
      await context.close();
    }

    // 2. Light & Dark x 320/390/1280px responsive, contrast, scrollability, drag-out guard & outside dismiss
    for (const colorScheme of ['light', 'dark']) {
      for (const width of [320, 390, 1280]) {
        const isMobile = width <= 390;
        const context = await browser.newContext({
          viewport: { width, height: 760 },
          colorScheme,
          reducedMotion: 'no-preference',
          hasTouch: isMobile,
          isMobile,
        });
        context.on('page', (p) => p.on('pageerror', (e) => errors.push(e.message)));
        const page = await context.newPage();
        await page.goto(baseUrl);

        const overlay = page.locator('[data-sps-celebration]');
        await overlay.waitFor({ state: 'visible' });
        await overlay.click({ position: { x: 20, y: 20 } }); // fast-forward Phase 1 -> Phase 2

        const card = page.locator('.sps-celebration-card.is-visible');
        await card.waitFor({ state: 'visible' });
        await card.evaluate((n) => Promise.all(n.getAnimations().map((a) => a.finished.catch(() => {}))));

        const overflowPhase2 = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
        assert.equal(overflowPhase2, false, `${colorScheme}/${width} Phase 2 has no horizontal overflow`);

        const continueBtn = page.locator('[data-celebration-continue]');
        const changelogBtn = page.locator('[data-celebration-changelog]');
        const continueBox = await continueBtn.boundingBox();
        const changelogBox = await changelogBtn.boundingBox();
        assert(continueBox && changelogBox);
        if (isMobile) {
          assert(continueBox.height >= 43.9 && changelogBox.height >= 43.9, `${colorScheme}/${width} mobile buttons >= 44px`);
          assert(continueBox.y < changelogBox.y, `${colorScheme}/${width} Continue button precedes View changelog`);
        } else {
          assert(continueBox.x < changelogBox.x, `${colorScheme}/${width} Continue button precedes View changelog`);
        }

        const contrasts = await page.evaluate((fnStr) => {
          const calc = eval(`(${fnStr})`);
          const c = document.querySelector('.sps-celebration-card');
          const cBg = getComputedStyle(c).backgroundColor;
          const t = getComputedStyle(c.querySelector('.sps-celebration-title')).color;
          const d = getComputedStyle(c.querySelector('.sps-celebration-desc')).color;
          const b1 = getComputedStyle(c.querySelector('[data-celebration-continue]'));
          const b2 = getComputedStyle(c.querySelector('[data-celebration-changelog]'));
          return {
            title: calc(t, cBg),
            desc: calc(d, cBg),
            continueBtn: calc(b1.color, b1.backgroundColor),
            changelogBtn: calc(b2.color, b2.backgroundColor),
          };
        }, contrastAgainstBg.toString());
        assert(contrasts.title >= 4.5, `${colorScheme}/${width} title contrast ${contrasts.title}`);
        assert(contrasts.desc >= 4.5, `${colorScheme}/${width} desc contrast ${contrasts.desc}`);
        assert(contrasts.continueBtn >= 4.5, `${colorScheme}/${width} Continue contrast ${contrasts.continueBtn}`);
        assert(contrasts.changelogBtn >= 4.5, `${colorScheme}/${width} View changelog contrast ${contrasts.changelogBtn}`);

        // Phase 3: View changelog
        await changelogBtn.click();
        const changelogWrap = page.locator('.sps-celebration-changelog-wrap.is-visible');
        await changelogWrap.waitFor({ state: 'visible' });
        await changelogWrap.evaluate((n) => Promise.all(n.getAnimations().map((a) => a.finished.catch(() => {}))));

        const overflowPhase3 = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
        assert.equal(overflowPhase3, false, `${colorScheme}/${width} Phase 3 has no horizontal overflow`);

        const phase3Metrics = await page.evaluate(() => {
          const box = document.querySelector('.sps-celebration-changelog-box');
          const body = document.querySelector('.sps-celebration-changelog-body');
          const hint = document.querySelector('[data-celebration-dismiss-hint]');
          const zh = body.querySelector('[lang="zh-CN"]');
          const sep = body.querySelector('.sps-celebration-lang-sep');
          const en = body.querySelector('[lang="en"]');
          const boxRect = box.getBoundingClientRect();
          const hintRect = hint.getBoundingClientRect();
          const zhRect = zh.getBoundingClientRect();
          const sepRect = sep.getBoundingClientRect();
          const enRect = en.getBoundingClientRect();
          return {
            scrollable: body.scrollHeight > body.clientHeight,
            boxWidthOk: boxRect.width <= window.innerWidth + 1,
            hintBelowBox: hintRect.top >= boxRect.bottom - 1,
            hintInsideViewport: hintRect.bottom <= window.innerHeight + 1,
            orderOk: zhRect.bottom <= sepRect.top + 2 && sepRect.bottom <= enRect.top + 2,
            hintText: hint.textContent,
          };
        });
        assert(phase3Metrics.scrollable, `${colorScheme}/${width} changelog scrolls vertically`);
        assert(phase3Metrics.boxWidthOk, `${colorScheme}/${width} changelog fits viewport width`);
        assert(phase3Metrics.hintBelowBox, `${colorScheme}/${width} hint sits below box bottom`);
        assert(phase3Metrics.hintInsideViewport, `${colorScheme}/${width} hint sits inside viewport`);
        assert(phase3Metrics.orderOk, `${colorScheme}/${width} Chinese precedes separator which precedes English`);
        assert.equal(phase3Metrics.hintText, isMobile ? 'Tap anywhere outside to continue' : 'Click anywhere outside to continue');

        // Drag-out protection: press inside changelog box, move to outside corner, release
        const boxBounds = await page.locator('.sps-celebration-changelog-box').boundingBox();
        await page.mouse.move(boxBounds.x + boxBounds.width / 2, boxBounds.y + boxBounds.height / 2);
        await page.mouse.down();
        await page.mouse.move(6, 6);
        await page.mouse.up();
        assert.equal(await overlay.count(), 1, `${colorScheme}/${width} drag-out does not close changelog`);

        // Genuine outside click closes and persists
        await page.mouse.click(6, 6);
        await overlay.waitFor({ state: 'detached', timeout: 2000 });
        assert.equal(await page.evaluate(() => localStorage.getItem('sps:celebration:2026-11-update')), '1');
        assert(await page.evaluate(() => document.cookie.includes('sps_celebration_202611=1')));

        await page.reload();
        await page.waitForLoadState('networkidle');
        assert.equal(await page.locator('[data-sps-celebration]').count(), 0, `${colorScheme}/${width} reload does not replay`);
        await context.close();
      }
    }

    assert.deepEqual(errors, []);
    console.log('Celebration browser acceptance passed: Starlight canvas pixels, Phase 1->2->3 transitions, light/dark 320/390/1280px, contrast, scrollability, drag-out guard & dedup.');
  } finally {
    await browser.close();
    server.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
