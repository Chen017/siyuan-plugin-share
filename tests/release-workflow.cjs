/* Exercise the release workflow's actual GitHub script without publishing. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/github-release.yml'), 'utf8').replace(/\r\n/g, '\n');
const scripts = workflow.split('          script: |\n');
assert.equal(scripts.length, 3, 'Expected release status and publishing scripts');
const source = scripts[2].split('\n').map(line => line.startsWith('            ') ? line.slice(12) : line).join('\n');
const run = new (Object.getPrototypeOf(async function () {}).constructor)('github', 'context', 'core', 'require', 'process', source);

async function scenario({ prerelease = false, latest = false, failUpload = 0 } = {}) {
  const calls = [];
  const repos = {
    async createRelease(payload) { calls.push(['create', payload]); return { data: { id: 7, html_url: 'https://example.invalid/release' } }; },
    async uploadReleaseAsset(payload) {
      calls.push(['upload', payload]);
      if (failUpload && calls.filter(([kind]) => kind === 'upload').length === failUpload) throw new Error('synthetic upload failure');
    },
    async updateRelease(payload) { calls.push(['update', payload]); },
  };
  const fakeRequire = name => name === 'fs' ? { readFileSync: () => Buffer.from('archive') } : require(name);
  const fakeProcess = { env: { VERSION: 'test-1', INPUT_PRERELEASE: String(prerelease), INPUT_LATEST: String(latest), GITHUB_WORKSPACE: '/tmp/workspace' } };
  let error;
  try { await run({ rest: { repos } }, { repo: { owner: 'owner', repo: 'repo' } }, { info() {} }, fakeRequire, fakeProcess); }
  catch (caught) { error = caught; }
  assert.equal(Boolean(error), Boolean(failUpload));
  assert.equal(calls[0][1].draft, true);
  if (failUpload) {
    assert.equal(calls.some(([kind]) => kind === 'update'), false, 'Failed uploads must remain drafts');
  } else {
    assert.deepEqual(calls.map(([kind]) => kind), ['create', 'upload', 'upload', 'update']);
    assert.deepEqual(calls.filter(([kind]) => kind === 'upload').map(([, payload]) => payload.name), ['package.zip', 'php-site-test-1.zip']);
    const published = calls.at(-1)[1];
    assert.equal(published.draft, false);
    assert.equal(published.make_latest, latest ? 'true' : prerelease ? undefined : 'legacy');
  }
}

(async () => {
  for (const options of [{}, { latest: true }, { prerelease: true }, { failUpload: 1 }, { failUpload: 2 }]) await scenario(options);
  console.log('Release publishing passed: both assets precede publication; failed uploads remain drafts.');
})().catch(error => { console.error(error); process.exitCode = 1; });
