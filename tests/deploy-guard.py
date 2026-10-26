"""Exercise the workflow's real shell with disposable mocks; never contact a server."""
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
source = (root / '.github/workflows/deploy.yml').read_text(encoding='utf-8')
source = source.split('          script: |\n', 1)[1]
source = '\n'.join(line[12:] if line.startswith('            ') else line for line in source.splitlines())
source = source.replace('${{ github.sha }}', 'a' * 40)
source = re.sub(r'\$\{\{.*?\}\}', 'no', source)
with tempfile.TemporaryDirectory(prefix='siyuan-deploy-guard-') as directory:
    work = Path(directory)
    (work / 'bin').mkdir()
    (work / 'scripts').mkdir()
    shutil.copy(root / 'scripts/prepare-config.sh', work / 'scripts/prepare-config.sh')
    (work / 'backups').mkdir()
    (work / 'scripts/backup-data.sh').write_text('#!/usr/bin/env bash\necho "Simulated backup failure"\nexit 42\n', encoding='utf-8', newline='\n')
    commands = {
        'git': 'case "$*" in "branch --show-current") echo main ;; "rev-parse origin/main") echo "$REMOTE_SHA" ;; esac\nexit 0',
        'flock': 'exit 0',
        'docker': 'printf "%s\\n" "$*" >> "$RUN_LOG"\ncase "$*" in *admin_only_schema_v1*) exit 1 ;; *State.Health.Status*) echo healthy ;; esac\nexit 0',
    }
    for name, body in commands.items():
        path = work / 'bin' / name
        path.write_text('#!/usr/bin/env bash\n' + body + '\n', encoding='utf-8', newline='\n')
        path.chmod(0o755)
    source = source.replace('cd /root/siyuan-plugin-share', 'cd "' + work.as_posix() + '"')
    source = source.replace('exec 9>/root/.siyuan-share-deploy.lock', 'exec 9>"' + (work / 'lock').as_posix() + '"')
    source = source.replace('/root/siyuan-share-backups', (work / 'backups').as_posix())
    source = re.sub(r'(?<![A-Za-z0-9_$])/core-before\.json', (work / 'retirement-before.json').as_posix(), source)
    script = work / 'workflow.sh'
    script.write_text(source + '\n', encoding='utf-8', newline='\n')
    env = {**os.environ, 'RUN_LOG': (work / 'calls.log').as_posix(), 'REMOTE_SHA': 'a' * 40}
    # Assign PATH inside Bash so Windows drive-letter separators cannot distort it.
    bin_path = (work / 'bin').as_posix()
    if os.name == 'nt': bin_path = '/' + bin_path[0].lower() + bin_path[2:]
    command = 'export PATH="' + bin_path + ':$PATH"; exec bash "' + script.as_posix() + '"'
    result = subprocess.run([args.bash, '-c', command], env=env, capture_output=True, text=True, timeout=20)
    calls = (work / 'calls.log').read_text(encoding='utf-8') if (work / 'calls.log').exists() else ''
    assert result.returncode != 0, result.stdout + result.stderr
    assert 'Backup failed; refusing cutover.' in result.stderr, repr((result.returncode, result.stdout, result.stderr, calls))
    assert not any(line.startswith('stop ') or line.startswith('compose up ') for line in calls.splitlines()), calls
    (work / 'calls.log').unlink()
    result = subprocess.run([args.bash, '-c', command], env={**env, 'REMOTE_SHA': 'b' * 40}, capture_output=True, text=True, timeout=20)
    assert result.returncode != 0, result.stdout + result.stderr
    assert 'Main changed after regression' in result.stderr, result.stderr
    assert not (work / 'calls.log').exists(), 'An untested revision reached Docker operations'
print('Deployment guards passed: backup failure prevents cutover; an untested main revision cannot reach Docker.')
