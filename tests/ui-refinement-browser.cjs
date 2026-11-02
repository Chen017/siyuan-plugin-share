// Real-browser acceptance using the disposable HTTP/PDF runner fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require(process.env.SIYUAN_PLAYWRIGHT_MODULE || 'playwright');
(async()=>{
 const [shareUrl, output]=process.argv.slice(2), fixture=JSON.parse(fs.readFileSync(0,'utf8'));
 const browser=await chromium.launch({executablePath:process.env.SIYUAN_BROWSER_EXECUTABLE||undefined,headless:true});
 const context=await browser.newContext({viewport:{width:1280,height:900},hasTouch:true});
 const errors=[];
 context.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
 const page=await context.newPage(), base=new URL(shareUrl).origin;
 const settle=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 const noOverflow=async p=>assert(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No page horizontal overflow');
 try {
  await page.goto(shareUrl);
  assert(await page.locator('[data-reader-show-tree]').evaluate(n=>n.classList.contains('primary')));
  await page.goto(shareUrl+'/'+encodeURIComponent(fixture.docIds[0]));
  await page.locator('.katex math').first().waitFor({state:'attached'});
  const image=page.locator('.markdown-body img[role=button]').first();
  await image.waitFor();
  await image.focus();await image.press('Enter');
  const viewer=page.getByRole('dialog',{name:'Image viewer',exact:true});
  await viewer.waitFor();
  assert(await viewer.locator('button[data-viewer-close]').evaluate(n=>document.activeElement===n));
  const more=viewer.locator('summary');await more.focus();await more.press('Enter');
  assert(await viewer.locator('details').evaluate(n=>n.open));
  await more.press('Escape');assert(await viewer.isVisible());assert(!(await viewer.locator('details').evaluate(n=>n.open)));
  await viewer.locator('button[data-viewer-close]').click();await viewer.waitFor({state:'hidden'});
  assert(await image.evaluate(n=>document.activeElement===n));
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.locator('[data-pdf-export-link]').click();
  await page.locator('dialog.pdf-export-dialog').waitFor();
  const panelMotion=await page.locator('dialog.pdf-export-dialog').evaluate(node=>({opacity:getComputedStyle(node).opacity,frames:node.getAnimations().filter(a=>!a.effect.pseudoElement).flatMap(a=>a.effect.getKeyframes())}));
  assert.equal(Number(panelMotion.opacity),1,'Panel text stays opaque during presentation');
  assert(panelMotion.frames.every(frame=>!('opacity' in frame)),'Panel motion does not fade text into background');
  await page.getByRole('button',{name:'Close export dialog',exact:true}).click();await page.locator('dialog.pdf-export-dialog').waitFor({state:'hidden'});
  for(const colorScheme of ['light','dark']) for(const width of [320,390,768,1280]) {
   await page.emulateMedia({colorScheme,reducedMotion:'reduce'});await page.setViewportSize({width,height:844});await settle();
   await noOverflow(page);
   if (width<=390) {
    await page.locator('[data-share-drawer-open]').click();await page.locator('[data-share-tab="toc"]').click();
    const entry=page.locator('.share-toc-link').first();
    await entry.locator('.share-toc-text').evaluate(node=>{node.textContent='A complete long mathematical heading for composition and primitive recursion';});
    assert(await entry.evaluate(node=>node.scrollWidth<=node.clientWidth+1),'Mobile contents wraps its complete title');
    await entry.focus();await entry.press('Enter');
    assert(await page.evaluate(()=>/^H[1-6]$/.test(document.activeElement.tagName)),'Mobile contents restores focus to the heading');
   }
   await page.locator('[data-pdf-export-link]').click();
   const modal=page.locator('dialog.pdf-export-dialog');await modal.waitFor();
   const options=page.frameLocator('[data-pdf-dialog-frame]');await options.locator('[data-pdf-export-form][data-export-state]').waitFor();
   await options.locator('.pdf-export-scroll').evaluate(node=>{
    const filler=document.createElement('div');filler.dataset.layoutFixture='';
    filler.textContent='A long document selection needs one main scroll owner. '.repeat(150);node.append(filler);
   });
   const geometry=await options.locator('.pdf-export-panel').evaluate(node=>{
    const scroll=node.querySelector('.pdf-export-scroll'), footer=node.querySelector('.pdf-export-footer'), field=node.querySelector('[data-pdf-selection]');
    return {scrollable:scroll.scrollHeight>scroll.clientHeight,rootOverflow:document.documentElement.scrollHeight>innerHeight+1,footerBottom:footer.getBoundingClientRect().bottom,height:innerHeight,listOverflow:getComputedStyle(field).overflowY};
   });
   assert(geometry.scrollable,JSON.stringify(geometry));assert(!geometry.rootOverflow,JSON.stringify(geometry));
   assert(geometry.footerBottom<=geometry.height+1,JSON.stringify(geometry));assert.equal(geometry.listOverflow,'visible');
   const bounds=await modal.boundingBox();assert(bounds.x>=-1 && bounds.x+bounds.width<=width+1);
   await page.screenshot({path:path.join(output,`ui-pdf-${colorScheme}-${width}.png`),animations:'disabled'});
   await page.getByRole('button',{name:'Close export dialog',exact:true}).click();await modal.waitFor({state:'hidden'});
   await page.screenshot({path:path.join(output,`ui-reader-${colorScheme}-${width}.png`),animations:'disabled'});
  }
  await page.setViewportSize({width:390,height:844});await page.emulateMedia({forcedColors:'active',reducedMotion:'reduce'});
  await page.keyboard.press('Tab');await page.locator('[data-pdf-export-link]').focus();assert.match(await page.locator('[data-pdf-export-link]').evaluate(n=>getComputedStyle(n).outlineStyle),/solid/);
  await noOverflow(page);await page.emulateMedia({forcedColors:'none'});
  await page.addStyleTag({content:'html {font-size:200% !important}'});await noOverflow(page);
  await page.goto(shareUrl);assert(!(await page.locator('[data-reader-resume]').evaluate(n=>n.classList.contains('primary'))));
  const admin=await context.newPage();await admin.goto(base+'/login');
  await admin.locator('[name=username]').fill('admin');await admin.locator('[name=password]').fill('123456');await admin.getByRole('button',{name:'Sign in',exact:true}).click();
  await admin.waitForURL('**/dashboard');
  for(const colorScheme of ['light','dark']) for(const width of [320,390,768,1280]) {
   await admin.emulateMedia({colorScheme,reducedMotion:'reduce'});await admin.setViewportSize({width,height:844});await admin.goto(base+'/dashboard');
   await noOverflow(admin);
   const contrast=await admin.locator('.table-actions .button.danger').first().evaluate(node=>{
    const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');
    const rgb=color=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});};
    const lum=v=>.2126*v[0]+.7152*v[1]+.0722*v[2];const fg=lum(rgb(getComputedStyle(node).color));const bg=lum(rgb(getComputedStyle(node.closest('.share-card')).backgroundColor));return (Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05);
   });assert(contrast>=4.5,`${colorScheme} danger text contrast ${contrast}`);
   await admin.screenshot({path:path.join(output,`ui-admin-${colorScheme}-${width}.png`),animations:'disabled'});
   await admin.goto(base+'/admin/share?share_id='+fixture.shareId);
   await admin.locator('.sps-date-trigger').click();
   const calendar=admin.locator('.sps-date-panel:not([hidden])');await calendar.waitFor();
   const sizes=await calendar.locator('.sps-calendar-grid button').evaluateAll(nodes=>nodes.map(n=>({width:n.getBoundingClientRect().width,height:n.getBoundingClientRect().height})));
   assert(sizes.length>=28);assert(sizes.every(r=>r.width>=43.9 && r.height>=44),`${width}: ${JSON.stringify(sizes.slice(0,7))}`);
   const rect=await calendar.boundingBox();assert(rect.x>=-1&&rect.x+rect.width<=width+1);await noOverflow(admin);
   await admin.screenshot({path:path.join(output,`ui-calendar-${colorScheme}-${width}.png`),animations:'disabled'});
   await admin.keyboard.press('Escape');
  }
  await admin.locator('[name=title]').fill('Unsaved fixture');await admin.getByRole('link',{name:'Site settings',exact:true}).click();
  const warning=admin.locator('dialog.confirm-dialog');await warning.waitFor();await warning.getByRole('button',{name:'Keep editing',exact:true}).click();
  assert.equal(await admin.locator('[name=title]').inputValue(),'Unsaved fixture');
  await admin.getByRole('link',{name:'Cancel',exact:true}).click();await admin.waitForURL('**/dashboard');
  assert.deepEqual(errors,[]);
  console.log('UI acceptance passed: image keyboard/More/focus, PDF scroll/footer, light/dark 320/390/768/1280, coarse calendar targets, high contrast, text scaling and unsaved edits.');
 } finally {await context.close();await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
