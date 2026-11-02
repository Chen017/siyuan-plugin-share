const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {chromium} = require(process.env.SIYUAN_PLAYWRIGHT_MODULE || 'playwright');
(async () => {
 const browser = await chromium.launch({executablePath: process.env.SIYUAN_BROWSER_EXECUTABLE || undefined, headless: true});
 try {
  const page = await browser.newPage({viewport:{width:1100,height:1800},deviceScaleFactor:1});
  const asset = name => pathToFileURL(path.resolve(__dirname, '../php-site/assets', name)).href;
  await page.goto(asset('style.css'));
  await page.setContent(`<!doctype html><base href="${asset('')}/"><link rel="stylesheet" href="vendor/katex.min.css"><link rel="stylesheet" href="style.css"><link rel="stylesheet" href="pdf-export.css"><body class="layout-share pdf-export-preview"><div id="fixture" class="pdf-document pdf-download-document"><div class="markdown-body"></div></div></body>`);
  for (const name of ['vendor/katex.min.js','vendor/html2pdf.bundle.min.js']) await page.addScriptTag({url:asset(name)});
  await page.addScriptTag({url: process.env.SIYUAN_PDF_TEXT_LAYER ? pathToFileURL(path.resolve(process.env.SIYUAN_PDF_TEXT_LAYER)).href : asset('pdf-text-layer.js')});
  const sources = [
   String.raw`\begin{cases}e_1'(t)=\kappa(t)e_2(t),\\e_2'(t)=-\kappa(t)e_1(t)+\tau(t)e_3(t),\\e_3'(t)=-\tau(t)e_2(t).\end{cases}`,
   String.raw`\left\{\begin{matrix}a\\b\\c\\d\\e\\f\end{matrix}\right\}`,
   String.raw`\left[\begin{matrix}a\\b\\c\\d\\e\\f\end{matrix}\right]`,
   String.raw`\left(\begin{matrix}a\\b\\c\\d\\e\\f\end{matrix}\right)`,
   String.raw`\left\lVert\begin{matrix}a\\b\\c\\d\\e\\f\end{matrix}\right\rVert`
  ];
  await page.evaluate(async values=>{
   let body=document.querySelector('.markdown-body');
   for (let size of [14,22,30]) for (const [index, source] of values.entries()) {let p=document.createElement('p');if (index < 2) p.dataset.brace = '1';p.style.cssText=`font-size:${size}px;margin:30px 0`; katex.render(source,p,{throwOnError:true});body.append(p)}
   await document.fonts.ready;
   window.worker=html2pdf().set({margin:[16,14],pagebreak:{mode:[]},html2canvas:{scale:2,backgroundColor:'#fff'}}).from(document.querySelector('#fixture')).toContainer();await window.worker;
   window.worker.prop.overlay.style.left='0';
  },sources);
  const result = await page.evaluate(async exportPdf=>{
   const container=await window.worker.get('container');const root=container.getBoundingClientRect();
   const seams=[...container.querySelectorAll('p[data-brace] .delimsizing.mult svg')].map(svg=>{let r=svg.getBoundingClientRect();return {x:(r.left+r.width/2-root.left)*2, top:(r.top-root.top)*2, bottom:(r.bottom-root.top)*2, width:r.width*2}}).filter(x=>x.width>0);
   SPSPdfTextLayer.protectFontMetrics(container);await SPSPdfTextLayer.prepareMathSvg(container);window.worker=window.worker.toCanvas();await window.worker;
   let canvas=await window.worker.get('canvas'),ctx=canvas.getContext('2d'),image=ctx.getImageData(0,0,canvas.width,canvas.height);
   const hasInk=(x,y)=>{for(let dx=-2;dx<=2;dx++){let px=Math.round(x)+dx,py=Math.round(y);if(px<0||px>=image.width||py<0||py>=image.height)continue;let i=(py*image.width+px)*4;if(Math.min(image.data[i],image.data[i+1],image.data[i+2])<180)return true}return false};
   const failed = seams.flatMap((s,i)=>[s.top,s.bottom].flatMap(y=>[-1,0,1].filter(d=>!hasInk(s.x,y+d)).map(d=>({i,y:y+d,x:s.x}))));
   let pdf = null;
   if (exportPdf) { window.worker=window.worker.toPdf(); await window.worker; pdf=(await window.worker.get('pdf')).output('datauristring'); }
   return {seams, failed, pdf};
  }, Boolean(process.env.SIYUAN_DELIMITER_PDF));
  if (result.pdf) fs.writeFileSync(process.env.SIYUAN_DELIMITER_PDF, Buffer.from(result.pdf.split(',')[1], 'base64'));
  assert(result.seams.length >= 12, `Need tall extensible delimiters: ${result.seams.length}`);
  assert.deepEqual(result.failed, [], `Visible gaps at delimiter joins: ${JSON.stringify(result.failed)}`);
  console.log(`PDF delimiter joins passed: ${result.seams.length} extender sections at three font sizes.`);
 } finally {await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
