/* Real-browser regression: navigation, individual downloads, CAPTCHA and task ownership. */
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require(process.env.SIYUAN_PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const [shareUrl, output] = process.argv.slice(2);
  const fixture = JSON.parse(fs.readFileSync(0, 'utf8'));
  const browser = await chromium.launch({ executablePath: process.env.SIYUAN_BROWSER_EXECUTABLE || undefined, headless: true });
  const base = new URL(shareUrl).origin;
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, acceptDownloads: true });
  const errors = [];
  const giveCookie = (ctx) => ctx.addCookies([{ name: 'sps_pdf_visitor', value: fixture.visitorCookie, url: base, httpOnly: true, sameSite: 'Lax' }]);
  const release = (page) => page.evaluate(async () => {
    const d = document.querySelector('[data-pdf-preview]').dataset;
    await fetch(d.exportUrl + '/release', { method: 'POST', body: new URLSearchParams({ csrf: d.csrf, lease: d.lease }) });
  });
  const openPreview = async (ctx, scope) => {
    const controls = await ctx.newPage();
    await controls.goto(shareUrl + '/export');
    await controls.locator('[data-pdf-scope]').selectOption(scope);
    if (scope === 'selected') {
      for (const box of await controls.locator('[name="doc_ids[]"]').all()) await box.check();
    }
    const next = ctx.waitForEvent('page');
    await controls.locator('[data-pdf-export-form] button[type=submit]').click();
    const preview = await next;
    preview.on('pageerror', (error) => errors.push(error.message));
    await preview.waitForLoadState();
    await preview.waitForFunction(() => document.querySelector('[data-pdf-download]')?.disabled === false, null, { timeout: 45000 });
    return preview;
  };
  const downloadPdfs = async (preview, count, label) => {
    const downloads = [];
    const listener = (download) => downloads.push(download);
    preview.on('download', listener);
    await preview.locator('[data-pdf-download]').click();
    try {
      await preview.waitForFunction(() => document.querySelector('[data-pdf-status]').textContent.includes('已逐篇触发'), null, { timeout: 120000 });
    } catch (error) {
      throw new Error(`${label}: ${await preview.locator('[data-pdf-status]').textContent()}; ${error.message}`);
    }
    const until = Date.now() + 10000;
    while (downloads.length < count && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(downloads.length, count, 'One download per document');
    assert.equal(new Set(downloads.map((d) => d.suggestedFilename())).size, count);
    for (let i = 0; i < downloads.length; i++) {
      assert.equal(await downloads[i].failure(), null);
      assert.match(downloads[i].suggestedFilename(), /\.pdf$/i);
      const saved = path.join(output, label + '-' + (i + 1) + '.pdf');
      await downloads[i].saveAs(saved);
      const bytes = fs.readFileSync(saved);
      assert.ok(bytes.length > 5000, 'PDF contains rendered content');
      assert.equal((bytes.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length, 1, 'No empty trailing page');
    }
    preview.off('download', listener);
    await release(preview);
  };
  try {
    await giveCookie(context);
    const reader = await context.newPage();
    await reader.goto(shareUrl);
    assert.equal(await reader.locator('[data-pdf-export-link]').count(), 0);
    const openDocument = async (id) => {
      await reader.locator('a[data-share-nav="doc"][data-doc-id="' + id + '"]').first().click();
      await reader.waitForFunction((docId) => document.querySelector('.share-shell')?.dataset.shareDocId === docId, id);
    };
    await openDocument(fixture.docIds[0]);
    assert.equal(await reader.locator('.kb-title-row .share-document-actions [data-pdf-export-link]').count(), 1);
    await openDocument(fixture.docIds[1]);
    assert.equal(new URL(await reader.locator('[data-pdf-export-link]').getAttribute('href'), base).searchParams.get('doc'), fixture.docIds[1]);
    await reader.locator('[data-share-toggle]').click();
    assert.equal(await reader.locator('.share-article.is-markdown [data-pdf-export-link]').count(), 1);
    await reader.locator('[data-share-toggle]').click();
    await reader.locator('a[data-share-nav="doc"][data-doc-id=""]').first().click();
    await reader.waitForFunction(() => document.querySelector('.share-shell')?.dataset.shareDocId === '');
    assert.equal(await reader.locator('[data-pdf-export-link]').count(), 0);
    await openDocument(fixture.docIds[0]);
    const title = reader.locator('.kb-title');
    const originalTitle = await title.textContent();
    await title.evaluate((n) => { n.textContent = '10.21 Functional completeness and Boolean Constants'; });
    for (const width of [1100, 390]) {
      await reader.setViewportSize({ width, height: 900 });
      const source = await reader.locator('[data-share-toggle]').boundingBox();
      const pdf = await reader.locator('[data-pdf-export-link]').boundingBox();
      assert.ok(Math.abs(source.y - pdf.y) < 1 && Math.abs(source.height - pdf.height) < 1);
      assert.ok(pdf.x + pdf.width <= width);
      await reader.screenshot({ path: path.join(output, 'reader-pdf-actions-' + width + '.png') });
    }
    await reader.setViewportSize({ width: 1100, height: 900 });
    await title.evaluate((n, value) => { n.textContent = value; }, originalTitle);
    const first = await openPreview(context, 'all');
    assert.equal(await first.locator('.pdf-doc').count(), 2);
    assert.ok(await first.locator('.katex').count() >= 2);
    assert.equal(await first.locator('.markdown-body table').count(), 1);
    assert.ok(await first.locator('.mermaid svg').count() >= 1);
    assert.equal(await first.locator('.markdown-body img').evaluateAll((imgs) => imgs.every((i) => i.complete && i.naturalWidth > 0)), true);
    const blocked = await context.request.post(shareUrl + '/export', { headers: { Accept: 'application/json' }, form: {
      csrf: await first.locator('[data-pdf-preview]').getAttribute('data-csrf'), fingerprint: 'b'.repeat(64), scope: 'all',
    } });
    assert.equal(blocked.status(), 429);
    await downloadPdfs(first, 2, 'individual-light');
    for (const scenario of [
      { name: 'dark', scope: 'single', count: 1, viewport: { width: 1100, height: 900 } },
      { name: 'mobile', scope: 'selected', count: 2, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
      { name: 'tree', scope: 'tree', count: 1, viewport: { width: 1100, height: 900 } },
    ]) {
      const extra = await browser.newContext({ viewport: scenario.viewport, colorScheme: 'dark', isMobile: scenario.isMobile, hasTouch: scenario.hasTouch, acceptDownloads: true });
      try {
        await giveCookie(extra);
        const preview = await openPreview(extra, scenario.scope);
        const color = await preview.locator('.markdown-body').first().evaluate((n) => ({ background: getComputedStyle(n).backgroundColor, color: getComputedStyle(n).color }));
        assert.deepEqual(color, { background: 'rgb(255, 255, 255)', color: 'rgb(31, 35, 40)' });
        await downloadPdfs(preview, scenario.count, 'individual-' + scenario.name);
      } finally { await extra.close(); }
    }
    const native = await openPreview(context, 'all');
    await native.evaluate(() => { window.print = () => { window.__printed = true; }; });
    await native.locator('[data-pdf-native-print]').nth(1).click();
    await native.waitForFunction(() => window.__printed === true);
    const nativePdf = await native.pdf({ path: path.join(output, 'native-single.pdf'), preferCSSPageSize: true, printBackground: true });
    assert.equal((nativePdf.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length, 1);
    await release(native);
    const revoked = await openPreview(context, 'single');
    let unexpected = false;
    revoked.on('download', () => { unexpected = true; });
    const accessUrl = base + '/api/v1/shares/access/update';
    try {
      assert.equal((await context.request.post(accessUrl, { headers: { 'X-Api-Key': fixture.apiKey }, data: { shareId: fixture.shareId, password: 'Revoked-Preview-Pass!' } })).status(), 200);
      await revoked.locator('[data-pdf-download]').click();
      await revoked.waitForFunction(() => document.querySelector('.pdf-document').children.length === 0);
      assert.equal(unexpected, false);
    } finally {
      await context.request.post(accessUrl, { headers: { 'X-Api-Key': fixture.apiKey }, data: { shareId: fixture.shareId, clearPassword: true } });
      await release(revoked);
    }
    const suspicious = await browser.newContext({ viewport: { width: 1100, height: 900 } });
    try {
      const page = await suspicious.newPage();
      await page.goto(shareUrl + '/export');
      await page.locator('[data-pdf-export-form] button[type=submit]').click();
      await page.locator('[data-pdf-challenge]').waitFor({ state: 'visible' });
      assert.match(await page.locator('[data-pdf-captcha-image]').getAttribute('src'), /^data:image\/png;base64,/);
    } finally { await suspicious.close(); }
    const adminContext = await browser.newContext();
    try {
      const admin = await adminContext.newPage();
      await admin.goto(base + '/login');
      await admin.locator('[name=username]').fill('admin');
      await admin.locator('[name=password]').fill('123456');
      await admin.locator('[data-login-panel=password] button[type=submit]').click();
      await admin.goto(base + '/admin#settings');
      const settings = admin.locator('[data-pdf-settings-form]');
      assert.equal(await settings.locator('input[type=number]:visible').count(), 2);
      assert.equal(await settings.locator('[name="limits[window_seconds]"]').inputValue(), '60');
      assert.equal(await settings.locator('[name="limits[requests]"]').inputValue(), '120');
      assert.equal(await settings.locator('[name="limits[requests]"]').getAttribute('max'), '256');
      assert.equal(await settings.locator('[name="limits[max_docs]"]').isVisible(), false);
    } finally { await adminContext.close(); }
    assert.deepEqual(errors, []);
    console.log('Browser passed: individual downloads, dark/mobile white PDFs, task mutex, native single print, CAPTCHA UI, access revocation, reader actions and 256 settings.');
  } finally { await context.close(); await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
