"""Check release tag validation against real lightweight and annotated Git tags."""
from pathlib import Path
import subprocess
import sys
import tempfile

script = Path(__file__).resolve().parents[1] / 'scripts/check-release-tag.py'
with tempfile.TemporaryDirectory(prefix='siyuan-release-tag-') as directory:
    def git(*args):
        return subprocess.run(['git', *args], cwd=directory, check=True, capture_output=True, text=True).stdout.strip()

    def check(tag, commit, expected):
        result = subprocess.run([sys.executable, str(script), tag, commit], cwd=directory, capture_output=True, text=True)
        assert (result.returncode == 0) == expected, result.stdout + result.stderr

    git('init')
    git('config', 'user.name', 'Release test')
    git('config', 'user.email', 'release-test@example.invalid')
    git('commit', '--allow-empty', '-m', 'first')
    first = git('rev-parse', 'HEAD')
    git('tag', 'lightweight')
    git('tag', '-a', 'annotated', '-m', 'annotated tag')
    git('commit', '--allow-empty', '-m', 'second')
    second = git('rev-parse', 'HEAD')
    for tag in ('lightweight', 'annotated'):
        check(tag, first, True)
        check(tag, second, False)
    check('missing', second, False)
print('Release tag checks passed: lightweight, annotated, mismatched and missing tags.')
