"""Compare the latest published plugin with the tested commit and choose a new patch version."""
import json
import os
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
# Only functionality shipped in the plugin; documentation-only edits do not publish.
PLUGIN_PATHS = ('index.js', 'index.css', 'plugin.json', 'i18n/', 'icon.png', 'LICENSE',
                'scripts/package.py', 'php-site/assets/controls.js', 'php-site/assets/controls.css')
SEMVER = re.compile(r'^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$')


def run(*args):
    return subprocess.run(args, cwd=ROOT, check=True, text=True, capture_output=True).stdout.strip()


def plan(latest_tag):
    # Fail closed on a missing or invalid release tag, rather than treating a failed
    # API lookup as a first release or publishing against an unverified baseline.
    run('git', 'rev-parse', '--verify', f'refs/tags/{latest_tag}^{{commit}}')
    latest_version = SEMVER.fullmatch(latest_tag)
    if not latest_version:
        raise ValueError('Latest release tag must be a numeric semantic version for automatic publication')
    diff = subprocess.run(['git', 'diff', '--quiet', latest_tag, 'HEAD', '--', *PLUGIN_PATHS], cwd=ROOT)
    if diff.returncode == 0:
        return None
    if diff.returncode != 1:
        raise RuntimeError('Could not compare the latest release with the tested commit')
    manifest_version = json.loads((ROOT / 'plugin.json').read_text(encoding='utf-8'))['version']
    match = SEMVER.fullmatch(manifest_version)
    if not match:
        raise ValueError('plugin.json version must be a numeric semantic version')
    major, minor, patch = map(int, match.groups())
    head = run('git', 'rev-parse', 'HEAD')
    for tag in run('git', 'tag', '--list').splitlines():
        version = SEMVER.fullmatch(tag)
        if version and tuple(map(int, version.groups()[:2])) == (major, minor):
            patch = max(patch, int(version.group(3)) + 1)
            if tag != latest_tag and run('git', 'rev-parse', f'refs/tags/{tag}^{{commit}}') == head:
                raise RuntimeError(f'Tag {tag} already points at this commit; inspect any draft release before retrying')
    if (major, minor, patch) <= tuple(map(int, latest_version.groups())):
        raise ValueError('Update plugin.json to the latest release series before automatic publication')
    return f'{major}.{minor}.{patch}'


if __name__ == '__main__':
    version = plan(os.environ['LATEST_RELEASE_TAG'])
    with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as output:
        output.write(f'publish={str(version is not None).lower()}\n')
        if version:
            output.write(f'version={version}\n')
    print(f'Plugin release: {version}' if version else 'Plugin unchanged since latest release; skipping publication.')
