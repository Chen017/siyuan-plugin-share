// Isolated behavior coverage for export selection and cancellation admission.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');
const dom = new JSDOM(`<body><form action="/export" data-pdf-export-form data-max-docs="1"><select data-pdf-scope><option value="single">Single</option><option value="selected">Selected</option></select><div data-pdf-root></div><fieldset data-pdf-selection><input data-pdf-filter><button type="button" data-pdf-clear>Clear</button><p data-pdf-filter-empty hidden></p><label><input type="checkbox" name="doc_ids[]" value="a">Course / Alpha</label><label><input type="checkbox" name="doc_ids[]" value="b">Course / Beta</label></fieldset><div data-pdf-challenge hidden><button data-pdf-captcha-refresh></button><input name="captcha_answer"></div><input name="csrf" value="fixture"><input name="ticket" value="fixture"><p data-pdf-selected-count></p><button type="submit">Export</button><div class="pdf-progress" data-pdf-progress hidden><div class="pdf-progress-label"><span data-pdf-progress-title>Estimated progress</span><span data-pdf-percent>0%</span></div><progress max="100" value="0"></progress><div class="pdf-progress-meta" data-pdf-timing hidden><span data-pdf-elapsed></span><span data-pdf-eta></span></div></div><p data-pdf-form-status></p></form><div data-pdf-quota='{"remaining":10,"limit":10,"window_seconds":3600,"used":0}'></div><iframe data-pdf-worker></iframe></body>`, {url:'https://fixture.test/export',runScripts:'outside-only'});
try {
 const w=dom.window,d=w.document;
 w.matchMedia=()=>({matches:true});
 w.fetch=async()=>({ok:true,arrayBuffer:async()=>new ArrayBuffer(0)});
 const scriptSource = fs.readFileSync(path.join(__dirname,'../php-site/assets/pdf-export.js'),'utf8');
 w.eval(scriptSource);
 const quotaText = d.querySelector('[data-pdf-quota]').textContent;
 assert.match(quotaText, /10 documents remaining · 10 per 60 minutes/);
 assert.equal(d.querySelectorAll('[data-pdf-quota] details').length, 0);
 assert.ok(!quotaText.includes('Quota and recovery details'));
 assert.ok(!quotaText.includes('Quota recovers per document'));
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
 // Verify dialog progress/timing message propagation.
 const worker = d.querySelector('[data-pdf-worker]');
 w.dispatchEvent(new w.MessageEvent('message', {
  origin: 'https://fixture.test',
  source: worker.contentWindow,
  data: { type: 'sps-pdf-export', state: 'progress', message: 'Document 1 / 2: Rendering pages 2 / 4…', percent: 42.7, elapsedText: 'Elapsed 0:08', etaText: 'About 15s remaining', completedCount: 0, totalCount: 2 }
 }));
 assert.equal(d.querySelector('[data-pdf-progress]').hidden, false);
 assert.equal(d.querySelector('[data-pdf-progress] progress').value, 42);
 assert.equal(d.querySelector('[data-pdf-percent]').textContent, '42%');
 assert.equal(d.querySelector('[data-pdf-timing]').hidden, false);
 assert.equal(d.querySelector('[data-pdf-elapsed]').textContent, 'Elapsed 0:08');
 assert.equal(d.querySelector('[data-pdf-eta]').textContent, 'About 15s remaining');
 assert.equal(d.querySelector('[data-pdf-form-status]').textContent, 'Document 1 / 2: Rendering pages 2 / 4…');
 console.log('PDF UI passed: count, empty/over-limit prevention, filter, retained hidden selections, clear, quota summary, and timing progress.');
} finally {dom.window.close();}

