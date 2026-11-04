/* Comprehensive Math Regression Test for Website Rendering and PDF Export.
 * Evaluates tests/fixtures/katex-supported.md against production web rendering (app.js)
 * and PDF export pipeline (pdf-export.css, pdf-text-layer.js, html2pdf, jsPDF).
 *
 * Usage:
 *   node tests/comprehensive-math.cjs [--web-only]
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { pathToFileURL } = require('node:url');

const assets = path.resolve(__dirname, '../php-site/assets');
const app = fs.readFileSync(process.env.SPS_TEST_APP || path.join(assets, 'app.js'), 'utf8');
const fixturePath = path.join(__dirname, 'fixtures/katex-supported.md');
const markdownFixture = fs.readFileSync(fixturePath, 'utf8');

const core = [
  'markdown-it.min.js', 'markdown-it-task-lists.min.js',
  'markdown-it-emoji.min.js', 'markdown-it-footnote.min.js',
  'markdown-it-deflist.min.js', 'markdown-it-mark.min.js',
  'markdown-it-sub.min.js', 'markdown-it-sup.min.js', 'markdown-it-abbr.min.js',
  'markdown-it-ins.min.js', 'markdown-it-container.min.js',
  'markdown-it-anchor.min.js', 'katex.min.js', 'highlight.min.js'
];

const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition, message, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${message}`);
    await delay(30);
  }
}

async function testWebsiteRendering() {
  console.log('\n==================================================');
  console.log('1. Testing Website Content Rendering (JSDOM + app.js)');
  console.log('==================================================');

  const main = `<div class="kb-main" role="main">
    <div class="markdown-body" data-md-id="doc"></div>
    <textarea class="markdown-source" data-md-id="doc">${escape(markdownFixture)}</textarea>
  </div>`;

  const dom = new JSDOM(
    `<body class="layout-share">
      <div class="share-shell">
        <aside data-share-sidebar>
          <div data-share-tabs data-share-default="toc">
            <button data-share-tab="toc">目录</button>
          </div>
          <div data-share-panel="toc"><div data-share-toc="doc"></div></div>
        </aside>
        ${main}
      </div>
    </body>`,
    {
      url: 'https://reader.test/s/test',
      runScripts: 'outside-only',
      pretendToBeVisual: true,
      virtualConsole: new VirtualConsole(),
    }
  );

  const w = dom.window;
  const pageErrors = [];
  w.console.error = (err) => pageErrors.push(err);
  w.scrollTo = () => {};
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.HTMLElement.prototype.scrollTo = () => {};
  w.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
  w.requestIdleCallback = (fn) => w.setTimeout(fn, 0);
  w.SVGElement.prototype.getBBox = () => ({ x: 0, y: 0, width: 100, height: 50 });

  for (const file of core) {
    w.eval(fs.readFileSync(path.join(assets, 'vendor', file), 'utf8'));
  }

  w.eval(app);

  await waitFor(
    () => w.document.querySelector('.markdown-body')?.dataset.spsRendered === '1',
    'comprehensive math note rendering'
  );

  const body = w.document.querySelector('.markdown-body');
  const katexElements = body.querySelectorAll('.katex');
  const katexBlocks = body.querySelectorAll('.katex-block, .katex-display');
  const mathMlElements = body.querySelectorAll('.katex math, math');
  const errorElements = body.querySelectorAll('.katex-error, [style*="#cc0000"], [style*="rgb(204, 0, 0)"]');

  console.log(`- Total rendered .katex elements: ${katexElements.length}`);
  console.log(`- Total block math elements: ${katexBlocks.length}`);
  console.log(`- MathML semantic elements: ${mathMlElements.length}`);
  console.log(`- Formula parse/render error elements: ${errorElements.length}`);

  const errorCategories = {
    unsupportedCommands: [],
    displayModeRequired: [],
    undefinedControlSequences: [],
    untrustedHtmlExtensions: [],
    other: []
  };

  errorElements.forEach((el, idx) => {
    const title = el.getAttribute('title') || el.title || el.textContent;
    const text = el.textContent.trim();
    const item = { index: idx + 1, text, title: title.split('\n')[0] };

    if (item.title.includes('can be used only in display mode')) {
      errorCategories.displayModeRequired.push(item);
    } else if (item.title.includes('Undefined control sequence')) {
      errorCategories.undefinedControlSequences.push(item);
    } else if (['\\href', '\\url', '\\includegraphics', '\\htmlId', '\\htmlClass', '\\htmlStyle', '\\htmlData'].includes(item.text)) {
      errorCategories.untrustedHtmlExtensions.push(item);
    } else if (['\\dddot', '\\ddddot', '\\overbracket', '\\underbracket', '\\reflectbox', '\\mathreflectbox', '\\mapsfrom', '\\mathsfit', '\\emph'].includes(item.text)) {
      errorCategories.unsupportedCommands.push(item);
    } else {
      errorCategories.other.push(item);
    }
  });

  const clone = body.cloneNode(true);
  clone.querySelectorAll('.katex, code, pre, script, style').forEach((n) => n.remove());
  const unparsedDollarMatches = Array.from(clone.textContent.matchAll(/\$([^\$\n]+)\$/g), (m) => m[0]);
  const unparsedDoubleMatches = Array.from(clone.textContent.matchAll(/\$\$([^\$]+)\$\$/g), (m) => m[0]);

  console.log(`- Potential unparsed inline formulas ($...$ outside code/katex): ${unparsedDollarMatches.length}`);
  console.log(`- Potential unparsed display formulas ($$...$$ outside code/katex): ${unparsedDoubleMatches.length}`);

  dom.window.close();

  return {
    katexCount: katexElements.length,
    blockCount: katexBlocks.length,
    mathMlCount: mathMlElements.length,
    errorCount: errorElements.length,
    errorCategories,
    unparsedDollarMatches,
    unparsedDoubleMatches,
    pageErrors
  };
}

async function testPdfExportRendering() {
  console.log('\n==================================================');
  console.log('2. Testing PDF Export (Playwright + Edge / Chromium)');
  console.log('==================================================');

  let playwright;
  try {
    playwright = require(process.env.SIYUAN_PLAYWRIGHT_MODULE || 'playwright');
  } catch (err) {
    console.warn('Playwright module not found. Skipping PDF browser rendering test.');
    return { skipped: true, reason: 'Playwright not available' };
  }

  const browserExecutable =
    process.env.SIYUAN_BROWSER_EXECUTABLE ||
    (fs.existsSync('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe')
      ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
      : undefined);

  const browser = await playwright.chromium.launch({
    executablePath: browserExecutable,
    headless: true
  });

  try {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 2000 },
      deviceScaleFactor: 1
    });

    const asset = (name) => pathToFileURL(path.resolve(__dirname, '../php-site/assets', name)).href;

    await page.goto(asset('style.css'));
    await page.setContent(`<!doctype html>
      <base href="${asset('')}/">
      <link rel="stylesheet" href="vendor/katex.min.css">
      <link rel="stylesheet" href="style.css">
      <link rel="stylesheet" href="pdf-export.css">
      <body class="layout-share pdf-export-preview">
        <div id="fixture" class="pdf-document pdf-download-document">
          <div class="markdown-body"></div>
          <textarea class="markdown-source" style="display:none"></textarea>
        </div>
      </body>`);

    for (const file of [
      'vendor/markdown-it.min.js',
      'vendor/markdown-it-task-lists.min.js',
      'vendor/markdown-it-emoji.min.js',
      'vendor/markdown-it-footnote.min.js',
      'vendor/markdown-it-deflist.min.js',
      'vendor/markdown-it-mark.min.js',
      'vendor/markdown-it-sub.min.js',
      'vendor/markdown-it-sup.min.js',
      'vendor/markdown-it-abbr.min.js',
      'vendor/markdown-it-ins.min.js',
      'vendor/markdown-it-container.min.js',
      'vendor/markdown-it-anchor.min.js',
      'vendor/katex.min.js',
      'vendor/highlight.min.js',
      'vendor/html2pdf.bundle.min.js',
      'pdf-text-layer.js',
      'app.js'
    ]) {
      await page.addScriptTag({ url: asset(file) });
    }

    const renderStats = await page.evaluate(async (markdown) => {
      const source = document.querySelector('.markdown-source');
      source.value = markdown;
      source.dataset.mdId = 'pdf-doc';
      const body = document.querySelector('.markdown-body');
      body.dataset.mdId = 'pdf-doc';

      window.dispatchEvent(new Event('load'));
      window.dispatchEvent(new Event('sps:markdown-ready'));

      let tries = 0;
      while (body.dataset.spsRendered !== '1' && tries++ < 100) {
        await new Promise((r) => setTimeout(r, 50));
      }
      await document.fonts.ready;

      const katexTotal = body.querySelectorAll('.katex').length;
      const svgTotal = body.querySelectorAll('.katex svg').length;
      return { rendered: body.dataset.spsRendered === '1', katexTotal, svgTotal };
    }, markdownFixture);

    console.log(`- In-page rendering status: ${renderStats.rendered ? 'OK' : 'FAILED'}`);
    console.log(`- KaTeX formula nodes in PDF preview DOM: ${renderStats.katexTotal}`);
    console.log(`- KaTeX SVG symbols in PDF preview DOM: ${renderStats.svgTotal}`);

    const prepResults = await page.evaluate(async () => {
      const container = document.querySelector('#fixture');
      let fontProtectionError = null;
      let prepareSvgError = null;

      try {
        window.unprotectFont = SPSPdfTextLayer.protectFontMetrics(container);
      } catch (err) {
        fontProtectionError = err.message;
      }

      const svgsBefore = container.querySelectorAll('.katex svg').length;
      const zeroSvgs = [];
      container.querySelectorAll('.katex svg').forEach((svg, i) => {
        const r = svg.getBoundingClientRect();
        if (!r.width || !r.height) {
          zeroSvgs.push({
            index: i,
            w: r.width,
            h: r.height,
            parentSnippet: (svg.closest('.katex')?.textContent || '').slice(0, 50)
          });
        }
      });
      let svgsReplaced = 0;
      try {
        await SPSPdfTextLayer.prepareMathSvg(container);
        svgsReplaced = container.querySelectorAll('.katex img').length;
      } catch (err) {
        prepareSvgError = err.message;
      }

      return {
        fontProtectionError,
        prepareSvgError,
        svgsBefore,
        svgsReplaced,
        zeroSvgs
      };
    });

    console.log(`- Font metrics protection: ${prepResults.fontProtectionError ? 'FAILED (' + prepResults.fontProtectionError + ')' : 'PASSED'}`);
    console.log(`- prepareMathSvg conversion: ${prepResults.prepareSvgError ? 'FAILED (' + prepResults.prepareSvgError + ')' : 'PASSED'}`);
    console.log(`  (SVGs found: ${prepResults.svgsBefore}, SVGs converted to <img>: ${prepResults.svgsReplaced})`);
    if (prepResults.zeroSvgs?.length) {
      console.log(`  (Note: ${prepResults.zeroSvgs.length} SVGs had 0 width/height and were ignored: ${JSON.stringify(prepResults.zeroSvgs)})`);
    }

    const captureResult = await page.evaluate(async () => {
      const container = document.querySelector('#fixture');
      try {
        const records = await SPSPdfTextLayer.capture(container);
        const mathRecords = records.filter((r) => /[α-ωΑ-Ω∀∃∈∉∑∫√≠≤≥]/.test(r.text));
        return {
          totalRecords: records.length,
          mathSymbolsCount: mathRecords.length,
          sampleMathSymbols: mathRecords.slice(0, 20).map((r) => r.text).join(' ')
        };
      } catch (err) {
        return { error: err.message };
      }
    });

    console.log(`- SPSPdfTextLayer.capture: ${captureResult.error ? 'FAILED (' + captureResult.error + ')' : 'PASSED'}`);
    if (!captureResult.error) {
      console.log(`  (Total text tokens: ${captureResult.totalRecords}, Math Unicode symbols captured: ${captureResult.mathSymbolsCount})`);
      console.log(`  (Sample math symbols in text layer: ${captureResult.sampleMathSymbols})`);
    }

    const canvasResult = await page.evaluate(async () => {
      try {
        let worker = html2pdf().set({
          margin: [16, 14],
          pagebreak: { mode: [] },
          html2canvas: { scale: 1, backgroundColor: '#fff', logging: false }
        }).from(document.querySelector('#fixture')).toContainer();
        await worker;
        if (worker.prop?.overlay) worker.prop.overlay.style.left = '0';

        const container = await worker.get('container');
        await SPSPdfTextLayer.prepareMathSvg(container);

        worker = worker.toCanvas();
        await worker;
        if (worker.prop?.overlay) worker.prop.overlay.style.left = '0';

        const canvas = await worker.get('canvas');
        if (!canvas) throw new Error('Canvas element not generated by html2pdf');
        return {
          success: true,
          canvasWidth: canvas.width,
          canvasHeight: canvas.height
        };
      } catch (err) {
        return { success: false, error: err.stack || err.message };
      }
    });

    console.log(`- html2canvas rasterization: ${canvasResult.success ? 'PASSED' : 'FAILED'}`);
    if (canvasResult.success) {
      console.log(`  (Generated Canvas dimensions: ${canvasResult.canvasWidth} x ${canvasResult.canvasHeight} px)`);
    } else {
      console.log(`  (Canvas Error: ${canvasResult.error})`);
    }

    const pdfResult = await page.evaluate(async () => {
      try {
        let worker = html2pdf().set({
          margin: [16, 14],
          pagebreak: { mode: ['css', 'legacy'] },
          html2canvas: { scale: 1, backgroundColor: '#fff', logging: false }
        }).from(document.querySelector('#fixture')).toPdf();
        await worker;

        const pdf = await worker.get('pdf');
        const pageCount = pdf.internal.getNumberOfPages();
        const outputBlob = pdf.output('blob');
        return {
          success: true,
          pageCount,
          blobSize: outputBlob.size
        };
      } catch (err) {
        return { success: false, error: err.stack || err.message };
      }
    });

    console.log(`- Full PDF Generation (jsPDF): ${pdfResult.success ? 'PASSED' : 'FAILED'}`);
    if (pdfResult.success) {
      console.log(`  (PDF Pages: ${pdfResult.pageCount}, Output Size: ${(pdfResult.blobSize / 1024).toFixed(1)} KB)`);
    } else {
      console.log(`  (PDF Error: ${pdfResult.error})`);
    }

    return {
      renderStats,
      prepResults,
      captureResult,
      canvasResult,
      pdfResult
    };
  } finally {
    await browser.close();
  }
}

(async () => {
  try {
    const webOnly = process.argv.includes('--web-only');
    const webResults = await testWebsiteRendering();
    const pdfResults = webOnly ? { skipped: true } : await testPdfExportRendering();

    console.log('\n==================================================');
    console.log('SUMMARY OF TEST EXECUTION (NO CODE MODIFIED)');
    console.log('==================================================');
    console.log(`Website Formulas Tested: ${webResults.katexCount}`);
    console.log(`Website Parse/Error Elements: ${webResults.errorCount}`);
    console.log(`  - Unsupported Commands (KaTeX >0.16.9): ${webResults.errorCategories.unsupportedCommands.length}`);
    console.log(`  - Display Mode in Table Cell Errors: ${webResults.errorCategories.displayModeRequired.length}`);
    console.log(`  - Undefined Control Sequences (Macro Scope): ${webResults.errorCategories.undefinedControlSequences.length}`);
    console.log(`  - Untrusted HTML Extensions (Security Filtered): ${webResults.errorCategories.untrustedHtmlExtensions.length}`);
    console.log(`  - Other Errors: ${webResults.errorCategories.other.length}`);
    console.log(`PDF KaTeX Elements: ${pdfResults.renderStats?.katexTotal ?? 'N/A'}`);
    console.log(`PDF SVG Elements Processed: ${pdfResults.prepResults?.svgsReplaced ?? 'N/A'}`);
    console.log(`PDF Canvas Generation: ${pdfResults.canvasResult?.success ? 'SUCCESS' : 'FAILED'}`);
    console.log(`PDF jsPDF File Generation: ${pdfResults.pdfResult?.success ? 'SUCCESS' : 'FAILED'}`);
  } catch (err) {
    console.error('Test runner encountered fatal error:', err);
    process.exitCode = 1;
  }
})();
