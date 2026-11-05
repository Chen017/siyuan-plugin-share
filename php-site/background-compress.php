<?php
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}
if (!preg_match('/^[a-f0-9]{32}$/D', $argv[1] ?? '')) exit(1);
define('SIYUAN_CLI_BOOTSTRAP_ONLY', true);
require_once __DIR__ . '/index.php';
session_write_close();
set_time_limit(0);
exit(run_background_compression_job($argv[1]));
