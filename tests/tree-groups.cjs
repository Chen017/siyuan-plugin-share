const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {chromium} = require(process.env.SIYUAN_PLAYWRIGHT_MODULE || 'playwright');
(async () => {
 const browser=await chromium.launch({executablePath:process.env.SIYUAN_BROWSER_EXECUTABLE || undefined,headless:true});
 try {
  for (const scheme of ['light','dark']) for (const width of [390,1100]) {
   const page=await browser.newPage({viewport:{width,height:700},colorScheme:scheme});
   const asset=name=>pathToFileURL(path.resolve(__dirname,'../php-site/assets',name)).href;
   await page.goto(asset('style.css'));
   const group=(i)=>`<li class="kb-tree-node kb-tree-group is-open" data-tree-group="${i%12}"><div class="kb-tree-row"><button class="kb-tree-toggle" aria-expanded="true">›</button><a class="kb-tree-item" href="#group${i}"><span class="kb-tree-label">${['Mathematical Logic','Theory of Computation','Differential Geometry'][i%3]} ${i+1}</span></a></div><ul class="kb-tree kb-tree-children" data-level="1"><li class="kb-tree-node kb-tree-subgroup is-open"><div class="kb-tree-row"><button class="kb-tree-toggle" aria-expanded="true">›</button><a class="kb-tree-item" href="#lecture${i}">Lecture</a></div><ul class="kb-tree kb-tree-children" data-level="2">${Array.from({length:8},(_,j)=>`<li class="kb-tree-node"><div class="kb-tree-row"><span class="kb-tree-spacer"></span><a class="kb-tree-item ${i===0&&j===2?'is-active':''}" href="#${i}-${j}"><span class="kb-tree-label">${j+1}. Lecture and notes</span></a></div></li>`).join('')}</ul></li></ul></li>`;
   await page.setContent(`<link rel="stylesheet" href="${asset('style.css')}"><body class="layout-share"><div style="background:var(--panel-bg);padding:12px;width:300px"><div class="kb-side-body" style="height:300px"><ul class="kb-tree kb-tree-children" data-level="0">${Array.from({length:13},(_,i)=>group(i)).join('')}</ul></div></div></body>`);
   await page.addStyleTag({content: '.kb-tree-item { transition: none !important; }'});
   const result=await page.evaluate(()=>{
    const pane=document.querySelector('.kb-side-body'), groups=[...document.querySelectorAll('.kb-tree-group')], headers=groups.map(g=>g.querySelector(':scope > .kb-tree-row'));
    const colors=groups.map(g=>getComputedStyle(g).backgroundColor), line=groups.map(g=>getComputedStyle(g.querySelector('.kb-tree-node'),'::before').backgroundColor);
    pane.scrollTop=120;const sticky=headers[0].getBoundingClientRect().top-pane.getBoundingClientRect().top; const nested=groups[0].querySelector('.kb-tree-subgroup > .kb-tree-row'); const nestedTop=nested.getBoundingClientRect().top-pane.getBoundingClientRect().top; const rowHeight=headers[0].getBoundingClientRect().height; const paneRadius=getComputedStyle(pane).borderTopLeftRadius; const padding=getComputedStyle(groups[0]).paddingBottom; const paddingTop=getComputedStyle(groups[0]).paddingTop;
    pane.scrollTop=groups[1].offsetTop+80;const second=headers[1].getBoundingClientRect().top-pane.getBoundingClientRect().top;
    const pixel = value => { const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');ctx.fillStyle=value;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}); };
    const luminance = rgb => .2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2];
    const selected = groups.slice(0,12).map(g=>{const item=g.querySelector('[data-level="2"] .kb-tree-item');item.classList.add('is-active');const style=getComputedStyle(item), bg=style.backgroundColor, fg=luminance(pixel(style.color)), back=luminance(pixel(bg));item.focus({preventScroll:true});const focusBg=getComputedStyle(item).backgroundColor, focusShadow=getComputedStyle(item).boxShadow;item.blur();item.classList.remove('is-active');return {bg,focusBg,focusShadow,contrast:(Math.max(fg,back)+.05)/(Math.min(fg,back)+.05)};});
    const items=[...groups[0].querySelectorAll('[data-level="2"] .kb-tree-item')];
    const first=items[0].getBoundingClientRect(),next=items[1].getBoundingClientRect();
    return {colors,line,sticky,second,nestedTop,rowHeight,paneRadius,padding,paddingTop,selected,highlightHeight:first.height,highlightGap:next.top-first.bottom,header:getComputedStyle(headers[0]).backgroundColor,panel:getComputedStyle(pane.parentElement).backgroundColor};
   });
   assert(result.colors.every(c=>c==='rgba(0, 0, 0, 0)'), `${scheme} course groups have no background`);
   assert.equal(new Set(result.line.slice(0,12)).size,12,`${scheme} ordered branch palette`);
   assert.equal(result.line[0],result.line[12],`${scheme} branch colors repeat in order`);
   assert(Math.abs(result.sticky)<2 && Math.abs(result.second)<2,`${scheme} headings stay at the top: ${JSON.stringify(result)}`);
   assert(Math.abs(result.nestedTop-result.rowHeight)<2, `${scheme} subgroup sticks below its course heading: ${JSON.stringify(result)}`);
   assert.equal(parseFloat(result.padding),0,`${scheme} no group bottom spacing`);
   assert.equal(parseFloat(result.paddingTop),0,`${scheme} no group top spacing`);
   assert.equal(result.highlightHeight,result.rowHeight-4,`${scheme} highlight inset keeps the row geometry`);
   assert.equal(result.highlightGap,4,`${scheme} adjacent active/focused highlights have a 4px gap`);
   for (const [i,item] of result.selected.entries()) {
    assert.notEqual(item.bg,'rgba(0, 0, 0, 0)',`${scheme} group ${i} selected state remains visible`);
    assert.equal(item.focusBg,item.bg,`${scheme} group ${i} focus matches selection color`);
    assert(item.focusShadow !== 'none',`${scheme} group ${i} retains focus indication`);
    assert(item.contrast>=4.5,`${scheme} group ${i} selected text contrast ${item.contrast}`);
   }
   assert.equal(new Set(result.selected.map(s=>s.bg)).size,12,`${scheme} selection colors follow groups`);
   assert.equal(result.header,result.panel,`${scheme} sticky heading matches neutral sidebar`);
   const target = page.locator('[data-tree-group="1"] [data-level="2"] .kb-tree-item').nth(2);
   await page.evaluate(() => { const pane = document.querySelector('.kb-side-body'); const group = document.querySelector('[data-tree-group="1"]'); pane.scrollTop = group.offsetTop + 20; });
   const box = await target.boundingBox();
   await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
   await page.mouse.down();
   assert.equal(await target.evaluate(el=>getComputedStyle(el).backgroundColor),result.selected[1].bg,`${scheme} pointer-down follows group`);
   await page.mouse.up();
   assert.notEqual(await target.evaluate(el=>getComputedStyle(el).boxShadow),'none',`${scheme} focused item remains identifiable`);
   assert.equal(await target.evaluate(el=>getComputedStyle(el).backgroundColor),result.selected[1].bg,`${scheme} focused item follows group`);
   if(process.env.SIYUAN_TREE_SCREENSHOT){await page.evaluate(()=>document.querySelector('.kb-side-body').scrollTop=120);await page.screenshot({path:`${process.env.SIYUAN_TREE_SCREENSHOT}-${scheme}-${width}.png`});}
   console.log(`${scheme}/${width}px: 12 ordered colors, matching branches, two sticky headings and active state passed`);
   await page.close();
  }
 } finally {await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
