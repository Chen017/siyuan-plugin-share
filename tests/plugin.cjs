/* Exercise the shipped no-build entry point against a disposable SiYuan host. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto, createHash } = require('node:crypto');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const plain = (value) => JSON.parse(JSON.stringify(value));

function host({ mobile = false, locale = 'en_US', stored = {} } = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://siyuan.invalid/' });
  const storage = new Map(Object.entries(structuredClone(stored)));
  const listeners = new Map();
  const timers = new Map();
  const requests = [];
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
        fetchSyncPost: async () => ({ code: 0, data: {} }),
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
    '\n;globalThis.testHelpers = {withRetry};', sandbox, { filename: 'index.js' });
  const plugin = new module.exports();
  // Background networking and real editor observation belong to the host integration.
  for (const name of ['bindDocTreeLater', 'refreshCurrentDocContext', 'startBackgroundSync', 'refreshAutoUpdateLoop']) {
    plugin[name] = () => {};
  }
  return { plugin, storage, listeners, timers, requests, sandbox, close() {
    dom.window.close();
    assert.deepEqual(errors, [], 'Plugin bootstrap must not hide asynchronous errors');
  } };
}

(async () => {
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
    settings: { siteUrl: 'https://notes.invalid', apiKey: 'existing-key' },
    shares: [oldShare],
  } });
  try {
    const { plugin, storage, requests, sandbox, timers } = fixture;
    await plugin.loadState();
    const siteId = plugin.settings.activeSiteId;
    assert(siteId);
    assert.equal(plugin.settings.apiKey, 'existing-key');
    assert.deepEqual(plain(plugin.shares), [oldShare]);
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
    assert.equal(plan.uploadAssets[0].hash, hash('new-image'));
    assert.equal(plugin.isIncrementalPlanNoop(plan), false);
    const unchanged = await plugin.buildScopedIncrementalPlan({ scopeDocs: remoteSnapshot.docs, remoteSnapshot });
    assert.equal(plugin.isIncrementalPlanNoop(unchanged), true);

    const payload = { uploadId: 'pending-upload', docs: plain(plan.uploadDocs), deletedDocIds: plain(plan.deletedDocIds) };
    assert.deepEqual(plain(await plugin.remoteRequest('/api/v1/shares/upload/complete', { body: payload, silent: true })), { accepted: true });
    assert.equal(requests[0].url, 'https://notes.invalid/api/v1/shares/upload/complete');
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
  console.log('Plugin passed: desktop/mobile lifecycle, settings migration, scoped incremental sync, API payloads, retries and cancellation.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
