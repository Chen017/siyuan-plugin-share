"""Test release detection and version allocation against a disposable Git repository."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
script = Path(__file__).resolve().parents[1] / 'scripts/plan-plugin-release.py'
spec = importlib.util.spec_from_file_location('release_plan', script)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

with tempfile.TemporaryDirectory(prefix='plugin-release-plan-') as directory:
    root = Path(directory)
    module.ROOT = root
    def git(*args):
        return subprocess.run(['git', *args], cwd=root, check=True, capture_output=True, text=True).stdout
    def commit(message):
        git('add', '.')
        git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', message)
    git('init', '-q')
    (root / 'plugin.json').write_text(json.dumps({'version': '0.5.8'}), encoding='utf-8')
    (root / 'index.js').write_text('old', encoding='utf-8')
    commit('release')
    git('tag', '0.5.8')
    assert module.plan('0.5.8') is None
    (root / 'README.md').write_text('documentation', encoding='utf-8')
    commit('docs')
    assert module.plan('0.5.8') is None
    (root / 'index.js').write_text('new', encoding='utf-8')
    commit('plugin')
    assert module.plan('0.5.8') == '0.5.9'
    git('tag', '0.5.9')
    try:
        module.plan('0.5.8')
        raise AssertionError('An existing tag on the commit must stop automatic retry')
    except RuntimeError as error:
        assert 'draft release' in str(error)
    assert module.plan('0.5.9') is None
    (root / 'php-site/assets').mkdir(parents=True)
    (root / 'php-site/assets/controls.js').write_text('shared controls', encoding='utf-8')
    commit('shared controls')
    assert module.plan('0.5.9') == '0.5.10'
    try:
        module.plan('missing')
        raise AssertionError('A missing baseline must fail closed')
    except subprocess.CalledProcessError:
        pass
print('Plugin release planning passed: change detection, versions, shared controls, retry and missing baseline.')
