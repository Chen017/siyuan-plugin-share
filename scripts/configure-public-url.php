<?php
declare(strict_types=1);

// Explicit operator action; never trust arbitrary forwarded request headers.
if (PHP_SAPI !== 'cli' || count($argv) !== 3) exit(1);
$appDir = realpath($argv[1]);
$url = rtrim($argv[2], '/');
$parts = parse_url($url);
if ($appDir === false || strlen($url) > 2048 || !filter_var($url, FILTER_VALIDATE_URL)
    || !is_array($parts) || ($parts['scheme'] ?? '') !== 'https' || empty($parts['host'])
    || isset($parts['user']) || isset($parts['pass']) || isset($parts['query']) || isset($parts['fragment'])) {
    fwrite(STDERR, "Use a valid public HTTPS URL without credentials, query or fragment.\n"); exit(1);
}
$config = is_file($appDir . '/config.php') ? require $appDir . '/config.php' : [];
$path = $config['db_path'] ?? $appDir . '/storage/app.db';
if (!is_file($path)) exit(1);
$pdo = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
$pdo->exec('PRAGMA busy_timeout=3000');
$stmt = $pdo->prepare('UPDATE settings SET value=?, updated_at=? WHERE key=?');
$stmt->execute([$url, gmdate('Y-m-d H:i:s'), 'site_base_url']);
if ($stmt->rowCount() !== 1) { fwrite(STDERR, "Public address setting has not been initialized.\n"); exit(1); }
echo "Public share address configured: {$url}\n";
