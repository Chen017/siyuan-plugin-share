/* Exercise the shipped no-build entry point against a disposable SiYuan host. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto, createHash } = require('node:crypto');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const plain = (value) => JSON.parse(JSON.stringify(value));

function host({ mobile = false, locale = 'en_US', stored = {}, exportMarkdown = '', kramdown = '', sqlRows = [], appVersion = '3.8.9', confirmAccepted = true } = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://siyuan.invalid/' });
  const storage = new Map(Object.entries(structuredClone(stored)));
  const listeners = new Map();
  const timers = new Map();
  const requests = [];
  const kernelRequests = [];
  const confirmCalls = [];
  const errors = [];
  let acceptConfirm = confirmAccepted;
  let timerId = 0;
  class Plugin {
    constructor() {
      this.name = 'siyuan-plugin-share';
      this.i18n = JSON.parse(fs.readFileSync(path.join(root, 'i18n', locale + '.json'), 'utf8'));
      this.eventBus = {
        on: (name, fn) => listeners.set(name, fn),
        off: (name, fn) => { assert.equal(listeners.get(name), fn); listeners.delete(name); },
      };
    }
    async loadData(key) { return structuredClone(storage.get(key)); }
    async saveData(key, value) { storage.set(key, plain(value)); }
    async removeData(key) { storage.delete(key); }
    addIcons() {}
    addCommand(command) { this.command = command; }
  }
  class Setting {
    addItem() {}
  }
  const module = { exports: {} };
  const schedule = (fn) => { timers.set(++timerId, fn); return timerId; };
  const sandbox = {
    module, console: { ...console, error: (...args) => errors.push(args.map(String).join(' ')) },
    window: dom.window, document: dom.window.document,
    location: dom.window.location,
    navigator: dom.window.navigator, MutationObserver: dom.window.MutationObserver,
    URL, URLSearchParams, TextEncoder, TextDecoder, Blob, FormData, AbortController,
    crypto: webcrypto, setTimeout: schedule, setInterval: schedule,
    clearTimeout: (id) => timers.delete(id), clearInterval: (id) => timers.delete(id),
    require(name) {
      if (name === 'siyuan') return {
        Plugin, Setting, getAllEditor: () => [], showMessage() {},
        confirm(title, text, yes, no) { confirmCalls.push({title, text}); if (acceptConfirm) yes?.(); else no?.(); },
        Dialog: class {
          constructor(opts = {}) {
            this.element = dom.window.document.createElement('div');
            this.element.innerHTML = opts.content || '';
            this._destroy = opts.destroyCallback;
          }
          destroy() { this._destroy?.(); }
        },
        fetchSyncPost: async (url, body) => {
          kernelRequests.push({url, body: plain(body)});
          if (url === '/api/export/exportMdContent') return { code: 0, data: {hPath: '/Fixture', content: exportMarkdown} };
          if (url === '/api/block/getBlockKramdown') return { code: 0, data: {id: body?.id || '', kramdown} };
          if (url === '/api/query/sql') return { code: 0, data: sqlRows };
          if (url === '/api/system/version') return { code: 0, data: appVersion };
          return { code: 0, data: {} };
        },
      };
      if (mobile) throw new Error('Node builtins are unavailable in the mobile frontend');
      return require(name);
    },
    async fetch(url, options) {
      requests.push({ url, options });
      if (options.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      return { ok: true, json: async () => ({ code: 0, data: { accepted: true } }) };
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'index.js'), 'utf8') +
    '\n;globalThis.testHelpers = {withRetry, buildDocMetaHashInput, extractMissingSameDocBlockAnchorIds, parseKramdownOrderedBlocks, injectMissingBlockAnchorsInMarkdown};', sandbox, { filename: 'index.js' });
  const plugin = new module.exports();
  // Background networking and real editor observation belong to the host integration.
  for (const name of ['bindDocTreeLater', 'refreshCurrentDocContext', 'startBackgroundSync', 'refreshAutoUpdateLoop']) {
    plugin[name] = () => {};
  }
  return { plugin, storage, listeners, timers, requests, kernelRequests, confirmCalls, setConfirmAccepted: (v) => { acceptConfirm = !!v; }, sandbox, close() {
    dom.window.close();
    assert.deepEqual(errors, [], 'Plugin bootstrap must not hide asynchronous errors');
  } };
}

(async () => {
  {
    const fixture = host({mobile: true});
    try {
      let shown;
      fixture.sandbox.console.error = () => {}; // showErr logs these expected errors.
      fixture.plugin.notify = message => { shown = message; };
      fixture.plugin.showErr(new Error('Failed to fetch'));
      assert.equal(shown, fixture.plugin.t('siyuanShare.error.networkFail'));
    } finally { fixture.close(); }
  }

  // Same-document block reference anchor injection: duplicate headings, paragraphs,
  // list items, math blocks, cross-doc footnotes, and fenced code blocks.
  {
    const docId = '20261119083700-docroot';
    const def1Id = '20261119083945-cy31h7h';
    const def2Id = '20261119091000-def2222';
    const def3Id = '20261119092000-def3333';
    const prop1Id = '20261119090213-69394ce';
    const prop2Id = '20261119093000-prop222';
    const thmId = '20261119090213-t2n1juy';
    const stepId = '20261119094000-step111';
    const mathId = '20261119095000-math111';
    const kramdown = [
      '## Orientation for Regular Surfaces',
      '{: id="20261119083800-h2first"}',
      '',
      '### **Definition**',
      `{: id="${def1Id}"}`,
      '',
      'An orientation of a regular surface $S$ is a map.',
      '{: id="20261119083950-p111111"}',
      '',
      '### **Proposition**',
      `{: id="${prop1Id}"}`,
      '',
      'Let $S$ be a regular surface and $N$ a unit normal vector field.',
      '{: id="20261119090220-p222222"}',
      '',
      '1. First proof step is continuous.',
      `{: id="${stepId}"}`,
      '',
      '### **Theorem**',
      `{: id="${thmId}"}`,
      '',
      '$$',
      'F(q) = 1',
      '$$',
      `{: id="${mathId}"}`,
      '',
      '### **Definition**',
      `{: id="${def2Id}"}`,
      '',
      'An oriented surface is a pair.',
      '{: id="20261119091010-p333333"}',
      '',
      '### **Definition**',
      `{: id="${def3Id}"}`,
      '',
      'An atlas is an oriented atlas.',
      '{: id="20261119092010-p444444"}',
      '',
      '### **Proposition**',
      `{: id="${prop2Id}"}`,
      '',
      'Uniqueness.',
      '{: id="20261119093010-p555555"}',
      '',
      `{: id="${docId}"}`,
    ].join('\n');

    const exportMarkdown = [
      '## Orientation for Regular Surfaces',
      '',
      '### **Definition**',
      '',
      'An orientation of a regular surface $S$ is a map.',
      '',
      '### **Proposition**',
      '',
      'Let $S$ be a regular surface and $N$ a unit normal vector field.',
      '',
      '1. First proof step is continuous.',
      '',
      '### **Theorem**',
      '',
      '$$',
      'F(q) = 1',
      '$$',
      '',
      '### **Definition**',
      '',
      'An oriented surface is a pair.',
      '',
      '### **Definition**',
      '',
      'An atlas is an oriented atlas.',
      '',
      '### **Proposition**',
      '',
      'Uniqueness.',
      '',
      `By [proposition](#${prop1Id}), [definition of orientation](#${def1Id}), [step 1](#${stepId}), [formula](#${mathId}), and [theorem](#${thmId})[^1].`,
      '',
      '```md',
      '[code link](#20261119099999-code999)',
      '```',
      '',
      '[^1]: Cross-doc footnote.',
    ].join('\n');

    const refFixture = host({ mobile: true, exportMarkdown, kramdown });
    try {
      const exported = await refFixture.plugin.exportDocMarkdown(docId);
      assert.equal(refFixture.kernelRequests.length, 2, 'Only fetches Kramdown when missing same-doc anchors exist');
      assert.equal(refFixture.kernelRequests[1].url, '/api/block/getBlockKramdown');
      const lines = exported.content.split(/\r?\n/);
      assert(lines[2].includes(`<span id="${def1Id}" class="sps-block-anchor"></span>`), 'First Definition gets def1Id anchor');
      assert(!lines[18].includes(def1Id) && !lines[22].includes(def1Id), 'Duplicate Definition headings are not mis-tagged');
      assert(lines[6].includes(`<span id="${prop1Id}" class="sps-block-anchor"></span>`), 'First Proposition gets prop1Id anchor');
      assert(lines[10].includes(`<span id="${stepId}" class="sps-block-anchor"></span>`), 'List item gets stepId anchor');
      assert(lines[12].includes(`<span id="${thmId}" class="sps-block-anchor"></span>`), 'Theorem heading gets thmId anchor');
      const mathAnchorIdx = exported.content.indexOf(`<span id="${mathId}" class="sps-block-anchor" data-sps-anchor-pos="before"></span>`);
      assert(mathAnchorIdx >= 0 && mathAnchorIdx < exported.content.indexOf('$$\nF(q) = 1'), 'Math block gets anchor placed before $$');
      assert(!exported.content.includes('20261119099999-code999" class="sps-block-anchor"'), 'Code block links are ignored');
      assert.deepEqual(plain(refFixture.sandbox.testHelpers.extractMissingSameDocBlockAnchorIds(exported.content)), [], 'No missing anchor IDs remain after injection');
    } finally { refFixture.close(); }
  }

  // Real SiYuan container Kramdown formats (inline list-item IAL, trailing container IALs for
  // multi-paragraph list items, lists, blockquotes, superblocks), zero-width space, bracketed
  // link text, images, deeply nested lists, math inside lists, and SQL parent_id fallback.
  {
    const docId = '20261124103520-2htohim';
    const item1Id = '20261124103521-ny54ujx';
    const item2Id = '20261124103521-9ledboo';
    const listId = '20261124103521-list111';
    const bqId = '20261124103521-bq11111';
    const sbId = '20261124103521-sb11111';
    const imgParaId = '20261124103521-img1111';
    const deepId = '20261124103521-deep111';
    const listMathId = '20261124103521-lmath11';

    const realKramdown = [
      `1. {: id="${item1Id}"}`,
      '   $R=\\Z$',
      '   {: id="20261124103521-c111111"}',
      '',
      '   $\\forall a,b\\neq 0,\\exist ! q,r\\in \\Z:a=qb+r$',
      '   {: id="20261124103521-c111112"}',
      '',
      `2. {: id="${item2Id}"}`,
      '   $R=\\mathbb{F}[x]$',
      '   {: id="20261124103521-c222221"}',
      '',
      '   $\\forall a(x),b(x)\\neq 0,\\exist ! q(x),r(x)$',
      '   {: id="20261124103521-c222222"}',
      `{: id="${listId}"}`,
      '',
      '> Quote first paragraph',
      '> {: id="20261124103521-qp11111"}',
      '>',
      '> Quote second paragraph',
      '> {: id="20261124103521-qp22222"}',
      `{: id="${bqId}"}`,
      '',
      '{{{row',
      'Superblock leading text',
      '{: id="20261124103521-sbp1111"}',
      '}}}',
      `{: id="${sbId}"}`,
      '',
      '![image](assets/pic.png)',
      `{: id="${imgParaId}"}`,
      '',
      '        - Deep level 3 bullet',
      `          {: id="${deepId}"}`,
      '',
      '   $$',
      '   a = qb + r',
      '   $$',
      `   {: id="${listMathId}"}`,
      '',
      `{: id="${docId}"}`,
    ].join('\n');

    const realExportMarkdown = [
      '## Euclidean Domains',
      '',
      '1. $R=\\Z$  ',
      '   \u200b$\\forall a,b\\neq 0,\\exist ! q,r\\in \\Z:a=qb+r$',
      '2. $R=\\mathbb{F}[x]$  ',
      '   \u200b$\\forall a(x),b(x)\\neq 0,\\exist ! q(x),r(x)$',
      '',
      '> Quote first paragraph',
      '>',
      '> Quote second paragraph',
      '',
      'Superblock leading text',
      '',
      '<img alt="image" src="assets/pic.png" />',
      '',
      '- Level 1',
      '    - Level 2',
      '        - Deep level 3 bullet',
      '',
      '   $$',
      '   a = qb + r',
      '   $$',
      '',
      `Refs: [this](#${item1Id}), [$R=\\mathbb{F}[x]$](#${item2Id}), [whole list](#${listId}), [quote](#${bqId}), [super](#${sbId}), [img](#${imgParaId}), [deep](#${deepId}), [listmath](#${listMathId}).`,
    ].join('\n');

    const containerFixture = host({ mobile: true, exportMarkdown: realExportMarkdown, kramdown: realKramdown });
    try {
      const exported = await containerFixture.plugin.exportDocMarkdown(docId);
      const outLines = exported.content.split(/\r?\n/);
      const item1Line = outLines.find((l) => l.includes('$R=\\Z$') && l.includes('1.'));
      assert(
        item1Line &&
          item1Line.includes(`<span id="${item1Id}" class="sps-block-anchor" data-sps-anchor-kind="list-item"></span>`) &&
          item1Line.endsWith('  '),
        'List item 1 keeps trailing hard-break spaces and list-item anchor kind',
      );
      assert(exported.content.includes(`<span id="${item2Id}" class="sps-block-anchor" data-sps-anchor-kind="list-item"></span>`), 'Bracketed link text triggers injection for list item 2');
      assert(exported.content.includes(`<span id="${listId}" class="sps-block-anchor" data-sps-anchor-kind="list"></span>`), 'Trailing list container ID is bound to first list item');
      assert(exported.content.includes(`<span id="${bqId}" class="sps-block-anchor" data-sps-anchor-kind="blockquote"></span>`), 'Trailing blockquote container ID is bound to quote');
      assert(exported.content.includes(`<span id="${sbId}" class="sps-block-anchor" data-sps-anchor-kind="superblock"></span>`), 'Superblock delimiter {{{row / }}} does not break superblock anchor');
      assert(exported.content.includes(`<span id="${imgParaId}" class="sps-block-anchor"></span>`), 'Image block anchor matches across Kramdown ![] and <img/>');
      assert(exported.content.includes(`<span id="${deepId}" class="sps-block-anchor"></span>`), 'Deeply nested (>6 spaces) list item gets anchored');
      const mathBeforeLine = outLines.find((l) => l.includes(`<span id="${listMathId}" class="sps-block-anchor" data-sps-anchor-pos="before"></span>`));
      assert(mathBeforeLine && mathBeforeLine.startsWith('   <span'), 'Before-anchor inside indented block preserves leading indentation');
      assert.deepEqual(plain(containerFixture.sandbox.testHelpers.extractMissingSameDocBlockAnchorIds(exported.content)), [], 'All 8 same-doc references are resolved');
    } finally { containerFixture.close(); }

    // SQL fallback runs automatically when Kramdown omits a missing container ID.
    const sqlChildId = '20261124103522-sqlchd1';
    const sqlItemId = '20261124103522-sqlitm1';
    const sqlFixture = host({
      mobile: true,
      exportMarkdown: `1. First item\n\n   Second line\n\nSee [target](#${sqlItemId}).`,
      kramdown: `1. Only unrelated\n{: id="20261124103522-other01"}\n{: id="${docId}"}`,
      sqlRows: [
        { id: sqlItemId, parent_id: docId, type: 'i', subtype: 'o', content: 'First item', markdown: '1. First item\n\n   Second line', sort: 10 },
        { id: sqlChildId, parent_id: sqlItemId, type: 'p', subtype: '', content: 'First item', markdown: 'First item', sort: 11 },
      ],
    });
    try {
      const exported = await sqlFixture.plugin.exportDocMarkdown(docId);
      assert(sqlFixture.kernelRequests.some((r) => r.url === '/api/query/sql'), 'SQL fallback runs when Kramdown misses referenced IDs');
      assert(exported.content.includes(`<span id="${sqlItemId}" class="sps-block-anchor" data-sps-anchor-kind="list-item"></span>`), 'SQL fallback resolves container block to first child leaf');
    } finally { sqlFixture.close(); }
  }

  // forceFull and republishAllNotebooks: force re-export + overwrite upload across all notebook shares.
  {
    const nb1Id = '20261027000001-nb11111';
    const nb2Id = '20261027000002-nb22222';
    const doc1Id = '20261027000003-doc1111';
    const doc2Id = '20261027000004-doc2222';
    const singleDocId = '20261027000005-single1';
    const hash = (text) => createHash('sha256').update(text).digest('hex');
    const allShares = [
      { id: 'share-doc-1', type: 'doc', docId: singleDocId, title: 'Doc Share', slug: 'doc1' },
      { id: 'share-nb-1', type: 'notebook', notebookId: nb1Id, title: 'Notebook 1', slug: 'nb1' },
      { id: 'share-nb-2', type: 'notebook', notebookId: nb2Id, title: 'Notebook 2', slug: 'nb2' },
    ];
    const reFixture = host({
      mobile: true,
      locale: 'en_US',
      stored: {
        settings: { siteUrl: 'https://note.etalib.space', apiKey: 'key' },
        sharesBySite: { personal: allShares },
      },
    });
    try {
      const { plugin, confirmCalls } = reFixture;
      await plugin.loadState();
      plugin.shares = structuredClone(allShares);
      plugin.notebooks = [{ id: nb1Id, name: 'Notebook 1' }, { id: nb2Id, name: 'Notebook 2' }];
      const buildMeta = reFixture.sandbox.testHelpers.buildDocMetaHashInput;
      const uploadedDocsByNb = new Map();
      const notifications = [];
      let failNb2 = false;
      Object.assign(plugin, {
        verifyRemote: async () => {},
        syncRemoteShares: async () => plugin.shares,
        refreshNotebookOptions: async () => {},
        supportsIncrementalShare: () => true,
        supportsDocChunkUpload: () => false,
        listDocsInNotebook: async (nbId) => ({
          docs: nbId === nb1Id
            ? [{ docId: doc1Id, title: 'Doc 1', sortIndex: 0, sortOrder: 0 }]
            : [{ docId: doc2Id, title: 'Doc 2', sortIndex: 0, sortOrder: 0 }],
        }),
        fillDocIcons: async () => {},
        fetchShareSnapshot: async (shareId) => {
          const id = shareId === 'share-nb-1' ? doc1Id : doc2Id;
          const title = shareId === 'share-nb-1' ? 'Doc 1' : 'Doc 2';
          const md = 'unchanged markdown';
          const metaInput = buildMeta({ title, icon: '', parentId: '', sortOrder: 0, sortIndex: 0 });
          return { docs: [{ docId: id, title, contentHash: hash(md), metaHash: hash(metaInput) }], assets: [] };
        },
        collectIncrementalCandidateDocIds: async () => { throw new Error('forceFull must skip incremental precheck'); },
        collectDocExportResults: async (docs) => docs.map((doc, index) => ({
          doc, index, exportRes: { hPath: '/' + doc.title }, markdown: 'unchanged markdown', assets: [], failures: [],
        })),
        resolveIconUpload: async () => '',
        maybeWarnExportReference: async () => { throw new Error('republishAllNotebooks must skip interactive warnings'); },
        remoteRequest: async (reqPath, options) => {
          if (reqPath.endsWith('/init')) {
            const nbId = options.body?.metadata?.notebookId;
            if (failNb2 && nbId === nb2Id) throw new Error('Simulated upload error');
            uploadedDocsByNb.set(nbId, (options.body?.metadata?.docs || []).map(d => d.docId));
          }
          return { uploadId: 'upload-' + (options.body?.metadata?.notebookId || 'x') };
        },
        uploadAssetsChunked: async () => {},
        updateSharePasswordCache: async () => {},
        setIncrementalCursor: async () => {},
        refreshDocBlockCountCacheForShare: async () => {},
        syncAutoUpdateStructDigestAfterShareSuccess: async () => {},
        notify: (msg) => notifications.push(msg),
      });

      // Verify Settings and Dock render the button
      plugin.initSettingPanel();
      assert(plugin.settingEls.sharesWrap.querySelector('[data-action="republish-all-notebooks"]'), 'Settings panel renders republish-all button');
      const dockEl = reFixture.sandbox.document.createElement('div');
      plugin.dockElement = dockEl;
      plugin.renderDock();
      assert(dockEl.querySelector('[data-action="republish-all-notebooks"]'), 'Dock panel renders republish-all button');

      // Cancel does nothing
      reFixture.setConfirmAccepted(false);
      await plugin.republishAllNotebooks();
      assert.equal(confirmCalls.length, 1);
      assert.equal(uploadedDocsByNb.size, 0, 'Cancelled republish uploads nothing');

      // Accept republishes both notebooks (skipping doc share) even with identical hashes
      reFixture.setConfirmAccepted(true);
      await plugin.republishAllNotebooks();
      assert.deepEqual(plain(uploadedDocsByNb.get(nb1Id)), [doc1Id], 'Notebook 1 docs forced into upload despite matching hashes');
      assert.deepEqual(plain(uploadedDocsByNb.get(nb2Id)), [doc2Id], 'Notebook 2 docs forced into upload despite matching hashes');
      assert(notifications.at(-1).includes('2'), 'Completion notification reports 2 notebooks');

      // Partial failure continues to remaining notebooks
      uploadedDocsByNb.clear();
      failNb2 = true;
      await plugin.republishAllNotebooks();
      assert.deepEqual(plain(uploadedDocsByNb.get(nb1Id)), [doc1Id]);
      assert(notifications.at(-1).includes('1 succeeded, 1 failed'), 'Partial failure summarizes counts');
    } finally { reFixture.close(); }
  }

  // The shared export path is used by initial publication and subsequent sync.
  // A pre-3.3 host ignores imgTag and still returns its Markdown unchanged.
  for (const {markdown, expected, path, uploadPath} of [
    {markdown: '<img alt="diagram" src="assets/diagram.png" style="width: 320px;" />', path: 'assets/diagram.png', uploadPath: 'assets/diagram.png'},
    {markdown: '<img alt="diagram" src="assets/a%20b.png" style="width: 320px;" />', expected: '<img alt="diagram" src="assets/ab.png" style="width: 320px;" />', path: 'assets/a%20b.png', uploadPath: 'assets/ab.png'},
    {markdown: '![diagram](assets/diagram.png)', path: 'assets/diagram.png', uploadPath: 'assets/diagram.png'},
  ]) {
    const fixture = host({mobile: true, exportMarkdown: markdown});
    try {
      const exported = await fixture.plugin.exportDocMarkdown('20261027000000-aaaaaaa');
      assert.deepEqual(fixture.kernelRequests, [{url: '/api/export/exportMdContent', body: {id: '20261027000000-aaaaaaa', imgTag: true}}]);
      assert.equal(exported.content, markdown);
      const fetched = [];
      fixture.plugin.fetchAssetBlob = async (assetPath) => {
        fetched.push(assetPath);
        return {path: assetPath, blob: new Blob(['image'])};
      };
      const prepared = await fixture.plugin.prepareMarkdownAssets(exported.content, new AbortController());
      assert.equal(prepared.markdown, expected || markdown, 'Image dimensions survive asset preparation');
      assert.deepEqual(fetched, [path]);
      assert.deepEqual(plain(prepared.assets).map((asset) => asset.path), [uploadPath]);
      assert.equal(prepared.failures.length, 0);
    } finally { fixture.close(); }
  }

  for (const mobile of [false, true]) {
    const fixture = host({ mobile, locale: mobile ? 'zh_CN' : 'en_US' });
    try {
      const { plugin, timers, listeners } = fixture;
      assert.equal(plugin.hasNodeFs, !mobile);
      plugin.onload();
      await new Promise(setImmediate); // Finish the actual asynchronous state bootstrap.
      assert.equal(listeners.size, 6, 'SiYuan event callbacks remain registered');
      assert.equal(typeof plugin.command.callback, 'function');
      plugin.docTreeBindTimer = fixture.sandbox.setInterval(() => {}, 1000);
      plugin.docTreeRefreshTimer = fixture.sandbox.setTimeout(() => {}, 1000);
      plugin.autoUpdateWsFlushTimer = fixture.sandbox.setTimeout(() => {}, 1000);
      plugin.autoUpdateShareStates = { old: { state: 'syncing' } };
      plugin.onunload();
      await new Promise(setImmediate);
      assert.equal(listeners.size, 0);
      assert.equal(timers.size, 0, 'Disable clears scheduled work');
      assert.deepEqual(plain(plugin.autoUpdateShareStates), {});
      assert.equal(plugin.isUnloading, true);
    } finally { fixture.close(); }
  }

  const oldShare = { id: 'share-old', type: 'doc', docId: '20261027000000-aaaaaaa', slug: 'kept' };
  const fixture = host({ mobile: true, stored: {
    settings: { siteUrl: 'https://note.etalib.space', apiKey: 'existing-key' },
    shares: [{...oldShare,visitorLimit:1,visitorCount:4}],
  } });
  try {
    const { plugin, storage, requests, sandbox, timers } = fixture;
    await plugin.loadState();
    const siteId = plugin.settings.activeSiteId;
    assert(siteId);
    assert.equal(plugin.settings.apiKey, 'existing-key');
    assert.deepEqual(plain(plugin.shares), [oldShare]);
    assert.deepEqual(plain(storage.get('shares')), [oldShare], 'Retire only visitor fields in legacy share cache');
    assert.deepEqual(storage.get('sharesBySite')[siteId], [oldShare]);
    await plugin.loadState();
    assert.equal(plugin.settings.activeSiteId, siteId, 'Old settings migration is idempotent');

    const ids = ['aaaaaaa', 'bbbbbbb', 'ccccccc', 'ddddddd'].map((suffix) => '20261027000000-' + suffix);
    const hash = (text) => createHash('sha256').update(text).digest('hex');
    const remoteSnapshot = {
      docs: [0, 1, 2].map((i) => ({ docId: ids[i], contentHash: hash('old'), metaHash: hash('meta') })),
      assets: [
        { path: 'assets/keep.png', docId: ids[0], hash: hash('keep') },
        { path: 'assets/remove.png', docId: ids[1], hash: hash('old') },
        { path: 'assets/deleted.png', docId: ids[2], hash: hash('old') },
      ],
    };
    const changed = { docId: ids[1], title: 'Changed', markdown: 'new', contentHash: hash('new'), metaHash: hash('meta') };
    const added = { docId: ids[3], title: 'Added', markdown: 'added', contentHash: hash('added'), metaHash: hash('meta') };
    const args = {
      scopeDocs: [ids[0], ids[1], ids[3]].map((docId) => ({ docId })),
      exportedDocs: [changed, added], remoteSnapshot,
      assetEntries: [{ docId: ids[1], asset: { path: 'assets/new.png', blob: new Blob(['new-image']) } }],
    };
    const plan = await plugin.buildScopedIncrementalPlan(args);
    assert.deepEqual(plain(plan.uploadDocs).map((doc) => doc.docId), [ids[1], ids[3]]);
    assert.deepEqual(plain(plan.deletedDocIds), [ids[2]]);
    assert.deepEqual(plain(plan.deletedAssetPaths), ['assets/remove.png', 'assets/deleted.png']);
    const protectedPlan = await plugin.buildScopedIncrementalPlan({...args, preserveExistingAssets: true});
    assert.deepEqual(plain(protectedPlan.deletedAssetPaths), [], 'A missing local attachment preserves every existing online asset, including assets shared by multiple documents');
    assert.equal(plan.uploadAssets[0].hash, hash('new-image'));
    assert.equal(plugin.isIncrementalPlanNoop(plan), false);
    const unchanged = await plugin.buildScopedIncrementalPlan({ scopeDocs: remoteSnapshot.docs, remoteSnapshot });
    assert.equal(plugin.isIncrementalPlanNoop(unchanged), true);

    const payload = { uploadId: 'pending-upload', docs: plain(plan.uploadDocs), deletedDocIds: plain(plan.deletedDocIds) };
    assert.deepEqual(plain(await plugin.remoteRequest('/api/v1/shares/upload/complete', { body: payload, silent: true })), { accepted: true });
    assert.equal(requests[0].url, 'https://note.etalib.space/api/v1/shares/upload/complete');
    assert.equal(requests[0].options.headers['X-Api-Key'], 'existing-key');
    assert.deepEqual(JSON.parse(requests[0].options.body), payload);

    let attempts = 0;
    assert.equal(await sandbox.testHelpers.withRetry(async () => {
      if (++attempts < 3) throw new Error('Transient upload failure');
      return 'uploaded';
    }, { retries: 2 }), 'uploaded');
    assert.equal(attempts, 3);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(plugin.buildScopedIncrementalPlan(args, { controller }), { name: 'AbortError' });
    await assert.rejects(plugin.remoteRequest('/api/v1/shares/upload/complete', { body: payload, controller, silent: true }), { name: 'AbortError' });
    await assert.rejects(sandbox.testHelpers.withRetry(() => { throw new Error('Must not run'); }, { controller }), { name: 'AbortError' });
    await plugin.cancelUploadSession('pending-upload');
    assert.equal(requests.at(-1).options.signal.aborted, false, 'Cleanup uses an independent request after user cancellation');
    assert.equal(timers.size, 0, 'Cleanup timeout is cleared');

    sandbox.siyuan = {config: {api: {token: 'SYNTHETIC_TOKEN'}}};
    const icons = [];
    sandbox.fetch = async (url, options) => {
      icons.push({url, options});
      return {ok: true, headers: {get: () => 'image/png'}, blob: async () => new Blob(['icon'])};
    };
    assert.equal(await plugin.resolveIconUpload('//external.invalid/icon.png'), '//external.invalid/icon.png');
    assert.equal(icons.length, 0, 'External icons never enter the authenticated downloader');
    for (const target of ['https://external.invalid/api/icon', '//external.invalid/api/icon', '/api/../outside', 'https://user@siyuan.invalid/api/icon']) {
      await assert.rejects(plugin.fetchIconUrlBlob(target), /current SiYuan origin/);
    }
    await plugin.resolveIconUpload('/api/icon/test', {controller: new AbortController()});
    assert.equal(icons.length, 1);
    assert.equal(icons[0].url, 'https://siyuan.invalid/api/icon/test');
    assert.equal(icons[0].options.headers.Authorization, 'Token SYNTHETIC_TOKEN');
    assert.equal(icons[0].options.redirect, 'error', 'Authenticated icon requests cannot follow redirects');
  } finally { fixture.close(); }
  const multi = host({ mobile: true, stored: {
    settings: { activeSiteId: 'personal', sites: [
      { id: 'other', siteUrl: 'https://other.invalid', apiKey: 'other-key' },
      { id: 'personal', siteUrl: 'https://note.etalib.space/', apiKey: 'personal-key', autoUpdateEnabled: true, quietWindowSeconds: 90 },
    ] },
    sharesBySite: { personal: [oldShare], other: [{ id: 'other-share', type: 'doc' }] },
  } });
  try {
    await multi.plugin.loadState();
    assert.equal(multi.plugin.settings.activeSiteId, 'personal');
    assert.equal(multi.plugin.settings.siteUrl, 'https://note.etalib.space');
    assert.equal(multi.plugin.settings.apiKey, 'personal-key');
    assert.equal(multi.plugin.getActiveSite().autoUpdateEnabled, true);
    assert.equal(multi.plugin.getActiveSite().quietWindowSeconds, 90);
    assert.deepEqual(plain(multi.plugin.shares), [oldShare]);
    assert.deepEqual(multi.storage.get('settings').sites.map(site => site.id), ['personal'], 'Other site configurations are removed');
    await multi.plugin.loadState();
    assert.equal(multi.plugin.settings.activeSiteId, 'personal', 'Single-site migration is idempotent');
    multi.plugin.initSettingPanel();
    assert.equal(multi.plugin.settingEls.siteInput.readOnly, true, 'The personal site cannot be changed in settings');
    assert.equal(multi.plugin.settingEls.siteSelect, undefined);
    multi.plugin.settingEls.siteInput.value = 'https://other.invalid';
    multi.plugin.persistCurrentSiteInputs();
    assert.equal(multi.plugin.settings.siteUrl, 'https://note.etalib.space', 'UI input cannot override the fixed endpoint');
    let finishRequest;
    multi.plugin.remoteRequest = () => new Promise(resolve => { finishRequest = resolve; });
    const pendingShares = multi.plugin.syncRemoteShares({ silent: true });
    multi.plugin.settings.apiKey = 'replacement-key';
    finishRequest({ shares: [{ id: 'stale', type: 'doc' }] });
    await assert.rejects(pendingShares, /Connection changed/);
    assert.deepEqual(plain(multi.plugin.shares), [oldShare], 'Old-key responses cannot replace the current cache');
    multi.plugin.remoteVerifiedAt = 0;
    const pendingVerify = multi.plugin.verifyRemote({ silent: true });
    multi.plugin.settings.apiKey = 'newer-key';
    finishRequest({ user: { username: 'stale' } });
    await assert.rejects(pendingVerify, /Connection changed/);
    assert.notEqual(multi.plugin.remoteUser?.username, 'stale');
  } finally { multi.close(); }
  const switched = host({ mobile: true, stored: {
    settings: { activeSiteId: 'other', sites: [
      { id: 'other', siteUrl: 'https://other.invalid', apiKey: 'other-key' },
      { id: 'personal', siteUrl: 'https://note.etalib.space', apiKey: 'personal-key' },
    ] },
    shares: [oldShare],
  } });
  try {
    await switched.plugin.loadState();
    assert.equal(switched.plugin.settings.activeSiteId, 'personal');
    assert.equal(switched.plugin.settings.apiKey, 'personal-key');
    assert.deepEqual(plain(switched.plugin.shares), [], 'Old active-site shares cannot be migrated into the personal site');
  } finally { switched.close(); }
  const wrongSite = host({ mobile: true, stored: {
    settings: { activeSiteId: 'other', sites: [{ id: 'other', siteUrl: 'https://other.invalid', apiKey: 'other-key' }] },
    sharesBySite: { other: [oldShare] },
  } });
  try {
    await wrongSite.plugin.loadState();
    assert.equal(wrongSite.plugin.settings.siteUrl, 'https://note.etalib.space');
    assert.equal(wrongSite.plugin.settings.apiKey, '', 'An unrelated site key is never carried to the personal site');
    assert.deepEqual(plain(wrongSite.plugin.shares), [], 'Shares from an unrelated site are not adopted');
    assert.equal(wrongSite.plugin.settings.sites.length, 1);
  } finally { wrongSite.close(); }

  {
    // Regression test: Inserting a new document into a notebook must not trigger a ripple effect
    // on sibling/subsequent documents' sortOrder, which previously caused mass re-exports and false updated counts.
    const fixture = host({ mobile: true });
    try {
      const { plugin } = fixture;
      const buildMeta = fixture.sandbox.testHelpers.buildDocMetaHashInput;
      const hash = (text) => createHash('sha256').update(text).digest('hex');
      const docIds = ['aaaaaaa', 'bbbbbbb', 'ccccccc', 'ddddddd', 'eeeeeee'].map((s) => '20261027000000-' + s);
      const remoteDocs = docIds.map((id, index) => {
        const metaInput = buildMeta({
          title: 'Doc ' + index,
          icon: '',
          parentId: '',
          sortOrder: index,
          sortIndex: index,
        });
        return {
          docId: id,
          title: 'Doc ' + index,
          icon: '',
          parentId: '',
          sortOrder: index,
          sortIndex: index,
          contentHash: hash('content-' + index),
          metaHash: hash(metaInput),
        };
      });
      const remoteSnapshot = { docs: remoteDocs, assets: [] };

      // Simulate a local notebook scan where a new document is inserted at position 1,
      // shifting subsequent preorder sortOrders by +1.
      const newDocId = '20261027000000-fffffff';
      const rawLocalDocs = [
        { docId: docIds[0], title: 'Doc 0', icon: '', parentId: '', sortOrder: 0, sortIndex: 0 },
        { docId: newDocId, title: 'New Doc', icon: '', parentId: '', sortOrder: 1, sortIndex: 1 },
        { docId: docIds[1], title: 'Doc 1', icon: '', parentId: '', sortOrder: 2, sortIndex: 2 },
        { docId: docIds[2], title: 'Doc 2', icon: '', parentId: '', sortOrder: 3, sortIndex: 3 },
        { docId: docIds[3], title: 'Doc 3', icon: '', parentId: '', sortOrder: 4, sortIndex: 4 },
        { docId: docIds[4], title: 'Doc 4', icon: '', parentId: '', sortOrder: 5, sortIndex: 5 },
      ];

      // Step 1: Alignment must preserve existing remote sortIndex/sortOrder
      const aligned = plugin.alignScopeDocsWithRemoteSnapshot(rawLocalDocs, remoteSnapshot);
      const alignedMap = new Map(aligned.map((d) => [d.docId, d]));
      for (let i = 0; i < docIds.length; i++) {
        const existing = alignedMap.get(docIds[i]);
        assert.equal(existing.sortOrder, i, `Doc ${docIds[i]} sortOrder must be preserved`);
        assert.equal(existing.sortIndex, i, `Doc ${docIds[i]} sortIndex must be preserved`);
      }

      // Step 2: Structural change detection must only detect the new document,
      // NOT untouched subsequent siblings.
      const structChanged = plugin.collectStructChangedDocIds(aligned, remoteSnapshot);
      assert.deepEqual(plain(structChanged), [newDocId], 'Only the newly inserted doc should be marked structurally changed');

      // Step 3: Incremental plan with 1 new doc and 1 modified doc (docIds[2])
      const exportedDocs = [
        {
          docId: newDocId,
          title: 'New Doc',
          icon: '',
          parentId: '',
          sortOrder: alignedMap.get(newDocId).sortOrder,
          sortIndex: alignedMap.get(newDocId).sortIndex,
          markdown: 'New Content',
          contentHash: hash('New Content'),
          metaHash: hash(buildMeta(alignedMap.get(newDocId))),
        },
        {
          docId: docIds[2],
          title: 'Doc 2',
          icon: '',
          parentId: '',
          sortOrder: alignedMap.get(docIds[2]).sortOrder,
          sortIndex: alignedMap.get(docIds[2]).sortIndex,
          markdown: 'Edited Content',
          contentHash: hash('Edited Content'),
          metaHash: hash(buildMeta(alignedMap.get(docIds[2]))),
        },
      ];

      const plan = await plugin.buildScopedIncrementalPlan({
        scopeDocs: aligned,
        exportedDocs,
        remoteSnapshot,
        assetEntries: [],
      });

      assert.equal(plan.summary.totalDocs, 6, 'Total docs is 6 (5 existing + 1 added)');
      assert.equal(plan.summary.addedDocs, 1, 'Only 1 doc should be marked as added');
      assert.equal(plan.summary.updatedDocs, 1, 'Only the actually edited doc (docIds[2]) should be updated, not the untouched siblings');
      assert.equal(plan.summary.changedDocs, 2, 'Exactly 2 docs changed in total');
      assert.deepEqual(plain(plan.uploadDocs.map((d) => d.docId)), [newDocId, docIds[2]], 'Only added and modified docs are uploaded');
    } finally { fixture.close(); }
  }
  console.log('Plugin passed: desktop/mobile lifecycle, settings migration, scoped incremental sync, API payloads, retries and cancellation.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
