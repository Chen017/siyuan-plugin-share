<?php
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

define('SIYUAN_CLI_BOOTSTRAP_ONLY', true);
$_SERVER['REQUEST_METHOD'] = 'CLI';
$_SERVER['REQUEST_URI'] = '';
$_SERVER['SCRIPT_NAME'] = '/background-compress.php';

require_once __DIR__ . '/index.php';

@set_time_limit(0);
if (function_exists('ignore_user_abort')) {
    ignore_user_abort(true);
}

$status = get_background_compression_status();
$status['status'] = 'running';
$status['pid'] = getmypid() ?: 0;
$status['started_at'] = $status['started_at'] ?: time();
$status['updated_at'] = time();
$status['stop_requested'] = false;
$status['error'] = null;
set_background_compression_status($status);

$pdo = db();
$batchLimit = 100;

try {
    while (true) {
        $current = get_background_compression_status();
        if (!empty($current['stop_requested'])) {
            $current['status'] = 'stopped';
            $current['updated_at'] = time();
            set_background_compression_status($current);
            echo "Background compression stopped by user request.\n";
            exit(0);
        }

        $res = batch_compress_pending_images($pdo, $batchLimit);

        $current['checked'] = (int)($current['checked'] ?? 0) + (int)$res['checked'];
        $current['compressed'] = (int)($current['compressed'] ?? 0) + (int)$res['compressed'];
        $current['optimal'] = (int)($current['optimal'] ?? 0) + (int)$res['optimal'];
        $current['skipped'] = (int)($current['skipped'] ?? 0) + (int)$res['skipped'];
        $current['failed'] = (int)($current['failed'] ?? 0) + (int)$res['failed'];
        $current['saved_bytes'] = (int)($current['saved_bytes'] ?? 0) + (int)$res['saved_bytes'];
        $current['remaining'] = (int)$res['remaining_pending'];
        $current['updated_at'] = time();

        if ($res['remaining_pending'] === 0 || $res['checked'] === 0) {
            $current['status'] = 'completed';
            $current['completed_at'] = time();
            set_background_compression_status($current);
            echo "Background compression completed successfully. All images are optimal.\n";
            exit(0);
        }

        set_background_compression_status($current);

        // Pause briefly between batches to allow web requests smooth database access
        usleep(100000);
    }
} catch (Throwable $e) {
    $err = $e->getMessage();
    $current = get_background_compression_status();
    $current['status'] = 'failed';
    $current['error'] = $err;
    $current['updated_at'] = time();
    set_background_compression_status($current);
    fwrite(STDERR, "Fatal background compression error: {$err}\n");
    exit(1);
}
