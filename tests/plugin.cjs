/* Exercise the shipped no-build entry point against a disposable SiYuan host. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto, createHash } = require('node:crypto');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const plain = (value) => JSON.parse(JSON.stringify(value));

function host({ mobile = false, locale = 'en_US', stored = {}, exportMarkdown = '', appVersion = '3.8.9' } = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://siyuan.invalid/' });
  const storage = new Map(Object.entries(structuredClone(stored)));
  const listeners = new Map();
  const timers = new Map();
  const requests = [];
  const kernelRequests = [];
  const errors = [];
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
        fetchSyncPost: async (url, body) => {
          kernelRequests.push({url, body: plain(body)});
          return { code: 0, data: url === '/api/export/exportMdContent' ? {hPath: '/Fixture', content: exportMarkdown} : url === '/api/system/version' ? appVersion : {} };
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
    '\n;globalThis.testHelpers = {withRetry, buildDocMetaHashInput};', sandbox, { filename: 'index.js' });
  const plugin = new module.exports();
  // Background networking and real editor observation belong to the host integration.
  for (const name of ['bindDocTreeLater', 'refreshCurrentDocContext', 'startBackgroundSync', 'refreshAutoUpdateLoop']) {
    plugin[name] = () => {};
  }
  return { plugin, storage, listeners, timers, requests, kernelRequests, sandbox, close() {
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
      const assetError = fixture.plugin.t('siyuanShare.error.imageSizeMigrationAssetsFailed');
      fixture.plugin.showErr(new Error(assetError));
      assert.equal(shown, assetError, 'An asset migration error must not be mislabeled as a network failure');
      fixture.plugin.showErr(new Error('Failed to fetch'));
      assert.equal(shown, fixture.plugin.t('siyuanShare.error.networkFail'));
    } finally { fixture.close(); }
  }
  // Upgrade migration must re-export unchanged documents once per share, and
  // retry after cancellation or upload failure without changing other shares.
  for (const kind of ['doc', 'notebook']) {
    const migration = host({mobile: true, stored: {settings: {siteUrl: 'https://note.etalib.space', apiKey: 'key'}}});
    try {
      const {plugin} = migration;
      await plugin.loadState();
      const rootId = '20261027000000-aaaaaaa';
      const otherId = '20261027000000-bbbbbbb';
      const share = {id: 'migration-' + kind, docId: rootId, notebookId: rootId, slug: 'test', type: kind};
      const docs = [{docId: rootId, title: 'First'}, {docId: otherId, title: 'Second'}];
      let exports = [], uploadCalls = 0, initBodies = [], warnings = [], plans = [], fail = false, cancel = false, failures = false;
      Object.assign(plugin, {
        notebooks: [{id: rootId, name: 'Notebook'}],
        createProgressHandle: () => ({update() {}, close() {}, setBarVisible() {}, confirm: async () => !cancel}),
        verifyRemote: async () => {}, resolveDocInfoFromAnyId: async () => ({title: 'First'}),
        resolveNotebookIdFromDoc: async () => '', resolveDocIcon: async () => '',
        getShareByDocId: () => share, getShareByNotebookId: () => share,
        isNotebookClosedForAutoUpdate: async () => false,
        supportsIncrementalShare: () => true, supportsDocChunkUpload: () => false,
        fetchShareSnapshot: async () => ({docs: [], assets: []}),
        listDocSubtree: async () => docs, listDocsInNotebook: async () => ({docs}),
        fillDocIcons: async () => {}, collectStructChangedDocIds: () => [],
        collectIncrementalCandidateDocIds: async () => ({candidateDocIds: []}),
        getDocBlockCountCache: () => ({[rootId]: 1}),
        collectDocExportResults: async selected => {
          exports.push(selected.map(doc => doc.docId));
          return selected.map((doc, index) => ({doc, index, exportRes: {}, markdown: '<img src="assets/a.png" style="width: 320px;">', assets: [], failures: failures && doc.docId === rootId ? ['missing'] : []}));
        },
        resolveIconUpload: async () => '', maybeWarnExportReference: async () => {},
        buildScopedIncrementalPlan: async ({exportedDocs, preserveExistingAssets}) => { plans.push(preserveExistingAssets); return {uploadDocs: exportedDocs, deletedDocIds: [], deletedAssetPaths: [], uploadAssetEntries: [], uploadAssets: [], summary: {changedDocs: 1}}; },
        formatIncrementSummaryDetail: () => '', uploadAssetsChunked: async () => {},
        remoteRequest: async (path, options) => { uploadCalls++; if (path.endsWith('/init')) initBodies.push(plain(options.body)); if (fail && path.includes('/complete')) throw new Error('Upload failed'); return {uploadId: 'test-upload'}; },
        cancelUploadSession: async () => {}, syncRemoteShares: async () => {},
        setAutoUpdateShareNotebookHint: () => {}, updateSharePasswordCache: async () => {},
        setIncrementalCursor: async () => {}, refreshDocBlockCountCacheForShare: async () => {},
        syncAutoUpdateStructDigestAfterShareSuccess: async () => {}, getShareUrl: () => 'https://note.etalib.space/s/test',
        renderSettingCurrent: () => {}, refreshDocTreeMarksLater: () => {}, notify: message => warnings.push(message),
      });
      const run = () => kind === 'doc'
        ? plugin.shareDoc(rootId, {includeChildren: true, allowRequestError: false})
        : plugin.shareNotebook(rootId, {allowRequestError: false});
      cancel = true;
      await assert.rejects(run());
      assert.deepEqual(plain(exports.at(-1)), [rootId, otherId], `${kind}: cancellation exports every old document`);
      cancel = false; fail = true;
      await assert.rejects(run(), /Upload failed/);
      assert.deepEqual(plain(exports.at(-1)), [rootId, otherId], `${kind}: failed upload retries all documents`);
      fail = false; failures = true;
      await run();
      assert.equal(plans.at(-1), true, `${kind}: missing assets protect all existing assets`);
      assert(warnings.at(-1).includes('1 local attachment'), `${kind}: user is informed`);
      assert(plugin.needsImageSizeMigration(share.id), `${kind}: missing files remain pending`);
      await plugin.loadState();
      assert.deepEqual(plain(plugin.pendingImageSizeMigrationDocs(share.id)), [rootId], `${kind}: pending documents survive restart`);
      failures = false;
      await run();
      assert.deepEqual(plain(exports.at(-1)), [rootId], `${kind}: only the affected document is retried`);
      assert.deepEqual(initBodies.at(-1).metadata.docs.map(doc => doc.docId), [rootId], `${kind}: affected document enters the upload`);
      assert(initBodies.at(-1).metadata.docs.every(doc => doc.markdown.includes('width: 320px;')), `${kind}: exported sizes enter the upload`);
      await run();
      assert.deepEqual(plain(exports.at(-1)), [], `${kind}: later updates return to incremental selection`);
      assert(plugin.needsImageSizeMigration('another-share'), 'Other shares migrate independently');
      await plugin.loadState();
      assert(!plugin.needsImageSizeMigration(share.id), 'Completed migration survives reload');
      share.id = 'noop-' + kind;
      plugin.buildScopedIncrementalPlan = async () => ({summary: {}});
      const uploadsBeforeNoop = uploadCalls;
      if (kind === 'doc') await plugin.shareDoc(rootId, {includeChildren: true, background: true});
      else await plugin.shareNotebook(rootId, {background: true});
      assert.equal(uploadCalls, uploadsBeforeNoop, 'Identical migrated content needs no upload');
      assert(!plugin.needsImageSizeMigration(share.id), 'A complete successful comparison finishes migration');
    } finally { migration.close(); }
  }

  for (const [appVersion, expectedComplete] of [['3.2.9', false], ['3.3.0', true], ['3.8.9', true], ['unknown', false]]) {
    const versionFixture = host({mobile: true, appVersion, stored: {settings: {siteUrl: 'https://note.etalib.space', apiKey: 'key'}}});
    try {
      await versionFixture.plugin.loadState();
      await versionFixture.plugin.markImageSizeMigrationComplete('share-version');
      assert.equal(!versionFixture.plugin.needsImageSizeMigration('share-version'), expectedComplete, `${appVersion}: only supported kernels finish migration`);
    } finally { versionFixture.close(); }
  }

  const olderKernel = host({mobile: true, appVersion: '3.2.9', stored: {settings: {siteUrl: 'https://note.etalib.space', apiKey: 'key'}}});
  try {
    await olderKernel.plugin.loadState();
    await olderKernel.plugin.markImageSizeMigrationComplete('share-upgrade');
    const newerKernel = host({mobile: true, appVersion: '3.8.9', stored: Object.fromEntries(olderKernel.storage)});
    try {
      await newerKernel.plugin.loadState();
      assert(newerKernel.plugin.needsImageSizeMigration('share-upgrade'), 'Upgrading SiYuan retries exports made with an unsupported kernel');
      await newerKernel.plugin.markImageSizeMigrationComplete('share-upgrade');
      assert(!newerKernel.plugin.needsImageSizeMigration('share-upgrade'));
    } finally { newerKernel.close(); }
  } finally { olderKernel.close(); }

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
