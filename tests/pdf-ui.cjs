// Isolated behavior coverage for export selection and cancellation admission.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');
const dom = new JSDOM(`<body><form action="/export" data-pdf-export-form data-max-docs="1"><select data-pdf-scope><option value="single">Single</option><option value="selected">Selected</option></select><div data-pdf-root></div><fieldset data-pdf-selection><input data-pdf-filter><button type="button" data-pdf-clear>Clear</button><p data-pdf-filter-empty hidden></p><label><input type="checkbox" name="doc_ids[]" value="a">Course / Alpha</label><label><input type="checkbox" name="doc_ids[]" value="b">Course / Beta</label></fieldset><div data-pdf-challenge hidden><button data-pdf-captcha-refresh></button><input name="captcha_answer"></div><input name="csrf" value="fixture"><input name="ticket" value="fixture"><p data-pdf-selected-count></p><button type="submit">Export</button><p data-pdf-form-status></p></form><div data-pdf-quota='{"remaining":10,"limit":10,"window_seconds":3600,"used":0}'></div><iframe data-pdf-worker></iframe></body>`, {url:'https://fixture.test/export',runScripts:'outside-only'});
try {
 const w=dom.window,d=w.document;
 w.matchMedia=()=>({matches:true});
 w.fetch=async()=>({ok:true,arrayBuffer:async()=>new ArrayBuffer(0)});
 w.eval(fs.readFileSync(path.join(__dirname,'../php-site/assets/pdf-export.js'),'utf8'));
 const scope=d.querySelector('[data-pdf-scope]'),boxes=[...d.querySelectorAll('[name="doc_ids[]"]')],submit=d.querySelector('[type=submit]'),filter=d.querySelector('[data-pdf-filter]');
 scope.value='selected';scope.dispatchEvent(new w.Event('change'));
 assert(submit.disabled,'Empty selection cannot submit');
 boxes[0].checked=true;boxes[0].dispatchEvent(new w.Event('change',{bubbles:true}));
 assert(!submit.disabled);assert.match(d.querySelector('[data-pdf-selected-count]').textContent,/1 selected \/ 1/);
 filter.value='Beta';filter.dispatchEvent(new w.Event('input'));
 assert(boxes[0].closest('label').hidden);assert(boxes[0].checked,'Filtering preserves hidden choices');
 boxes[1].checked=true;boxes[1].dispatchEvent(new w.Event('change',{bubbles:true}));
 assert(submit.disabled,'Over-limit selection cannot submit');
 d.querySelector('[data-pdf-clear]').click();assert(boxes.every(box=>!box.checked),'Clear includes hidden choices');assert(submit.disabled);
 filter.value='missing';filter.dispatchEvent(new w.Event('input'));assert(!d.querySelector('[data-pdf-filter-empty]').hidden);
 scope.value='single';scope.dispatchEvent(new w.Event('change'));assert(!submit.disabled);
 console.log('PDF UI passed: count, empty/over-limit prevention, filter, retained hidden selections and clear.');
} finally {dom.window.close();}
