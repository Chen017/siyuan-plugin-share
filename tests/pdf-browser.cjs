/* Optional end-to-end regression; uses an existing browser, never builds the app. */
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require(process.env.SIYUAN_PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const [shareUrl, output] = process.argv.slice(2);
  const fixture = JSON.parse(fs.readFileSync(0, 'utf8'));
  const browser = await chromium.launch({ executablePath: process.env.SIYUAN_BROWSER_EXECUTABLE || undefined, headless: true });
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const errors = [];
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  try {
    const page = await context.newPage();
    await page.goto(shareUrl);
    assert.equal(await page.locator('[data-pdf-export-link]').count(), 0, 'Directory view must not show a PDF action');
    const openDocument = async (id) => {
      await page.locator(`a[data-share-nav="doc"][data-doc-id="${id}"]`).first().click();
      await page.waitForFunction((docId) => document.querySelector('.share-shell')?.dataset.shareDocId === docId, id);
    };
    const docUrl = `${shareUrl}/${fixture.docIds[0]}`;
    await openDocument(fixture.docIds[0]);
    assert.equal(await page.locator('.kb-title-row .share-document-actions [data-pdf-export-link]').count(), 1);
    assert.equal(await page.locator('.pdf-share-tools').count(), 0);
    await openDocument(fixture.docIds[1]);
    assert.equal(new URL(await page.locator('[data-pdf-export-link]').getAttribute('href'), shareUrl).searchParams.get('doc'), fixture.docIds[1]);
    await page.locator('[data-share-toggle]').click();
    assert.equal(await page.locator('.share-article.is-markdown [data-pdf-export-link]').count(), 1);
    await page.locator('[data-share-toggle]').click();
    await page.locator('a[data-share-nav="doc"][data-doc-id=""]').first().click();
    await page.waitForFunction(() => document.querySelector('.share-shell')?.dataset.shareDocId === '');
    assert.equal(await page.locator('[data-pdf-export-link]').count(), 0, 'Returning to the directory removes the PDF action');
    await openDocument(fixture.docIds[0]);
    const title = page.locator('.kb-title');
    const originalTitle = await title.textContent();
    await title.evaluate((node) => { node.textContent = '10.21 Functional completeness and Boolean Constants'; });
    for (const width of [1100, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const source = await page.locator('[data-share-toggle]').boundingBox();
      const pdf = await page.locator('[data-pdf-export-link]').boundingBox();
      assert.ok(Math.abs(source.y - pdf.y) < 1, 'Source and PDF actions are side by side');
      assert.ok(Math.abs(source.height - pdf.height) < 1, 'Source and PDF actions have matching heights');
      assert.ok(pdf.x + pdf.width <= width, 'PDF action stays within the viewport');
      await page.screenshot({ path: path.join(output, `reader-pdf-actions-${width}.png`) });
    }
    await page.setViewportSize({ width: 1100, height: 900 });
    await title.evaluate((node, text) => { node.textContent = text; }, originalTitle);
    await page.locator('[data-pdf-export-link]').click();
    assert.equal(await page.locator('[name=doc_id]').inputValue(), fixture.docIds[0]);
    await page.locator('[data-pdf-scope]').selectOption('all');
    const popupPromise = context.waitForEvent('page');
    await page.locator('[data-pdf-export-form] button[type=submit]').click();
    const preview = await popupPromise;
    await preview.waitForLoadState();
    await preview.waitForFunction(() => document.querySelector('[data-pdf-print]')?.disabled === false, { timeout: 45000 });
    assert.equal(await preview.locator('.pdf-doc').count(), 2);
    assert.ok(await preview.locator('.katex').count() >= 2);
    assert.equal(await preview.locator('.markdown-body table').count(), 1);
    assert.ok(await preview.locator('.mermaid svg').count() >= 1);
    assert.notEqual(await preview.locator('.mermaid .node rect').first().evaluate((node) => getComputedStyle(node).fill), 'rgb(0, 0, 0)', 'SVG styles must survive combined-document anchor changes');
    assert.match(await preview.locator('.code-body').innerText(), /PDF_CODE_MARKER/);
    assert.equal(await preview.locator('.markdown-body img').evaluateAll((images) => images.every((img) => img.complete && img.naturalWidth > 0)), true);
    const ids = await preview.locator('.pdf-doc [id]').evaluateAll((nodes) => nodes.map((node) => node.id));
    assert.equal(new Set(ids).size, ids.length, 'Combined documents must not duplicate heading/footnote IDs');
    await preview.screenshot({ path: path.join(output, 'pdf-preview.png'), fullPage: true });
    // Exercise the application's permission check before the browser print call.
    await preview.evaluate(() => { window.print = () => { window.__pdfPrinted = true; }; });
    await preview.locator('[data-pdf-print]').click();
    await preview.waitForFunction(() => window.__pdfPrinted === true);
    await preview.pdf({ path: path.join(output, 'guest-batch.pdf'), preferCSSPageSize: true, printBackground: true, displayHeaderFooter: false });
    const releasePreview = (target) => target.evaluate(async () => {
      const data = document.querySelector('[data-pdf-preview]').dataset;
      await fetch(`${data.exportUrl}/release`, { method: 'POST', body: new URLSearchParams({ csrf: data.csrf, lease: data.lease }) });
    });
    await releasePreview(preview);
    for (const scenario of [
      { name: 'dark-single', scope: 'single', colorScheme: 'dark', viewport: { width: 1100, height: 900 } },
      { name: 'mobile-batch', scope: 'all', colorScheme: 'dark', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    ]) {
      const extra = await browser.newContext({ viewport: scenario.viewport, colorScheme: scenario.colorScheme, isMobile: scenario.isMobile, hasTouch: scenario.hasTouch });
      try {
        const controls = await extra.newPage();
        await controls.goto(`${shareUrl}/export`);
        await controls.locator('[data-pdf-scope]').selectOption(scenario.scope);
        const nextPage = extra.waitForEvent('page');
        await controls.locator('[data-pdf-export-form] button[type=submit]').click();
        const printPage = await nextPage;
        await printPage.waitForLoadState();
        await printPage.waitForFunction(() => document.querySelector('[data-pdf-print]')?.disabled === false, { timeout: 45000 });
        assert.equal(await printPage.locator('.pdf-doc').count(), scenario.scope === 'single' ? 1 : 2);
        await printPage.emulateMedia({ media: 'print' });
        const palette = await printPage.evaluate(() => {
          const style = (selector) => {
            const value = getComputedStyle(document.querySelector(selector));
            return { background: value.backgroundColor, color: value.color };
          };
          return { body: style('body'), content: style('.markdown-body'), code: style('.code-body pre code') };
        });
        assert.equal(palette.body.background, 'rgb(255, 255, 255)');
        assert.equal(palette.content.background, 'rgb(255, 255, 255)');
        assert.equal(palette.content.color, 'rgb(31, 35, 40)');
        assert.equal(palette.code.color, 'rgb(31, 35, 40)');
        await printPage.screenshot({ path: path.join(output, `pdf-${scenario.name}.png`), fullPage: true });
        const pdfBytes = await printPage.pdf({ path: path.join(output, `guest-${scenario.name}.pdf`), preferCSSPageSize: true, printBackground: true, displayHeaderFooter: false });
        const pages = (pdfBytes.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length;
        assert.equal(pages, scenario.scope === 'single' ? 1 : 2, 'Print layout must not append empty viewport-height pages');
        await releasePreview(printPage);
      } finally {
        await extra.close();
      }
    }
    // Revoking the password after preview must block the application's print action.
    await page.goto(`${shareUrl}/export`);
    const revokedPage = context.waitForEvent('page');
    await page.locator('[data-pdf-export-form] button[type=submit]').click();
    const revoked = await revokedPage;
    await revoked.waitForLoadState();
    await revoked.waitForFunction(() => document.querySelector('[data-pdf-print]')?.disabled === false, { timeout: 45000 });
    const accessUrl = `${new URL(shareUrl).origin}/api/v1/shares/access/update`;
    try {
      assert.equal((await context.request.post(accessUrl, { headers: { 'X-Api-Key': fixture.apiKey }, data: { shareId: fixture.shareId, password: 'Revoked-Preview-Pass!' } })).status(), 200);
      await revoked.evaluate(() => { window.print = () => { window.__unexpectedPrint = true; }; });
      await revoked.locator('[data-pdf-print]').click();
      await revoked.waitForFunction(() => document.querySelector('.pdf-document').children.length === 0);
      assert.equal(await revoked.evaluate(() => !!window.__unexpectedPrint), false);
    } finally {
      await context.request.post(accessUrl, { headers: { 'X-Api-Key': fixture.apiKey }, data: { shareId: fixture.shareId, clearPassword: true } });
      await releasePreview(revoked);
    }
    // Real admin UI: save in the standalone form, observe Guest changes, restore.
    const adminContext = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    try {
      const admin = await adminContext.newPage();
      const base = new URL(shareUrl).origin;
      await admin.goto(`${base}/login`);
      await admin.locator('input[name=username]').fill('admin');
      await admin.locator('input[name=password]').fill('123456');
      await admin.locator('[data-login-panel=password] button[type=submit]').click();
      await admin.goto(`${base}/admin#settings`);
      let settings = admin.locator('[data-pdf-settings-form]');
      assert.equal(await settings.locator('input[type=number]:visible').count(), 2, 'Only time window and unified allowance are visible by default');
      assert.equal(await settings.locator('[name="limits[window_seconds]"]').inputValue(), '60');
      assert.equal(await settings.locator('[name="limits[requests]"]').inputValue(), '5');
      assert.equal(await settings.locator('[name="limits[max_docs]"]').isVisible(), false);
      const original = await settings.evaluate((form) => Object.fromEntries(new FormData(form)));
      try {
        await settings.locator('[name=pdf_export_enabled]').uncheck();
        await settings.locator('[data-pdf-advanced] > summary').click();
        await settings.locator('[name="limits[max_docs]"]').fill('5');
        await settings.locator('[data-pdf-proxy-settings] > summary').click();
        await settings.locator('[name=pdf_export_trusted_proxies]').fill('192.0.2.10');
        await settings.locator('[name=pdf_export_ip_header]').selectOption('HTTP_CF_CONNECTING_IP');
        await settings.locator('button[type=submit]').click();
        await admin.reload();
        settings = admin.locator('[data-pdf-settings-form]');
        assert.equal(await settings.locator('[name=pdf_export_enabled]').isChecked(), false);
        assert.equal(await settings.locator('[name="limits[max_docs]"]').inputValue(), '5');
        assert.equal(await settings.locator('[name=pdf_export_trusted_proxies]').inputValue(), '192.0.2.10');
        assert.equal(await settings.locator('[name=pdf_export_ip_header]').inputValue(), 'HTTP_CF_CONNECTING_IP');
        assert.equal(await settings.locator('[name="limits[max_docs]"]').isVisible(), false);
        await admin.locator('#pdf-export-settings').screenshot({ path: path.join(output, 'pdf-admin-settings.png') });
        await page.goto(docUrl);
        assert.equal(await page.locator('[data-pdf-export-link]').count(), 0);
        assert.equal((await context.request.get(`${shareUrl}/export`)).status(), 404);
      } finally {
        const restored = await admin.request.post(`${base}/admin/pdf-export-settings`, { form: original, maxRedirects: 0 });
        assert.equal(restored.status(), 302);
      }
      await page.goto(docUrl);
      assert.equal(await page.locator('[data-pdf-export-link]').count(), 1);
    } finally {
      await adminContext.close();
    }
    assert.deepEqual(errors, []);
    console.log('Browser PDF checks passed: Guest rendering, printable PDF, admin settings UI, persistence and live Guest enable/disable.');
  } finally {
    await context.close();
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
