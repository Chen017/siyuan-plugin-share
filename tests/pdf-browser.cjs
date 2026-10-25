/* Optional end-to-end regression; uses an existing browser, never builds the app. */
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require(process.env.SIYUAN_PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const [shareUrl, output] = process.argv.slice(2);
  const browser = await chromium.launch({ executablePath: process.env.SIYUAN_BROWSER_EXECUTABLE || undefined, headless: true });
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const errors = [];
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  try {
    const page = await context.newPage();
    await page.goto(shareUrl);
    await page.locator('[data-pdf-export-link]').click();
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
      const original = await settings.evaluate((form) => Object.fromEntries(new FormData(form)));
      try {
        await settings.locator('[name=pdf_export_enabled]').uncheck();
        await settings.locator('[name="limits[max_docs]"]').fill('5');
        await settings.locator('summary').click();
        await settings.locator('[name=pdf_export_trusted_proxies]').fill('192.0.2.10');
        await settings.locator('[name=pdf_export_ip_header]').selectOption('HTTP_CF_CONNECTING_IP');
        await settings.locator('button[type=submit]').click();
        await admin.reload();
        settings = admin.locator('[data-pdf-settings-form]');
        assert.equal(await settings.locator('[name=pdf_export_enabled]').isChecked(), false);
        assert.equal(await settings.locator('[name="limits[max_docs]"]').inputValue(), '5');
        assert.equal(await settings.locator('[name=pdf_export_trusted_proxies]').inputValue(), '192.0.2.10');
        assert.equal(await settings.locator('[name=pdf_export_ip_header]').inputValue(), 'HTTP_CF_CONNECTING_IP');
        await settings.locator('summary').click();
        await admin.locator('#pdf-export-settings').screenshot({ path: path.join(output, 'pdf-admin-settings.png') });
        await page.goto(shareUrl);
        assert.equal(await page.locator('[data-pdf-export-link]').count(), 0);
        assert.equal((await context.request.get(`${shareUrl}/export`)).status(), 404);
      } finally {
        const restored = await admin.request.post(`${base}/admin/pdf-export-settings`, { form: original, maxRedirects: 0 });
        assert.equal(restored.status(), 302);
      }
      await page.goto(shareUrl);
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
