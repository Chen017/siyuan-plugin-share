// Check the whole continuous outline, not just the old extender centers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {chromium} = require(process.env.SIYUAN_PLAYWRIGHT_MODULE || 'playwright');
(async () => {
 const browser=await chromium.launch({executablePath:process.env.SIYUAN_BROWSER_EXECUTABLE||undefined,headless:true});
 try {
  const page=await browser.newPage({viewport:{width:1100,height:2400},deviceScaleFactor:2});
  const asset=name=>pathToFileURL(path.resolve(__dirname,'../php-site/assets',name)).href;
  await page.goto(asset('style.css'));
  await page.setContent(`<!doctype html><base href="${asset('')}/"><link rel="stylesheet" href="vendor/katex.min.css"><link rel="stylesheet" href="style.css"><link rel="stylesheet" href="pdf-export.css"><body class="layout-share pdf-export-preview"><div id="fixture" class="pdf-document pdf-download-document"><div class="markdown-body"></div></div></body>`);
  for(const name of ['vendor/katex.min.js','vendor/html2pdf.bundle.min.js','pdf-text-layer.js'])await page.addScriptTag({url:asset(name)});
  const sources=[
   String.raw`\begin{cases}e_1'(t)=\kappa(t)e_2(t),\\e_2'(t)=-\kappa(t)e_1(t)+\tau(t)e_3(t),\\e_3'(t)=-\tau(t)e_2(t).\end{cases}`,
   String.raw`\left\{\begin{matrix}a\\b\\c\\d\\e\\f\end{matrix}\right\}`,
   String.raw`\left\lgroup\begin{matrix}a\\b\\c\\d\\e\\f\end{matrix}\right\rgroup`,
   String.raw`\left[\begin{matrix}a\\b\\c\\d\\e\\f\end{matrix}\right]`,
   String.raw`\left(\begin{matrix}a\\b\\c\\d\\e\\f\end{matrix}\right)`,
   String.raw`\left\lVert\begin{matrix}a\\b\\c\\d\\e\\f\end{matrix}\right\rVert`,
  ];
  await page.evaluate(async values=>{
   const body=document.querySelector('.markdown-body');
   for(const size of [14,14.6667,22,30])for(const [index,source]of values.entries()){
    const p=document.createElement('p');if(index<3)p.dataset.curly='1';
    p.style.cssText=`font-size:${size}px;margin:20px 0`;
    katex.render(source,p,{throwOnError:true});body.append(p);
   }
   await document.fonts.ready;
  },sources);
  const bounds=await page.evaluate(()=>{
   const root=document.querySelector('#fixture').getBoundingClientRect();
   return [...document.querySelectorAll('[data-curly] .delimsizing.mult')].map(delimiter=>{
    const svg=delimiter.querySelector('svg');
    if(delimiter.querySelectorAll('svg').length!==1||delimiter.querySelector('.delimsizinginner')||svg.querySelectorAll('path').length!==1)throw Error('Curly delimiters must use a single outline, without font/SVG joins');
    const d=svg.querySelector('path').getAttribute('d');
    if((d.match(/M/g)||[]).length!==1||(d.match(/Z/g)||[]).length!==1)throw Error('Curly delimiter must have one closed contour');
    const r=svg.getBoundingClientRect();return {x:(r.left-root.left)*2,y:(r.top-root.top)*2,w:r.width*2,h:r.height*2};
   });
  });
  assert.equal(bounds.length,20,'Both curly directions and groups, including fractional PDF font sizes');
  const reference=await page.locator('#fixture').screenshot();
  const result=await page.evaluate(async ({exportPdf,font})=>{
   let worker=html2pdf().set({margin:[16,14],pagebreak:{mode:[]},html2canvas:{scale:2,backgroundColor:'#fff'}}).from(document.querySelector('#fixture')).toContainer();await worker;
   const container=await worker.get('container');
   SPSPdfTextLayer.protectFontMetrics(container);await SPSPdfTextLayer.prepareMathSvg(container);
   if([...container.querySelectorAll('.katex img')].some(img=>img.style.transform))throw Error('Export must not scale extender segments');
   const records=await SPSPdfTextLayer.capture(container);
   worker=worker.toCanvas();await worker;
   const image=(await worker.get('canvas')).toDataURL();let pdf=null;
   if(exportPdf){
    worker=worker.toPdf();await worker;
    const document=await worker.get('pdf'),size=await worker.get('pageSize');
    SPSPdfTextLayer.write(document,records,{width:size.inner.width,pixelWidth:size.inner.px.width,pixelHeight:Math.floor(size.inner.px.width*size.inner.ratio)},font);
    pdf=document.output('datauristring');
   }
   return {image,pdf,text:records.map(record=>record.text).join('')};
  },{exportPdf:Boolean(process.env.SIYUAN_DELIMITER_PDF),font:process.env.SIYUAN_DELIMITER_PDF?fs.readFileSync(path.resolve(__dirname,'../php-site/assets/vendor/fonts/pdf-provenance.ttf')).toString('base64'):null});
  assert(result.text.includes('κ')&&result.text.includes('τ'),'Math text remains available to PDF selection');
  const failures=await page.evaluate(async({reference,exported,bounds})=>{
   const pixels=async src=>{const image=new Image();image.src=src;await image.decode();const c=document.createElement('canvas');c.width=image.width;c.height=image.height;const ctx=c.getContext('2d');ctx.drawImage(image,0,0);return ctx.getImageData(0,0,c.width,c.height)};
   const images=await Promise.all([pixels(reference),pixels(exported)]),failures=[];
   for(const [kind,image]of images.entries())for(const [index,b]of bounds.entries()){
    const ink=(x,y)=>{const i=(y*image.width+x)*4;return image.data[i+3]>0&&Math.min(image.data[i],image.data[i+1],image.data[i+2])<200};
    for(let y=Math.ceil(b.y)+2;y<Math.floor(b.y+b.h)-2;y++){
     let found=false;for(let x=Math.floor(b.x);x<Math.ceil(b.x+b.w);x++)if(ink(x,y)){found=true;break}
     if(!found)failures.push({kind,index,y,reason:'gap'});
    }
    // Around the former joins both stem edges must stay straight.
    const unit=b.w/888.89;
    for(const center of [b.y+900*unit,b.y+b.h-900*unit]){
     const widths=[];
     for(let y=Math.ceil(center-60*unit);y<=Math.floor(center+60*unit);y++){
      let width=0;for(let x=Math.floor(b.x);x<Math.ceil(b.x+b.w);x++)if(ink(x,y))width++;
      widths.push(width);
     }
     if(Math.max(...widths)-Math.min(...widths)>1)failures.push({kind,index,widths,reason:'stem bulge'});
    }
   }
   return failures;
  },{reference:'data:image/png;base64,'+reference.toString('base64'),exported:result.image,bounds});
  if(result.pdf)fs.writeFileSync(process.env.SIYUAN_DELIMITER_PDF,Buffer.from(result.pdf.split(',')[1],'base64'));
  if(process.env.SIYUAN_DELIMITER_PREVIEW){fs.writeFileSync(process.env.SIYUAN_DELIMITER_PREVIEW+'-web.png',reference);fs.writeFileSync(process.env.SIYUAN_DELIMITER_PREVIEW+'-canvas.png',Buffer.from(result.image.split(',')[1],'base64'));}
  assert.deepEqual(failures,[],`Delimiter contour defects: ${JSON.stringify(failures)}`);
  console.log(`Continuous delimiters passed: ${bounds.length} complete outlines in browser and PDF canvas, no gaps or stem bulges, selectable math preserved.`);
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
