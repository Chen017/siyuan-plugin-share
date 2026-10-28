// Interaction contracts shared by the web reader and the shipped plugin.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {JSDOM} = require('jsdom');
const dom = new JSDOM('<body><form><label>Status<select name="status"><option value="active">Active</option><option value="deleted">Deleted</option><option value="all">All</option></select></label><label>Expires<input type="datetime-local" name="expires_at" value="2030-12-31T23:59"></label><button>Save</button></form></body>', {runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window, doc=w.document;
w.matchMedia=()=>({matches:true});
w.eval(fs.readFileSync(require('node:path').join(__dirname,'../php-site/assets/controls.js'),'utf8'));
const dispose=w.SPSControls.mount();
const select=doc.querySelector('select'), trigger=doc.querySelector('[role="combobox"]');
assert.equal(trigger.getAttribute('aria-label'),'Status');
const key=(target,key)=>target.dispatchEvent(new w.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));
(async()=>{
  let changes=0; select.addEventListener('change',()=>changes++);
  trigger.click(); key(trigger,'End'); key(trigger,'Enter');
  assert.equal(select.value,'all'); assert.equal(changes,1); assert.equal(trigger.textContent,'All');
  assert.equal(new w.FormData(doc.querySelector('form')).get('status'),'all');
  trigger.click(); key(trigger,'Home'); key(trigger,'Escape');
  assert.equal(select.value,'all'); assert.equal(trigger.getAttribute('aria-expanded'),'false');
  trigger.click(); key(trigger,'d'); key(trigger,'Enter'); assert.equal(select.value,'deleted');
  select.disabled=true; await new Promise(resolve=>setTimeout(resolve,0)); assert(trigger.disabled);
  const input=doc.querySelector('[name="expires_at"]'), date=doc.querySelector('.sps-date-trigger');
  assert.equal(input.type,'text');
  input.value='2030-02-31T12:00'; input.dispatchEvent(new w.Event('input',{bubbles:true})); assert(!input.checkValidity());
  input.value='2030-12-31T23:59'; input.dispatchEvent(new w.Event('input',{bubbles:true})); assert(input.checkValidity());
  date.click();
  doc.querySelector('.sps-calendar-header [aria-label="Next month"]').click();
  doc.querySelector('[data-day="2"]').click(); assert.equal(input.value,'2031-01-02T23:59');
  key(doc.querySelector('[data-day="2"]'),'ArrowLeft'); assert.equal(doc.activeElement.dataset.day,'1');
  key(doc.activeElement,'Escape'); assert.equal(doc.activeElement,date);
  date.click(); doc.querySelector('[aria-label="Clear date"]').click(); assert.equal(input.value,''); assert(input.checkValidity());
  // Replacing plugin dialogs must remove their detached popovers without leaks.
  doc.querySelector('label').remove(); await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(doc.querySelectorAll('.sps-select-panel').length,0);
  dispose(); assert.equal(input.type,'datetime-local'); assert.equal(doc.querySelectorAll('.sps-control-panel').length,0);
  dom.window.close();
  console.log('Controls passed: keyboard selection, cancellation, form payload, disabled state, calendar rollover, invalid dates, focus return and dialog cleanup.');
})().catch(error=>{dom.window.close();console.error(error);process.exitCode=1;});
