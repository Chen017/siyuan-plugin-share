/* Real-browser regression: navigation, individual downloads, CAPTCHA and task ownership. */
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const zlib = require('node:zlib');
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
    // Inspect the renderer independently; the user-facing form auto-downloads.
    const html = await controls.evaluate(async () => {
      const form = document.querySelector('[data-pdf-export-form]');
      const body = new FormData(form);
      body.delete('auto_download');
      body.set('fingerprint', 'a'.repeat(64));
      const response = await fetch(form.action, { method: 'POST', body, headers: { Accept: 'text/html' } });
      if (!response.ok) throw new Error(await response.text());
      return response.text();
    });
    const preview = controls;
    preview.on('pageerror', (error) => errors.push(error.message));
    await preview.setContent(html, { waitUntil: 'load' });
    await preview.waitForFunction(() => document.querySelector('[data-pdf-download]')?.disabled === false, null, { timeout: 45000 });
    assert.equal(await preview.getByRole('button', { name: '打印此篇', exact: true }).count(), 0, 'Export offers direct PDF saving only');
    return preview;
  };
  const downloadPdfs = async (preview, count, label) => {
    const sources = await preview.locator('[data-pdf-manifest]').evaluate((node) => JSON.parse(node.textContent).map((doc) => new URL(doc.source, location.origin).href));
    await preview.evaluate(() => {
      window.pdfLayouts = [];
      window.pdfLayoutObserver = (event) => {
        if (event.origin !== location.origin || event.data?.type !== 'sps-pdf-document' || !event.data.blob) return;
        const doc = event.source.document;
        const body = doc.querySelector('.markdown-body');
        const style = event.source.getComputedStyle(body);
        window.pdfLayouts.push({ background: style.backgroundColor, color: style.color,
          katex: doc.querySelectorAll('.katex').length, tables: doc.querySelectorAll('.markdown-body table').length,
          mermaid: doc.querySelectorAll('.mermaid svg').length,
          imagesReady: Array.from(doc.querySelectorAll('.markdown-body img')).every((img) => img.complete && img.naturalWidth > 0) });
      };
      window.addEventListener('message', window.pdfLayoutObserver);
    });
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
    const layouts = await preview.evaluate(() => {
      window.removeEventListener('message', window.pdfLayoutObserver);
      return window.pdfLayouts;
    });
    assert.equal(layouts.length, count);
    for (const layout of layouts) {
      assert.equal(layout.background, 'rgb(255, 255, 255)');
      assert.equal(layout.color, 'rgb(31, 35, 40)');
      assert.equal(layout.imagesReady, true);
    }
    if (label === 'individual-light') {
      assert.ok(layouts.reduce((sum, layout) => sum + layout.katex, 0) >= 2);
      assert.equal(layouts.reduce((sum, layout) => sum + layout.tables, 0), 1);
      assert.ok(layouts.some((layout) => layout.mermaid >= 1));
    }
    assert.equal(await preview.locator('[data-pdf-download]').isDisabled(), true, 'Completed task disables saving');
    assert.equal(new Set(downloads.map((d) => d.suggestedFilename())).size, count);
    for (let i = 0; i < downloads.length; i++) {
      assert.equal(await downloads[i].failure(), null);
      assert.match(downloads[i].suggestedFilename(), /\.pdf$/i);
      const saved = path.join(output, label + '-' + (i + 1) + '.pdf');
      await downloads[i].saveAs(saved);
      const bytes = fs.readFileSync(saved);
      const raw = bytes.toString('latin1');
      assert.ok(bytes.includes(Buffer.from(`<dc:source>${sources[i]}</dc:source>`)), 'Each file identifies its own source document');
      assert.ok(bytes.includes(Buffer.from('<rdf:li>塵</rdf:li>')), 'XMP records the requested author');
      assert.ok(bytes.includes(Buffer.from('随意传播，禁止售卖')), 'XMP preserves the exact Chinese rights notice');
      const streams = [...raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)].flatMap((match) => {
        try { return [zlib.inflateSync(Buffer.from(match[1], 'latin1')).toString('latin1')]; } catch { return []; }
      });
      assert.ok(streams.some((stream) => /\b3 Tr\b/.test(stream)), 'Hidden text uses PDF invisible rendering mode');
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
    const originalUrl = reader.url();
    const applicationPages = () => context.pages().filter((page) => !/^(edge|chrome):\/\//.test(page.url()));
    const pagesBefore = applicationPages().length;
    await reader.locator('[data-pdf-export-link]').click();
    const modal = reader.locator('dialog.pdf-export-dialog');
    await modal.waitFor({ state: 'visible' });
    const options = reader.frameLocator('[data-pdf-dialog-frame]');
    await options.locator('[data-pdf-export-form]').waitFor();
    assert.match(await options.locator('[data-pdf-quota]').innerText(), /剩余 120 篇.*60 分钟额度 120 篇/);
    assert.match(await modal.evaluate((node) => getComputedStyle(node, '::backdrop').backdropFilter), /blur/);
    await reader.waitForTimeout(250); // Let the requested opening/height animations settle.
    await reader.screenshot({ path: path.join(output, 'pdf-dialog-desktop.png'), animations: 'disabled' });
    await reader.setViewportSize({ width: 390, height: 844 });
    await reader.waitForTimeout(250);
    await reader.screenshot({ path: path.join(output, 'pdf-dialog-mobile.png'), animations: 'disabled' });
    assert.ok((await modal.boundingBox()).width <= 390);
    await reader.setViewportSize({ width: 1100, height: 900 });
    await options.locator('[data-pdf-scope]').selectOption('all');
    const automaticDownloads = [];
    reader.on('download', (download) => automaticDownloads.push(download));
    await options.getByRole('button', { name: '确定导出', exact: true }).click();
    await options.locator('[data-pdf-form-status]').filter({ hasText: '已逐篇触发 2 个独立 PDF 下载' }).waitFor({ timeout: 120000 });
    assert.equal(automaticDownloads.length, 2);
    for (let index = 0; index < automaticDownloads.length; index++) await automaticDownloads[index].saveAs(path.join(output, `dialog-auto-${index + 1}.pdf`));
    await options.locator('[data-pdf-quota]').filter({ hasText: '剩余 118 篇' }).waitFor();
    assert.match(await options.locator('[data-pdf-quota]').innerText(), /下一次恢复/);
    assert.equal(applicationPages().length, pagesBefore, 'Dialog and automatic download open no extra application tabs');
    assert.equal(reader.url(), originalUrl, 'Reader stays on the document');
    await reader.getByRole('button', { name: '关闭导出弹窗' }).click();
    await modal.waitFor({ state: 'hidden' });
    await reader.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await reader.locator('[data-pdf-export-link]').click();
    await options.locator('[data-pdf-export-form]').waitFor();
    await reader.waitForTimeout(100);
    await reader.screenshot({ path: path.join(output, 'pdf-dialog-dark.png'), animations: 'disabled' });
    await options.locator('[data-pdf-scope]').press('Escape');
    await modal.waitFor({ state: 'hidden' });
    await reader.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
    await reader.route('**/assets/vendor/html2pdf.bundle.min.js*', (route) => route.abort(), { times: 1 });
    await reader.locator('[data-pdf-export-link]').click();
    await options.getByRole('button', { name: '确定导出', exact: true }).click();
    await options.getByRole('button', { name: '重试剩余文档', exact: true }).waitFor({ timeout: 45000 });
    const task = reader.frames().find((frame) => frame.name() === 'sps-pdf-worker');
    const taskCredentials = await task.locator('[data-pdf-preview]').evaluate((node) => ({ csrf: node.dataset.csrf, lease: node.dataset.lease }));
    await reader.getByRole('button', { name: '关闭导出弹窗' }).click();
    await modal.waitFor({ state: 'hidden' });
    await reader.waitForTimeout(150);
    assert.equal((await context.request.post(shareUrl + '/export/verify', { form: taskCredentials })).status(), 410, 'Closing the dialog releases an interrupted task');
    const first = await openPreview(context, 'all');
    assert.equal(await first.locator('[data-pdf-manifest]').evaluate((node) => JSON.parse(node.textContent).length), 2);
    assert.equal(await first.locator('.pdf-doc').count(), 0, 'Batch content is prepared incrementally');
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
        await downloadPdfs(preview, scenario.count, 'individual-' + scenario.name);
      } finally { await extra.close(); }
    }
    const revoked = await openPreview(context, 'single');
    let unexpected = false;
    revoked.on('download', () => { unexpected = true; });
    const accessUrl = base + '/api/v1/shares/access/update';
    try {
      assert.equal((await context.request.post(accessUrl, { headers: { 'X-Api-Key': fixture.apiKey }, data: { shareId: fixture.shareId, password: 'Revoked-Preview-Pass!' } })).status(), 200);
      await revoked.locator('[data-pdf-download]').click();
      await revoked.waitForFunction(() => /已下载 0/.test(document.querySelector('[data-pdf-status]').textContent));
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
    console.log('Browser passed: direct individual downloads, dark/mobile white PDFs, task mutex, CAPTCHA UI, access revocation, reader actions and 256 settings.');
  } finally { await context.close(); await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
