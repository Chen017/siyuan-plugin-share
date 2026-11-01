/* Compare every KaTeX SVG region in the exported canvas with the browser rendering. */
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.SIYUAN_PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.SIYUAN_BROWSER_EXECUTABLE || undefined, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 2600 }, deviceScaleFactor: 1 });
    const asset = (name) => pathToFileURL(path.resolve(__dirname, '../php-site/assets', name)).href;
    await page.goto(pathToFileURL(path.resolve(__dirname, '../php-site/assets/vendor/katex.min.css')).href);
    await page.setContent(`<!doctype html><base href="${asset('')}/"><link rel="stylesheet" href="vendor/katex.min.css"><link rel="stylesheet" href="style.css"><link rel="stylesheet" href="pdf-export.css"><body class="layout-share pdf-export-preview"><div id="fixture" class="pdf-document pdf-download-document"><div class="markdown-body"></div></div></body>`);
    await page.addScriptTag({ url: asset('vendor/katex.min.js') });
    await page.addScriptTag({ url: asset('vendor/html2pdf.bundle.min.js') });
    await page.addScriptTag({ url: asset('pdf-text-layer.js') });
    const formulas = [
      String.raw`\begin{pmatrix}1&0&0\\0&1&0\\\frac{\partial f}{\partial x}&\frac{\partial f}{\partial y}&\frac{\partial f}{\partial z}\end{pmatrix}`,
      String.raw`\left[\begin{matrix}a&b\\c&d\end{matrix}\right] + \left\{\frac{a}{b}\right\} + \left\langle\frac{a}{b}\right\rangle`,
      String.raw`\sqrt{\frac{1}{1+\frac{1}{x}}}+\sqrt[3]{a+b}+\frac{\sqrt{x}}{\sqrt{y}}`,
      String.raw`\overbrace{a+b+c}^{n}+\underbrace{x+y}_{m}+\widehat{a+b}+\widetilde{x+y}`,
      String.raw`\xrightarrow{\text{long}}\quad\xleftarrow{f}\quad\overrightarrow{AB}\quad\overline{abc}`,
      String.raw`\color{red}{\left(\frac{x}{y}\right)} + \color{blue}{\sqrt{\frac{a}{b}}}`,
      String.raw`\begin{cases}x^2 & x>0\\-x & x\leq0\end{cases} + \sum_{i=0}^{n}\frac{1}{i!}`,
      String.raw`\left\lVert\begin{matrix}a\\b\\c\\d\\e\end{matrix}\right\rVert\quad\int_0^1\frac{dx}{1+x^2}`,
    ];
    await page.evaluate(async (values) => {
      const body = document.querySelector('.markdown-body');
      values.forEach((formula, index) => {
        const p = document.createElement('p'); p.style.margin = '20px 0';
        katex.render(formula, p, { displayMode: index !== 0, throwOnError: true }); body.append(p);
      });
      await document.fonts.ready;
      window.worker = html2pdf().set({ margin: [16, 14], pagebreak: {mode: []}, html2canvas: { scale: 1, backgroundColor: '#fff' } }).from(document.querySelector('#fixture')).toContainer();
      await window.worker; window.worker.prop.overlay.style.left = "0";
    }, formulas);
    const container = await page.evaluateHandle(() => window.worker.get('container'));
    const referenceNode = page.locator('#fixture').first();
    const bounds = await referenceNode.evaluate((element) => {
      const root = element.getBoundingClientRect();
      return Array.from(element.querySelectorAll('.katex svg'), (svg) => { const r = svg.getBoundingClientRect(); return { x: r.x-root.x, y: r.y-root.y, w:r.width, h:r.height }; });
    });
    assert.ok(bounds.length >= 20, `Expected broad SVG coverage, got ${bounds.length}`);
    const reference = await referenceNode.screenshot();
    const result = await page.evaluate(async () => {
      const container = await window.worker.get('container');
      await SPSPdfTextLayer.prepareMathSvg(container);
      window.worker = window.worker.toCanvas(); await window.worker; window.worker.prop.overlay.style.left = "0";
      const image = (await window.worker.get('canvas')).toDataURL();
      window.worker = window.worker.toPdf(); await window.worker;
      const blob = (await window.worker.get('pdf')).output('blob');
      const pdf = await new Promise((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(blob); });
      return { image, pdf };
    });
    if (process.env.SIYUAN_MATH_PDF_OUTPUT) require('node:fs').writeFileSync(process.env.SIYUAN_MATH_PDF_OUTPUT, Buffer.from(result.pdf.split(',')[1], 'base64'));
    const comparisons = await page.evaluate(async ({reference, result, bounds}) => {
      const load = (src) => new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = src; });
      const [a,b] = await Promise.all([load(reference),load(result)]);
      const pixels = (image) => { const c = document.createElement('canvas'); c.width=image.width;c.height=image.height;const ctx=c.getContext('2d');ctx.drawImage(image,0,0);return ctx.getImageData(0,0,c.width,c.height); };
      const first=pixels(a), second=pixels(b);
      return bounds.map(({x,y,w,h}) => {
        let expected=0, found=0;
        const dark=(data,x,y) => { if(x<0||y<0||x>=data.width||y>=data.height)return false; const i=(y*data.width+x)*4; return Math.min(data.data[i],data.data[i+1],data.data[i+2])<180; };
        for(let py=Math.max(0,Math.ceil(y));py<Math.min(first.height,Math.floor(y+h));py++) for(let px=Math.max(0,Math.ceil(x));px<Math.min(first.width,Math.floor(x+w));px++) if(dark(first,px,py)) { expected++; let ok=false; for(let dy=-2;dy<=2&&!ok;dy++) for(let dx=-2;dx<=2&&!ok;dx++) ok=dark(second,px+dx,py+dy); if(ok)found++; }
        return {expected, ratio:expected?found/expected:1, x,y,w,h};
      });
    }, {reference:'data:image/png;base64,'+reference.toString('base64'),result:result.image,bounds});
    const failures = comparisons.filter((item) => item.expected > 3 && item.ratio < 0.8);
    assert.deepEqual(failures, [], `Formula SVG pixels lost: ${JSON.stringify(failures)}`);
    console.log(`PDF math canvas passed: ${formulas.length} formula groups, ${bounds.length} SVG symbols compared with browser rendering.`);
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });





