const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.SIYUAN_PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const [url, output] = process.argv.slice(2);
  const fixture = JSON.parse(fs.readFileSync(0, 'utf8'));
  const browser = await chromium.launch({ executablePath: process.env.SIYUAN_BROWSER_EXECUTABLE || undefined, headless: true });
  try {
    const context = await browser.newContext({ colorScheme: 'dark', acceptDownloads: true });
    await context.addCookies([{ name: 'sps_pdf_visitor', value: fixture.cookie, url: new URL(url).origin, httpOnly: true }]);
    const page = await context.newPage();
    await page.goto(url + '/export');
    const downloaded = page.waitForEvent('download', { timeout: 180000 });
    await page.locator('[data-pdf-export-form] button[type=submit]').click();
    let download;
    try { download = await downloaded; }
    catch (error) { throw new Error(`${await page.locator('[data-pdf-form-status]').textContent()}; ${error.message}`); }
    assert.equal(await download.failure(), null);
    const saved = path.join(output, 'long-individual.pdf');
    await download.saveAs(saved);
    const bytes = fs.readFileSync(saved).toString('latin1');
    const pages = (bytes.match(/\/Type\s*\/Page\b/g) || []).length;
    const images = (bytes.match(/\/Subtype\s*\/Image\b/g) || []).length;
    assert.ok(pages >= 3 && pages < 30, 'Long fixture is split into several pages');
    assert.equal(images, pages, 'Exactly one rendered image per page, without rounding pages');
    console.log('Long document PDF passed: ' + pages + ' pages with independent page images.');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
