<?php
declare(strict_types=1);

// Real application code and disposable files/SQLite, never instance data.
ini_set('session.save_path', dirname($argv[1]) . '/storage');
define('SIYUAN_CLI_BOOTSTRAP_ONLY', true);
require $argv[1];
session_write_close();
$pdo = db();
$checks = 0;
function image_check(bool $condition, string $message): void {
    global $checks;
    if (!$condition) throw new RuntimeException($message);
    $checks++;
}
function image_fixture(string $name): string {
    global $config;
    $path = $config['uploads_dir'] . '/' . $name;
    $im = imagecreatetruecolor(200, 200);
    imagefill($im, 0, 0, imagecolorallocate($im, 20, 110, 210));
    imagepng($im, $path, 0);
    imagedestroy($im);
    return $path;
}
function image_asset(int $share, string $name, ?string $path = null): array {
    global $pdo, $config;
    $full = $config['uploads_dir'] . '/' . ($path ?? $name);
    $size = is_file($full) ? filesize($full) : 100;
    $hash = is_file($full) ? hash_file('sha256', $full) : str_repeat('a', 64);
    $pdo->prepare('INSERT INTO share_assets(share_id,asset_path,file_path,size_bytes,asset_hash,created_at) VALUES(?,?,?,?,?,?)')
        ->execute([$share, 'assets/' . $name, $path ?? $name, $size, $hash, now()]);
    return $pdo->query('SELECT * FROM share_assets WHERE id = ' . $pdo->lastInsertId())->fetch(PDO::FETCH_ASSOC);
}
$owner = (int)$pdo->query("SELECT id FROM users WHERE username = 'admin'")->fetchColumn();
$pdo->prepare('INSERT INTO shares(user_id,type,slug,title,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    ->execute([$owner, 'doc', 'image-fixture', 'Image fixture', now(), now()]);
$share = (int)$pdo->lastInsertId();

$path = image_fixture('plain.png');
$originalHash = hash_file('sha256', $path);
$row = image_asset($share, 'plain.png');
recalculate_share_size($share);
recalculate_user_storage($owner);
$oldSize = (int)$row['size_bytes'];
$res = optimize_share_asset_row($pdo, $row);
$updated = $pdo->query('SELECT * FROM share_assets WHERE id = ' . $row['id'])->fetch(PDO::FETCH_ASSOC);
image_check($res['status'] === 'compressed' && $res['saved_bytes'] > 0, 'Real PNG becomes smaller: ' . json_encode($res));
image_check($updated['file_path'] !== $row['file_path'] && !is_file($path), 'Published image uses a new generation and old copy is reclaimed');
image_check($updated['asset_hash'] === $originalHash, 'Client hash is unchanged');
image_check((int)$updated['original_size_bytes'] === $oldSize, 'Original byte count survives');
$newSize = (int)filesize($config['uploads_dir'] . '/' . $updated['file_path']);
image_check((int)$updated['size_bytes'] === $newSize, 'Database matches published bytes');
image_check((int)$pdo->query('SELECT size_bytes FROM shares WHERE id = ' . $share)->fetchColumn() === $newSize, 'Share size matches');
image_check((int)$pdo->query('SELECT storage_used_bytes FROM users WHERE id = ' . $owner)->fetchColumn() === $newSize, 'User quota matches');
image_check(optimize_share_asset_row($pdo, $row)['status'] === 'failed', 'A stale row cannot overwrite the new generation');

$spoof = $config['uploads_dir'] . '/spoof.png';
file_put_contents($spoof, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
$hash = hash_file('sha256', $spoof);
image_check(compress_image_file($spoof)['status'] === 'skipped' && hash_file('sha256', $spoof) === $hash, 'MIME spoof remains byte-identical');
$png = file_get_contents(image_fixture('animation.png'));
$actl = pack('NN', 2, 0);
$chunk = pack('N', 8) . 'acTL' . $actl . pack('N', crc32('acTL' . $actl));
file_put_contents($config['uploads_dir'] . '/animation.png', substr($png, 0, 33) . $chunk . substr($png, 33));
$hash = hash_file('sha256', $config['uploads_dir'] . '/animation.png');
image_check(compress_image_file($config['uploads_dir'] . '/animation.png')['status'] === 'skipped', 'APNG is excluded');
image_check(hash_file('sha256', $config['uploads_dir'] . '/animation.png') === $hash, 'APNG bytes preserved');
$ihdr = pack('NN', 100000, 100000) . substr($png, 24, 5);
file_put_contents($config['uploads_dir'] . '/huge.png', substr($png, 0, 16) . $ihdr . pack('N', crc32('IHDR' . $ihdr)) . substr($png, 33));
image_check(compress_image_file($config['uploads_dir'] . '/huge.png')['status'] === 'skipped', 'Decoded image allocation is bounded');

// Throw at SQL publication: filesystem rollback must preserve the original file.
$rollbackPath = image_fixture('rollback.png');
$rollbackHash = hash_file('sha256', $rollbackPath);
$rollback = image_asset($share, 'rollback.png');
$pdo->exec("CREATE TRIGGER reject_image_update BEFORE UPDATE ON share_assets BEGIN SELECT RAISE(ABORT, 'synthetic publication failure'); END");
image_check(optimize_share_asset_row($pdo, $rollback)['status'] === 'failed', 'Publication failure is reported');
image_check(is_file($rollbackPath) && hash_file('sha256', $rollbackPath) === $rollbackHash, 'SQL failure preserves old published bytes');
$pdo->exec('DROP TRIGGER reject_image_update');

image_asset($share, 'missing.png');
file_put_contents($config['uploads_dir'] . '/ignored.gif', 'GIF89a');
image_asset($share, 'ignored.gif');
$created = create_image_compression_job();
image_check($created['success'], 'A new job can start');
image_check(!create_image_compression_job()['success'], 'A simultaneous start is rejected');
image_fixture('arrived-later.png');
image_asset($share, 'arrived-later.png');
$code = run_background_compression_job($created['data']['job_id'], 1);
$task = get_background_compression_status();
image_check($code === 1 && $task['status'] === 'failed', 'Missing image finishes with an error rather than looping');
image_check($task['checked'] === 3 && $task['failed'] === 1 && $task['compressed'] === 2, 'Later valid images, including a new upload, are processed once despite failure');
image_check($task['remaining'] === 1, 'Missing image remains retryable');
image_check(get_image_compression_stats($pdo)['total_images'] === 4, 'Unsupported GIF is excluded from all counts');

$created = create_image_compression_job();
request_stop_background_compression();
image_check(run_background_compression_job($created['data']['job_id']) === 0, 'Pre-start stop is honored');
$task = get_background_compression_status();
image_check($task['status'] === 'stopped' && $task['checked'] === 0 && $task['stop_requested'], 'Stop flag survives worker initialization');
$lock = image_compression_worker_lock();
image_check($lock !== false && image_compression_worker_lock() === false, 'Only one worker owns the execution lock');
fclose($lock);

$created = create_image_compression_job();
$lock = image_compression_worker_lock();
update_image_compression_task(function (array $task): array { $task['pid'] = getmypid(); $task['updated_at'] = time() - 500; return $task; });
image_check(get_background_compression_status()['status'] === 'running', 'An active worker lease survives a delayed heartbeat');
request_stop_background_compression();
update_image_compression_task(function (array $task): array { $task['checked']++; return $task; });
image_check(get_background_compression_status()['stop_requested'], 'Progress updates preserve a concurrent stop flag');
fclose($lock);
image_check(get_background_compression_status()['status'] === 'failed', 'A dead worker is detected from its released lock');

// A lossless JPEG optimizer must preserve orientation metadata and decoded pixels.
$jpeg = $config['uploads_dir'] . '/oriented.jpg';
$im = imagecreatetruecolor(80, 40);
imagefill($im, 0, 0, imagecolorallocate($im, 20, 40, 220));
imagejpeg($im, $jpeg, 100); imagedestroy($im);
$exif = "Exif\0\0II\x2a\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0\x06\0\0\0\0\0\0\0";
$jpegData = file_get_contents($jpeg);
file_put_contents($jpeg, substr($jpegData, 0, 2) . "\xff\xe1" . pack('n', strlen($exif) + 2) . $exif . substr($jpegData, 2));
$before = imagecreatefromjpeg($jpeg);
$result = compress_image_file($jpeg);
$after = imagecreatefromjpeg($jpeg);
image_check(str_contains(file_get_contents($jpeg), $exif), 'JPEG EXIF orientation is retained');
image_check(imagecolorat($before, 10, 10) === imagecolorat($after, 10, 10), 'JPEG optimization does not requantize pixels');
imagedestroy($before); imagedestroy($after);

$streamsBefore = count(get_resources('stream'));
for ($i = 0; $i < 100; $i++) { $write = new ShareFileWrite($pdo); $write->commit(); }
unset($write);
$registry = new ReflectionProperty(ShareFileWrite::class, 'activeWrites');
image_check($registry->getValue() === [], 'Completed writes leave no active shutdown entries');
image_check(count(get_resources('stream')) <= $streamsBefore, 'Repeated writes do not leak generation lock handles');
image_check((int)$pdo->query("SELECT COUNT(*) FROM sqlite_master WHERE name='idx_share_assets_compression_pending'")->fetchColumn() === 1, 'Real migration creates the pending-image index');

$started = microtime(true);
image_check(!run_image_compression_tool([PHP_BINARY, '-r', 'usleep(5000000);'], 0.1), 'Encoder deadline is enforced');
image_check(microtime(true) - $started < 3, 'Timed-out process is reaped promptly');
echo "Image runtime checks passed: {$checks}\n";
