"""Exercise the actual deployment shell using disposable command mocks only."""
import argparse
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--bash', default='bash')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
source = (root / '.github/workflows/deploy.yml').read_text(encoding='utf-8').split('          script: |\n', 1)[1]
source = '\n'.join(line[12:] if line.startswith('            ') else line for line in source.splitlines())
source = source.replace(chr(36) + '{{ github.sha }}', 'a' * 40)
source = re.sub(r'\$\{\{.*?\}\}', 'no', source)
with tempfile.TemporaryDirectory(prefix='siyuan-deploy-guard-') as directory:
    work = Path(directory)
    (work / 'bin').mkdir()
    (work / 'scripts').mkdir()
    shutil.copy(root / 'scripts/prepare-config.sh', work / 'scripts/prepare-config.sh')
    commands = {
        'git': 'case "$*" in "branch --show-current") echo main ;; "rev-parse origin/main") echo "$REMOTE_SHA" ;; esac\nexit 0',
        'flock': 'exit 0',
        'docker': '''printf "%s\\n" "$*" >> "$RUN_LOG"
case "$*" in
  *"/ops/data-snapshot.php"*)
    if [ "$VERIFY_MODE" = before_fail ]; then echo 'Synthetic verification failure' >&2; exit 42; fi
    echo '{"same":true}' ;;
  *"/tmp/core-data-snapshot.php /var/www/html/storage/app.db"*)
    if [ "$VERIFY_MODE" = after_mismatch ]; then echo '{"same":false}'; else echo '{"same":true}'; fi ;;
  *State.Health.Status*) echo healthy ;;
esac
exit 0''',
        'curl': '''case "$*" in *"%{http_code}"*) echo 200 ;; *) echo '<h1>Sign in</h1>' ;; esac''',
    }
    for name, body in commands.items():
        file = work / 'bin' / name
        file.write_text('#!/usr/bin/env bash\n' + body + '\n', encoding='utf-8', newline='\n')
        file.chmod(0o755)
    source = source.replace('cd /root/siyuan-plugin-share', 'cd "' + work.as_posix() + '"')
    source = source.replace('exec 9>/root/.siyuan-share-deploy.lock', 'exec 9>"' + (work / 'lock').as_posix() + '"')
    source = source.replace('/tmp/siyuan-share-verify.', (work / 'siyuan-share-verify.').as_posix())
    script = work / 'workflow.sh'
    script.write_text(source + '\n', encoding='utf-8', newline='\n')
    bin_path = (work / 'bin').as_posix()
    if os.name == 'nt': bin_path = '/' + bin_path[0].lower() + bin_path[2:]
    command = 'export PATH="' + bin_path + ':$PATH"; exec bash "' + script.as_posix() + '"'
    env = {**os.environ, 'RUN_LOG': (work / 'calls.log').as_posix(), 'REMOTE_SHA': 'a' * 40}

    def run(mode, remote_sha='a' * 40):
        (work / 'calls.log').unlink(missing_ok=True)
        result = subprocess.run([args.bash, '-c', command], env={**env, 'VERIFY_MODE': mode, 'REMOTE_SHA': remote_sha}, capture_output=True, text=True, timeout=20)
        calls = (work / 'calls.log').read_text(encoding='utf-8') if (work / 'calls.log').exists() else ''
        assert not list(work.glob('siyuan-share-verify.*')), 'Temporary fingerprints must be removed'
        assert not any(line.startswith(('tag ', 'commit ', 'export ')) for line in calls.splitlines()), 'Policy retains no rollback image'
        return result, calls

    result, calls = run('before_fail')
    assert result.returncode != 0 and 'Synthetic verification failure' in result.stderr
    assert not any(line.startswith('compose up ') for line in calls.splitlines()), calls
    assert 'start siyuan-share-web' in calls, 'A failed preflight must resume the stopped service'
    result, calls = run('success', 'b' * 40)
    assert result.returncode != 0 and 'Main changed after regression' in result.stderr
    assert not calls, 'An untested revision reached Docker operations'
    result, calls = run('after_mismatch')
    assert result.returncode != 0 and 'CORE_DATA_PRESERVED=1' not in result.stdout
    result, calls = run('success')
    assert result.returncode == 0, result.stdout + result.stderr
    assert 'CORE_DATA_PRESERVED=1' in result.stdout
print('Deployment guards passed: preflight failure resumes service, untested main is blocked, data mismatch fails, temporary verification is removed, no rollback image retained.')