// Verify byte-weighted multi-document progress and EMA ETA calculation in runJob.
(async () => {
 const jobDom = new JSDOM(`<body>
  <div data-pdf-preview data-pdf-job="1" data-pdf-auto="0" data-pdf-renew-after="60" data-export-url="https://fixture.test/export" data-lease="lease1" data-csrf="csrf1">
   <div class="pdf-progress" data-pdf-progress hidden>
    <div class="pdf-progress-label"><span data-pdf-progress-title>Estimated progress</span><span data-pdf-percent>0%</span></div>
    <progress max="100" value="0"></progress>
    <div class="pdf-progress-meta" data-pdf-timing hidden><span data-pdf-elapsed></span><span data-pdf-eta></span></div>
   </div>
   <p data-pdf-status role="status"></p>
   <button type="button" data-pdf-download>Download</button>
  </div>
  <script type="application/json" data-pdf-manifest>[{"title":"Short","source":"/s/a","bytes":1000},{"title":"Long","source":"/s/b","bytes":20000}]</script>
 </body>`, { url: 'https://fixture.test/export/job', runScripts: 'outside-only' });
 try {
  const w = jobDom.window, d = w.document;
  w.URL.createObjectURL = () => 'blob:mock';
  w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = () => {};
  w.fetch = async () => ({ ok: true, json: async () => ({ ok: true, renew_after: 60 }) });
  const scriptSource = fs.readFileSync(path.join(__dirname, '../php-site/assets/pdf-export.js'), 'utf8');
  w.eval(scriptSource);
  const submitOrig = w.HTMLFormElement.prototype.submit;
  const events = [];
  w.HTMLFormElement.prototype.submit = function () {
   const frame = d.querySelector(`iframe[name="${this.target}"]`);
   const docIndex = Number(this.querySelector('input[name="index"]').value);
   setTimeout(() => {
    const fakeChild = { querySelector: () => ({}) };
    Object.defineProperty(frame, 'contentDocument', { value: fakeChild, configurable: true });
    w.dispatchEvent(new w.MessageEvent('message', { origin: 'https://fixture.test', source: frame.contentWindow, data: { type: 'sps-pdf-document', index: docIndex, progress: 0.25, message: 'Rendering pages 0 / 4…', page: 0, totalPages: 4 } }));
    w.dispatchEvent(new w.MessageEvent('message', { origin: 'https://fixture.test', source: frame.contentWindow, data: { type: 'sps-pdf-document', index: docIndex, progress: 0.4125, message: 'Rendering pages 1 / 4…', page: 1, totalPages: 4, pageMs: 2500 } }));
    events.push({ docIndex, afterPage1Percent: d.querySelector('[data-pdf-progress] progress').value, etaAfterPage1: d.querySelector('[data-pdf-eta]').textContent });
    w.dispatchEvent(new w.MessageEvent('message', { origin: 'https://fixture.test', source: frame.contentWindow, data: { type: 'sps-pdf-document', index: docIndex, progress: 0.575, message: 'Rendering pages 2 / 4…', page: 2, totalPages: 4, pageMs: 2500 } }));
    events.push({ docIndex, afterPage2Percent: d.querySelector('[data-pdf-progress] progress').value, etaAfterPage2: d.querySelector('[data-pdf-eta]').textContent });
    w.dispatchEvent(new w.MessageEvent('message', { origin: 'https://fixture.test', source: frame.contentWindow, data: { type: 'sps-pdf-document', index: docIndex, blob: new w.Blob(['%PDF-1.4']) } }));
   }, 5);
  };
  d.querySelector('[data-pdf-download]').click();
  await new Promise((resolve, reject) => {
   const limit = Date.now() + 5000;
   const poll = () => {
    if (d.querySelector('[data-pdf-status]').textContent.includes('Started 2 individual PDF downloads')) return resolve();
    if (Date.now() > limit) return reject(new Error('Timed out waiting for runJob completion: ' + d.querySelector('[data-pdf-status]').textContent));
    setTimeout(poll, 10);
   };
   poll();
  });
  w.HTMLFormElement.prototype.submit = submitOrig;
  assert.equal(events.length, 4);
  // Short doc weight = 5096, Long doc weight = 24096 => Short doc is ~17.5% of total weight, not 50%.
  assert.ok(events[1].afterPage2Percent < 20, `Short doc should stay below 20% weighted progress, got ${events[1].afterPage2Percent}`);
  assert.match(events[1].etaAfterPage2, /About .* remaining|Less than 5s remaining/);
  assert.equal(d.querySelector('[data-pdf-progress] progress').value, 100);
  assert.equal(d.querySelector('[data-pdf-percent]').textContent, '100%');
  assert.match(d.querySelector('[data-pdf-elapsed]').textContent, /^Completed in \d+:\d{2}$/);
  assert.equal(d.querySelector('[data-pdf-eta]').textContent, '');
  console.log('PDF runJob passed: byte-weighted progress, EMA ETA, and completion timing.');
 } finally { jobDom.window.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
