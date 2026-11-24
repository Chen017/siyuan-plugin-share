/* Real-browser regression for PDF internal GoTo jumps and external share link resolution. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.SIYUAN_PLAYWRIGHT_MODULE || 'playwright');

const ASSETS_DIR = path.resolve(__dirname, '../php-site/assets');
const MIME_TYPES = {
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ttf': 'font/ttf',
};

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.SIYUAN_BROWSER_EXECUTABLE || undefined,
    headless: true,
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'reader.test') {
        await route.abort();
        return;
      }
      if (url.pathname === '/s/demo-share/export') {
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: `<!doctype html><html><body>
            <iframe src="http://reader.test/s/demo-share/export/document"></iframe>
            <script>
              window.addEventListener('message', async (event) => {
                if (event.origin !== location.origin || event.data?.type !== 'sps-pdf-document') return;
                if (event.data.error) { window.__pdfError = event.data.error; return; }
                if (event.data.blob instanceof Blob) {
                  const buf = await event.data.blob.arrayBuffer();
                  window.__pdfBytes = Array.from(new Uint8Array(buf));
                }
              });
            </script>
          </body></html>`,
        });
        return;
      }
      if (url.pathname === '/s/demo-share/export/document') {
        const externalRefs = JSON.stringify({
          '20261119099999-other01': '/s/demo-share/20261119099999-other01',
          '20261119099999-blk0002': '/s/demo-share/20261119099999-other01#20261119099999-blk0002',
        }).replace(/'/g, '&#39;');
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: `<!doctype html><html><head><meta charset="utf-8">
            <link rel="stylesheet" href="/assets/vendor/github-markdown.min.css">
            <link rel="stylesheet" href="/assets/reader-style.css">
            <link rel="stylesheet" href="/assets/pdf-export.css">
          </head><body class="layout-share pdf-export-preview">
            <div data-pdf-preview data-pdf-child="1" data-pdf-index="0"
              data-pdf-library="/assets/vendor/html2pdf.bundle.min.js"
              data-pdf-font="/assets/vendor/fonts/pdf-provenance.ttf"
              data-pdf-text-library="/assets/pdf-text-layer.js"
              data-export-url="/s/demo-share/export"
              data-lease="testlease"
              data-csrf="testcsrf">
              <p data-pdf-status role="status">Preparing</p>
              <button type="button" data-pdf-download disabled>Generate PDF</button>
            </div>
            <main class="pdf-document">
              <section class="pdf-doc"
                data-pdf-doc="20261119083700-docroot"
                data-pdf-title="PDF Link Test"
                data-pdf-source="/s/demo-share/20261119083700-docroot"
                data-pdf-external-refs='${externalRefs}'>
                <h1>PDF Link Test</h1>
                <div class="markdown-body" data-md-id="pdf-0" data-sps-rendered="1">
                  <p>
                    <a href="#20261119083945-cy31h7h">Inline block ref</a> |
                    <a href="#20261119095000-math111">Standalone block ref</a> |
                    <a href="#section-two">Heading ref</a> |
                    <button type="button" class="sps-footnote-action" aria-label="Preview footnote">icon</button><sup class="footnote-ref"><a href="#fn1" id="fnref1">[1]</a></sup> |
                    <a href="/s/demo-share/20261119083700-docroot#20261119083945-cy31h7h">Explicit same-doc ref</a> |
                    <a href="#20261119099999-other01">Cross-doc ref</a> |
                    <a href="#20261119099999-blk0002">Cross-doc block ref</a> |
                    <a href="#20261119099999-missing">Unresolved ref</a> |
                    <a href="#20261119099999-hidden1">Hidden target ref</a> |
                    <a href="./20261119099999-other01#20261119099999-blk0003">Relative doc ref</a> |
                    <a href="https://example.com/guide">External website</a>
                  </p>
                  <div style="display: none;"><span id="20261119099999-hidden1" class="sps-block-anchor"></span></div>
                  <p style="margin-top: 1150px;">Spacer paragraph on page two boundary.</p>
                  <h2 id="section-two">Section Two</h2>
                  <p>Target inline paragraph <span id="20261119083945-cy31h7h" class="sps-block-anchor"></span></p>
                  <p class="sps-block-anchor-wrapper"><span id="20261119095000-math111" class="sps-block-anchor"></span></p>
                  <p>Block immediately after standalone wrapper.</p>
                  <section class="footnotes">
                    <ol>
                      <li id="fn1"><p>Footnote on page two <a href="#fnref1" class="footnote-backref">back</a></p></li>
                    </ol>
                  </section>
                </div>
              </section>
            </main>
            <script src="/assets/pdf-export.js"></script>
          </body></html>`,
        });
        return;
      }
      if (url.pathname.startsWith('/assets/')) {
        const rel = url.pathname.slice('/assets/'.length);
        const filePath = path.resolve(ASSETS_DIR, rel);
        if (!filePath.startsWith(ASSETS_DIR) || !fs.existsSync(filePath)) {
          await route.fulfill({ status: 404, body: 'Not found' });
          return;
        }
        const ext = path.extname(filePath).toLowerCase();
        await route.fulfill({
          status: 200,
          contentType: MIME_TYPES[ext] || 'application/octet-stream',
          body: fs.readFileSync(filePath),
        });
        return;
      }
      await route.fulfill({ status: 404, body: 'Not found' });
    });

    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    await page.goto('http://reader.test/s/demo-share/export');
    await page.waitForFunction(() => window.__pdfBytes || window.__pdfError, null, { timeout: 60000 });
    const pageError = await page.evaluate(() => window.__pdfError || null);
    assert.equal(pageError, null, `PDF export failed: ${pageError}`);
    assert.deepEqual(pageErrors, []);

    const pdfCssProbe = await page.frameLocator('iframe').locator('body').evaluate(() => {
      const probe = document.createElement('div');
      probe.className = 'pdf-document pdf-download-document';
      probe.innerHTML = '<div class="markdown-body"><button type="button" class="sps-footnote-action">x</button><hr class="footnotes-sep"><section class="footnotes"><ol><li>fn</li></ol></section></div>';
      document.body.append(probe);
      try {
        return {
          footnoteActionDisplay: getComputedStyle(probe.querySelector('.sps-footnote-action')).display,
          footnotesDisplay: getComputedStyle(probe.querySelector('.footnotes')).display,
          footnotesSepDisplay: getComputedStyle(probe.querySelector('.footnotes-sep')).display,
        };
      } finally {
        probe.remove();
      }
    });
    assert.equal(pdfCssProbe.footnoteActionDisplay, 'none', 'PDF export hides .sps-footnote-action icon');
    assert.notEqual(pdfCssProbe.footnotesDisplay, 'none', 'PDF export keeps .footnotes visible');
    assert.notEqual(pdfCssProbe.footnotesSepDisplay, 'none', 'PDF export keeps hr.footnotes-sep visible');

    const bytes = Buffer.from(await page.evaluate(() => window.__pdfBytes));
    const raw = bytes.toString('latin1');

    const pagesMatch = raw.match(/<<\s*\/Type\s*\/Pages\b[\s\S]*?\/Kids\s*\[([^\]]+)\]/);
    assert.ok(pagesMatch, 'PDF must declare /Pages /Kids');
    const pageObjIds = [...pagesMatch[1].matchAll(/(\d+)\s+0\s+R/g)].map((m) => m[1]);
    assert.ok(pageObjIds.length >= 2, `Expected at least 2 pages, got ${pageObjIds.length}`);

    const dests = [...raw.matchAll(/\/Dest\s*\[(\d+)\s+0\s+R\s+\/XYZ\s+0\s+(-?\d+(?:\.\d+)?)\s+0\]/g)]
      .map((m) => ({ objId: m[1], y: Number(m[2]) }));
    const uris = [...raw.matchAll(/\/URI\s*\(([^)]+)\)/g)].map((m) => m[1]);

    // Five internal links jump to page 2 (inline ref, standalone wrapper ref, heading ref, footnote #fn1, explicit same-doc URL)
    // and one footnote backref (#fnref1) jumps back to page 1.
    const toPage2 = dests.filter((d) => d.objId === pageObjIds[1]);
    const toPage1 = dests.filter((d) => d.objId === pageObjIds[0]);
    assert.ok(toPage2.length >= 5, `Expected at least 5 internal jumps to page 2, got ${JSON.stringify(dests)} (pageObjIds=${JSON.stringify(pageObjIds)})`);
    assert.ok(toPage1.length >= 1, `Expected footnote backref jump to page 1, got ${JSON.stringify(dests)} (pageObjIds=${JSON.stringify(pageObjIds)})`);
    for (const d of dests) {
      assert.ok(d.y > 0 && d.y < 900, `Expected valid PDF Y coordinate, got ${d.y}`);
    }

    const expectedUris = [
      'http://reader.test/s/demo-share/20261119099999-other01',
      'http://reader.test/s/demo-share/20261119099999-other01#20261119099999-blk0002',
      'http://reader.test/s/demo-share/20261119083700-docroot#20261119099999-missing',
      'http://reader.test/s/demo-share/20261119083700-docroot#20261119099999-hidden1',
      'http://reader.test/s/demo-share/20261119099999-other01#20261119099999-blk0003',
      'https://example.com/guide',
    ];
    for (const expected of expectedUris) {
      assert.ok(uris.includes(expected), `Missing expected URI ${expected}; got ${JSON.stringify(uris)}`);
    }
    for (const uri of uris) {
      assert.ok(!uri.includes('/export'), `Export URI leaked into PDF annotation: ${uri}`);
      assert.ok(!uri.includes('pdf-0-'), `Internal pdf-0- prefix leaked into PDF annotation: ${uri}`);
    }

    console.log(`PDF links passed: ${dests.length} internal /Dest jumps across ${pageObjIds.length} pages, ${uris.length} external /URI links, zero /export leaks.`);
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
