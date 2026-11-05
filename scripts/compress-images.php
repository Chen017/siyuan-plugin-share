<?php
declare(strict_types=1);

if (PHP_SAPI !== 'cli') exit(1);

$candidateDirs = [
    $argv[1] ?? '',
    '/var/www/html',
    realpath(__DIR__ . '/../php-site') ?: '',
    realpath(__DIR__ . '/..') ?: '',
];

$appDir = '';
foreach ($candidateDirs as $dir) {
    if ($dir !== '' && is_dir($dir) && is_file($dir . '/bootstrap.php')) {
        $appDir = realpath($dir) ?: $dir;
        break;
    }
}

if ($appDir === '') {
    fwrite(STDERR, "Error: bootstrap.php not found. Provide app directory as first argument.\n");
    exit(1);
}

require_once $appDir . '/bootstrap.php';
require_once $appDir . '/image-compression.php';

$pdo = db();
$stats = get_image_compression_stats($pdo);

echo "=== SiYuan Share - Image Compression Tool ===\n";
echo "Total images: {$stats['total_images']}\n";
echo "Already compressed: {$stats['compressed_images']}\n";
echo "Pending optimization: {$stats['pending_images']}\n";
echo "Current space saved: " . format_bytes((float)$stats['saved_bytes']) . "\n\n";

if ($stats['pending_images'] === 0) {
    echo "All images are already optimized. Nothing to do.\n";
    exit(0);
}

$batchLimit = 500;
foreach ($argv as $arg) {
    if (str_starts_with($arg, '--limit=')) {
        $batchLimit = max(1, min(1000, (int)substr($arg, 8)));
    }
}

$startTime = microtime(true);
$totalCompressed = 0;
$totalSaved = 0;
$totalChecked = 0;
$iteration = 0;

echo "Starting optimization with batch limit {$batchLimit}...\n";

while (true) {
    $iteration++;
    $stepStart = microtime(true);
    $res = batch_compress_pending_images($pdo, $batchLimit);
    $stepElapsed = round(microtime(true) - $stepStart, 2);

    $totalChecked += $res['checked'];
    $totalCompressed += $res['compressed'];
    $totalSaved += $res['saved_bytes'];

    echo sprintf(
        "[%d] Checked %d, compressed %d, saved %s in %.2fs. Remaining pending: %d\n",
        $iteration,
        $res['checked'],
        $res['compressed'],
        format_bytes((float)$res['saved_bytes']),
        $stepElapsed,
        $res['remaining_pending']
    );

    if ($res['remaining_pending'] === 0 || $res['checked'] === 0) {
        break;
    }
}

$totalElapsed = round(microtime(true) - $startTime, 2);
echo "\n=== Optimization Complete ===\n";
echo "Total checked: {$totalChecked}\n";
echo "Total compressed: {$totalCompressed}\n";
echo "Total space saved: " . format_bytes((float)$totalSaved) . "\n";
echo "Time elapsed: {$totalElapsed}s\n";
