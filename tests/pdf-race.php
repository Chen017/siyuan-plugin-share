<?php
declare(strict_types=1);
// Isolated bootstrap only, provided by tests/run.py. One fresh visitor per process.
$_SERVER['SCRIPT_NAME'] = '/index.php';
$_SERVER['REMOTE_ADDR'] = '192.0.2.' . (int)$argv[3];
session_id('pdfrace' . bin2hex(random_bytes(12)));
require $argv[1];
while (microtime(true) < (float)$argv[4]) usleep(1000);
try {
    pdf_export_admit((int)$argv[2], hash('sha256', $argv[3]));
    echo 'accepted';
} catch (RuntimeException $error) {
    if ($error->getCode() !== 429) throw $error;
    echo 'limited';
}
