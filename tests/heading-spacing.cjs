const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {chromium} = require(process.env.SIYUAN_PLAYWRIGHT_MODULE || 'playwright');
(async () => {
 const browser = await chromium.launch({executablePath:process.env.SIYUAN_BROWSER_EXECUTABLE || undefined,headless:true});
 try {
  const asset=name=>pathToFileURL(path.resolve(__dirname,'../php-site/assets',name)).href;
  for (const mode of ['reader','pdf']) for (const scheme of ['light','dark']) for (const width of [320,390,1100]) {
   const page=await browser.newPage({viewport:{width,height:1900},colorScheme:scheme});
   await page.goto(asset('style.css'));
   const blocks=Array.from({length:6},(_,i)=>`<section><h${i+1}>Heading ${i+1} 标题层级</h${i+1}><p>Clear text immediately follows the heading. 正文和公式 $x$。</p></section>`).join('');
   await page.setContent(`<!doctype html><base href="${asset('')}/"><link rel="stylesheet" href="vendor/github-markdown.min.css"><link rel="stylesheet" href="style.css"><link rel="stylesheet" href="pdf-export.css"><body class="layout-share ${mode==='pdf'?'pdf-export-preview':''}"><main class="${mode==='pdf'?'pdf-document pdf-download-document':'kb-main'}"><div class="markdown-body"><h1>Summations and products</h1><h2>Theorem</h2><p>Adjacent headings belong together.</p>${blocks}</div></main></body>`);
   await page.evaluate(()=>document.fonts.ready);
   const result=await page.evaluate(()=>{
    let body=document.querySelector('.markdown-body');let a=body.querySelector('h1').getBoundingClientRect(),b=body.querySelector('h2').getBoundingClientRect();
    let pairs=[...body.querySelectorAll('section')].map(section=>{let h=section.querySelector('h1,h2,h3,h4,h5,h6').getBoundingClientRect(),p=section.querySelector('p').getBoundingClientRect(); return {gap:p.top-h.bottom,size:parseFloat(getComputedStyle(section.querySelector('h1,h2,h3,h4,h5,h6')).fontSize)};});
    const headings=[...body.querySelectorAll('section h1,section h2,section h3,section h4,section h5,section h6')];
    return {adjacent:b.top-a.bottom,pairs,overflow:document.documentElement.scrollWidth>innerWidth,weights:headings.map(h=>getComputedStyle(h).fontWeight)};
   });
   assert(result.adjacent>=0&&result.adjacent<=28,`${mode}/${scheme} adjacent heading gap ${result.adjacent}`);
   for (const [i,pair] of result.pairs.entries()) assert(pair.gap>=0&&pair.gap<=26,`${mode}/${scheme} h${i+1} gap ${pair.gap}`);
   assert(result.pairs.every((pair,i)=>!i||result.pairs[i-1].size>pair.size),`${mode}/${scheme}/${width} heading hierarchy`);
   assert(result.weights.every(weight=>Number(weight)===600),`${mode}/${scheme}/${width} heading weights`);
   if (mode==='reader') assert(!result.overflow,`${mode}/${scheme}/${width} horizontal overflow`);
   if (mode==='reader' && width<=390) {
    assert(result.pairs[1].gap>=15,`${mode}/${scheme}/${width} h2 needs breathing room`);
    assert(result.pairs[2].gap>=12,`${mode}/${scheme}/${width} h3 needs breathing room`);
   }
   if (process.env.SIYUAN_HEADING_SCREENSHOT) await page.screenshot({path:`${process.env.SIYUAN_HEADING_SCREENSHOT}-${mode}-${scheme}.png`,fullPage:true});
   console.log(`${mode}/${scheme}/${width}: adjacent ${result.adjacent.toFixed(1)}px, heading-to-body ${result.pairs.map(p=>p.gap.toFixed(1)).join(', ')}px`);
   await page.close();
  }
 } finally {await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
