<?php
declare(strict_types=1);

if (PHP_SAPI !== 'cli') exit(1);
$appDir = realpath($argv[1] ?? (__DIR__ . '/../php-site'));
if ($appDir === false || !is_file($appDir . '/index.php') || !is_file($appDir . '/image-compression.php')) {
    fwrite(STDERR, "Provide the application directory as the first argument.\n");
    exit(1);
}
define('SIYUAN_CLI_BOOTSTRAP_ONLY', true);
require_once $appDir . '/index.php';
session_write_close();
set_time_limit(0);
$limit = 20;
foreach (array_slice($argv, 2) as $arg) {
    if (!preg_match('/^--limit=([0-9]+)$/D', $arg, $match) || (int)$match[1] < 1 || (int)$match[1] > 1000) {
        fwrite(STDERR, "Expected --limit=1..1000.\n");
        exit(1);
    }
    $limit = (int)$match[1];
}
$created = create_image_compression_job();
if (!$created['success']) {
    echo $created['message'], "\n";
    exit(get_image_compression_stats(db())['pending_images'] === 0 ? 0 : 1);
}
$code = run_background_compression_job($created['data']['job_id'], $limit);
$task = get_background_compression_status();
echo json_encode($task, JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR), "\n";
exit($code);
