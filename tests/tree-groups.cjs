const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {chromium} = require(process.env.SIYUAN_PLAYWRIGHT_MODULE || 'playwright');
(async () => {
 const browser=await chromium.launch({executablePath:process.env.SIYUAN_BROWSER_EXECUTABLE || undefined,headless:true});
 try {
  for (const scheme of ['light','dark']) {
   const page=await browser.newPage({viewport:{width:900,height:700},colorScheme:scheme});
   const asset=name=>pathToFileURL(path.resolve(__dirname,'../php-site/assets',name)).href;
   await page.goto(asset('style.css'));
   const group=(i)=>`<li class="kb-tree-node kb-tree-group is-open" data-tree-group="${i%12}"><div class="kb-tree-row"><button class="kb-tree-toggle" aria-expanded="true">›</button><a class="kb-tree-item" href="#group${i}"><span class="kb-tree-label">${['Mathematical Logic','Theory of Computation','Differential Geometry'][i%3]} ${i+1}</span></a></div><ul class="kb-tree kb-tree-children" data-level="1">${Array.from({length:8},(_,j)=>`<li class="kb-tree-node"><div class="kb-tree-row"><span class="kb-tree-spacer"></span><a class="kb-tree-item ${i===0&&j===2?'is-active':''}" href="#${i}-${j}"><span class="kb-tree-label">${j+1}. Lecture and notes</span></a></div></li>`).join('')}</ul></li>`;
   await page.setContent(`<link rel="stylesheet" href="${asset('style.css')}"><body class="layout-share"><div style="background:var(--panel-bg);padding:12px;width:300px"><div class="kb-side-body" style="height:300px"><ul class="kb-tree kb-tree-children" data-level="0">${Array.from({length:13},(_,i)=>group(i)).join('')}</ul></div></div></body>`);
   await page.addStyleTag({content: '.kb-tree-item { transition: none !important; }'});
   const result=await page.evaluate(()=>{
    const pane=document.querySelector('.kb-side-body'), groups=[...document.querySelectorAll('.kb-tree-group')], headers=groups.map(g=>g.querySelector(':scope > .kb-tree-row'));
    const colors=groups.map(g=>getComputedStyle(g).backgroundColor), line=groups.slice(0,2).map(g=>getComputedStyle(g.querySelector('.kb-tree-node'),'::before').backgroundColor);
    pane.scrollTop=120;const sticky=headers[0].getBoundingClientRect().top-pane.getBoundingClientRect().top;
    pane.scrollTop=groups[1].offsetTop+80;const second=headers[1].getBoundingClientRect().top-pane.getBoundingClientRect().top;
    const pixel = value => { const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');ctx.fillStyle=value;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}); };
    const luminance = rgb => .2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2];
    const selected = groups.slice(0,12).map(g=>{const item=g.querySelector('.kb-tree-children .kb-tree-item');item.classList.add('is-active');let s=getComputedStyle(item), fg=luminance(pixel(s.color)), bg=luminance(pixel(s.backgroundColor)), value={bg:s.backgroundColor,contrast:(Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05)};item.classList.remove('is-active');return value;});
    return {colors,line,sticky,second,selected,header:getComputedStyle(headers[0]).backgroundColor};
   });
   assert.equal(new Set(result.colors.slice(0,12)).size,12,`${scheme} ordered palette`);
   assert.equal(result.colors[0],result.colors[12],`${scheme} repeats in order`);
   assert.notEqual(result.line[0],result.line[1],`${scheme} branch colors follow group`);
   assert(Math.abs(result.sticky)<2 && Math.abs(result.second)<2,`${scheme} headings stay at the top: ${JSON.stringify(result)}`);
   for (const [i, item] of result.selected.entries()) {
    assert.notEqual(item.bg,result.colors[i],`${scheme} group ${i} selected item remains distinct`);
    assert(item.contrast>=4.5,`${scheme} group ${i} selected text contrast ${item.contrast}`);
   }
   assert.equal(new Set(result.selected.map(s=>s.bg)).size,12,`${scheme} selected colors follow each group`);
   assert.equal(result.header,result.colors[0],`${scheme} sticky heading is opaque and matches group`);
   if(process.env.SIYUAN_TREE_SCREENSHOT){await page.evaluate(()=>document.querySelector('.kb-side-body').scrollTop=0);await page.screenshot({path:`${process.env.SIYUAN_TREE_SCREENSHOT}-${scheme}.png`});}
   console.log(`${scheme}: 12 ordered colors, matching branches, sticky headings and active state passed`);
   await page.close();
  }
 } finally {await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
