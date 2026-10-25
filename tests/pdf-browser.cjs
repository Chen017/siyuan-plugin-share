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
    assert.deepEqual(errors, []);
    console.log('Browser PDF checks passed: Guest flow, math, local image, table, code, Mermaid, unique IDs and printable PDF.');
  } finally {
    await context.close();
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
