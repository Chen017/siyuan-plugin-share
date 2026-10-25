<?php
declare(strict_types=1);
// Isolated bootstrap only, provided by tests/run.py. One fresh visitor per process.
$_SERVER['SCRIPT_NAME'] = '/index.php';
$rateRace = ($argv[5] ?? '') === 'rate';
$_SERVER['REMOTE_ADDR'] = $rateRace ? '192.0.2.1' : '192.0.2.' . (int)$argv[3];
session_id('pdfrace' . bin2hex(random_bytes(12)));
require $argv[1];
while (microtime(true) < (float)$argv[4]) usleep(1000);
$deadline = microtime(true) + 5;
while (true) {
    try {
        $lease = pdf_export_admit((int)$argv[2], hash('sha256', $argv[3]));
        if ($rateRace) pdf_export_release($lease);
        echo 'accepted';
        break;
    } catch (RuntimeException $error) {
        if ($error->getCode() !== 429) throw $error;
        // Do not mistake a transient per-IP lease for an exhausted time quota.
        if ($rateRace && str_contains($error->getMessage(), '已有导出') && microtime(true) < $deadline) {
            usleep(10000);
            continue;
        }
        echo 'limited';
        break;
    }
}
