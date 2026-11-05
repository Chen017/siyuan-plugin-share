"""Exercise actual image encoders, publication, worker lifecycle and snapshots."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
mode = parser.add_mutually_exclusive_group(required=True)
mode.add_argument('--php', help='PHP CLI with GD and PDO SQLite')
mode.add_argument('--docker', help='Built application image, including CLI encoders')
args = parser.parse_args()
with tempfile.TemporaryDirectory(prefix='siyuan-image-runtime-') as directory:
    work = Path(directory)
    app = work / 'app'
    shutil.copytree(ROOT / 'php-site', app, ignore=shutil.ignore_patterns('config.php', 'storage', 'uploads'))
    (app / 'storage').mkdir()
    (app / 'uploads').mkdir()
    runtime = '/fixture/app' if args.docker else app.as_posix()
    config = "<?php return ['db_path'=>" + json.dumps(runtime + '/storage/app.db') + ", 'uploads_dir'=>" + json.dumps(runtime + '/uploads') + "];"
    (app / 'config.php').write_text(config, encoding='utf-8')
    shutil.copy(ROOT / 'tests/image-compression.php', work / 'checks.php')
    shutil.copy(ROOT / 'scripts/compress-images.php', work / 'compress-images.php')
    shutil.copy(ROOT / 'scripts/data-snapshot.php', work / 'data-snapshot.php')

    def php(arguments, check=True):
        command = [args.php] if args.php else ['docker', 'run', '--rm', '--network', 'none', *(['--user', f'{os.getuid()}:{os.getgid()}'] if os.name == 'posix' else []), '-v', f'{work}:/fixture', '--entrypoint', 'php', args.docker]
        result = subprocess.run([*command, *arguments], capture_output=True, text=True, timeout=45)
        if check and result.returncode:
            raise AssertionError(result.stdout + result.stderr)
        if 'Warning:' in result.stdout + result.stderr or 'Fatal error:' in result.stdout + result.stderr:
            raise AssertionError(result.stdout + result.stderr)
        return result

    mount = '/fixture' if args.docker else work.as_posix()
    index = runtime + '/index.php'
    result = php([mount + '/checks.php', index])
    print(result.stdout.strip())
    bootstrap = "ini_set('session.save_path',dirname($argv[1]).'/storage'); define('SIYUAN_CLI_BOOTSTRAP_ONLY',true); require $argv[1]; session_write_close(); "
    if args.php:
        barrier = time.time() + 1
        racing = bootstrap + 'while(microtime(true)<(float)$argv[2]) usleep(1000); echo json_encode(create_image_compression_job());'
        workers = [subprocess.Popen([args.php, '-r', racing, index, str(barrier)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(6)]
        try:
            results = []
            for worker in workers:
                stdout, stderr = worker.communicate(timeout=10)
                assert worker.returncode == 0, stderr
                results.append(json.loads(stdout))
            assert sum(item['success'] for item in results) == 1, results
        finally:
            for worker in workers:
                if worker.poll() is None:
                    worker.kill()
                worker.communicate(timeout=5)
        php(['-r', bootstrap + '$task=get_background_compression_status(); request_stop_background_compression(); exit(run_background_compression_job($task["job_id"]));', index])
        print('Six simultaneous starts produce exactly one reserved task.')
    code = bootstrap + "echo json_encode(start_background_compression_job(), JSON_THROW_ON_ERROR);"
    # Keep one container alive for detached children; docker run would reap them.
    if args.php:
        created = json.loads(php(['-r', code, index]).stdout)
        assert created['success'], created
        deadline = time.monotonic() + 8
        while True:
            task = json.loads(php(['-r', bootstrap + 'echo json_encode(get_background_compression_status());', index]).stdout)
            if task['status'] != 'running':
                break
            assert time.monotonic() < deadline, task
            time.sleep(0.05)
        assert task['status'] == 'failed' and task['checked'] == 1, task
        print('Detached worker starts, acknowledges its job and exits on a missing attachment.')

    result = php([mount + '/compress-images.php', runtime, '--limit=1'], check=False)
    assert result.returncode == 1, result.stdout + result.stderr
    task = json.loads(result.stdout)
    assert task['status'] == 'failed' and task['checked'] == 1, task
    print('Production CLI works without a test-generated bootstrap and reports incomplete work.')

    db = runtime + '/storage/app.db'
    def snapshot(core=False):
        return json.loads(php([mount + '/data-snapshot.php', db, *(['--core-only'] if core else [])]).stdout)
    before, core_before = snapshot(), snapshot(True)
    php(['-r', bootstrap + "db()->exec(\"UPDATE share_assets SET original_size_bytes=original_size_bytes+1, compressed_at='changed'\");", index])
    assert snapshot()['fingerprints']['share_assets'] != before['fingerprints']['share_assets']
    assert snapshot(True) == core_before, 'Compression metadata must not break migration fingerprints'
    php(['-r', bootstrap + "db()->exec(\"INSERT OR REPLACE INTO settings(key,value,updated_at) VALUES('admin_auth_mode','github','fixture')\");", index])
    assert snapshot(True)['fingerprints']['settings'] != core_before['fingerprints']['settings']
    print('Full snapshots verify compression metadata; core snapshots tolerate new columns and protect authentication mode.')
print('All image compression runtime checks passed.')
