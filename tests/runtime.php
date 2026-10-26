<?php
declare(strict_types=1);

// The runner supplies a bootstrap from an isolated copy, never production data.
error_reporting(E_ALL);
set_error_handler(static function (int $severity, string $message, string $file, int $line): bool {
    if (!(error_reporting() & $severity)) {
        return false;
    }
    throw new ErrorException($message, 0, $severity, $file, $line);
});
$_SERVER['SCRIPT_NAME'] = '/index.php';
$_SERVER['HTTP_HOST'] = 'localhost';
require $argv[1];

$checks = 0;
function check(bool $condition, string $message): void {
    global $checks;
    if (!$condition) {
        throw new RuntimeException($message);
    }
    $checks++;
}

check(
    PHP_MAJOR_VERSION === 8 && PHP_MINOR_VERSION === 3 && version_compare(PHP_VERSION, '8.3.36', '>='),
    'Expected PHP 8.3.36 or newer in the PHP 8.3 series (security fixes CVE-2026-109618 / CVE-2026-109619)'
);
foreach (['gd', 'mbstring', 'PDO', 'pdo_sqlite', 'zip', 'dom', 'fileinfo', 'openssl', 'zlib'] as $extension) {
    check(extension_loaded($extension), 'Missing extension: ' . $extension);
}
$pdo = db();
$before = $pdo->query('SELECT name, sql FROM sqlite_master ORDER BY name')->fetchAll();
migrate($pdo);
check($before === $pdo->query('SELECT name, sql FROM sqlite_master ORDER BY name')->fetchAll(), 'Migrations must be idempotent');
check((int)$pdo->query('SELECT COUNT(*) FROM users')->fetchColumn() === 1, 'Seed admin exactly once');
check($pdo->query('PRAGMA integrity_check')->fetchColumn() === 'ok', 'SQLite integrity');
check((int)$pdo->query('PRAGMA foreign_keys')->fetchColumn() === 1, 'Foreign keys enabled');
check(password_verify('123456', $pdo->query('SELECT password_hash FROM users')->fetchColumn()), 'Seed password hashing');

check(mb_strlen('思源笔记') === 4, 'UTF-8 mbstring');
check(compute_doc_content_hash('笔记') === hash('sha256', '笔记'), 'Content hashing');
check(sanitize_asset_path('../private.db') === '', 'Reject traversal');
check(sanitize_asset_path('assets/image.png') === 'assets/image.png', 'Allow normal asset path');
check(parse_expires_at(null) === null, 'No expiration');
check(parse_visitor_limit(4) === 4, 'Visitor limit');

$markdown = "# 中文标题\n\n**加粗** and [link](https://example.com)\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n- parent\n  - child\n\n```php\necho 1;\n```";
$html = render_markdown($markdown);
foreach (['中文标题', '<strong>加粗</strong>', '<table>', '<li>', '<code'] as $fragment) {
    check(str_contains($html, $fragment), 'Markdown rendering: ' . $fragment);
}
$clean = sanitize_share_html('<script>alert(1)</script><img src="x" onerror="alert(1)"><a href="javascript:alert(1)">link</a>');
check(!str_contains($clean, '<script') && !str_contains($clean, 'onerror') && !str_contains($clean, 'javascript:'), 'HTML sanitization');
$table = render_markdown("| A | B |\n| :--- | ---: |\n| left | right |\n{: colgroup=\"{x}{x}\"}");
check(str_contains($table, '<table>') && str_contains($table, 'left'), 'SiYuan table attributes render without diagnostics');

$image = imagecreatetruecolor(20, 20);
ob_start();
imagepng($image);
$png = ob_get_clean();
check(str_starts_with($png, "\x89PNG"), 'GD PNG generation');
check((new finfo(FILEINFO_MIME_TYPE))->buffer($png) === 'image/png', 'MIME detection');
imagedestroy($image);

$_SERVER['REMOTE_ADDR'] = '203.0.113.1';
$_SERVER['HTTP_X_REAL_IP'] = '198.51.100.1';
$originalIp = pdf_export_client_ip();
check($originalIp === bin2hex(inet_pton('203.0.113.1')), 'PDF ignores spoofed forwarding headers');
set_setting('pdf_export_trusted_proxies', '["203.0.113.1"]');
check(pdf_export_client_ip() === bin2hex(inet_pton('198.51.100.1')), 'PDF accepts the configured proxy-overwritten IP header');
set_setting('pdf_export_trusted_proxies', '[]');
$_SERVER['REMOTE_ADDR'] = '2001:db8::1';
$ipv6 = pdf_export_client_ip();
$_SERVER['REMOTE_ADDR'] = '2001:db8::abcd';
check(pdf_export_client_ip() === $ipv6, 'IPv6 privacy addresses share a /64 quota');
$config['pdf_export'] = ['max_docs' => 100000, 'max_concurrent' => 0];
$fileDefaults = pdf_export_initial_settings();
check($fileDefaults['pdf_export_max_docs'] === '120' && $fileDefaults['pdf_export_max_concurrent'] === '1', 'Configuration cannot disable export safety ceilings');
unset($config['pdf_export']);
set_setting('pdf_export_requests', '3');
migrate($pdo);
check(pdf_export_limits()['requests'] === 3, 'Migrations preserve administrator PDF settings');
set_setting('pdf_export_requests', '120');
$pdo->exec("DELETE FROM settings WHERE key = 'pdf_export_requests'");
set_setting('pdf_export_window_seconds', '600');
set_setting('pdf_export_ip_requests', '10');
set_setting('pdf_export_fingerprint_requests', '6');
seed_pdf_export_settings($pdo);
check(pdf_export_limits()['requests'] === 6 && pdf_export_limits()['window_seconds'] === 3600, 'Legacy stricter limits remain saved during policy migration');
$pdo->exec("DELETE FROM settings WHERE key = 'pdf_export_requests'");
set_setting('pdf_export_window_seconds', '1200');
set_setting('pdf_export_ip_requests', '2');
set_setting('pdf_export_fingerprint_requests', '7');
seed_pdf_export_settings($pdo);
check(pdf_export_limits()['requests'] === 2 && pdf_export_limits()['window_seconds'] === 1200, 'Legacy stricter custom allowance and custom window survive migration');
check((int)$pdo->query("SELECT COUNT(*) FROM settings WHERE key IN ('pdf_export_ip_requests', 'pdf_export_fingerprint_requests')")->fetchColumn() === 0, 'Legacy independent controls are retired');
set_setting('pdf_export_requests', '120');
set_setting('pdf_export_window_seconds', '3600');
unset($_SERVER['REMOTE_ADDR'], $_SERVER['HTTP_X_REAL_IP']);
$compressed = gzencode('中文文档');
check(gzdecode($compressed) === '中文文档', 'gzip round trip');
$zipPath = dirname($argv[1]) . '/storage/test.zip';
$zip = new ZipArchive();
check($zip->open($zipPath, ZipArchive::CREATE) === true, 'Create ZIP');
$zip->addFromString('note.md', $markdown);
$zip->close();
check($zip->open($zipPath) === true && $zip->getFromName('note.md') === $markdown, 'Read ZIP');
$zip->close();
unlink($zipPath);

require __DIR__ . '/legacy-migration.php';

echo "Runtime checks passed: {$checks}; PHP " . PHP_VERSION . "\n";
