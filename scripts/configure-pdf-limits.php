<?php
declare(strict_types=1);

// Explicit operator action only; ordinary upgrades never overwrite admin limits.
if (PHP_SAPI !== 'cli' || count($argv) !== 4) exit(1);
date_default_timezone_set('Asia/Shanghai');
[$script, $appDir, $minutes, $documents] = $argv;
if (!preg_match('/^[0-9]+$/D', $minutes) || !preg_match('/^[0-9]+$/D', $documents)
    || (int)$minutes < 1 || (int)$minutes > 1440 || (int)$documents < 1 || (int)$documents > 256) exit(1);
$appDir = realpath($appDir);
if ($appDir === false) exit(1);
$config = is_file($appDir . '/config.php') ? require $appDir . '/config.php' : [];
$path = $config['db_path'] ?? $appDir . '/storage/app.db';
if (!is_file($path)) exit(1);
$pdo = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
$pdo->exec('PRAGMA busy_timeout = 3000');
$pdo->beginTransaction();
try {
    $stmt = $pdo->prepare('UPDATE settings SET value = ?, updated_at = ? WHERE key = ?');
    foreach (['pdf_export_window_seconds' => (string)((int)$minutes * 60), 'pdf_export_requests' => $documents] as $key => $value) {
        $stmt->execute([$value, date('Y-m-d H:i:s'), $key]);
        if ($stmt->rowCount() !== 1) throw new RuntimeException('PDF settings have not been initialized.');
    }
    $pdo->commit();
    echo "Applied requested per-visitor PDF quota: {$minutes} minutes, {$documents} documents.\n";
} catch (Throwable $error) {
    $pdo->rollBack();
    fwrite(STDERR, "PDF quota update failed; existing settings preserved.\n");
    exit(1);
}
