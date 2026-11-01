// NODE_PATH=/path/to/playwright/node_modules SPS_TEST_BROWSER=/path/to/chrome node tests/image-sizing.cjs
const assert = require('node:assert/strict');
const path = require('node:path');
const {chromium} = require('playwright');
const assets = path.join(__dirname, '../php-site/assets');

(async () => {
  const options = {headless: true};
  if (process.env.SPS_TEST_BROWSER) options.executablePath = process.env.SPS_TEST_BROWSER;
  const browser = await chromium.launch(options);
  try {
    const page = await browser.newPage({viewport: {width: 1000, height: 800}});
    const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
    const source = [
      `<img src="${pixel}" style="width: 400px; height: 300px">`,
      `<img src="${pixel}" style="width: 540px">`,
      `<img src="${pixel}">`,
    ].join('\n\n');
    const escaped = source.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    await page.setContent(`<body class="layout-share"><div class="markdown-body" data-md-id="doc"></div><textarea class="markdown-source" data-md-id="doc">${escaped}</textarea></body>`);
    await page.addStyleTag({path: path.join(assets, 'style.css')});
    await page.addStyleTag({content: '.markdown-body { width: 600px; } .markdown-body img:not([style]) { width: 1000px; }'});
    await page.addScriptTag({path: path.join(assets, 'vendor/markdown-it.min.js')});
    await page.addScriptTag({path: path.join(assets, 'app.js')});
    const image = page.locator('.markdown-body img').nth(0);
    await image.waitFor();
    await page.waitForFunction(() => document.querySelector('.markdown-body img')?.hasAttribute('data-sps-sized-pair'));
    let box = await image.boundingBox();
    assert(Math.abs(box.width - 400) < 1 && Math.abs(box.height - 300) < 1, `Desktop image: ${box.width} × ${box.height}`);
    assert(Math.abs((await page.locator('.markdown-body img').nth(1).boundingBox()).width - 540) < 1, 'Explicit width is not limited to 80%');
    assert(Math.abs((await page.locator('.markdown-body img').nth(2).boundingBox()).width - 480) < 1, 'Unsized image retains 80% maximum');
    await page.locator('.markdown-body').evaluate(el => { el.style.width = '200px'; });
    box = await image.boundingBox();
    assert(Math.abs(box.width - 200) < 1 && Math.abs(box.height - 150) < 1, `Narrow image: ${box.width} × ${box.height}`);
    assert(Math.abs((await page.locator('.markdown-body img').nth(2).boundingBox()).width - 160) < 1, 'Unsized image retains 80% on a narrow screen');

    console.log('Image sizing passed: explicit dimensions and the original unsized-image limit on desktop and narrow screens.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
