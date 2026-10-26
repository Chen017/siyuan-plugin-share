<?php
declare(strict_types=1);

$exampleVersion = null;
if (file_exists(__DIR__ . '/config.example.php')) {
    $exampleConfig = require __DIR__ . '/config.example.php';
    if (is_array($exampleConfig)) {
        if (array_key_exists('site_version', $exampleConfig)) {
            $exampleVersion = trim((string)($exampleConfig['site_version'] ?? ''));
        }
    }
}

$config = [
    'app_name' => '思源笔记分享',
    'site_version' => '',
    'db_path' => __DIR__ . '/storage/app.db',
    'uploads_dir' => __DIR__ . '/uploads',
    'default_storage_limit_mb' => 1024,
    'session_lifetime_days' => 30,
    'chunk_ttl_seconds' => 7200,
    'chunk_cleanup_probability' => 0.05,
    'chunk_cleanup_limit' => 20,
    'min_chunk_size_kb' => 256,
    'max_chunk_size_mb' => 8,
];

if (file_exists(__DIR__ . '/config.php')) {
    $local = require __DIR__ . '/config.php';
    if (is_array($local)) {
        $config = array_merge($config, $local);
    }
}
if ($exampleVersion !== null) {
    $config['site_version'] = $exampleVersion;
}

$sessionDays = (int)($config['session_lifetime_days'] ?? 30);
if ($sessionDays <= 0) {
    $sessionDays = 30;
}
$sessionLifetime = $sessionDays * 86400;
ini_set('session.gc_maxlifetime', (string)$sessionLifetime);
ini_set('session.cookie_lifetime', (string)$sessionLifetime);
session_set_cookie_params($sessionLifetime, '/', '', false, true);
session_start();
date_default_timezone_set('UTC');

if (function_exists('date_default_timezone_set')) {
    date_default_timezone_set('Asia/Shanghai');
}

require_once __DIR__ . '/vendor/Parsedown.php';
require_once __DIR__ . '/pdf-export.php';
require_once __DIR__ . '/legacy-cleanup.php';

function base_path(): string {
    $script = $_SERVER['SCRIPT_NAME'] ?? '';
    $dir = str_replace('\\', '/', dirname($script));
    $dir = rtrim($dir, '/');
    return $dir === '/' ? '' : $dir;
}

function base_url(): string {
    static $customBaseUrl = null;
    if ($customBaseUrl === null) {
        $customBaseUrl = trim((string)get_setting('site_base_url', ''));
        if ($customBaseUrl !== '') {
            $customBaseUrl = rtrim($customBaseUrl, '/');
        }
    }
    if ($customBaseUrl !== null && $customBaseUrl !== '') {
        return $customBaseUrl;
    }
    $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    $host = $_SERVER['HTTP_HOST'] ?? 'localhost';
    return $scheme . '://' . $host . base_path();
}

function redirect(string $path): void {
    header('Location: ' . base_path() . $path);
    exit;
}

function now(): string {
    return date('Y-m-d H:i:s');
}

function db(): PDO {
    static $pdo = null;
    global $config;
    if ($pdo) {
        return $pdo;
    }
    $dbDir = dirname($config['db_path']);
    if (!is_dir($dbDir)) {
        mkdir($dbDir, 0775, true);
    }
    $dsn = 'sqlite:' . $config['db_path'];
    $pdo = new PDO($dsn);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->exec('PRAGMA foreign_keys = ON;');
    migrate($pdo);
    return $pdo;
}

function migrate(PDO $pdo): void {
    $pdo->exec('CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT "user",
        api_key_hash TEXT,
        api_key_prefix TEXT,
        api_key_last4 TEXT,
        disabled INTEGER NOT NULL DEFAULT 0,
        storage_limit_bytes INTEGER NOT NULL DEFAULT 0,
        storage_used_bytes INTEGER NOT NULL DEFAULT 0,
        must_change_password INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );');

    $pdo->exec('CREATE TABLE IF NOT EXISTS shares (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        doc_id TEXT,
        notebook_id TEXT,
        password_hash TEXT,
        expires_at INTEGER,
        visitor_limit INTEGER NOT NULL DEFAULT 0,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        FOREIGN KEY(user_id) REFERENCES users(id)
    );');

    pdf_export_migrate($pdo);

    $pdo->exec('CREATE TABLE IF NOT EXISTS share_docs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        share_id INTEGER NOT NULL,
        doc_id TEXT NOT NULL,
        title TEXT NOT NULL,
        icon TEXT,
        hpath TEXT,
        parent_id TEXT,
        sort_index INTEGER NOT NULL DEFAULT 0,
        markdown TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        content_hash TEXT,
        meta_hash TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(share_id) REFERENCES shares(id)
    );');

    $pdo->exec('CREATE TABLE IF NOT EXISTS share_assets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        share_id INTEGER NOT NULL,
        doc_id TEXT,
        asset_path TEXT NOT NULL,
        file_path TEXT NOT NULL,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        asset_hash TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(share_id, asset_path),
        FOREIGN KEY(share_id) REFERENCES shares(id)
    );');

    $pdo->exec('CREATE TABLE IF NOT EXISTS share_uploads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        upload_id TEXT NOT NULL UNIQUE,
        user_id INTEGER NOT NULL,
        share_id INTEGER,
        type TEXT NOT NULL,
        doc_id TEXT,
        notebook_id TEXT,
        slug TEXT,
        title TEXT,
        password_hash TEXT,
        expires_at INTEGER,
        visitor_limit INTEGER NOT NULL DEFAULT 0,
        asset_manifest TEXT,
        doc_manifest TEXT,
        upload_mode TEXT,
        patch_manifest TEXT,
        status TEXT NOT NULL DEFAULT "pending",
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id),
        FOREIGN KEY(share_id) REFERENCES shares(id)
    );');

    $pdo->exec('CREATE TABLE IF NOT EXISTS share_upload_docs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        upload_id TEXT NOT NULL,
        doc_id TEXT NOT NULL,
        title TEXT NOT NULL,
        icon TEXT,
        hpath TEXT,
        parent_id TEXT,
        sort_index INTEGER NOT NULL DEFAULT 0,
        markdown TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        content_hash TEXT,
        meta_hash TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );');

    $pdo->exec('CREATE TABLE IF NOT EXISTS share_visitors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        share_id INTEGER NOT NULL,
        visitor_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(share_id, visitor_id),
        FOREIGN KEY(share_id) REFERENCES shares(id)
    );');
    $pdo->exec('CREATE INDEX IF NOT EXISTS idx_share_visitors_share ON share_visitors (share_id)');

    $pdo->exec('CREATE TABLE IF NOT EXISTS recycled_share_ids (
        share_id INTEGER PRIMARY KEY,
        created_at TEXT NOT NULL
    );');

    $pdo->exec('CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );');

    ensure_column($pdo, 'users', 'storage_limit_bytes', 'INTEGER NOT NULL DEFAULT 0');
    ensure_column($pdo, 'users', 'storage_used_bytes', 'INTEGER NOT NULL DEFAULT 0');
    ensure_column($pdo, 'users', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0');
    ensure_column($pdo, 'shares', 'password_hash', 'TEXT');
    ensure_column($pdo, 'shares', 'expires_at', 'INTEGER');
    ensure_column($pdo, 'shares', 'visitor_limit', 'INTEGER NOT NULL DEFAULT 0');
    ensure_column($pdo, 'shares', 'size_bytes', 'INTEGER NOT NULL DEFAULT 0');
    ensure_column($pdo, 'share_uploads', 'visitor_limit', 'INTEGER NOT NULL DEFAULT 0');
    ensure_column($pdo, 'share_uploads', 'upload_mode', 'TEXT');
    ensure_column($pdo, 'share_uploads', 'patch_manifest', 'TEXT');
    ensure_column($pdo, 'share_uploads', 'doc_manifest', 'TEXT');
    ensure_column($pdo, 'share_upload_docs', 'icon', 'TEXT');
    ensure_column($pdo, 'share_upload_docs', 'content_hash', 'TEXT');
    ensure_column($pdo, 'share_upload_docs', 'meta_hash', 'TEXT');
    ensure_column($pdo, 'share_docs', 'size_bytes', 'INTEGER NOT NULL DEFAULT 0');
    ensure_column($pdo, 'share_docs', 'icon', 'TEXT');
    ensure_column($pdo, 'share_docs', 'sort_order', 'INTEGER NOT NULL DEFAULT 0');
    ensure_column($pdo, 'share_docs', 'parent_id', 'TEXT');
    ensure_column($pdo, 'share_docs', 'sort_index', 'INTEGER NOT NULL DEFAULT 0');
    ensure_column($pdo, 'share_docs', 'content_hash', 'TEXT');
    ensure_column($pdo, 'share_docs', 'meta_hash', 'TEXT');
    ensure_column($pdo, 'share_assets', 'size_bytes', 'INTEGER NOT NULL DEFAULT 0');
    ensure_column($pdo, 'share_assets', 'asset_hash', 'TEXT');

    seed_default_settings($pdo);
    seed_default_admin($pdo);
    retire_legacy_modules($pdo);
}

function table_has_column(PDO $pdo, string $table, string $column): bool {
    $stmt = $pdo->query('PRAGMA table_info(' . $table . ')');
    $cols = $stmt ? $stmt->fetchAll(PDO::FETCH_ASSOC) : [];
    foreach ($cols as $col) {
        if (isset($col['name']) && $col['name'] === $column) {
            return true;
        }
    }
    return false;
}

function ensure_column(PDO $pdo, string $table, string $column, string $definition): void {
    if (!table_has_column($pdo, $table, $column)) {
        $pdo->exec('ALTER TABLE ' . $table . ' ADD COLUMN ' . $column . ' ' . $definition);
    }
}

function fetch_setting(PDO $pdo, string $key): ?string {
    $stmt = $pdo->prepare('SELECT value FROM settings WHERE key = :key LIMIT 1');
    $stmt->execute([':key' => $key]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ? $row['value'] : null;
}

function ensure_setting(PDO $pdo, string $key, string $value): void {
    $existing = fetch_setting($pdo, $key);
    if ($existing !== null) {
        return;
    }
    $stmt = $pdo->prepare('INSERT INTO settings (key, value, updated_at) VALUES (:key, :value, :updated_at)');
    $stmt->execute([
        ':key' => $key,
        ':value' => $value,
        ':updated_at' => now(),
    ]);
}

function seed_default_settings(PDO $pdo): void {
    global $config;
    $defaultLimit = (int)$config['default_storage_limit_mb'] * 1024 * 1024;
    ensure_setting($pdo, 'default_storage_limit_bytes', (string)$defaultLimit);
    ensure_setting($pdo, 'site_base_url', '');
    ensure_setting($pdo, 'reader_home_url', '');
    ensure_setting($pdo, 'site_head_html', '');
    ensure_setting($pdo, 'site_custom_css_enabled', '1');
    ensure_setting($pdo, 'site_custom_css', '');
    ensure_setting($pdo, 'site_custom_js_enabled', '0');
    ensure_setting($pdo, 'site_custom_js', '');
    seed_pdf_export_settings($pdo);
}

function seed_default_admin(PDO $pdo): void {
    $count = (int)$pdo->query('SELECT COUNT(*) AS cnt FROM users WHERE role = "admin"')->fetchColumn();
    if ($count > 0) {
        return;
    }
    $now = now();
    $stmt = $pdo->prepare('INSERT INTO users (username, password_hash, role, api_key_hash, api_key_prefix, api_key_last4, disabled, storage_limit_bytes, storage_used_bytes, must_change_password, created_at, updated_at)
        VALUES (:username, :password_hash, :role, :api_key_hash, :api_key_prefix, :api_key_last4, :disabled, :storage_limit_bytes, :storage_used_bytes, :must_change_password, :created_at, :updated_at)');
    $stmt->execute([
        ':username' => 'admin',
        ':password_hash' => password_hash('123456', PASSWORD_DEFAULT),
        ':role' => 'admin',
        ':api_key_hash' => null,
        ':api_key_prefix' => null,
        ':api_key_last4' => null,
        ':disabled' => 0,
        ':storage_limit_bytes' => 0,
        ':storage_used_bytes' => 0,
        ':must_change_password' => 1,
        ':created_at' => $now,
        ':updated_at' => $now,
    ]);
}

function csrf_token(): string {
    if (empty($_SESSION['csrf'])) {
        $_SESSION['csrf'] = bin2hex(random_bytes(16));
    }
    return $_SESSION['csrf'];
}

function check_csrf(): void {
    $token = $_POST['csrf'] ?? '';
    if (!$token || !hash_equals($_SESSION['csrf'] ?? '', $token)) {
        http_response_code(400);
        echo 'Page verification expired. Reload and retry.';
        exit;
    }
}

function flash(string $key, ?string $value = null): ?string {
    if ($value !== null) {
        $_SESSION['flash'][$key] = $value;
        return null;
    }
    $val = $_SESSION['flash'][$key] ?? null;
    if (isset($_SESSION['flash'][$key])) {
        unset($_SESSION['flash'][$key]);
    }
    return $val;
}

function get_setting(string $key, ?string $default = null): ?string {
    $pdo = db();
    $stmt = $pdo->prepare('SELECT value FROM settings WHERE key = :key LIMIT 1');
    $stmt->execute([':key' => $key]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if ($row && array_key_exists('value', $row)) {
        return $row['value'];
    }
    return $default;
}

function set_setting(string $key, string $value): void {
    $pdo = db();
    $stmt = $pdo->prepare('INSERT INTO settings (key, value, updated_at) VALUES (:key, :value, :updated_at)
        ON CONFLICT(key) DO UPDATE SET value = :value_update, updated_at = :updated_at_update');
    $stmt->execute([
        ':key' => $key,
        ':value' => $value,
        ':updated_at' => now(),
        ':value_update' => $value,
        ':updated_at_update' => now(),
    ]);
}

function get_bool_setting(string $key, bool $default = false): bool {
    $value = get_setting($key, $default ? '1' : '0');
    return (int)$value === 1;
}

function escape_inline_style_content(string $css): string {
    return str_ireplace('</style', '<\/style', $css);
}

function escape_inline_script_content(string $js): string {
    return str_ireplace('</script', '<\/script', $js);
}

function default_storage_limit_bytes(): int {
    $value = (int)get_setting('default_storage_limit_bytes', '0');
    return max(0, $value);
}

function string_len(string $text): int {
    if (function_exists('mb_strlen')) {
        return (int)mb_strlen($text, 'UTF-8');
    }
    return strlen($text);
}

function string_sub(string $text, int $start, int $length): string {
    if (function_exists('mb_substr')) {
        return (string)mb_substr($text, $start, $length, 'UTF-8');
    }
    return substr($text, $start, $length);
}

function parse_expires_at($raw): ?int {
    if ($raw === null || $raw === '' || $raw === false) {
        return null;
    }
    if (is_numeric($raw)) {
        $ts = (int)$raw;
        if ($ts > 1000000000000) {
            $ts = (int)floor($ts / 1000);
        }
        return $ts > 0 ? $ts : null;
    }
    $ts = strtotime((string)$raw);
    return $ts ? $ts : null;
}

function parse_visitor_limit($raw): ?int {
    if ($raw === null || $raw === '' || $raw === false) {
        return null;
    }
    if (is_numeric($raw)) {
        return max(0, (int)$raw);
    }
    return null;
}

function extract_front_matter(string $markdown): array {
    $meta = [];
    $body = $markdown;
    if (preg_match('/\A---\s*\R(.*?)\R---\s*\R/s', $markdown, $matches)) {
        $raw = trim((string)$matches[1]);
        $body = substr($markdown, strlen($matches[0]));
        foreach (preg_split('/\R/', $raw) as $line) {
            if (strpos($line, ':') === false) {
                continue;
            }
            [$key, $value] = array_map('trim', explode(':', $line, 2));
            if ($key === '') {
                continue;
            }
            $meta[strtolower($key)] = trim($value, " \t\"'");
        }
    }
    return ['meta' => $meta, 'body' => $body];
}

function format_bytes(float $bytes): string {
    if ($bytes <= 0) {
        return '0 B';
    }
    $units = ['B', 'KB', 'MB', 'GB', 'TB'];
    $idx = 0;
    $val = (float)$bytes;
    while ($val >= 1024 && $idx < count($units) - 1) {
        $val /= 1024;
        $idx++;
    }
    return sprintf('%.2f %s', $val, $units[$idx]);
}

function normalize_page_size($raw, int $default = 10): int {
    $allowed = [10, 50, 200, 1000];
    $size = (int)$raw;
    if (!in_array($size, $allowed, true)) {
        $size = $default;
    }
    return $size;
}

function paginate(int $total, int $page, int $size): array {
    $pages = max(1, (int)ceil($total / max(1, $size)));
    $page = max(1, min($page, $pages));
    $offset = ($page - 1) * $size;
    return [$page, $size, $pages, $offset];
}

function build_dashboard_query_url(array $overrides = []): string {
    $query = array_merge($_GET, $overrides);
    foreach ($query as $key => $value) {
        if ($value === null || $value === '') {
            unset($query[$key]);
        }
    }
    $qs = http_build_query($query);
    return base_path() . '/dashboard' . ($qs ? '?' . $qs : '') . '#shares';
}

function render_hidden_inputs(array $values): string {
    $html = '';
    foreach ($values as $key => $value) {
        if ($value === null || $value === '') {
            continue;
        }
        $html .= '<input type="hidden" name="' . htmlspecialchars((string)$key) . '" value="' . htmlspecialchars((string)$value) . '">';
    }
    return $html;
}

function bytes_from_mb(int $mb): int {
    if ($mb <= 0) {
        return 0;
    }
    return $mb * 1024 * 1024;
}

function mb_from_bytes(int $bytes): int {
    if ($bytes <= 0) {
        return 0;
    }
    return (int)floor($bytes / 1024 / 1024);
}

function render_share_icon_defs(): string {
    return <<<'SVG'
<svg class="kb-icon-defs" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">
  <symbol id="sps-tree-arrow-collapsed" viewBox="0 0 24 24" fill="none">
    <path d="M9 18L15 12L9 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </symbol>
  <symbol id="sps-tree-arrow-expanded" viewBox="0 0 24 24" fill="none">
    <path d="M6 9L12 15L18 9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </symbol>
  <symbol id="sps-tree-collapse-all" viewBox="0 0 24 24" fill="none">
    <path d="M4 20L11 13M11 13V17M11 13H7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M20 4L13 11M13 11V7M13 11H17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </symbol>
  <symbol id="sps-tree-expand-all" viewBox="0 0 24 24" fill="none">
    <path d="M11 13L4 20M4 20V16M4 20H8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M13 11L20 4M20 4V8M20 4H16" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </symbol>
</svg>
SVG;
}

function site_asset_version(): string {
    static $version = null;
    if ($version !== null) return $version;
    $paths = array_merge(glob(__DIR__ . '/assets/*.*') ?: [], glob(__DIR__ . '/assets/vendor/*.*') ?: []);
    $parts = [];
    foreach ($paths as $path) {
        if (is_file($path)) $parts[] = basename($path) . ':' . filemtime($path) . ':' . filesize($path);
    }
    sort($parts);
    return $version = substr(hash('sha256', implode('|', $parts)), 0, 16);
}

function site_asset_url(string $path): string {
    return base_path() . '/assets/' . $path . '?v=' . site_asset_version();
}

function render_page(string $title, string $content, ?array $user = null, string $baseHref = '', array $options = []): void {
    global $config;
    $base = base_path();
    $app = htmlspecialchars($config['app_name']);
    $pageTitle = htmlspecialchars($title);
    $userName = $user ? htmlspecialchars($user['username']) : '';
    $layout = isset($options['layout']) ? (string)$options['layout'] : ($user ? 'app' : 'public');
    $titleHtml = $pageTitle;
    if (!empty($options['title_html'])) {
        $titleHtml = (string)$options['title_html'];
    }
    $layoutClass = 'layout-' . preg_replace('/[^a-z0-9_-]+/i', '', $layout);
    $includeMarkdown = !empty($options['markdown']);
    if (!empty($options['pdf_export']) && $includeMarkdown) $layoutClass .= ' pdf-export-preview';
    if (!empty($options['pdf_embedded'])) $layoutClass .= ' pdf-export-embedded';
    $navKey = (string)($options['nav'] ?? '');
    echo "<!doctype html>";
    $pageLanguage = in_array($layout, ['share', 'public', 'auth'], true) ? 'en' : 'zh-CN';
    echo "<html lang='{$pageLanguage}'>";
    echo "<head>";
    echo "<meta charset='utf-8'>";
    echo "<meta name='viewport' content='width=device-width, initial-scale=1'>";
    echo "<title>{$pageTitle} - {$app}</title>";
    $description = htmlspecialchars(mb_substr($title . ' - ' . $config['app_name'] . '，在线阅读与分享笔记、课程资料和学习记录。', 0, 160), ENT_QUOTES, 'UTF-8');
    echo "<meta name='description' content='{$description}'>";
    if ($baseHref !== '') {
        $safeBase = htmlspecialchars($baseHref);
        echo "<base href='{$safeBase}'>";
    }
    if ($includeMarkdown) {
        echo "<link rel='stylesheet' href='" . htmlspecialchars(site_asset_url('vendor/github-markdown.min.css'), ENT_QUOTES, 'UTF-8') . "'>";
        echo "<link rel='stylesheet' href='" . htmlspecialchars(site_asset_url('vendor/katex.min.css'), ENT_QUOTES, 'UTF-8') . "'>";
        echo "<link rel='stylesheet' href='" . htmlspecialchars(site_asset_url('vendor/highlight.min.css'), ENT_QUOTES, 'UTF-8') . "'>";
    }
    $styleUrl = htmlspecialchars(site_asset_url('style.css'), ENT_QUOTES, 'UTF-8');
    echo "<link rel='stylesheet' href='{$styleUrl}'>";
    $siteCustomCssEnabled = get_bool_setting('site_custom_css_enabled', true);
    $siteCustomCss = (string)get_setting('site_custom_css', '');
    if ($siteCustomCssEnabled && trim($siteCustomCss) !== '') {
        $safeCustomCss = escape_inline_style_content($siteCustomCss);
        echo "<style id='site-custom-css'>\n{$safeCustomCss}\n</style>";
    }
    $siteHeadHtml = (string)get_setting('site_head_html', '');
    if ($siteHeadHtml !== '') {
        echo $siteHeadHtml;
    }
    if ($layout === 'share') {
        echo "<style id='sps-share-font-force'>body.layout-share .markdown-body,body.layout-share .markdown-body :where(p,li,a,strong,em,del,mark,h1,h2,h3,h4,h5,h6,blockquote,td,th){font-family:var(--font-markdown) !important;}</style>";
    }
    if ($layout === 'share') {
        $pdfStyleUrl = htmlspecialchars(site_asset_url('pdf-export.css'), ENT_QUOTES, 'UTF-8');
        echo "<link rel='stylesheet' href='{$pdfStyleUrl}'>";
    }
    echo "</head>";
    echo "<body class='{$layoutClass}'>";

    if ($layout === 'auth') {
        echo "<div class='auth-shell' role='main'>";
        echo $content;
        echo "</div>";
    } elseif ($layout === 'share') {
        echo "<div class='share-page'>";
        echo render_share_icon_defs();
        if (empty($options['pdf_export'])) echo "<div class='reader-frame'>";
        echo "<header class='reader-mobile-bar'><button class='reader-nav-button' type='button' data-share-drawer-open aria-label='Open navigation' aria-expanded='false'><svg viewBox='0 0 24 24' aria-hidden='true'><path fill='currentColor' d='M4 6h16v2H4zM4 11h16v2H4zM4 16h16v2H4z'/></svg><span>Navigation</span></button><span class='reader-mobile-title' data-reader-mobile-title>{$pageTitle}</span></header>";
        echo $content;
        echo "<footer class='share-footer'><span class='footer-credit'>Maintained by <a class='footer-owner' href='https://github.com/Chen017/siyuan-plugin-share' target='_blank' rel='noopener noreferrer'>Chen017</a></span><span class='footer-separator' aria-hidden='true'>·</span><span class='footer-credit'>Upstream: <a class='footer-upstream' href='https://github.com/b8l8u8e8/siyuan-plugin-share' target='_blank' rel='noopener noreferrer'>Siyuan Share</a></span></footer>";
        if (empty($options['pdf_export'])) echo "</div>";
        echo "<div class='share-side-backdrop' data-share-drawer-close></div>";
        echo "<p class='reader-status sr-only' data-reader-status role='status' aria-live='polite'></p>";
        echo "<button class='scroll-top' type='button' data-scroll-top aria-label='Back to top'><svg viewBox='0 0 24 24' aria-hidden='true'><path fill='currentColor' d='M12 2c-2.76 0-5 2.24-5 5v2.5L4 13l4.5 1L12 22l3.5-8L20 13l-3-3.5V7c0-2.76-2.24-5-5-5zm0 3a2 2 0 0 1 2 2v1.5l-2 2-2-2V7a2 2 0 0 1 2-2z'/></svg></button>";
        echo "</div>";
    } elseif ($user) {
        $navItems = [
            ['key' => 'dashboard', 'label' => 'Notes', 'href' => $base . '/dashboard'],
            ['key' => 'admin-settings', 'label' => 'Site settings', 'href' => $base . '/admin#settings'],
            ['key' => 'account', 'label' => 'Password', 'href' => $base . '/account'],
        ];
        echo "<div class='app-shell'>";
        echo "<aside class='app-sidebar'>";
        echo "<div class='app-logo'>{$app}</div>";
        echo "<nav class='app-nav'>";
        foreach ($navItems as $item) {
            $active = $navKey === $item['key'] ? ' is-active' : '';
            $label = htmlspecialchars($item['label']);
            $hrefRaw = (string)$item['href'];
            $hashPos = strpos($hrefRaw, '#');
            $pathOnly = $hashPos === false ? $hrefRaw : substr($hrefRaw, 0, $hashPos);
            $hash = $hashPos === false ? '' : substr($hrefRaw, $hashPos + 1);
            $href = htmlspecialchars($hrefRaw);
            $dataAttrs = ' data-nav-key="' . htmlspecialchars((string)$item['key']) . '"';
            $dataAttrs .= ' data-nav-path="' . htmlspecialchars($pathOnly) . '"';
            if ($hash !== '') {
                $dataAttrs .= ' data-nav-hash="' . htmlspecialchars($hash) . '"';
            }
            echo "<a class='nav-item{$active}' href='{$href}'{$dataAttrs}><span class='nav-dot'></span><span class='nav-label'>{$label}</span>";
            echo "</a>";
        }
        echo "</nav>";
        echo "</aside>";
        echo "<div class='app-main'>";
        echo "<header class='app-topbar'>";
        echo "<div class='topbar-left'>";
        echo "<button class='app-side-trigger' type='button' data-app-drawer-open aria-label='Open navigation'><svg viewBox='0 0 24 24' aria-hidden='true'><path fill='currentColor' d='M4 6h16v2H4zM4 11h16v2H4zM4 16h16v2H4z'/></svg></button>";
        echo "<div class='topbar-title'>{$titleHtml}</div>";
        echo "</div>";
        echo "<div class='topbar-right'>";
        echo "<span class='user-pill'>{$userName}</span>";
        echo "<form method='post' action='{$base}/logout' class='inline-form'>";
        echo "<input type='hidden' name='csrf' value='" . csrf_token() . "'>";
        echo "<button class='button ghost' type='submit'>Sign out</button>";
        echo "</form>";
        echo "</div>";
        echo "</header>";
        echo "<main class='app-content'>";
        echo $content;
        echo "</main>";
        echo "<footer class='app-footer'><span class='footer-credit'>Maintained by <a class='footer-owner' href='https://github.com/Chen017/siyuan-plugin-share' target='_blank' rel='noopener noreferrer'>Chen017</a></span><span class='footer-separator' aria-hidden='true'>·</span><span class='footer-credit'>Upstream: <a class='footer-upstream' href='https://github.com/b8l8u8e8/siyuan-plugin-share' target='_blank' rel='noopener noreferrer'>Siyuan Share</a></span></footer>";
        echo "</div>";
        echo "</div>";
        echo "<div class='app-side-backdrop' data-app-drawer-close></div>";
    } else {
        echo "<div class='public-shell' role='main'>";
        echo $content;
        echo "</div>";
    }


    // Core Markdown is ready before app.js; large diagram engines load only on demand.
    if ($includeMarkdown) {
        echo "<script defer src='" . htmlspecialchars(site_asset_url('vendor/markdown-it.min.js'), ENT_QUOTES, 'UTF-8') . "'></script>";
        echo "<script defer src='" . htmlspecialchars(site_asset_url('vendor/markdown-it-task-lists.min.js'), ENT_QUOTES, 'UTF-8') . "'></script>";
        echo "<script defer src='" . htmlspecialchars(site_asset_url('vendor/markdown-it-emoji.min.js'), ENT_QUOTES, 'UTF-8') . "'></script>";
        echo "<script defer src='" . htmlspecialchars(site_asset_url('vendor/markdown-it-footnote.min.js'), ENT_QUOTES, 'UTF-8') . "'></script>";
        echo "<script defer src='" . htmlspecialchars(site_asset_url('vendor/markdown-it-deflist.min.js'), ENT_QUOTES, 'UTF-8') . "'></script>";
        echo "<script defer src='" . htmlspecialchars(site_asset_url('vendor/markdown-it-mark.min.js'), ENT_QUOTES, 'UTF-8') . "'></script>";
        echo "<script defer src='" . htmlspecialchars(site_asset_url('vendor/markdown-it-sub.min.js'), ENT_QUOTES, 'UTF-8') . "'></script>";
        echo "<script defer src='" . htmlspecialchars(site_asset_url('vendor/markdown-it-sup.min.js'), ENT_QUOTES, 'UTF-8') . "'></script>";
        echo "<script defer src='" . htmlspecialchars(site_asset_url('vendor/markdown-it-abbr.min.js'), ENT_QUOTES, 'UTF-8') . "'></script>";
        echo "<script defer src='" . htmlspecialchars(site_asset_url('vendor/markdown-it-ins.min.js'), ENT_QUOTES, 'UTF-8') . "'></script>";
        echo "<script defer src='" . htmlspecialchars(site_asset_url('vendor/markdown-it-container.min.js'), ENT_QUOTES, 'UTF-8') . "'></script>";
        echo "<script defer src='" . htmlspecialchars(site_asset_url('vendor/markdown-it-anchor.min.js'), ENT_QUOTES, 'UTF-8') . "'></script>";
        echo "<script defer src='" . htmlspecialchars(site_asset_url('vendor/katex.min.js'), ENT_QUOTES, 'UTF-8') . "'></script>";
        echo "<script defer src='" . htmlspecialchars(site_asset_url('vendor/highlight.min.js'), ENT_QUOTES, 'UTF-8') . "'></script>";
    }
    $appJsUrl = htmlspecialchars(site_asset_url('app.js'), ENT_QUOTES, 'UTF-8');
    echo "<script defer src='{$appJsUrl}'></script>";
    $siteCustomJsEnabled = get_bool_setting('site_custom_js_enabled', false);
    $siteCustomJs = (string)get_setting('site_custom_js', '');
    if ($siteCustomJsEnabled && trim($siteCustomJs) !== '') {
        $safeCustomJs = escape_inline_script_content($siteCustomJs);
        echo "<script id='site-custom-js'>\nwindow.addEventListener('DOMContentLoaded', function () {\n{$safeCustomJs}\n});\n</script>";
    }
    if ($layout === 'share') {
        $pdfJsUrl = htmlspecialchars(site_asset_url('pdf-export.js'), ENT_QUOTES, 'UTF-8');
        echo "<script defer src='{$pdfJsUrl}'></script>";
    }
    echo "</body>";
    echo "</html>";
    exit;
}

function render_auth_mascot(): string {
    return <<<'HTML'
<div class="auth-mascot-pair" aria-hidden="true">
  <div class="auth-mascot auth-mascot--left" data-auth-mascot data-mascot-state="idle">
    <div class="auth-mascot__halo"></div>
    <div class="auth-mascot__head">
      <span class="auth-mascot__ear auth-mascot__ear--left"></span>
      <span class="auth-mascot__ear auth-mascot__ear--right"></span>
      <span class="auth-mascot__eye auth-mascot__eye--left"><span class="auth-mascot__pupil"></span></span>
      <span class="auth-mascot__eye auth-mascot__eye--right"><span class="auth-mascot__pupil"></span></span>
      <span class="auth-mascot__blush auth-mascot__blush--left"></span>
      <span class="auth-mascot__blush auth-mascot__blush--right"></span>
      <span class="auth-mascot__nose"></span>
      <span class="auth-mascot__mouth"></span>
      <span class="auth-mascot__hand auth-mascot__hand--left"></span>
      <span class="auth-mascot__hand auth-mascot__hand--right"></span>
    </div>
  </div>
  <div class="auth-mascot auth-mascot--right" data-auth-mascot data-mascot-state="idle">
    <div class="auth-mascot__halo"></div>
    <div class="auth-mascot__head">
      <span class="auth-mascot__ear auth-mascot__ear--left"></span>
      <span class="auth-mascot__ear auth-mascot__ear--right"></span>
      <span class="auth-mascot__eye auth-mascot__eye--left"><span class="auth-mascot__pupil"></span></span>
      <span class="auth-mascot__eye auth-mascot__eye--right"><span class="auth-mascot__pupil"></span></span>
      <span class="auth-mascot__blush auth-mascot__blush--left"></span>
      <span class="auth-mascot__blush auth-mascot__blush--right"></span>
      <span class="auth-mascot__nose"></span>
      <span class="auth-mascot__mouth"></span>
      <span class="auth-mascot__hand auth-mascot__hand--left"></span>
      <span class="auth-mascot__hand auth-mascot__hand--right"></span>
    </div>
  </div>
</div>
HTML;
}

function render_404_page(): void {
    http_response_code(404);
    $base = base_path();
    $content = '<div class="error-page">';
    $content .= '<div class="error-page__scene">';
    $content .= '<div class="error-page__stars"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>';
    $content .= '<div class="error-page__planet"><div class="error-page__planet-body"></div><div class="error-page__planet-ring"></div></div>';
    $content .= '<div class="error-page__satellite"></div>';
    $content .= '<div class="error-page__comet"></div>';
    $content .= '</div>';
    $content .= '<h1 class="error-page__code">404</h1>';
    $content .= '<h2 class="error-page__title">页面飞走了</h2>';
    $content .= '<p class="error-page__desc">你访问的页面不存在，可能已被移除或者地址有误。</p>';
    $content .= '<a class="error-page__back" href="' . $base . '/">';
    $content .= '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/></svg>';
    $content .= 'Home</a>';
    $content .= '</div>';
    render_page('页面未找到', $content, null);
}

function render_share_not_found_page(): void {
    http_response_code(404);
    $base = base_path();
    $content = '<div class="error-page">';
    $content .= '<div class="error-page__scene">';
    $content .= '<div class="error-page__stars"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>';
    $content .= '<div class="error-page__signal"><i></i><i></i><i></i><i></i><div class="error-page__signal-core"></div></div>';
    $content .= '</div>';
    $content .= '<h2 class="error-page__title">找不到这个分享</h2>';
    $content .= '<p class="error-page__desc">该分享链接不存在或已被创建者删除。</p>';
    $content .= '<a class="error-page__back" href="' . $base . '/">';
    $content .= '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/></svg>';
    $content .= 'Home</a>';
    $content .= '</div>';
    render_page('分享不存在', $content, null);
}

function sanitize_slug(string $slug): string {
    return strtolower(trim($slug));
}

function parse_requested_share_slug_or_fail($raw): string {
    $slug = sanitize_slug((string)$raw);
    if ($slug === '') {
        return '';
    }
    if (!preg_match('/^[a-z0-9]+$/', $slug)) {
        api_response(400, [
            'errorKey' => 'share.slug.invalid_chars',
            'min' => SHARE_SLUG_MIN_LENGTH,
            'max' => SHARE_SLUG_MAX_LENGTH,
        ], 'Invalid share link suffix');
    }
    $len = strlen($slug);
    if ($len < SHARE_SLUG_MIN_LENGTH || $len > SHARE_SLUG_MAX_LENGTH) {
        api_response(400, [
            'errorKey' => 'share.slug.invalid_length',
            'min' => SHARE_SLUG_MIN_LENGTH,
            'max' => SHARE_SLUG_MAX_LENGTH,
        ], 'Invalid share link suffix length');
    }
    return $slug;
}

function share_slug_exists(PDO $pdo, string $slug, int $excludeShareId = 0): bool {
    if ($slug === '') {
        return false;
    }
    if ($excludeShareId > 0) {
        $stmt = $pdo->prepare('SELECT id FROM shares WHERE slug = :slug AND deleted_at IS NULL AND id != :id LIMIT 1');
        $stmt->execute([
            ':slug' => $slug,
            ':id' => $excludeShareId,
        ]);
        return !!$stmt->fetchColumn();
    }
    $stmt = $pdo->prepare('SELECT id FROM shares WHERE slug = :slug AND deleted_at IS NULL LIMIT 1');
    $stmt->execute([':slug' => $slug]);
    return !!$stmt->fetchColumn();
}

function ensure_share_slug_available_or_fail(PDO $pdo, string $slug, int $excludeShareId = 0): void {
    if (!share_slug_exists($pdo, $slug, $excludeShareId)) {
        return;
    }
    api_response(409, [
        'errorKey' => 'share.slug.conflict',
        'min' => SHARE_SLUG_MIN_LENGTH,
        'max' => SHARE_SLUG_MAX_LENGTH,
    ], 'Share link already exists');
}

function allocate_random_share_slug_or_fail(PDO $pdo): string {
    for ($i = 0; $i < 20; $i++) {
        $slug = sanitize_slug(bin2hex(random_bytes(4)));
        if (!share_slug_exists($pdo, $slug)) {
            return $slug;
        }
    }
    api_response(500, [
        'errorKey' => 'share.slug.generate_failed',
        'min' => SHARE_SLUG_MIN_LENGTH,
        'max' => SHARE_SLUG_MAX_LENGTH,
    ], 'Unable to allocate unique share link');
}

function generate_api_key(): array {
    $raw = bin2hex(random_bytes(24));
    $hash = password_hash($raw, PASSWORD_DEFAULT);
    $prefix = substr($raw, 0, 8);
    $last4 = substr($raw, -4);
    return [$raw, $hash, $prefix, $last4];
}

function get_user_limit_bytes(array $user): int {
    $userLimit = isset($user['storage_limit_bytes']) ? (int)$user['storage_limit_bytes'] : 0;
    if ($userLimit > 0) {
        return $userLimit;
    }
    return default_storage_limit_bytes();
}

function recalculate_user_storage(int $userId): int {
    $pdo = db();
    $stmt = $pdo->prepare('SELECT COALESCE(SUM(size_bytes), 0) AS total FROM shares WHERE user_id = :uid AND deleted_at IS NULL');
    $stmt->execute([':uid' => $userId]);
    $shareTotal = (int)($stmt->fetch(PDO::FETCH_ASSOC)['total'] ?? 0);
    $total = $shareTotal;
    $update = $pdo->prepare('UPDATE users SET storage_used_bytes = :total WHERE id = :id');
    $update->execute([':total' => $total, ':id' => $userId]);
    return $total;
}

function get_visitor_id(): string {
    $existing = trim((string)($_COOKIE['sps_uv'] ?? ''));
    if ($existing !== '') {
        return $existing;
    }
    $id = bin2hex(random_bytes(12));
    setcookie('sps_uv', $id, time() + 86400 * 365, '/', '', false, true);
    $_COOKIE['sps_uv'] = $id;
    return $id;
}

function min_chunk_size_bytes(): int {
    global $config;
    $kb = (int)($config['min_chunk_size_kb'] ?? 256);
    if ($kb <= 0) {
        $kb = 256;
    }
    return $kb * 1024;
}

function max_chunk_size_bytes(): int {
    global $config;
    $mb = (int)($config['max_chunk_size_mb'] ?? 8);
    if ($mb <= 0) {
        $mb = 8;
    }
    return $mb * 1024 * 1024;
}

function chunk_size_limits(): array {
    $min = min_chunk_size_bytes();
    $max = max_chunk_size_bytes();
    if ($max < $min) {
        $max = $min;
    }
    return [$min, $max];
}

function site_version(): string {
    global $config;
    return trim((string)($config['site_version'] ?? ''));
}

function handle_share_search(string $slug): void {
    $share = find_share_by_slug($slug);
    if (!$share) {
        api_response(404, null, '分享不存在');
    }
    if (share_is_expired($share) || share_visitor_limit_reached($share)) {
        api_response(403, null, '分享已关闭');
    }
    if (share_requires_password($share) && !share_access_granted((int)$share['id'])) {
        api_response(403, null, '请先输入访问密码');
    }
    $q = trim((string)($_GET['q'] ?? ''));
    if (mb_strlen($q) < 1) {
        api_response(200, ['results' => []]);
    }
    $pdo = db();
    $shareId = (int)$share['id'];
    $words = preg_split('/\s+/u', $q, -1, PREG_SPLIT_NO_EMPTY);
    if (empty($words)) {
        api_response(200, ['results' => []]);
    }
    $wordConditions = [];
    $params = [':sid' => $shareId];
    foreach ($words as $i => $word) {
        $pk = ':qw' . $i;
        $likeVal = '%' . str_replace(['%', '_'], ['\\%', '\\_'], $word) . '%';
        $wordConditions[] = "(title LIKE {$pk} ESCAPE \"\\\" OR markdown LIKE {$pk} ESCAPE \"\\\")";
        $params[$pk] = $likeVal;
    }
    $firstWord = $words[0];
    $params[':q_raw'] = $firstWord;
    $params[':q_raw2'] = $firstWord;
    $whereWords = implode(' AND ', $wordConditions);
    $stmt = $pdo->prepare("
        SELECT doc_id, title, hpath,
            CASE
                WHEN INSTR(markdown, :q_raw) > 50 THEN
                    SUBSTR(markdown, INSTR(markdown, :q_raw) - 40, 200)
                WHEN INSTR(markdown, :q_raw) > 0 THEN
                    SUBSTR(markdown, 1, 200)
                ELSE
                    SUBSTR(markdown, 1, 200)
            END AS snippet_raw,
            INSTR(markdown, :q_raw2) AS match_pos
        FROM share_docs
        WHERE share_id = :sid
          AND {$whereWords}
        ORDER BY sort_order ASC, id ASC
        LIMIT 30
    ");
    $stmt->execute($params);
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    $results = [];
    foreach ($rows as $row) {
        $raw = $row['snippet_raw'] ?? '';
        $raw = preg_replace('/^---\s*\n.*?\n---\s*\n/s', '', $raw);
        $snippet = preg_replace('/[#*`~>\[\]!]+/', '', $raw);
        $snippet = trim(preg_replace('/\s+/', ' ', $snippet));
        $matchPos = (int)($row['match_pos'] ?? 0);
        if ($matchPos > 50) {
            $snippet = '...' . $snippet;
        }
        if (mb_strlen($snippet) > 120) {
            $snippet = mb_substr($snippet, 0, 120) . '...';
        }
        $results[] = [
            'docId'   => $row['doc_id'],
            'title'   => $row['title'],
            'hpath'   => $row['hpath'] ?? '',
            'snippet' => $snippet,
        ];
    }
    api_response(200, ['results' => $results]);
}

function current_user(): ?array {
    if (empty($_SESSION['user_id']) || empty($_SESSION['password_hash'])) {
        return null;
    }
    $pdo = db();
    $stmt = $pdo->prepare('SELECT * FROM users WHERE id = :id');
    $stmt->execute([':id' => $_SESSION['user_id']]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row || $row['role'] !== 'admin' || (int)$row['disabled'] === 1) {
        return null;
    }
    $sessionHash = (string)($_SESSION['password_hash'] ?? '');
    if ($sessionHash === '' || !hash_equals((string)$row['password_hash'], $sessionHash)) {
        $_SESSION = [];
        session_regenerate_id(true);
        return null;
    }
    return $row;
}

function require_login(): array {
    $user = current_user();
    if (!$user) {
        redirect('/login');
    }
    if ((int)$user['disabled'] === 1) {
        session_destroy();
        redirect('/login');
    }
    return $user;
}

function require_admin(): array {
    $user = require_login();
    if ($user['role'] !== 'admin') {
        http_response_code(403);
        echo 'Forbidden';
        exit;
    }
    return $user;
}

function api_user_from_key(string $key): ?array {
    if ($key === '') {
        return null;
    }
    $prefix = substr($key, 0, 8);
    $pdo = db();
    $stmt = $pdo->prepare('SELECT * FROM users WHERE api_key_prefix = :prefix AND disabled = 0');
    $stmt->execute([':prefix' => $prefix]);
    $users = $stmt->fetchAll(PDO::FETCH_ASSOC);
    foreach ($users as $user) {
        if (!empty($user['api_key_hash']) && password_verify($key, $user['api_key_hash'])) {
            return $user;
        }
    }
    return null;
}

function require_api_user(): array {
    $key = $_SERVER['HTTP_X_API_KEY'] ?? '';
    if (!$key) {
        $auth = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
        if (stripos($auth, 'bearer ') === 0) {
            $key = trim(substr($auth, 7));
        }
    }
    $user = api_user_from_key($key);
    if (!$user) {
        api_response(401, null, 'API Key 无效或已失效，请前往控制台重新生成');
    }
    return $user;
}

function api_response(int $status, $data, string $msg = ''): void {
    header('Content-Type: application/json');
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Headers: Content-Type, X-Api-Key, Authorization');
    header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    http_response_code($status);
    echo json_encode([
        'code' => $status === 200 ? 0 : $status,
        'msg' => $msg,
        'data' => $data,
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

function parse_json_body(): array {
    $raw = file_get_contents('php://input');
    if (!$raw) {
        return [];
    }
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

function build_share_redirect_path(string $slug, ?string $docId, string $anchor): string {
    $path = '/s/' . $slug;
    if ($docId !== null && $docId !== '') {
        $path .= '/' . rawurlencode($docId);
    }
    if ($anchor !== '') {
        $path .= '#' . $anchor;
    }
    return $path;
}

function share_url(string $slug): string {
    return base_url() . '/s/' . rawurlencode($slug);
}

function find_share_by_slug(string $slug): ?array {
    $pdo = db();
    $stmt = $pdo->prepare('SELECT * FROM shares WHERE slug = :slug AND deleted_at IS NULL LIMIT 1');
    $stmt->execute([':slug' => $slug]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}

function find_share_by_id(int $shareId): ?array {
    if ($shareId <= 0) {
        return null;
    }
    $pdo = db();
    $stmt = $pdo->prepare('SELECT * FROM shares WHERE id = :id AND deleted_at IS NULL LIMIT 1');
    $stmt->execute([':id' => $shareId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}

function find_share_asset_row(int $shareId, string $assetPath): ?array {
    if ($shareId <= 0 || $assetPath === '') {
        return null;
    }
    $pdo = db();
    $stmt = $pdo->prepare('SELECT asset_path, file_path, size_bytes FROM share_assets WHERE share_id = :sid AND asset_path = :asset_path LIMIT 1');
    $stmt->execute([
        ':sid' => $shareId,
        ':asset_path' => $assetPath,
    ]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}

function ensure_dir(string $path): void {
    if (!is_dir($path)) {
        mkdir($path, 0775, true);
    }
}

function remove_dir(string $dir): void {
    if (!is_dir($dir)) {
        return;
    }
    $items = scandir($dir);
    if ($items === false) {
        return;
    }
    foreach ($items as $item) {
        if ($item === '.' || $item === '..') {
            continue;
        }
        $path = $dir . DIRECTORY_SEPARATOR . $item;
        if (is_dir($path)) {
            remove_dir($path);
        } else {
            @unlink($path);
        }
    }
    @rmdir($dir);
}

function move_dir(string $source, string $target): bool {
    if (!is_dir($source)) {
        return false;
    }
    if (is_dir($target)) {
        remove_dir($target);
    }
    ensure_dir(dirname($target));
    if (@rename($source, $target)) {
        return true;
    }
    ensure_dir($target);
    $items = scandir($source);
    if ($items === false) {
        return false;
    }
    foreach ($items as $item) {
        if ($item === '.' || $item === '..') {
            continue;
        }
        $src = $source . DIRECTORY_SEPARATOR . $item;
        $dst = $target . DIRECTORY_SEPARATOR . $item;
        if (is_dir($src)) {
            move_dir($src, $dst);
        } else {
            @copy($src, $dst);
        }
    }
    remove_dir($source);
    return true;
}

function chunk_cleanup_settings(): array {
    global $config;
    $ttl = (int)($config['chunk_ttl_seconds'] ?? 7200);
    $prob = (float)($config['chunk_cleanup_probability'] ?? 0.05);
    $limit = (int)($config['chunk_cleanup_limit'] ?? 20);
    if ($ttl < 60) {
        $ttl = 60;
    }
    if ($prob < 0) {
        $prob = 0;
    } elseif ($prob > 1) {
        $prob = 1;
    }
    if ($limit < 1) {
        $limit = 20;
    }
    return [$ttl, $prob, $limit];
}

function latest_mtime(string $path): int {
    if (is_file($path)) {
        return (int)(@filemtime($path) ?: 0);
    }
    if (!is_dir($path)) {
        return 0;
    }
    $items = scandir($path);
    if ($items === false) {
        return (int)(@filemtime($path) ?: 0);
    }
    $latest = 0;
    foreach ($items as $item) {
        if ($item === '.' || $item === '..') {
            continue;
        }
        $child = $path . DIRECTORY_SEPARATOR . $item;
        $mtime = latest_mtime($child);
        if ($mtime > $latest) {
            $latest = $mtime;
        }
    }
    if ($latest <= 0) {
        $latest = (int)(@filemtime($path) ?: 0);
    }
    return $latest;
}

function cleanup_stale_dirs(string $base, int $ttl, int $limit): void {
    if (!is_dir($base)) {
        return;
    }
    $dirs = scandir($base);
    if ($dirs === false) {
        return;
    }
    $now = time();
    $deleted = 0;
    foreach ($dirs as $dir) {
        if ($dir === '.' || $dir === '..') {
            continue;
        }
        $path = $base . DIRECTORY_SEPARATOR . $dir;
        if (!is_dir($path)) {
            continue;
        }
        $mtime = latest_mtime($path);
        if ($mtime <= 0 || ($now - $mtime) < $ttl) {
            continue;
        }
        remove_dir($path);
        $deleted += 1;
        if ($deleted >= $limit) {
            break;
        }
    }
}

function maybe_cleanup_chunks(): void {
    global $config;
    [$ttl, $prob, $limit] = chunk_cleanup_settings();
    if ($prob <= 0 || $ttl <= 0 || $limit <= 0) {
        return;
    }
    $rand = mt_rand() / mt_getrandmax();
    if ($rand > $prob) {
        return;
    }
    cleanup_stale_dirs($config['uploads_dir'] . '/chunks', $ttl, $limit);
    cleanup_stale_dirs($config['uploads_dir'] . '/staging', $ttl, $limit);
}

function sanitize_asset_path(string $path): string {
    $path = str_replace('\\', '/', $path);
    $path = ltrim($path, '/');
    if ($path === '' || strpos($path, '..') !== false) {
        return '';
    }
    return $path;
}

function sanitize_upload_id(string $uploadId): string {
    $uploadId = trim($uploadId);
    if ($uploadId === '' || !preg_match('/^[a-f0-9]{32}$/', $uploadId)) {
        return '';
    }
    return $uploadId;
}

function collect_asset_entries(array $files, array $paths, array $docIds): array {
    $entries = [];
    $seen = [];
    if (empty($files['name'])) {
        return $entries;
    }
    $count = is_array($files['name']) ? count($files['name']) : 0;
    for ($i = 0; $i < $count; $i++) {
        $tmp = $files['tmp_name'][$i] ?? '';
        if ($tmp === '') {
            continue;
        }
        $assetPath = $paths[$i] ?? ($files['name'][$i] ?? '');
        $assetPath = sanitize_asset_path((string)$assetPath);
        if ($assetPath === '' || isset($seen[$assetPath])) {
            continue;
        }
        $seen[$assetPath] = true;
        $entries[] = [
            'tmp' => $tmp,
            'path' => $assetPath,
            'docId' => $docIds[$i] ?? null,
            'size' => (int)($files['size'][$i] ?? 0),
        ];
    }
    return $entries;
}

function allocate_share_id(PDO $pdo): int {
    $stmt = $pdo->query('SELECT share_id FROM recycled_share_ids ORDER BY share_id ASC LIMIT 1');
    $shareId = (int)($stmt ? $stmt->fetchColumn() : 0);
    if ($shareId > 0) {
        $del = $pdo->prepare('DELETE FROM recycled_share_ids WHERE share_id = :share_id');
        $del->execute([':share_id' => $shareId]);
        return $shareId;
    }
    return 0;
}

function recycle_share_id(int $shareId): void {
    if ($shareId <= 0) {
        return;
    }
    $pdo = db();
    $stmt = $pdo->prepare('INSERT OR IGNORE INTO recycled_share_ids (share_id, created_at) VALUES (:share_id, :created_at)');
    $stmt->execute([
        ':share_id' => $shareId,
        ':created_at' => now(),
    ]);
}

function purge_share_assets(int $shareId): void {
    global $config;
    $pdo = db();
    $root = realpath($config['uploads_dir']);
    $stmt = $pdo->prepare('SELECT file_path FROM share_assets WHERE share_id = ?');
    $stmt->execute([$shareId]);
    $other = $pdo->prepare('SELECT 1 FROM share_assets WHERE share_id != ? AND file_path = ? LIMIT 1');
    foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $path) {
        $other->execute([$shareId, $path]);
        if ($other->fetchColumn()) continue;
        $file = realpath($config['uploads_dir'] . '/' . ltrim((string)$path, '/'));
        if ($root !== false && $file !== false && str_starts_with(strtolower($file), strtolower($root . DIRECTORY_SEPARATOR)) && is_file($file)) unlink($file);
    }
    remove_dir($config['uploads_dir'] . '/shares/' . $shareId);
    $pdo->prepare('DELETE FROM share_assets WHERE share_id = ?')->execute([$shareId]);
}

function hard_delete_share(int $shareId): ?int {
    $pdo = db();
    $stmt = $pdo->prepare('SELECT user_id FROM shares WHERE id = :id');
    $stmt->execute([':id' => $shareId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row) {
        return null;
    }
    $userId = (int)$row['user_id'];
    purge_share_assets($shareId);
    purge_share_chunks($shareId);
    $uploadIds = $pdo->prepare('SELECT upload_id FROM share_uploads WHERE share_id = :share_id');
    $uploadIds->execute([':share_id' => $shareId]);
    $uploadList = array_values(array_filter($uploadIds->fetchAll(PDO::FETCH_COLUMN)));
    if ($uploadList) {
        $placeholders = implode(',', array_fill(0, count($uploadList), '?'));
        $stmt = $pdo->prepare('DELETE FROM share_upload_docs WHERE upload_id IN (' . $placeholders . ')');
        $stmt->execute($uploadList);
    }
    $pdo->prepare('DELETE FROM share_uploads WHERE share_id = :share_id')->execute([':share_id' => $shareId]);
    $pdo->prepare('DELETE FROM share_visitors WHERE share_id = :share_id')->execute([':share_id' => $shareId]);
    $pdo->prepare('DELETE FROM share_docs WHERE share_id = :share_id')->execute([':share_id' => $shareId]);
    $pdo->prepare('DELETE FROM shares WHERE id = :id')->execute([':id' => $shareId]);
    recycle_share_id($shareId);
    recalculate_user_storage($userId);
    return $userId;
}

function handle_asset_uploads(int $shareId, array $entries): int {
    global $config;
    if (empty($entries)) {
        return 0;
    }
    ensure_dir($config['uploads_dir']);
    $pdo = db();
    $total = 0;
    foreach ($entries as $entry) {
        $tmp = $entry['tmp'];
        $assetPath = (string)($entry['path'] ?? '');
        $assetPath = trim(str_replace('\\', '/', $assetPath));
        $assetPath = ltrim($assetPath, '/');
        if ($assetPath === '' || substr($assetPath, -1) === '/') {
            continue;
        }
        if (!is_uploaded_file($tmp)) {
            continue;
        }
        $docId = $entry['docId'] ?? null;
        $size = (int)($entry['size'] ?? 0);
        $targetDir = $config['uploads_dir'] . '/shares/' . $shareId . '/' . dirname($assetPath);
        ensure_dir($targetDir);
        $targetFile = $config['uploads_dir'] . '/shares/' . $shareId . '/' . $assetPath;
        if (!move_uploaded_file($tmp, $targetFile)) {
            continue;
        }
        $actualSize = $size;
        if ($actualSize <= 0 && is_file($targetFile)) {
            $actualSize = (int)filesize($targetFile);
        }
        $assetHash = '';
        if (is_file($targetFile)) {
            $computed = @hash_file('sha256', $targetFile);
            $assetHash = normalize_hash_hex($computed ?: '');
        }
        $total += $actualSize;
        $stmt = $pdo->prepare('INSERT OR REPLACE INTO share_assets (share_id, doc_id, asset_path, file_path, size_bytes, asset_hash, created_at)
            VALUES (:share_id, :doc_id, :asset_path, :file_path, :size_bytes, :asset_hash, :created_at)');
        $stmt->execute([
            ':share_id' => $shareId,
            ':doc_id' => $docId,
            ':asset_path' => $assetPath,
            ':file_path' => 'shares/' . $shareId . '/' . $assetPath,
            ':size_bytes' => $actualSize,
            ':asset_hash' => $assetHash !== '' ? $assetHash : null,
            ':created_at' => now(),
        ]);
    }
    return $total;
}

function normalize_hash_hex($value): string {
    $raw = strtolower(trim((string)$value));
    if ($raw === '' || !preg_match('/^[a-f0-9]{64}$/', $raw)) {
        return '';
    }
    return $raw;
}

function normalize_sort_index_value($value): float {
    if (!is_numeric($value)) {
        return 0;
    }
    $num = (float)$value;
    if (is_infinite($num) || is_nan($num)) {
        return 0;
    }
    return round($num, 6);
}

function build_doc_meta_signature(array $row): string {
    $payload = [
        'title' => (string)($row['title'] ?? ''),
        'hPath' => (string)($row['hPath'] ?? $row['hpath'] ?? ''),
        'parentId' => (string)($row['parentId'] ?? $row['parent_id'] ?? ''),
        'sortIndex' => normalize_sort_index_value($row['sortIndex'] ?? $row['sort_index'] ?? 0),
        'sortOrder' => max(0, (int)($row['sortOrder'] ?? $row['sort_order'] ?? 0)),
        'icon' => normalize_doc_icon_value($row['icon'] ?? ''),
    ];
    $json = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    return is_string($json) ? $json : '';
}

function compute_doc_content_hash(string $markdown): string {
    return hash('sha256', $markdown);
}

function compute_doc_meta_hash(array $row): string {
    return hash('sha256', build_doc_meta_signature($row));
}

function normalize_doc_id_list($raw): array {
    if (!is_array($raw)) {
        return [];
    }
    $out = [];
    $seen = [];
    foreach ($raw as $item) {
        $docId = trim((string)$item);
        if ($docId === '' || isset($seen[$docId])) {
            continue;
        }
        $seen[$docId] = true;
        $out[] = $docId;
    }
    return $out;
}

function normalize_asset_path_list($raw): array {
    if (!is_array($raw)) {
        return [];
    }
    $out = [];
    $seen = [];
    foreach ($raw as $item) {
        $path = sanitize_asset_path((string)$item);
        if ($path === '' || isset($seen[$path])) {
            continue;
        }
        $seen[$path] = true;
        $out[] = $path;
    }
    return $out;
}

function normalize_incremental_patch($raw): array {
    if (!is_array($raw)) {
        return ['enabled' => false, 'deletedDocIds' => [], 'deletedAssetPaths' => []];
    }
    return [
        'enabled' => !empty($raw['enabled']),
        'deletedDocIds' => normalize_doc_id_list($raw['deletedDocIds'] ?? []),
        'deletedAssetPaths' => normalize_asset_path_list($raw['deletedAssetPaths'] ?? []),
    ];
}

function normalize_asset_manifest($rawAssets): array {
    $assets = [];
    $seen = [];
    if (!is_array($rawAssets)) {
        return $assets;
    }
    foreach ($rawAssets as $item) {
        if (!is_array($item)) {
            continue;
        }
        $path = sanitize_asset_path((string)($item['path'] ?? ''));
        if ($path === '' || isset($seen[$path])) {
            continue;
        }
        $seen[$path] = true;
        $size = (int)($item['size'] ?? 0);
        if ($size < 0) {
            $size = 0;
        }
        $docId = isset($item['docId']) ? trim((string)($item['docId'])) : null;
        $hash = normalize_hash_hex($item['hash'] ?? '');
        $assets[] = [
            'path' => $path,
            'size' => $size,
            'docId' => $docId,
            'hash' => $hash,
        ];
    }
    return $assets;
}

function doc_chunk_prefix(): string {
    return '__sps_docs/';
}

function is_doc_chunk_path(string $path): bool {
    return str_starts_with($path, doc_chunk_prefix());
}

function normalize_doc_manifest($rawDocs): array {
    $docs = [];
    $seenPath = [];
    $seenDoc = [];
    if (!is_array($rawDocs)) {
        return $docs;
    }
    foreach ($rawDocs as $item) {
        if (!is_array($item)) {
            continue;
        }
        $docId = trim((string)($item['docId'] ?? ''));
        $path = sanitize_asset_path((string)($item['path'] ?? ''));
        if ($docId === '' || $path === '' || !is_doc_chunk_path($path)) {
            continue;
        }
        if (isset($seenPath[$path]) || isset($seenDoc[$docId])) {
            continue;
        }
        $seenPath[$path] = true;
        $seenDoc[$docId] = true;
        $size = (int)($item['size'] ?? 0);
        if ($size < 0) {
            $size = 0;
        }
        $docs[] = [
            'docId' => $docId,
            'path' => $path,
            'size' => $size,
            'hash' => normalize_hash_hex($item['hash'] ?? ''),
        ];
    }
    return $docs;
}

function share_chunks_dir(int $shareId): string {
    global $config;
    return $config['uploads_dir'] . '/chunks/' . $shareId;
}

function upload_chunks_dir(string $uploadId): string {
    global $config;
    return $config['uploads_dir'] . '/chunks/' . $uploadId;
}

function upload_staging_dir(string $uploadId): string {
    global $config;
    return $config['uploads_dir'] . '/staging/' . $uploadId;
}

function purge_upload_session_files(string $uploadId): void {
    remove_dir(upload_chunks_dir($uploadId));
    remove_dir(upload_staging_dir($uploadId));
}

function generate_upload_id(): string {
    return bin2hex(random_bytes(16));
}

function purge_share_chunks(int $shareId): void {
    $dir = share_chunks_dir($shareId);
    remove_dir($dir);
}

function recalculate_share_size(int $shareId): int {
    $pdo = db();
    $stmt = $pdo->prepare('SELECT COALESCE(SUM(size_bytes), 0) AS total FROM share_docs WHERE share_id = :share_id');
    $stmt->execute([':share_id' => $shareId]);
    $docSize = (int)$stmt->fetchColumn();
    $stmt = $pdo->prepare('SELECT COALESCE(SUM(size_bytes), 0) AS total FROM share_assets WHERE share_id = :share_id');
    $stmt->execute([':share_id' => $shareId]);
    $assetSize = (int)$stmt->fetchColumn();
    $total = $docSize + $assetSize;
    $stmt = $pdo->prepare('UPDATE shares SET size_bytes = :size_bytes, updated_at = :updated_at WHERE id = :id');
    $stmt->execute([
        ':size_bytes' => $total,
        ':updated_at' => now(),
        ':id' => $shareId,
    ]);
    return $total;
}

function handle_api(string $path): void {
    if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
        api_response(200, null, '');
    }
    $user = require_api_user();
    $pdo = db();
    global $config;
    maybe_cleanup_chunks();

    if ($path === '/api/v1/auth/verify') {
        [$minChunk, $maxChunk] = chunk_size_limits();
        api_response(200, ['user' => [
            'id' => $user['id'],
            'username' => $user['username'],
            'role' => $user['role'],
        ], 'limits' => [
            'minChunkSize' => $minChunk,
            'maxChunkSize' => $maxChunk,
        ], 'features' => [
            'incrementalShare' => true,
            'docChunkUpload' => true,
        ]]);
    }

    if ($path === '/api/v1/shares' && $_SERVER['REQUEST_METHOD'] === 'GET') {
        $stmt = $pdo->prepare('SELECT shares.*, COALESCE(doc_counts.doc_count, 0) AS doc_count
            FROM shares
            LEFT JOIN (SELECT share_id, COUNT(*) AS doc_count FROM share_docs GROUP BY share_id) doc_counts
                ON shares.id = doc_counts.share_id
            WHERE shares.user_id = :uid AND shares.deleted_at IS NULL
            ORDER BY shares.updated_at DESC');
        $stmt->execute([':uid' => $user['id']]);
        $shares = [];
        while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
            $shares[] = [
                'id' => $row['id'],
                'slug' => $row['slug'],
                'type' => $row['type'],
                'title' => $row['title'],
                'docId' => $row['doc_id'],
                'notebookId' => $row['notebook_id'],
                'updatedAt' => strtotime($row['updated_at']) * 1000,
                'createdAt' => strtotime($row['created_at']) * 1000,
                'hasPassword' => !empty($row['password_hash']),
                'expiresAt' => $row['expires_at'] ? ((int)$row['expires_at'] * 1000) : null,
                'visitorLimit' => (int)($row['visitor_limit'] ?? 0),
                'includeChildren' => ((string)($row['type'] ?? '') === 'doc') && ((int)($row['doc_count'] ?? 0) > 1),
                'path' => '/s/' . $row['slug'],
                'url' => share_url($row['slug']),
            ];
        }
        api_response(200, ['shares' => $shares]);
    }

    if ($path === '/api/v1/shares/snapshot' && $_SERVER['REQUEST_METHOD'] === 'POST') {
        $payload = parse_json_body();
        $shareId = (int)($payload['shareId'] ?? 0);
        if ($shareId <= 0) {
            api_response(400, null, 'Missing share id');
        }
        $stmt = $pdo->prepare('SELECT * FROM shares WHERE id = :id AND user_id = :uid AND deleted_at IS NULL LIMIT 1');
        $stmt->execute([
            ':id' => $shareId,
            ':uid' => $user['id'],
        ]);
        $share = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$share) {
            api_response(404, null, 'Share not found');
        }

        $docs = [];
        $docStmt = $pdo->prepare('SELECT id, doc_id, title, icon, hpath, parent_id, sort_index, sort_order, size_bytes, content_hash, meta_hash
            FROM share_docs WHERE share_id = :sid ORDER BY sort_order ASC, id ASC');
        $docStmt->execute([':sid' => $shareId]);
        $docHashUpdate = $pdo->prepare('UPDATE share_docs SET content_hash = :content_hash, meta_hash = :meta_hash WHERE id = :id');
        $docMarkdownStmt = $pdo->prepare('SELECT markdown FROM share_docs WHERE share_id = :sid AND id = :id LIMIT 1');
        while ($row = $docStmt->fetch(PDO::FETCH_ASSOC)) {
            $contentHash = normalize_hash_hex($row['content_hash'] ?? '');
            $metaHash = normalize_hash_hex($row['meta_hash'] ?? '');
            if ($contentHash === '') {
                $docMarkdownStmt->execute([
                    ':sid' => $shareId,
                    ':id' => (int)($row['id'] ?? 0),
                ]);
                $docMarkdown = (string)($docMarkdownStmt->fetchColumn() ?: '');
                $contentHash = compute_doc_content_hash($docMarkdown);
                unset($docMarkdown);
            }
            if ($metaHash === '') {
                $metaHash = compute_doc_meta_hash($row);
            }
            if (($row['content_hash'] ?? '') !== $contentHash || ($row['meta_hash'] ?? '') !== $metaHash) {
                $docHashUpdate->execute([
                    ':content_hash' => $contentHash,
                    ':meta_hash' => $metaHash,
                    ':id' => (int)($row['id'] ?? 0),
                ]);
            }
            $docs[] = [
                'docId' => (string)($row['doc_id'] ?? ''),
                'title' => (string)($row['title'] ?? ''),
                'icon' => (string)($row['icon'] ?? ''),
                'hPath' => (string)($row['hpath'] ?? ''),
                'parentId' => (string)($row['parent_id'] ?? ''),
                'sortIndex' => (float)($row['sort_index'] ?? 0),
                'sortOrder' => max(0, (int)($row['sort_order'] ?? 0)),
                'contentHash' => $contentHash,
                'metaHash' => $metaHash,
            ];
            unset($row);
        }

        $assets = [];
        $assetStmt = $pdo->prepare('SELECT id, asset_path, doc_id, file_path, size_bytes, asset_hash FROM share_assets
            WHERE share_id = :sid ORDER BY id ASC');
        $assetStmt->execute([
            ':sid' => $shareId,
        ]);
        $assetHashUpdate = $pdo->prepare('UPDATE share_assets SET asset_hash = :asset_hash WHERE id = :id');
        while ($row = $assetStmt->fetch(PDO::FETCH_ASSOC)) {
            $assetHash = normalize_hash_hex($row['asset_hash'] ?? '');
            if ($assetHash === '') {
                $filePath = (string)($row['file_path'] ?? '');
                $fullPath = $config['uploads_dir'] . '/' . ltrim($filePath, '/');
                if ($filePath !== '' && is_file($fullPath)) {
                    $computed = @hash_file('sha256', $fullPath);
                    $assetHash = normalize_hash_hex($computed ?: '');
                }
            }
            if ($assetHash !== '' && ($row['asset_hash'] ?? '') !== $assetHash) {
                $assetHashUpdate->execute([
                    ':asset_hash' => $assetHash,
                    ':id' => (int)($row['id'] ?? 0),
                ]);
            }
            $assets[] = [
                'path' => (string)($row['asset_path'] ?? ''),
                'docId' => (string)($row['doc_id'] ?? ''),
                'size' => max(0, (int)($row['size_bytes'] ?? 0)),
                'hash' => $assetHash,
            ];
            unset($row);
        }

        api_response(200, [
            'share' => [
                'id' => (int)($share['id'] ?? 0),
                'type' => (string)($share['type'] ?? ''),
                'docId' => (string)($share['doc_id'] ?? ''),
                'notebookId' => (string)($share['notebook_id'] ?? ''),
            ],
            'docs' => $docs,
            'assets' => $assets,
        ]);
    }

    if ($path === '/api/v1/shares/delete') {
        $payload = parse_json_body();
        $shareId = (int)($payload['shareId'] ?? 0);
        $hardDelete = !empty($payload['hardDelete']);
        if (!$shareId) {
            api_response(400, null, '缺少分享 ID');
        }
        if ($hardDelete) {
            $check = $pdo->prepare('SELECT id FROM shares WHERE id = :id AND user_id = :uid');
            $check->execute([
                ':id' => $shareId,
                ':uid' => $user['id'],
            ]);
            if (!$check->fetchColumn()) {
                api_response(404, null, '分享不存在');
            }
            hard_delete_share($shareId);
            api_response(200, ['ok' => true, 'hard' => true]);
        }
        $stmt = $pdo->prepare('UPDATE shares SET deleted_at = :deleted_at WHERE id = :id AND user_id = :uid');
        $stmt->execute([
            ':deleted_at' => now(),
            ':id' => $shareId,
            ':uid' => $user['id'],
        ]);
        recalculate_user_storage((int)$user['id']);
        api_response(200, ['ok' => true]);
    }

    if ($path === '/api/v1/shares/access/update' && $_SERVER['REQUEST_METHOD'] === 'POST') {
        $payload = parse_json_body();
        $shareId = (int)($payload['shareId'] ?? 0);
        if (!$shareId) {
            api_response(400, null, 'Missing share id');
        }
        $stmt = $pdo->prepare('SELECT * FROM shares WHERE id = :id AND user_id = :uid AND deleted_at IS NULL LIMIT 1');
        $stmt->execute([
            ':id' => $shareId,
            ':uid' => $user['id'],
        ]);
        $share = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$share) {
            api_response(404, null, 'Share not found');
        }
        $password = trim((string)($payload['password'] ?? ''));
        $clearPassword = !empty($payload['clearPassword']);
        $expiresAt = parse_expires_at($payload['expiresAt'] ?? null);
        $clearExpires = !empty($payload['clearExpires']);
        $visitorLimit = parse_visitor_limit($payload['visitorLimit'] ?? null);
        $clearVisitorLimit = !empty($payload['clearVisitorLimit']);
        $slug = parse_requested_share_slug_or_fail($payload['slug'] ?? '');

        $passwordHash = $share['password_hash'] ?? null;
        $expiresValue = isset($share['expires_at']) ? (int)$share['expires_at'] : null;
        $visitorValue = isset($share['visitor_limit']) ? (int)$share['visitor_limit'] : 0;
        if ($clearPassword) {
            $passwordHash = null;
        } elseif ($password !== '') {
            $passwordHash = password_hash($password, PASSWORD_DEFAULT);
        }
        if ($clearExpires) {
            $expiresValue = null;
        } elseif ($expiresAt !== null) {
            $expiresValue = $expiresAt;
        }
        if ($clearVisitorLimit) {
            $visitorValue = 0;
        } elseif ($visitorLimit !== null) {
            $visitorValue = $visitorLimit;
        }
        $newSlug = (string)($share['slug'] ?? '');
        if ($slug !== '' && $slug !== $newSlug) {
            ensure_share_slug_available_or_fail($pdo, $slug, (int)$share['id']);
            $newSlug = $slug;
        }

        $stmt = $pdo->prepare('UPDATE shares SET slug = :slug, password_hash = :password_hash, expires_at = :expires_at, visitor_limit = :visitor_limit, updated_at = :updated_at WHERE id = :id AND user_id = :uid');
        $stmt->execute([
            ':slug' => $newSlug,
            ':password_hash' => $passwordHash,
            ':expires_at' => $expiresValue,
            ':visitor_limit' => $visitorValue,
            ':updated_at' => now(),
            ':id' => $shareId,
            ':uid' => $user['id'],
        ]);

        api_response(200, ['share' => [
            'id' => (int)$share['id'],
            'slug' => $newSlug,
            'url' => share_url($newSlug),
            'hasPassword' => !empty($passwordHash),
            'expiresAt' => $expiresValue ? ($expiresValue * 1000) : null,
            'visitorLimit' => $visitorValue,
        ]]);
    }

    if ($path === '/api/v1/shares/doc/init' && $_SERVER['REQUEST_METHOD'] === 'POST') {
        $payload = parse_json_body();
        $meta = $payload['metadata'] ?? $payload;
        if (!is_array($meta)) {
            api_response(400, null, 'Invalid metadata');
        }
        $docId = trim((string)($meta['docId'] ?? ''));
        $title = trim((string)($meta['title'] ?? ''));
        $markdown = (string)($meta['markdown'] ?? '');
        $hPath = (string)($meta['hPath'] ?? '');
        $sortOrder = max(0, (int)($meta['sortOrder'] ?? 0));
        $password = trim((string)($meta['password'] ?? ''));
        $clearPassword = !empty($meta['clearPassword']);
        $expiresAt = parse_expires_at($meta['expiresAt'] ?? null);
        $clearExpires = !empty($meta['clearExpires']);
        $visitorLimit = parse_visitor_limit($meta['visitorLimit'] ?? null);
        $clearVisitorLimit = !empty($meta['clearVisitorLimit']);
        $docs = $meta['docs'] ?? [];
        $hasDocs = is_array($docs) && count($docs) > 0;
        $incrementalPatch = normalize_incremental_patch($meta['incremental'] ?? []);
        $docChunks = normalize_doc_manifest($payload['docChunks'] ?? []);
        $docChunkById = [];
        foreach ($docChunks as $item) {
            $docChunkById[(string)($item['docId'] ?? '')] = $item;
        }
        $hasDocChunks = !empty($docChunkById);
        $stmt = $pdo->prepare('SELECT * FROM shares WHERE user_id = :uid AND type = "doc" AND doc_id = :doc_id ORDER BY id DESC LIMIT 1');
        $stmt->execute([':uid' => $user['id'], ':doc_id' => $docId]);
        $existing = $stmt->fetch(PDO::FETCH_ASSOC) ?: null;
        $useIncremental = !empty($incrementalPatch['enabled']) && !!$existing;
        if ($docId === '' || (!$hasDocs && $markdown === '' && !$hasDocChunks && !$useIncremental)) {
            api_response(400, null, 'Missing document content');
        }

        $slug = parse_requested_share_slug_or_fail($meta['slug'] ?? '');
        $assets = normalize_asset_manifest($payload['assets'] ?? []);
        $assetSize = 0;
        foreach ($assets as $asset) {
            $assetSize += (int)($asset['size'] ?? 0);
        }
        $docRows = [];
        $docSizeTotal = 0;
        if ($hasDocs) {
            foreach ($docs as $index => $doc) {
                $rowDocId = trim((string)($doc['docId'] ?? ''));
                $rowTitle = trim((string)($doc['title'] ?? ''));
                $rowIcon = trim((string)($doc['icon'] ?? ''));
                $rowHpath = (string)($doc['hPath'] ?? '');
                $rowMarkdown = (string)($doc['markdown'] ?? '');
                $rowSort = max(0, (int)($doc['sortOrder'] ?? $index));
                $rowParent = trim((string)($doc['parentId'] ?? ''));
                $rowSortIndex = (float)($doc['sortIndex'] ?? $index);
                if ($rowDocId === '') {
                    continue;
                }
                $chunkMeta = $docChunkById[$rowDocId] ?? null;
                $size = strlen($rowMarkdown);
                if ($size === 0 && $chunkMeta) {
                    $size = max(0, (int)($chunkMeta['size'] ?? 0));
                }
                $rowContentHash = normalize_hash_hex($doc['contentHash'] ?? '');
                if ($rowContentHash === '' && $chunkMeta) {
                    $rowContentHash = normalize_hash_hex($chunkMeta['hash'] ?? '');
                }
                if ($rowContentHash === '') {
                    $rowContentHash = ($rowMarkdown !== '' || !$chunkMeta)
                        ? compute_doc_content_hash($rowMarkdown)
                        : '';
                }
                $rowMetaHash = normalize_hash_hex($doc['metaHash'] ?? '');
                if ($rowMetaHash === '') {
                    $rowMetaHash = compute_doc_meta_hash([
                        'title' => $rowTitle ?: $rowDocId,
                        'icon' => $rowIcon,
                        'hPath' => $rowHpath,
                        'parentId' => $rowParent,
                        'sortIndex' => $rowSortIndex,
                        'sortOrder' => $rowSort,
                    ]);
                }
                $docSizeTotal += $size;
                $docRows[] = [
                    'docId' => $rowDocId,
                    'title' => $rowTitle ?: $rowDocId,
                    'icon' => $rowIcon,
                    'hPath' => $rowHpath,
                    'parentId' => $rowParent,
                    'sortIndex' => $rowSortIndex,
                    'markdown' => $rowMarkdown,
                    'sortOrder' => $rowSort,
                    'size' => $size,
                    'contentHash' => $rowContentHash,
                    'metaHash' => $rowMetaHash,
                ];
            }
            if (empty($docRows) && !$useIncremental) {
                api_response(400, null, 'Missing document content');
            }
        } elseif ($markdown !== '') {
            $docSizeTotal = strlen($markdown);
            $docIcon = trim((string)($meta['icon'] ?? ''));
            $docContentHash = normalize_hash_hex($meta['contentHash'] ?? '');
            if ($docContentHash === '') {
                $docContentHash = compute_doc_content_hash($markdown);
            }
            $docMetaHash = normalize_hash_hex($meta['metaHash'] ?? '');
            if ($docMetaHash === '') {
                $docMetaHash = compute_doc_meta_hash([
                    'title' => $title ?: $docId,
                    'icon' => $docIcon,
                    'hPath' => $hPath,
                    'parentId' => '',
                    'sortIndex' => 0,
                    'sortOrder' => $sortOrder,
                ]);
            }
            $docRows[] = [
                'docId' => $docId,
                'title' => $title ?: $docId,
                'icon' => $docIcon,
                'hPath' => $hPath,
                'parentId' => null,
                'sortIndex' => 0,
                'markdown' => $markdown,
                'sortOrder' => $sortOrder,
                'size' => $docSizeTotal,
                'contentHash' => $docContentHash,
                'metaHash' => $docMetaHash,
            ];
        } elseif ($hasDocChunks && isset($docChunkById[$docId])) {
            $docIcon = trim((string)($meta['icon'] ?? ''));
            $chunkMeta = $docChunkById[$docId];
            $docContentHash = normalize_hash_hex($meta['contentHash'] ?? '');
            if ($docContentHash === '') {
                $docContentHash = normalize_hash_hex($chunkMeta['hash'] ?? '');
            }
            $docMetaHash = normalize_hash_hex($meta['metaHash'] ?? '');
            if ($docMetaHash === '') {
                $docMetaHash = compute_doc_meta_hash([
                    'title' => $title ?: $docId,
                    'icon' => $docIcon,
                    'hPath' => $hPath,
                    'parentId' => '',
                    'sortIndex' => 0,
                    'sortOrder' => $sortOrder,
                ]);
            }
            $docSizeTotal = max(0, (int)($chunkMeta['size'] ?? 0));
            $docRows[] = [
                'docId' => $docId,
                'title' => $title ?: $docId,
                'icon' => $docIcon,
                'hPath' => $hPath,
                'parentId' => null,
                'sortIndex' => 0,
                'markdown' => '',
                'sortOrder' => $sortOrder,
                'size' => $docSizeTotal,
                'contentHash' => $docContentHash,
                'metaHash' => $docMetaHash,
            ];
        }
        if (empty($docRows) && !$useIncremental) {
            api_response(400, null, 'Missing document content');
        }
        $baseShareSize = $docSizeTotal + $assetSize;
        $existingSize = $existing ? (int)($existing['size_bytes'] ?? 0) : 0;
        $newShareSize = $baseShareSize;
        $used = recalculate_user_storage((int)$user['id']);
        $limit = get_user_limit_bytes($user);
        $usedWithout = max(0, $used - $existingSize);
        if (!$useIncremental && $limit > 0 && ($usedWithout + $newShareSize) > $limit) {
            api_response(413, null, 'Storage limit reached');
        }

        $passwordHash = $existing['password_hash'] ?? null;
        $expiresValue = isset($existing['expires_at']) ? (int)$existing['expires_at'] : null;
        $visitorValue = isset($existing['visitor_limit']) ? (int)$existing['visitor_limit'] : 0;
        if ($clearPassword) {
            $passwordHash = null;
        } elseif ($password !== '') {
            $passwordHash = password_hash($password, PASSWORD_DEFAULT);
        }
        if ($clearExpires) {
            $expiresValue = null;
        } elseif ($expiresAt !== null) {
            $expiresValue = $expiresAt;
        }
        if ($clearVisitorLimit) {
            $visitorValue = 0;
        } elseif ($visitorLimit !== null) {
            $visitorValue = $visitorLimit;
        }

        $finalSlug = $slug;
        if ($existing) {
            if ($finalSlug && $finalSlug !== $existing['slug']) {
                ensure_share_slug_available_or_fail($pdo, $finalSlug, (int)$existing['id']);
            }
            if (!$finalSlug) {
                $finalSlug = (string)$existing['slug'];
            }
        } else {
            if (!$finalSlug) {
                $finalSlug = allocate_random_share_slug_or_fail($pdo);
            } else {
                ensure_share_slug_available_or_fail($pdo, $finalSlug);
            }
        }

        $finalTitle = $title ?: ($existing['title'] ?? $docId);
        $uploadMode = $useIncremental ? 'incremental' : 'full';
        $patchManifest = json_encode(
            $useIncremental
                ? $incrementalPatch
                : ['enabled' => false, 'deletedDocIds' => [], 'deletedAssetPaths' => []],
            JSON_UNESCAPED_SLASHES
        );
        $uploadId = generate_upload_id();
        $stmt = $pdo->prepare('INSERT INTO share_uploads (upload_id, user_id, share_id, type, doc_id, slug, title, password_hash, expires_at, visitor_limit, asset_manifest, doc_manifest, upload_mode, patch_manifest, status, created_at, updated_at)
            VALUES (:upload_id, :user_id, :share_id, "doc", :doc_id, :slug, :title, :password_hash, :expires_at, :visitor_limit, :asset_manifest, :doc_manifest, :upload_mode, :patch_manifest, "pending", :created_at, :updated_at)');
        $stmt->execute([
            ':upload_id' => $uploadId,
            ':user_id' => $user['id'],
            ':share_id' => $existing ? (int)$existing['id'] : null,
            ':doc_id' => $docId,
            ':slug' => $finalSlug,
            ':title' => $finalTitle,
            ':password_hash' => $passwordHash,
            ':expires_at' => $expiresValue,
            ':visitor_limit' => $visitorValue,
            ':asset_manifest' => json_encode($assets, JSON_UNESCAPED_SLASHES),
            ':doc_manifest' => json_encode($docChunks, JSON_UNESCAPED_SLASHES),
            ':upload_mode' => $uploadMode,
            ':patch_manifest' => $patchManifest,
            ':created_at' => now(),
            ':updated_at' => now(),
        ]);
        $insertDoc = $pdo->prepare('INSERT INTO share_upload_docs (upload_id, doc_id, title, icon, hpath, parent_id, sort_index, markdown, sort_order, size_bytes, content_hash, meta_hash, created_at, updated_at)
            VALUES (:upload_id, :doc_id, :title, :icon, :hpath, :parent_id, :sort_index, :markdown, :sort_order, :size_bytes, :content_hash, :meta_hash, :created_at, :updated_at)');
        foreach ($docRows as $row) {
            $insertDoc->execute([
                ':upload_id' => $uploadId,
                ':doc_id' => $row['docId'],
                ':title' => $row['title'],
                ':icon' => $row['icon'] !== '' ? $row['icon'] : null,
                ':hpath' => $row['hPath'],
                ':parent_id' => $row['parentId'] !== '' ? $row['parentId'] : null,
                ':sort_index' => $row['sortIndex'],
                ':markdown' => $row['markdown'],
                ':sort_order' => $row['sortOrder'],
                ':size_bytes' => $row['size'],
                ':content_hash' => normalize_hash_hex($row['contentHash'] ?? ''),
                ':meta_hash' => normalize_hash_hex($row['metaHash'] ?? ''),
                ':created_at' => now(),
                ':updated_at' => now(),
            ]);
        }
        api_response(200, ['uploadId' => $uploadId, 'slug' => $finalSlug]);
    }

    if ($path === '/api/v1/shares/notebook/init' && $_SERVER['REQUEST_METHOD'] === 'POST') {
        $payload = parse_json_body();
        $meta = $payload['metadata'] ?? $payload;
        if (!is_array($meta)) {
            api_response(400, null, 'Invalid metadata');
        }
        $notebookId = trim((string)($meta['notebookId'] ?? ''));
        $title = trim((string)($meta['title'] ?? ''));
        $docs = $meta['docs'] ?? [];
        $password = trim((string)($meta['password'] ?? ''));
        $clearPassword = !empty($meta['clearPassword']);
        $expiresAt = parse_expires_at($meta['expiresAt'] ?? null);
        $clearExpires = !empty($meta['clearExpires']);
        $visitorLimit = parse_visitor_limit($meta['visitorLimit'] ?? null);
        $clearVisitorLimit = !empty($meta['clearVisitorLimit']);
        $incrementalPatch = normalize_incremental_patch($meta['incremental'] ?? []);
        $docChunks = normalize_doc_manifest($payload['docChunks'] ?? []);
        $docChunkById = [];
        foreach ($docChunks as $item) {
            $docChunkById[(string)($item['docId'] ?? '')] = $item;
        }
        $stmt = $pdo->prepare('SELECT * FROM shares WHERE user_id = :uid AND type = "notebook" AND notebook_id = :nid ORDER BY id DESC LIMIT 1');
        $stmt->execute([':uid' => $user['id'], ':nid' => $notebookId]);
        $existing = $stmt->fetch(PDO::FETCH_ASSOC) ?: null;
        $useIncremental = !empty($incrementalPatch['enabled']) && !!$existing;
        if ($notebookId === '' || !is_array($docs) || (count($docs) === 0 && !$useIncremental)) {
            api_response(400, null, 'Missing notebook or documents');
        }

        $slug = parse_requested_share_slug_or_fail($meta['slug'] ?? '');
        $assets = normalize_asset_manifest($payload['assets'] ?? []);
        $assetSize = 0;
        foreach ($assets as $asset) {
            $assetSize += (int)($asset['size'] ?? 0);
        }
        $docRows = [];
        $docSizeTotal = 0;
        foreach ($docs as $index => $doc) {
            $docId = trim((string)($doc['docId'] ?? ''));
            $docTitle = trim((string)($doc['title'] ?? ''));
            $docIcon = trim((string)($doc['icon'] ?? ''));
            $docHpath = (string)($doc['hPath'] ?? '');
            $docMarkdown = (string)($doc['markdown'] ?? '');
            $docSort = max(0, (int)($doc['sortOrder'] ?? $index));
            $docParent = trim((string)($doc['parentId'] ?? ''));
            $docSortIndex = (float)($doc['sortIndex'] ?? $index);
            if ($docId === '') {
                continue;
            }
            $chunkMeta = $docChunkById[$docId] ?? null;
            $size = strlen($docMarkdown);
            if ($size === 0 && $chunkMeta) {
                $size = max(0, (int)($chunkMeta['size'] ?? 0));
            }
            $docContentHash = normalize_hash_hex($doc['contentHash'] ?? '');
            if ($docContentHash === '' && $chunkMeta) {
                $docContentHash = normalize_hash_hex($chunkMeta['hash'] ?? '');
            }
            if ($docContentHash === '') {
                $docContentHash = ($docMarkdown !== '' || !$chunkMeta)
                    ? compute_doc_content_hash($docMarkdown)
                    : '';
            }
            $docMetaHash = normalize_hash_hex($doc['metaHash'] ?? '');
            if ($docMetaHash === '') {
                $docMetaHash = compute_doc_meta_hash([
                    'title' => $docTitle ?: $docId,
                    'icon' => $docIcon,
                    'hPath' => $docHpath,
                    'parentId' => $docParent,
                    'sortIndex' => $docSortIndex,
                    'sortOrder' => $docSort,
                ]);
            }
            $docSizeTotal += $size;
            $docRows[] = [
                'docId' => $docId,
                'title' => $docTitle ?: $docId,
                'icon' => $docIcon,
                'hPath' => $docHpath,
                'parentId' => $docParent,
                'sortIndex' => $docSortIndex,
                'markdown' => $docMarkdown,
                'sortOrder' => $docSort,
                'size' => $size,
                'contentHash' => $docContentHash,
                'metaHash' => $docMetaHash,
            ];
        }
        if (empty($docRows) && !$useIncremental) {
            api_response(400, null, 'No documents to share');
        }
        $baseShareSize = $docSizeTotal + $assetSize;
        $existingSize = $existing ? (int)($existing['size_bytes'] ?? 0) : 0;
        $newShareSize = $baseShareSize;
        $used = recalculate_user_storage((int)$user['id']);
        $limit = get_user_limit_bytes($user);
        $usedWithout = max(0, $used - $existingSize);
        if (!$useIncremental && $limit > 0 && ($usedWithout + $newShareSize) > $limit) {
            api_response(413, null, 'Storage limit reached');
        }

        $passwordHash = $existing['password_hash'] ?? null;
        $expiresValue = isset($existing['expires_at']) ? (int)$existing['expires_at'] : null;
        $visitorValue = isset($existing['visitor_limit']) ? (int)$existing['visitor_limit'] : 0;
        if ($clearPassword) {
            $passwordHash = null;
        } elseif ($password !== '') {
            $passwordHash = password_hash($password, PASSWORD_DEFAULT);
        }
        if ($clearExpires) {
            $expiresValue = null;
        } elseif ($expiresAt !== null) {
            $expiresValue = $expiresAt;
        }
        if ($clearVisitorLimit) {
            $visitorValue = 0;
        } elseif ($visitorLimit !== null) {
            $visitorValue = $visitorLimit;
        }

        $finalSlug = $slug;
        if ($existing) {
            if ($finalSlug && $finalSlug !== $existing['slug']) {
                ensure_share_slug_available_or_fail($pdo, $finalSlug, (int)$existing['id']);
            }
            if (!$finalSlug) {
                $finalSlug = (string)$existing['slug'];
            }
        } else {
            if (!$finalSlug) {
                $finalSlug = allocate_random_share_slug_or_fail($pdo);
            } else {
                ensure_share_slug_available_or_fail($pdo, $finalSlug);
            }
        }

        $finalTitle = $title ?: ($existing['title'] ?? $notebookId);
        $uploadMode = $useIncremental ? 'incremental' : 'full';
        $patchManifest = json_encode(
            $useIncremental
                ? $incrementalPatch
                : ['enabled' => false, 'deletedDocIds' => [], 'deletedAssetPaths' => []],
            JSON_UNESCAPED_SLASHES
        );
        $uploadId = generate_upload_id();
        $stmt = $pdo->prepare('INSERT INTO share_uploads (upload_id, user_id, share_id, type, notebook_id, slug, title, password_hash, expires_at, visitor_limit, asset_manifest, doc_manifest, upload_mode, patch_manifest, status, created_at, updated_at)
            VALUES (:upload_id, :user_id, :share_id, "notebook", :notebook_id, :slug, :title, :password_hash, :expires_at, :visitor_limit, :asset_manifest, :doc_manifest, :upload_mode, :patch_manifest, "pending", :created_at, :updated_at)');
        $stmt->execute([
            ':upload_id' => $uploadId,
            ':user_id' => $user['id'],
            ':share_id' => $existing ? (int)$existing['id'] : null,
            ':notebook_id' => $notebookId,
            ':slug' => $finalSlug,
            ':title' => $finalTitle,
            ':password_hash' => $passwordHash,
            ':expires_at' => $expiresValue,
            ':visitor_limit' => $visitorValue,
            ':asset_manifest' => json_encode($assets, JSON_UNESCAPED_SLASHES),
            ':doc_manifest' => json_encode($docChunks, JSON_UNESCAPED_SLASHES),
            ':upload_mode' => $uploadMode,
            ':patch_manifest' => $patchManifest,
            ':created_at' => now(),
            ':updated_at' => now(),
        ]);
        $stmt = $pdo->prepare('INSERT INTO share_upload_docs (upload_id, doc_id, title, icon, hpath, parent_id, sort_index, markdown, sort_order, size_bytes, content_hash, meta_hash, created_at, updated_at)
            VALUES (:upload_id, :doc_id, :title, :icon, :hpath, :parent_id, :sort_index, :markdown, :sort_order, :size_bytes, :content_hash, :meta_hash, :created_at, :updated_at)');
        foreach ($docRows as $row) {
            $stmt->execute([
                ':upload_id' => $uploadId,
                ':doc_id' => $row['docId'],
                ':title' => $row['title'],
                ':icon' => $row['icon'] !== '' ? $row['icon'] : null,
                ':hpath' => $row['hPath'],
                ':parent_id' => $row['parentId'] !== '' ? $row['parentId'] : null,
                ':sort_index' => $row['sortIndex'],
                ':markdown' => $row['markdown'],
                ':sort_order' => $row['sortOrder'],
                ':size_bytes' => $row['size'],
                ':content_hash' => normalize_hash_hex($row['contentHash'] ?? ''),
                ':meta_hash' => normalize_hash_hex($row['metaHash'] ?? ''),
                ':created_at' => now(),
                ':updated_at' => now(),
            ]);
        }
        api_response(200, ['uploadId' => $uploadId, 'slug' => $finalSlug]);
    }

    if ($path === '/api/v1/shares/asset/chunk' && $_SERVER['REQUEST_METHOD'] === 'POST') {
        $uploadId = sanitize_upload_id((string)($_POST['uploadId'] ?? ''));
        $assetPath = sanitize_asset_path((string)($_POST['assetPath'] ?? ''));
        $docId = trim((string)($_POST['assetDocId'] ?? ''));
        $chunkIndex = (int)($_POST['chunkIndex'] ?? -1);
        $totalChunks = (int)($_POST['totalChunks'] ?? 0);
        if ($uploadId === '' || $assetPath === '' || $chunkIndex < 0 || $totalChunks <= 0 || $chunkIndex >= $totalChunks) {
            api_response(400, null, 'Invalid chunk request');
        }
        $check = $pdo->prepare('SELECT * FROM share_uploads WHERE upload_id = :upload_id AND user_id = :uid AND status = "pending" LIMIT 1');
        $check->execute([
            ':upload_id' => $uploadId,
            ':uid' => $user['id'],
        ]);
        $upload = $check->fetch(PDO::FETCH_ASSOC);
        if (!$upload) {
            api_response(404, null, 'Upload not found');
        }
        $manifest = normalize_asset_manifest(json_decode((string)($upload['asset_manifest'] ?? ''), true));
        $docManifest = normalize_doc_manifest(json_decode((string)($upload['doc_manifest'] ?? ''), true));
        $manifestItem = null;
        $isDocChunk = false;
        foreach ($manifest as $item) {
            $path = sanitize_asset_path((string)($item['path'] ?? ''));
            if ($path !== '' && $path === $assetPath) {
                $manifestItem = $item;
                break;
            }
        }
        if (!$manifestItem) {
            foreach ($docManifest as $item) {
                $path = sanitize_asset_path((string)($item['path'] ?? ''));
                if ($path !== '' && $path === $assetPath) {
                    $manifestItem = $item;
                    $isDocChunk = true;
                    break;
                }
            }
        }
        if (!$manifestItem) {
            api_response(400, null, 'Asset not allowed');
        }
        if ($isDocChunk) {
            $expectedDocId = trim((string)($manifestItem['docId'] ?? ''));
            if ($expectedDocId !== '' && $docId !== '' && $expectedDocId !== $docId) {
                api_response(400, null, 'Document chunk mismatch');
            }
        }
        if (empty($_FILES['chunk'])) {
            api_response(400, null, 'Missing chunk file');
        }
        $file = $_FILES['chunk'];
        $chunkSize = (int)($file['size'] ?? 0);
        [$minChunk, $maxChunk] = chunk_size_limits();
        if ($maxChunk > 0 && $chunkSize > $maxChunk) {
            api_response(413, null, 'Chunk too large');
        }
        if ($minChunk > 0 && $chunkIndex < ($totalChunks - 1) && $chunkSize > 0 && $chunkSize < $minChunk) {
            api_response(400, null, 'Chunk too small');
        }
        $tmp = $file['tmp_name'] ?? '';
        if ($tmp === '' || !is_uploaded_file($tmp)) {
            api_response(400, null, 'Invalid chunk upload');
        }

        $chunkDir = upload_chunks_dir($uploadId);
        $chunkPath = $chunkDir . '/' . $assetPath . '.part' . $chunkIndex;
        ensure_dir(dirname($chunkPath));
        if (!move_uploaded_file($tmp, $chunkPath)) {
            api_response(500, null, 'Chunk save failed');
        }

        $complete = false;
        if ($chunkIndex === $totalChunks - 1) {
            $missing = [];
            for ($i = 0; $i < $totalChunks; $i++) {
                $part = $chunkDir . '/' . $assetPath . '.part' . $i;
                if (!is_file($part)) {
                    $missing[] = $i;
                }
            }
            if (!empty($missing)) {
                api_response(409, [
                    'missingChunks' => $missing,
                    'uploadId' => $uploadId,
                    'assetPath' => $assetPath,
                    'totalChunks' => $totalChunks,
                ], 'Missing chunk');
            }
            $targetFile = upload_staging_dir($uploadId) . '/' . $assetPath;
            ensure_dir(dirname($targetFile));
            $out = fopen($targetFile, 'wb');
            if ($out === false) {
                api_response(500, null, 'Failed to open target file');
            }
            for ($i = 0; $i < $totalChunks; $i++) {
                $part = $chunkDir . '/' . $assetPath . '.part' . $i;
                $in = fopen($part, 'rb');
                if ($in === false) {
                    fclose($out);
                    api_response(500, null, 'Failed to read chunk');
                }
                while (!feof($in)) {
                    $buffer = fread($in, 1048576);
                    if ($buffer === false) {
                        break;
                    }
                    fwrite($out, $buffer);
                }
                fclose($in);
                @unlink($part);
            }
            fclose($out);
            $complete = true;
        }
        $stmt = $pdo->prepare('UPDATE share_uploads SET updated_at = :updated_at WHERE upload_id = :upload_id');
        $stmt->execute([
            ':updated_at' => now(),
            ':upload_id' => $uploadId,
        ]);
        api_response(200, ['complete' => $complete]);
    }

    if ($path === '/api/v1/shares/upload/complete' && $_SERVER['REQUEST_METHOD'] === 'POST') {
        $payload = parse_json_body();
        $uploadId = sanitize_upload_id((string)($payload['uploadId'] ?? ''));
        if ($uploadId === '') {
            api_response(400, null, 'Missing upload id');
        }
        $stmt = $pdo->prepare('SELECT * FROM share_uploads WHERE upload_id = :upload_id AND user_id = :uid AND status = "pending" LIMIT 1');
        $stmt->execute([
            ':upload_id' => $uploadId,
            ':uid' => $user['id'],
        ]);
        $upload = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$upload) {
            api_response(404, null, 'Upload not found');
        }

        $stagingDir = upload_staging_dir($uploadId);
        $docManifest = normalize_doc_manifest(json_decode((string)($upload['doc_manifest'] ?? ''), true));
        $docChunkById = [];
        foreach ($docManifest as $item) {
            $docChunkById[(string)($item['docId'] ?? '')] = $item;
        }

        $docStmt = $pdo->prepare('SELECT id, doc_id, title, icon, hpath, parent_id, sort_index, sort_order, size_bytes, content_hash, meta_hash, LENGTH(markdown) AS markdown_len FROM share_upload_docs WHERE upload_id = :upload_id ORDER BY id ASC');
        $docStmt->execute([':upload_id' => $uploadId]);
        $docRows = [];
        $docSizeTotal = 0;
        $chunkFilesToClean = [];
        while ($row = $docStmt->fetch(PDO::FETCH_ASSOC)) {
            $docIdKey = trim((string)($row['doc_id'] ?? ''));
            $docTitle = (string)($row['title'] ?? '');
            $docIcon = (string)($row['icon'] ?? '');
            $docHpath = (string)($row['hpath'] ?? '');
            $docParent = (string)($row['parent_id'] ?? '');
            $docSortIndex = normalize_sort_index_value($row['sort_index'] ?? 0);
            $docSortOrder = max(0, (int)($row['sort_order'] ?? 0));
            $docChunk = $docIdKey !== '' ? ($docChunkById[$docIdKey] ?? null) : null;
            $chunkHash = '';
            $chunkSize = -1;
            $chunkFilePath = null;
            if ($docChunk) {
                $chunkPath = sanitize_asset_path((string)($docChunk['path'] ?? ''));
                $fullChunkPath = $chunkPath !== '' ? ($stagingDir . '/' . $chunkPath) : '';
                if ($fullChunkPath === '' || !is_file($fullChunkPath)) {
                    api_response(400, null, 'Missing document: ' . $docIdKey);
                }
                $chunkSize = (int)filesize($fullChunkPath);
                if ($chunkSize < 0) {
                    $chunkSize = 0;
                }
                $expectedSize = max(0, (int)($docChunk['size'] ?? 0));
                if ($expectedSize > 0 && $chunkSize !== $expectedSize) {
                    api_response(400, null, 'Document size mismatch: ' . $docIdKey);
                }
                $chunkHash = normalize_hash_hex($docChunk['hash'] ?? '');
                if ($chunkHash !== '') {
                    $computedChunkHash = normalize_hash_hex(hash_file('sha256', $fullChunkPath));
                    if ($computedChunkHash !== $chunkHash) {
                        api_response(400, null, 'Document hash mismatch: ' . $docIdKey);
                    }
                }
                $chunkFilePath = $fullChunkPath;
                $chunkFilesToClean[] = $fullChunkPath;

            } else {

            }
            $docContentHash = normalize_hash_hex($row['content_hash'] ?? '');
            if ($chunkHash !== '') {
                $docContentHash = $chunkHash;
            }
            if ($docContentHash === '' && $chunkFilePath) {
                $docContentHash = normalize_hash_hex(hash_file('sha256', $chunkFilePath));
            }
            if ($docContentHash === '' && !$chunkFilePath) {
                $inlineMdStmt2 = $pdo->prepare('SELECT markdown FROM share_upload_docs WHERE id = :id LIMIT 1');
                $inlineMdStmt2->execute([':id' => (int)$row['id']]);
                $inlineMd2 = (string)($inlineMdStmt2->fetchColumn() ?: '');
                $docContentHash = compute_doc_content_hash($inlineMd2);
                unset($inlineMd2);
            }
            $docMetaHash = normalize_hash_hex($row['meta_hash'] ?? '');
            if ($docMetaHash === '') {
                $docMetaHash = compute_doc_meta_hash([
                    'title' => $docTitle,
                    'icon' => $docIcon,
                    'hPath' => $docHpath,
                    'parentId' => $docParent,
                    'sortIndex' => $docSortIndex,
                    'sortOrder' => $docSortOrder,
                ]);
            }
            $rowSize = (int)($row['size_bytes'] ?? 0);
            if ($chunkSize >= 0) {
                $rowSize = $chunkSize;
            } elseif ($rowSize <= 0) {
                $rowSize = (int)($row['markdown_len'] ?? 0);
            }
            $docRows[] = [
                'doc_id' => $docIdKey,
                'title' => $docTitle,
                'icon' => $docIcon,
                'hpath' => $docHpath,
                'parent_id' => $docParent !== '' ? $docParent : null,
                'sort_index' => $docSortIndex,
                'sort_order' => $docSortOrder,
                'size_bytes' => $rowSize,
                'content_hash' => $docContentHash,
                'meta_hash' => $docMetaHash,
                '_chunk_file' => $chunkFilePath,
                '_upload_row_id' => (int)$row['id'],
            ];
            $docSizeTotal += $rowSize;
            unset($row);
        }

        $manifest = normalize_asset_manifest(json_decode((string)($upload['asset_manifest'] ?? ''), true));
        $assetSizeTotal = 0;
        $manifestEntries = [];
        foreach ($manifest as $item) {
            $path = sanitize_asset_path((string)($item['path'] ?? ''));
            if ($path === '') {
                continue;
            }
            $full = $stagingDir . '/' . $path;
            if (!is_file($full)) {
                api_response(400, null, 'Missing asset: ' . $path);
            }
            $size = (int)filesize($full);
            $assetSizeTotal += $size;
            $assetHash = normalize_hash_hex($item['hash'] ?? '');
            if ($assetHash === '') {
                $computed = @hash_file('sha256', $full);
                $assetHash = normalize_hash_hex($computed ?: '');
            }
            $manifestEntries[] = [
                'path' => $path,
                'docId' => isset($item['docId']) ? trim((string)$item['docId']) : null,
                'size' => $size,
                'hash' => $assetHash,
            ];
        }

        $share = null;
        $shareId = (int)($upload['share_id'] ?? 0);
        if ($shareId > 0) {
            $check = $pdo->prepare('SELECT * FROM shares WHERE id = :id AND user_id = :uid LIMIT 1');
            $check->execute([
                ':id' => $shareId,
                ':uid' => $user['id'],
            ]);
            $share = $check->fetch(PDO::FETCH_ASSOC) ?: null;
            if (!$share) {
                $shareId = 0;
            }
        }

        $uploadMode = strtolower(trim((string)($upload['upload_mode'] ?? '')));
        $uploadMode = $uploadMode === 'incremental' ? 'incremental' : 'full';
        if ($uploadMode === 'incremental' && !$share) {
            $uploadMode = 'full';
        }
        if ($uploadMode === 'full' && empty($docRows)) {
            api_response(400, null, 'Missing documents');
        }
        $patchManifest = normalize_incremental_patch(json_decode((string)($upload['patch_manifest'] ?? ''), true));
        $changedDocSet = [];
        foreach ($docRows as $row) {
            $docKey = trim((string)($row['doc_id'] ?? ''));
            if ($docKey !== '') {
                $changedDocSet[$docKey] = true;
            }
        }
        $changedAssetSet = [];
        foreach ($manifestEntries as $entry) {
            $assetKey = sanitize_asset_path((string)($entry['path'] ?? ''));
            if ($assetKey !== '') {
                $changedAssetSet[$assetKey] = true;
            }
        }
        $deletedDocIds = [];
        foreach (($patchManifest['deletedDocIds'] ?? []) as $docKey) {
            $docKey = trim((string)$docKey);
            if ($docKey === '' || isset($changedDocSet[$docKey])) {
                continue;
            }
            $deletedDocIds[] = $docKey;
        }
        $deletedAssetPaths = [];
        foreach (($patchManifest['deletedAssetPaths'] ?? []) as $assetPath) {
            $assetPath = sanitize_asset_path((string)$assetPath);
            if ($assetPath === '' || isset($changedAssetSet[$assetPath])) {
                continue;
            }
            $deletedAssetPaths[] = $assetPath;
        }

        $baseShareSize = $docSizeTotal + $assetSizeTotal;
        $newShareSize = $baseShareSize;
        $existingSize = $share ? (int)($share['size_bytes'] ?? 0) : 0;
        $used = recalculate_user_storage((int)$user['id']);
        $limit = get_user_limit_bytes($user);
        $usedWithout = max(0, $used - $existingSize);
        if ($uploadMode === 'full') {
            if ($limit > 0 && ($usedWithout + $newShareSize) > $limit) {
                api_response(413, null, 'Storage limit reached');
            }
        } elseif ($share) {
            $oldDocSizes = [];
            $stmt = $pdo->prepare('SELECT doc_id, size_bytes FROM share_docs WHERE share_id = :sid');
            $stmt->execute([':sid' => (int)$share['id']]);
            foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
                $oldDocSizes[(string)($row['doc_id'] ?? '')] = (int)($row['size_bytes'] ?? 0);
            }
            $oldAssetSizes = [];
            $stmt = $pdo->prepare('SELECT asset_path, size_bytes FROM share_assets WHERE share_id = :sid');
            $stmt->execute([
                ':sid' => (int)$share['id'],
            ]);
            foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
                $oldAssetSizes[(string)($row['asset_path'] ?? '')] = (int)($row['size_bytes'] ?? 0);
            }
            $docDelta = 0;
            foreach ($docRows as $row) {
                $key = (string)($row['doc_id'] ?? '');
                if ($key === '') {
                    continue;
                }
                $docDelta += (int)($row['size_bytes'] ?? 0);
                if (isset($oldDocSizes[$key])) {
                    $docDelta -= (int)$oldDocSizes[$key];
                }
            }
            foreach ($deletedDocIds as $key) {
                if (isset($oldDocSizes[$key])) {
                    $docDelta -= (int)$oldDocSizes[$key];
                }
            }
            $assetDelta = 0;
            foreach ($manifestEntries as $entry) {
                $key = (string)($entry['path'] ?? '');
                if ($key === '') {
                    continue;
                }
                $assetDelta += (int)($entry['size'] ?? 0);
                if (isset($oldAssetSizes[$key])) {
                    $assetDelta -= (int)$oldAssetSizes[$key];
                }
            }
            foreach ($deletedAssetPaths as $key) {
                if (isset($oldAssetSizes[$key])) {
                    $assetDelta -= (int)$oldAssetSizes[$key];
                }
            }
            $projectedSize = max(0, $existingSize + $docDelta + $assetDelta);
            if ($limit > 0 && ($usedWithout + $projectedSize) > $limit) {
                api_response(413, null, 'Storage limit reached');
            }
        }

        $slug = sanitize_slug((string)($upload['slug'] ?? ''));
        if ($slug === '') {
            $slug = allocate_random_share_slug_or_fail($pdo);
        } else {
            ensure_share_slug_available_or_fail($pdo, $slug, $share ? (int)$share['id'] : 0);
        }

        $title = trim((string)($upload['title'] ?? ''));
        $passwordHash = $upload['password_hash'] ?? null;
        $expiresValue = isset($upload['expires_at']) ? (int)$upload['expires_at'] : null;
        $visitorValue = isset($upload['visitor_limit']) ? (int)$upload['visitor_limit'] : 0;
        $type = (string)($upload['type'] ?? 'doc');
        $docId = trim((string)($upload['doc_id'] ?? ''));
        $notebookId = trim((string)($upload['notebook_id'] ?? ''));

        $pdo->beginTransaction();
        try {
            if ($share) {
                $update = $pdo->prepare('UPDATE shares SET title = :title, slug = :slug, password_hash = :password_hash, expires_at = :expires_at, visitor_limit = :visitor_limit, updated_at = :updated_at, deleted_at = NULL WHERE id = :id');
                $update->execute([
                    ':title' => $title !== '' ? $title : ($share['title'] ?? $slug),
                    ':slug' => $slug,
                    ':password_hash' => $passwordHash,
                    ':expires_at' => $expiresValue,
                    ':visitor_limit' => $visitorValue,
                    ':updated_at' => now(),
                    ':id' => $share['id'],
                ]);
                $shareId = (int)$share['id'];
                if ($uploadMode === 'full') {
                    purge_share_assets($shareId);
                    purge_share_chunks($shareId);
                    $pdo->prepare('DELETE FROM share_docs WHERE share_id = :share_id')->execute([':share_id' => $shareId]);
                }
            } else {
                $shareId = allocate_share_id($pdo);
                if ($shareId > 0) {
                    $stmt = $pdo->prepare('INSERT INTO shares (id, user_id, type, slug, title, doc_id, notebook_id, password_hash, expires_at, visitor_limit, created_at, updated_at)
                        VALUES (:id, :uid, :type, :slug, :title, :doc_id, :notebook_id, :password_hash, :expires_at, :visitor_limit, :created_at, :updated_at)');
                    $stmt->execute([
                        ':id' => $shareId,
                        ':uid' => $user['id'],
                        ':type' => $type,
                        ':slug' => $slug,
                        ':title' => $title !== '' ? $title : $slug,
                        ':doc_id' => $type === 'doc' ? $docId : null,
                        ':notebook_id' => $type === 'notebook' ? $notebookId : null,
                        ':password_hash' => $passwordHash,
                        ':expires_at' => $expiresValue,
                        ':visitor_limit' => $visitorValue,
                        ':created_at' => now(),
                        ':updated_at' => now(),
                    ]);
                } else {
                    $stmt = $pdo->prepare('INSERT INTO shares (user_id, type, slug, title, doc_id, notebook_id, password_hash, expires_at, visitor_limit, created_at, updated_at)
                        VALUES (:uid, :type, :slug, :title, :doc_id, :notebook_id, :password_hash, :expires_at, :visitor_limit, :created_at, :updated_at)');
                    $stmt->execute([
                        ':uid' => $user['id'],
                        ':type' => $type,
                        ':slug' => $slug,
                        ':title' => $title !== '' ? $title : $slug,
                        ':doc_id' => $type === 'doc' ? $docId : null,
                        ':notebook_id' => $type === 'notebook' ? $notebookId : null,
                        ':password_hash' => $passwordHash,
                        ':expires_at' => $expiresValue,
                        ':visitor_limit' => $visitorValue,
                        ':created_at' => now(),
                        ':updated_at' => now(),
                    ]);
                    $shareId = (int)$pdo->lastInsertId();
                }
            }

            $targetDir = $config['uploads_dir'] . '/shares/' . $shareId;
            ensure_dir($targetDir);
            if ($uploadMode === 'full') {
                $insertDoc = $pdo->prepare('INSERT INTO share_docs (share_id, doc_id, title, icon, hpath, parent_id, sort_index, markdown, sort_order, size_bytes, content_hash, meta_hash, created_at, updated_at)
                    VALUES (:share_id, :doc_id, :title, :icon, :hpath, :parent_id, :sort_index, :markdown, :sort_order, :size_bytes, :content_hash, :meta_hash, :created_at, :updated_at)');
                $fetchMdStmt = $pdo->prepare('SELECT markdown FROM share_upload_docs WHERE id = :id LIMIT 1');
                foreach ($docRows as $row) {
                    $docMarkdown = '';
                    if (!empty($row['_chunk_file']) && is_file($row['_chunk_file'])) {
                        $docMarkdown = (string)@file_get_contents($row['_chunk_file']);
                    } else {
                        $fetchMdStmt->execute([':id' => (int)$row['_upload_row_id']]);
                        $docMarkdown = (string)($fetchMdStmt->fetchColumn() ?: '');
                    }
                    $insertDoc->execute([
                        ':share_id' => $shareId,
                        ':doc_id' => $row['doc_id'],
                        ':title' => $row['title'],
                        ':icon' => isset($row['icon']) && trim((string)$row['icon']) !== '' ? $row['icon'] : null,
                        ':hpath' => $row['hpath'],
                        ':parent_id' => $row['parent_id'] ?? null,
                        ':sort_index' => $row['sort_index'] ?? 0,
                        ':markdown' => $docMarkdown,
                        ':sort_order' => $row['sort_order'] ?? 0,
                        ':size_bytes' => $row['size_bytes'] ?? 0,
                        ':content_hash' => normalize_hash_hex($row['content_hash'] ?? ''),
                        ':meta_hash' => normalize_hash_hex($row['meta_hash'] ?? ''),
                        ':created_at' => now(),
                        ':updated_at' => now(),
                    ]);
                    unset($docMarkdown);
                }
                foreach ($chunkFilesToClean as $cf) {
                    if (is_file($cf)) {
                        @unlink($cf);
                    }
                }
                if (is_dir($stagingDir)) {
                    move_dir($stagingDir, $targetDir);
                }
                if (!empty($manifestEntries)) {
                    $assetStmt = $pdo->prepare('INSERT OR REPLACE INTO share_assets (share_id, doc_id, asset_path, file_path, size_bytes, asset_hash, created_at)
                        VALUES (:share_id, :doc_id, :asset_path, :file_path, :size_bytes, :asset_hash, :created_at)');
                    foreach ($manifestEntries as $entry) {
                        $assetStmt->execute([
                            ':share_id' => $shareId,
                            ':doc_id' => $entry['docId'] !== '' ? $entry['docId'] : null,
                            ':asset_path' => $entry['path'],
                            ':file_path' => 'shares/' . $shareId . '/' . $entry['path'],
                            ':size_bytes' => $entry['size'],
                            ':asset_hash' => normalize_hash_hex($entry['hash'] ?? ''),
                            ':created_at' => now(),
                        ]);
                    }
                }
                $updateSize = $pdo->prepare('UPDATE shares SET size_bytes = :size_bytes, updated_at = :updated_at WHERE id = :id');
                $updateSize->execute([
                    ':size_bytes' => $newShareSize,
                    ':updated_at' => now(),
                    ':id' => $shareId,
                ]);
            } else {
                if (!empty($deletedDocIds)) {
                    $placeholders = implode(',', array_fill(0, count($deletedDocIds), '?'));
                    $params = $deletedDocIds;
                    array_unshift($params, $shareId);
                    $stmt = $pdo->prepare('DELETE FROM share_docs WHERE share_id = ? AND doc_id IN (' . $placeholders . ')');
                    $stmt->execute($params);
                }

                $findDoc = $pdo->prepare('SELECT id FROM share_docs WHERE share_id = :share_id AND doc_id = :doc_id LIMIT 1');
                $updateDoc = $pdo->prepare('UPDATE share_docs SET title = :title, icon = :icon, hpath = :hpath, parent_id = :parent_id, sort_index = :sort_index, markdown = :markdown, sort_order = :sort_order, size_bytes = :size_bytes, content_hash = :content_hash, meta_hash = :meta_hash, updated_at = :updated_at WHERE id = :id');
                $insertDoc = $pdo->prepare('INSERT INTO share_docs (share_id, doc_id, title, icon, hpath, parent_id, sort_index, markdown, sort_order, size_bytes, content_hash, meta_hash, created_at, updated_at)
                    VALUES (:share_id, :doc_id, :title, :icon, :hpath, :parent_id, :sort_index, :markdown, :sort_order, :size_bytes, :content_hash, :meta_hash, :created_at, :updated_at)');
                $fetchMdStmt2 = $pdo->prepare('SELECT markdown FROM share_upload_docs WHERE id = :id LIMIT 1');
                foreach ($docRows as $row) {
                    $docKey = trim((string)($row['doc_id'] ?? ''));
                    if ($docKey === '') {
                        continue;
                    }
                    $docMarkdown = '';
                    if (!empty($row['_chunk_file']) && is_file($row['_chunk_file'])) {
                        $docMarkdown = (string)@file_get_contents($row['_chunk_file']);
                    } else {
                        $fetchMdStmt2->execute([':id' => (int)$row['_upload_row_id']]);
                        $docMarkdown = (string)($fetchMdStmt2->fetchColumn() ?: '');
                    }
                    $findDoc->execute([
                        ':share_id' => $shareId,
                        ':doc_id' => $docKey,
                    ]);
                    $docRowId = (int)($findDoc->fetchColumn() ?: 0);
                    $bind = [
                        ':title' => $row['title'],
                        ':icon' => isset($row['icon']) && trim((string)$row['icon']) !== '' ? $row['icon'] : null,
                        ':hpath' => $row['hpath'],
                        ':parent_id' => $row['parent_id'] ?? null,
                        ':sort_index' => $row['sort_index'] ?? 0,
                        ':markdown' => $docMarkdown,
                        ':sort_order' => $row['sort_order'] ?? 0,
                        ':size_bytes' => $row['size_bytes'] ?? 0,
                        ':content_hash' => normalize_hash_hex($row['content_hash'] ?? ''),
                        ':meta_hash' => normalize_hash_hex($row['meta_hash'] ?? ''),
                        ':updated_at' => now(),
                    ];
                    unset($docMarkdown);
                    if ($docRowId > 0) {
                        $bind[':id'] = $docRowId;
                        $updateDoc->execute($bind);
                    } else {
                        $insertDoc->execute(array_merge($bind, [
                            ':share_id' => $shareId,
                            ':doc_id' => $docKey,
                            ':created_at' => now(),
                        ]));
                    }
                }
                foreach ($chunkFilesToClean as $cf) {
                    if (is_file($cf)) {
                        @unlink($cf);
                    }
                }

                if (!empty($deletedAssetPaths)) {
                    $placeholders = implode(',', array_fill(0, count($deletedAssetPaths), '?'));
                    $params = $deletedAssetPaths;
                    array_unshift($params, $shareId);
                    $select = $pdo->prepare('SELECT file_path FROM share_assets WHERE share_id = ? AND asset_path IN (' . $placeholders . ')');
                    $select->execute($params);
                    $files = $select->fetchAll(PDO::FETCH_COLUMN);
                    foreach ($files as $filePath) {
                        $fullPath = $config['uploads_dir'] . '/' . ltrim((string)$filePath, '/');
                        if ($fullPath !== '' && is_file($fullPath)) {
                            @unlink($fullPath);
                        }
                    }
                    $deleteAsset = $pdo->prepare('DELETE FROM share_assets WHERE share_id = ? AND asset_path IN (' . $placeholders . ')');
                    $deleteAsset->execute($params);
                }

                if (!empty($manifestEntries)) {
                    $assetStmt = $pdo->prepare('INSERT OR REPLACE INTO share_assets (share_id, doc_id, asset_path, file_path, size_bytes, asset_hash, created_at)
                        VALUES (:share_id, :doc_id, :asset_path, :file_path, :size_bytes, :asset_hash, :created_at)');
                    foreach ($manifestEntries as $entry) {
                        $source = $stagingDir . '/' . $entry['path'];
                        if (!is_file($source)) {
                            continue;
                        }
                        $targetFile = $targetDir . '/' . $entry['path'];
                        ensure_dir(dirname($targetFile));
                        if (!@rename($source, $targetFile)) {
                            if (!@copy($source, $targetFile)) {
                                continue;
                            }
                            @unlink($source);
                        }
                        $assetStmt->execute([
                            ':share_id' => $shareId,
                            ':doc_id' => $entry['docId'] !== '' ? $entry['docId'] : null,
                            ':asset_path' => $entry['path'],
                            ':file_path' => 'shares/' . $shareId . '/' . $entry['path'],
                            ':size_bytes' => $entry['size'],
                            ':asset_hash' => normalize_hash_hex($entry['hash'] ?? ''),
                            ':created_at' => now(),
                        ]);
                    }
                }
                recalculate_share_size($shareId);
            }

            $pdo->prepare('DELETE FROM share_upload_docs WHERE upload_id = :upload_id')->execute([':upload_id' => $uploadId]);
            $pdo->prepare('DELETE FROM share_uploads WHERE upload_id = :upload_id')->execute([':upload_id' => $uploadId]);
            $pdo->commit();
            foreach ($chunkFilesToClean as $chunkFile) {
                if (is_file($chunkFile)) {
                    @unlink($chunkFile);
                }
            }
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            error_log('Upload finalize failed for uploadId=' . $uploadId . ': ' . $e->getMessage() . ' in ' . $e->getFile() . ':' . $e->getLine());
            api_response(500, null, 'Upload finalize failed: ' . $e->getMessage());
        }

        purge_upload_session_files($uploadId);
        recalculate_user_storage((int)$user['id']);
        api_response(200, [
            'shareId' => $shareId,
            'slug' => $slug,
            'url' => share_url($slug),
        ]);
    }

    if ($path === '/api/v1/shares/upload/cancel' && $_SERVER['REQUEST_METHOD'] === 'POST') {
        $payload = parse_json_body();
        $uploadId = sanitize_upload_id((string)($payload['uploadId'] ?? ''));
        if ($uploadId === '') {
            api_response(400, null, 'Missing upload id');
        }
        $stmt = $pdo->prepare('SELECT id FROM share_uploads WHERE upload_id = :upload_id AND user_id = :uid LIMIT 1');
        $stmt->execute([
            ':upload_id' => $uploadId,
            ':uid' => $user['id'],
        ]);
        if (!$stmt->fetchColumn()) {
            api_response(404, null, 'Upload not found');
        }
        $pdo->prepare('DELETE FROM share_upload_docs WHERE upload_id = :upload_id')->execute([':upload_id' => $uploadId]);
        $pdo->prepare('DELETE FROM share_uploads WHERE upload_id = :upload_id')->execute([':upload_id' => $uploadId]);
        purge_upload_session_files($uploadId);
        api_response(200, ['ok' => true]);
    }

    if ($path === '/api/v1/shares/doc') {
        $metaRaw = $_POST['metadata'] ?? '';
        if (!$metaRaw) {
            $metaRaw = json_encode(parse_json_body());
        }
        $meta = json_decode($metaRaw, true);
        if (!is_array($meta)) {
            api_response(400, null, '数据格式错误');
        }
        $docId = trim((string)($meta['docId'] ?? ''));
        $title = trim((string)($meta['title'] ?? ''));
        $markdown = (string)($meta['markdown'] ?? '');
        $hPath = (string)($meta['hPath'] ?? '');
        $sortOrder = max(0, (int)($meta['sortOrder'] ?? 0));
        $password = trim((string)($meta['password'] ?? ''));
        $clearPassword = !empty($meta['clearPassword']);
        $expiresAt = parse_expires_at($meta['expiresAt'] ?? null);
        $clearExpires = !empty($meta['clearExpires']);
        $visitorLimit = parse_visitor_limit($meta['visitorLimit'] ?? null);
        $clearVisitorLimit = !empty($meta['clearVisitorLimit']);
        $docs = $meta['docs'] ?? [];
        $hasDocs = is_array($docs) && count($docs) > 0;
        if ($docId === '' || (!$hasDocs && $markdown === '')) {
            api_response(400, null, '缺少文档内容');
        }

        $slug = parse_requested_share_slug_or_fail($meta['slug'] ?? '');
        $paths = $_POST['assetPaths'] ?? [];
        $docIds = $_POST['assetDocIds'] ?? [];
        $paths = is_array($paths) ? $paths : [$paths];
        $docIds = is_array($docIds) ? $docIds : [$docIds];
        $entries = [];
        if (!empty($_FILES['assets'])) {
            $entries = collect_asset_entries($_FILES['assets'], $paths, $docIds);
        }
        $assetSize = 0;
        foreach ($entries as $entry) {
            $assetSize += (int)($entry['size'] ?? 0);
        }
        $docRows = [];
        $docSizeTotal = 0;
        if ($hasDocs) {
            foreach ($docs as $index => $doc) {
                $rowDocId = trim((string)($doc['docId'] ?? ''));
                $rowTitle = trim((string)($doc['title'] ?? ''));
                $rowIcon = trim((string)($doc['icon'] ?? ''));
                $rowHpath = (string)($doc['hPath'] ?? '');
                $rowMarkdown = (string)($doc['markdown'] ?? '');
                $rowSort = max(0, (int)($doc['sortOrder'] ?? $index));
                $rowParent = trim((string)($doc['parentId'] ?? ''));
                $rowSortIndex = (float)($doc['sortIndex'] ?? $index);
                if ($rowDocId === '') {
                    continue;
                }
                $size = strlen($rowMarkdown);
                $rowContentHash = compute_doc_content_hash($rowMarkdown);
                $rowMetaHash = compute_doc_meta_hash([
                    'title' => $rowTitle ?: $rowDocId,
                    'icon' => $rowIcon,
                    'hPath' => $rowHpath,
                    'parentId' => $rowParent,
                    'sortIndex' => $rowSortIndex,
                    'sortOrder' => $rowSort,
                ]);
                $docSizeTotal += $size;
                $docRows[] = [
                    'docId' => $rowDocId,
                    'title' => $rowTitle ?: $rowDocId,
                    'icon' => $rowIcon,
                    'hPath' => $rowHpath,
                    'parentId' => $rowParent,
                    'sortIndex' => $rowSortIndex,
                    'markdown' => $rowMarkdown,
                    'sortOrder' => $rowSort,
                    'size' => $size,
                    'contentHash' => $rowContentHash,
                    'metaHash' => $rowMetaHash,
                ];
            }
            if (empty($docRows)) {
                api_response(400, null, '缺少文档内容');
            }
        } else {
            $docSizeTotal = strlen($markdown);
            $docIcon = trim((string)($meta['icon'] ?? ''));
            $docContentHash = compute_doc_content_hash($markdown);
            $docMetaHash = compute_doc_meta_hash([
                'title' => $title ?: $docId,
                'icon' => $docIcon,
                'hPath' => $hPath,
                'parentId' => '',
                'sortIndex' => 0,
                'sortOrder' => $sortOrder,
            ]);
            $docRows[] = [
                'docId' => $docId,
                'title' => $title ?: $docId,
                'icon' => $docIcon,
                'hPath' => $hPath,
                'parentId' => null,
                'sortIndex' => 0,
                'markdown' => $markdown,
                'sortOrder' => $sortOrder,
                'size' => $docSizeTotal,
                'contentHash' => $docContentHash,
                'metaHash' => $docMetaHash,
            ];
        }
        $baseShareSize = $docSizeTotal + $assetSize;
        $stmt = $pdo->prepare('SELECT * FROM shares WHERE user_id = :uid AND type = "doc" AND doc_id = :doc_id ORDER BY id DESC LIMIT 1');
        $stmt->execute([':uid' => $user['id'], ':doc_id' => $docId]);
        $existing = $stmt->fetch(PDO::FETCH_ASSOC) ?: null;
        $existingSize = $existing ? (int)($existing['size_bytes'] ?? 0) : 0;
        $newShareSize = $baseShareSize;
        $used = recalculate_user_storage((int)$user['id']);
        $limit = get_user_limit_bytes($user);
        $usedWithout = max(0, $used - $existingSize);
        if ($limit > 0 && ($usedWithout + $newShareSize) > $limit) {
            api_response(413, null, '存储空间不足，请清理后重试');
        }

        $passwordHash = $existing['password_hash'] ?? null;
        $expiresValue = isset($existing['expires_at']) ? (int)$existing['expires_at'] : null;
        $visitorValue = isset($existing['visitor_limit']) ? (int)$existing['visitor_limit'] : 0;
        if ($clearPassword) {
            $passwordHash = null;
        } elseif ($password !== '') {
            $passwordHash = password_hash($password, PASSWORD_DEFAULT);
        }
        if ($clearExpires) {
            $expiresValue = null;
        } elseif ($expiresAt !== null) {
            $expiresValue = $expiresAt;
        }
        if ($clearVisitorLimit) {
            $visitorValue = 0;
        } elseif ($visitorLimit !== null) {
            $visitorValue = $visitorLimit;
        }

        if ($existing) {
            if ($slug && $slug !== $existing['slug']) {
                ensure_share_slug_available_or_fail($pdo, $slug, (int)$existing['id']);
            }
            $newSlug = $slug ?: $existing['slug'];
            $stmt = $pdo->prepare('UPDATE shares SET title = :title, slug = :slug, password_hash = :password_hash, expires_at = :expires_at, visitor_limit = :visitor_limit, updated_at = :updated_at, deleted_at = NULL WHERE id = :id');
            $stmt->execute([
                ':title' => $title ?: $existing['title'],
                ':slug' => $newSlug,
                ':password_hash' => $passwordHash,
                ':expires_at' => $expiresValue,
                ':visitor_limit' => $visitorValue,
                ':updated_at' => now(),
                ':id' => $existing['id'],
            ]);
            $shareId = (int)$existing['id'];
            $slug = $newSlug;
        } else {
            if (!$slug) {
                $slug = allocate_random_share_slug_or_fail($pdo);
            } else {
                ensure_share_slug_available_or_fail($pdo, $slug);
            }
            $shareId = allocate_share_id($pdo);
            if ($shareId > 0) {
                $stmt = $pdo->prepare('INSERT INTO shares (id, user_id, type, slug, title, doc_id, password_hash, expires_at, visitor_limit, created_at, updated_at)
                    VALUES (:id, :uid, "doc", :slug, :title, :doc_id, :password_hash, :expires_at, :visitor_limit, :created_at, :updated_at)');
                $stmt->execute([
                    ':id' => $shareId,
                    ':uid' => $user['id'],
                    ':slug' => $slug,
                    ':title' => $title ?: $docId,
                    ':doc_id' => $docId,
                    ':password_hash' => $passwordHash,
                    ':expires_at' => $expiresValue,
                    ':visitor_limit' => $visitorValue,
                    ':created_at' => now(),
                    ':updated_at' => now(),
                ]);
            } else {
                $stmt = $pdo->prepare('INSERT INTO shares (user_id, type, slug, title, doc_id, password_hash, expires_at, visitor_limit, created_at, updated_at)
                    VALUES (:uid, "doc", :slug, :title, :doc_id, :password_hash, :expires_at, :visitor_limit, :created_at, :updated_at)');
                $stmt->execute([
                    ':uid' => $user['id'],
                    ':slug' => $slug,
                    ':title' => $title ?: $docId,
                    ':doc_id' => $docId,
                    ':password_hash' => $passwordHash,
                    ':expires_at' => $expiresValue,
                    ':visitor_limit' => $visitorValue,
                    ':created_at' => now(),
                    ':updated_at' => now(),
                ]);
                $shareId = (int)$pdo->lastInsertId();
            }
        }

        if ($existing) {
            purge_share_assets($shareId);
        }

        $pdo->prepare('DELETE FROM share_docs WHERE share_id = :share_id')->execute([':share_id' => $shareId]);
        $insertDoc = $pdo->prepare('INSERT INTO share_docs (share_id, doc_id, title, icon, hpath, parent_id, sort_index, markdown, sort_order, size_bytes, content_hash, meta_hash, created_at, updated_at)
            VALUES (:share_id, :doc_id, :title, :icon, :hpath, :parent_id, :sort_index, :markdown, :sort_order, :size_bytes, :content_hash, :meta_hash, :created_at, :updated_at)');
        foreach ($docRows as $row) {
            $insertDoc->execute([
                ':share_id' => $shareId,
                ':doc_id' => $row['docId'],
                ':title' => $row['title'],
                ':icon' => $row['icon'] !== '' ? $row['icon'] : null,
                ':hpath' => $row['hPath'],
                ':parent_id' => $row['parentId'] !== '' ? $row['parentId'] : null,
                ':sort_index' => $row['sortIndex'],
                ':markdown' => $row['markdown'],
                ':sort_order' => $row['sortOrder'],
                ':size_bytes' => $row['size'],
                ':content_hash' => normalize_hash_hex($row['contentHash'] ?? ''),
                ':meta_hash' => normalize_hash_hex($row['metaHash'] ?? ''),
                ':created_at' => now(),
                ':updated_at' => now(),
            ]);
        }

        $actualAssets = handle_asset_uploads($shareId, $entries);
        $finalSize = $docSizeTotal + $actualAssets;
        $stmt = $pdo->prepare('UPDATE shares SET size_bytes = :size_bytes, updated_at = :updated_at WHERE id = :id');
        $stmt->execute([
            ':size_bytes' => $finalSize,
            ':updated_at' => now(),
            ':id' => $shareId,
        ]);
        recalculate_user_storage((int)$user['id']);

        api_response(200, ['share' => [
            'id' => $shareId,
            'slug' => $slug,
            'url' => share_url($slug),
        ]]);
    }

    if ($path === '/api/v1/shares/notebook') {
        $metaRaw = $_POST['metadata'] ?? '';
        if (!$metaRaw) {
            $metaRaw = json_encode(parse_json_body());
        }
        $meta = json_decode($metaRaw, true);
        if (!is_array($meta)) {
            api_response(400, null, '数据格式错误');
        }
        $notebookId = trim((string)($meta['notebookId'] ?? ''));
        $title = trim((string)($meta['title'] ?? ''));
        $docs = $meta['docs'] ?? [];
        $password = trim((string)($meta['password'] ?? ''));
        $clearPassword = !empty($meta['clearPassword']);
        $expiresAt = parse_expires_at($meta['expiresAt'] ?? null);
        $clearExpires = !empty($meta['clearExpires']);
        $visitorLimit = parse_visitor_limit($meta['visitorLimit'] ?? null);
        $clearVisitorLimit = !empty($meta['clearVisitorLimit']);
        if ($notebookId === '' || !is_array($docs) || count($docs) === 0) {
            api_response(400, null, '缺少笔记本 ID 或文档数据');
        }

        $slug = parse_requested_share_slug_or_fail($meta['slug'] ?? '');
        $paths = $_POST['assetPaths'] ?? [];
        $docIds = $_POST['assetDocIds'] ?? [];
        $paths = is_array($paths) ? $paths : [$paths];
        $docIds = is_array($docIds) ? $docIds : [$docIds];
        $entries = [];
        if (!empty($_FILES['assets'])) {
            $entries = collect_asset_entries($_FILES['assets'], $paths, $docIds);
        }
        $assetSize = 0;
        foreach ($entries as $entry) {
            $assetSize += (int)($entry['size'] ?? 0);
        }
        $docRows = [];
        $docSizeTotal = 0;
        foreach ($docs as $index => $doc) {
            $docId = trim((string)($doc['docId'] ?? ''));
            $docTitle = trim((string)($doc['title'] ?? ''));
            $docIcon = trim((string)($doc['icon'] ?? ''));
            $docHpath = (string)($doc['hPath'] ?? '');
            $docMarkdown = (string)($doc['markdown'] ?? '');
            $docSort = max(0, (int)($doc['sortOrder'] ?? $index));
            $docParent = trim((string)($doc['parentId'] ?? ''));
            $docSortIndex = (float)($doc['sortIndex'] ?? $index);
            if ($docId === '') {
                continue;
            }
            $size = strlen($docMarkdown);
            $docContentHash = compute_doc_content_hash($docMarkdown);
            $docMetaHash = compute_doc_meta_hash([
                'title' => $docTitle ?: $docId,
                'icon' => $docIcon,
                'hPath' => $docHpath,
                'parentId' => $docParent,
                'sortIndex' => $docSortIndex,
                'sortOrder' => $docSort,
            ]);
            $docSizeTotal += $size;
            $docRows[] = [
                'docId' => $docId,
                'title' => $docTitle ?: $docId,
                'icon' => $docIcon,
                'hPath' => $docHpath,
                'parentId' => $docParent,
                'sortIndex' => $docSortIndex,
                'markdown' => $docMarkdown,
                'sortOrder' => $docSort,
                'size' => $size,
                'contentHash' => $docContentHash,
                'metaHash' => $docMetaHash,
            ];
        }
        if (empty($docRows)) {
            api_response(400, null, '没有可用的文档');
        }
        $baseShareSize = $docSizeTotal + $assetSize;
        $stmt = $pdo->prepare('SELECT * FROM shares WHERE user_id = :uid AND type = "notebook" AND notebook_id = :nid ORDER BY id DESC LIMIT 1');
        $stmt->execute([':uid' => $user['id'], ':nid' => $notebookId]);
        $existing = $stmt->fetch(PDO::FETCH_ASSOC) ?: null;
        $existingSize = $existing ? (int)($existing['size_bytes'] ?? 0) : 0;
        $newShareSize = $baseShareSize;
        $used = recalculate_user_storage((int)$user['id']);
        $limit = get_user_limit_bytes($user);
        $usedWithout = max(0, $used - $existingSize);
        if ($limit > 0 && ($usedWithout + $newShareSize) > $limit) {
            api_response(413, null, '存储空间不足，请清理后重试');
        }

        $passwordHash = $existing['password_hash'] ?? null;
        $expiresValue = isset($existing['expires_at']) ? (int)$existing['expires_at'] : null;
        $visitorValue = isset($existing['visitor_limit']) ? (int)$existing['visitor_limit'] : 0;
        if ($clearPassword) {
            $passwordHash = null;
        } elseif ($password !== '') {
            $passwordHash = password_hash($password, PASSWORD_DEFAULT);
        }
        if ($clearExpires) {
            $expiresValue = null;
        } elseif ($expiresAt !== null) {
            $expiresValue = $expiresAt;
        }
        if ($clearVisitorLimit) {
            $visitorValue = 0;
        } elseif ($visitorLimit !== null) {
            $visitorValue = $visitorLimit;
        }

        if ($existing) {
            if ($slug && $slug !== $existing['slug']) {
                ensure_share_slug_available_or_fail($pdo, $slug, (int)$existing['id']);
            }
            $newSlug = $slug ?: $existing['slug'];
            $stmt = $pdo->prepare('UPDATE shares SET title = :title, slug = :slug, password_hash = :password_hash, expires_at = :expires_at, visitor_limit = :visitor_limit, updated_at = :updated_at, deleted_at = NULL WHERE id = :id');
            $stmt->execute([
                ':title' => $title ?: $existing['title'],
                ':slug' => $newSlug,
                ':password_hash' => $passwordHash,
                ':expires_at' => $expiresValue,
                ':visitor_limit' => $visitorValue,
                ':updated_at' => now(),
                ':id' => $existing['id'],
            ]);
            $shareId = (int)$existing['id'];
            $slug = $newSlug;
        } else {
            if (!$slug) {
                $slug = allocate_random_share_slug_or_fail($pdo);
            } else {
                ensure_share_slug_available_or_fail($pdo, $slug);
            }
            $shareId = allocate_share_id($pdo);
            if ($shareId > 0) {
                $stmt = $pdo->prepare('INSERT INTO shares (id, user_id, type, slug, title, notebook_id, password_hash, expires_at, visitor_limit, created_at, updated_at)
                    VALUES (:id, :uid, "notebook", :slug, :title, :notebook_id, :password_hash, :expires_at, :visitor_limit, :created_at, :updated_at)');
                $stmt->execute([
                    ':id' => $shareId,
                    ':uid' => $user['id'],
                    ':slug' => $slug,
                    ':title' => $title ?: $notebookId,
                    ':notebook_id' => $notebookId,
                    ':password_hash' => $passwordHash,
                    ':expires_at' => $expiresValue,
                    ':visitor_limit' => $visitorValue,
                    ':created_at' => now(),
                    ':updated_at' => now(),
                ]);
            } else {
                $stmt = $pdo->prepare('INSERT INTO shares (user_id, type, slug, title, notebook_id, password_hash, expires_at, visitor_limit, created_at, updated_at)
                    VALUES (:uid, "notebook", :slug, :title, :notebook_id, :password_hash, :expires_at, :visitor_limit, :created_at, :updated_at)');
                $stmt->execute([
                    ':uid' => $user['id'],
                    ':slug' => $slug,
                    ':title' => $title ?: $notebookId,
                    ':notebook_id' => $notebookId,
                    ':password_hash' => $passwordHash,
                    ':expires_at' => $expiresValue,
                    ':visitor_limit' => $visitorValue,
                    ':created_at' => now(),
                    ':updated_at' => now(),
                ]);
                $shareId = (int)$pdo->lastInsertId();
            }
        }

        if ($existing) {
            purge_share_assets($shareId);
        }

        $pdo->prepare('DELETE FROM share_docs WHERE share_id = :share_id')->execute([':share_id' => $shareId]);
        $stmt = $pdo->prepare('INSERT INTO share_docs (share_id, doc_id, title, icon, hpath, parent_id, sort_index, markdown, sort_order, size_bytes, content_hash, meta_hash, created_at, updated_at)
            VALUES (:share_id, :doc_id, :title, :icon, :hpath, :parent_id, :sort_index, :markdown, :sort_order, :size_bytes, :content_hash, :meta_hash, :created_at, :updated_at)');
        foreach ($docRows as $row) {
            $stmt->execute([
                ':share_id' => $shareId,
                ':doc_id' => $row['docId'],
                ':title' => $row['title'],
                ':icon' => $row['icon'] !== '' ? $row['icon'] : null,
                ':hpath' => $row['hPath'],
                ':parent_id' => $row['parentId'] !== '' ? $row['parentId'] : null,
                ':sort_index' => $row['sortIndex'],
                ':markdown' => $row['markdown'],
                ':sort_order' => (int)$row['sortOrder'],
                ':size_bytes' => $row['size'],
                ':content_hash' => normalize_hash_hex($row['contentHash'] ?? ''),
                ':meta_hash' => normalize_hash_hex($row['metaHash'] ?? ''),
                ':created_at' => now(),
                ':updated_at' => now(),
            ]);
        }

        $actualAssets = handle_asset_uploads($shareId, $entries);
        $finalSize = $docSizeTotal + $actualAssets;
        $stmt = $pdo->prepare('UPDATE shares SET size_bytes = :size_bytes, updated_at = :updated_at WHERE id = :id');
        $stmt->execute([
            ':size_bytes' => $finalSize,
            ':updated_at' => now(),
            ':id' => $shareId,
        ]);
        recalculate_user_storage((int)$user['id']);

        api_response(200, ['share' => [
            'id' => $shareId,
            'slug' => $slug,
            'url' => share_url($slug),
        ]]);
    }

    api_response(404, null, '接口不存在');
}

function rewrite_asset_links(string $markdown, string $assetBase = ''): string {
    $prefix = $assetBase;
    if ($prefix !== '' && substr($prefix, -1) !== '/') {
        $prefix .= '/';
    }
    $markdown = str_replace('](/assets/', '](' . $prefix . 'assets/', $markdown);
    $markdown = str_replace('](./assets/', '](' . $prefix . 'assets/', $markdown);
    $markdown = str_replace('](assets/', '](' . $prefix . 'assets/', $markdown);
    $markdown = str_replace('](<assets/', '](<' . $prefix . 'assets/', $markdown);
    $markdown = str_replace('](</assets/', '](<' . $prefix . 'assets/', $markdown);
    $markdown = str_replace('src="/assets/', 'src="' . $prefix . 'assets/', $markdown);
    $markdown = str_replace('src="./assets/', 'src="' . $prefix . 'assets/', $markdown);
    $markdown = str_replace('src="assets/', 'src="' . $prefix . 'assets/', $markdown);
    $markdown = str_replace('href="/assets/', 'href="' . $prefix . 'assets/', $markdown);
    $markdown = str_replace('href="./assets/', 'href="' . $prefix . 'assets/', $markdown);
    $markdown = str_replace('href="assets/', 'href="' . $prefix . 'assets/', $markdown);
    $markdown = str_replace('](/emojis/', '](' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('](./emojis/', '](' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('](emojis/', '](' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('](<emojis/', '](<' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('](</emojis/', '](<' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('src="/emojis/', 'src="' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('src="./emojis/', 'src="' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('src="emojis/', 'src="' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('href="/emojis/', 'href="' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('href="./emojis/', 'href="' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('href="emojis/', 'href="' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('](/emojis/', '](' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('](./emojis/', '](' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('](emojis/', '](' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('src="/emojis/', 'src="' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('src="./emojis/', 'src="' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('src="emojis/', 'src="' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('href="/emojis/', 'href="' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('href="./emojis/', 'href="' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('href="emojis/', 'href="' . $prefix . 'emojis/', $markdown);
    return $markdown;
}

function encode_path_segments(string $path): string {
    $parts = explode('/', $path);
    $encoded = array_map(static fn($part) => rawurlencode($part), $parts);
    return implode('/', $encoded);
}

function sanitize_emoji_token_name(string $token): string {
    $token = trim($token);
    if ($token === '' || $token[0] !== ':' || substr($token, -1) !== ':') {
        return '';
    }
    $name = trim(substr($token, 1, -1));
    if ($name === '' || strpos($name, "\n") !== false || strpos($name, "\r") !== false) {
        return '';
    }
    if (strpos($name, ':') !== false) {
        return '';
    }
    return $name;
}

function normalize_emoji_key(string $name): string {
    $value = strtolower(trim($name));
    if ($value === '') {
        return '';
    }
    $normalized = preg_replace('/[\s_-]+/', '', $value);
    return $normalized ?? '';
}

function resolve_custom_emoji_src(string $name, int $shareId, string $assetBasePath): string {
    global $config;
    static $cache = [];
    $key = $shareId . '|' . $name;
    if (isset($cache[$key])) {
        return $cache[$key];
    }
    $clean = str_replace('\\', '/', $name);
    $clean = ltrim($clean, '/');
    if ($clean === '' || strpos($clean, '..') !== false) {
        $cache[$key] = '';
        return '';
    }
    $decoded = rawurldecode($clean);
    $candidates = [$clean];
    if ($decoded !== '' && $decoded !== $clean) {
        $candidates[] = $decoded;
    }
    $compact = preg_replace('/\s+/', '', $clean);
    if ($compact !== $clean && $compact !== '') {
        $candidates[] = $compact;
    }
    $extensions = ['svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];
    $uploadsDir = (string)($config['uploads_dir'] ?? (__DIR__ . '/uploads'));
    $uploadsDir = rtrim($uploadsDir, '/\\');
    $fsBase = $uploadsDir . '/shares/' . $shareId . '/emojis/';
    foreach ($candidates as $candidate) {
        $hasExt = (bool)preg_match('/\.(svg|png|jpe?g|gif|webp|bmp)$/i', $candidate);
        $names = $hasExt ? [$candidate] : array_merge([$candidate], array_map(
            static fn($ext) => $candidate . '.' . $ext,
            $extensions
        ));
        foreach ($names as $file) {
            $fsPath = $fsBase . $file;
            if (is_file($fsPath)) {
                $rel = 'emojis/' . $file;
                $cache[$key] = $assetBasePath . encode_path_segments($rel);
                return $cache[$key];
            }
        }
    }
    $index = build_share_emoji_index($shareId, $uploadsDir);
    if (!empty($index)) {
        $normalizedIndex = [];
        foreach ($index as $nameKey => $rel) {
            $norm = normalize_emoji_key($nameKey);
            if ($norm !== '' && !isset($normalizedIndex[$norm])) {
                $normalizedIndex[$norm] = $rel;
            }
        }
        foreach ($candidates as $candidate) {
            if (isset($index[$candidate])) {
                $cache[$key] = $assetBasePath . encode_path_segments($index[$candidate]);
                return $cache[$key];
            }
            $lower = strtolower($candidate);
            foreach ($index as $nameKey => $rel) {
                if (strtolower($nameKey) === $lower) {
                    $cache[$key] = $assetBasePath . encode_path_segments($rel);
                    return $cache[$key];
                }
            }
            foreach ($index as $nameKey => $rel) {
                if (str_starts_with($nameKey, $candidate . '-')) {
                    $cache[$key] = $assetBasePath . encode_path_segments($rel);
                    return $cache[$key];
                }
            }
            if (!empty($normalizedIndex)) {
                $normalized = normalize_emoji_key($candidate);
                if ($normalized !== '' && isset($normalizedIndex[$normalized])) {
                    $cache[$key] = $assetBasePath . encode_path_segments($normalizedIndex[$normalized]);
                    return $cache[$key];
                }
            }
        }
    }
    $cache[$key] = '';
    return '';
}

function build_share_emoji_index(int $shareId, string $uploadsDir): array {
    static $cache = [];
    $key = $uploadsDir . '|' . $shareId;
    if (isset($cache[$key])) {
        return $cache[$key];
    }
    $map = [];
    if ($shareId <= 0 || $uploadsDir === '') {
        $cache[$key] = $map;
        return $map;
    }
    $root = rtrim($uploadsDir, '/\\') . '/shares/' . $shareId . '/emojis';
    if (!is_dir($root)) {
        $cache[$key] = $map;
        return $map;
    }
    try {
        $iterator = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS)
        );
        foreach ($iterator as $file) {
            if (!$file->isFile()) {
                continue;
            }
            $fullPath = str_replace('\\', '/', $file->getPathname());
            if (!preg_match('/\.(svg|png|jpe?g|gif|webp|bmp)$/i', $fullPath)) {
                continue;
            }
            $relative = substr($fullPath, strlen(rtrim($root, '/\\')) + 1);
            if ($relative === false || $relative === '') {
                continue;
            }
            $relative = ltrim(str_replace('\\', '/', $relative), '/');
            $name = preg_replace('/\.(svg|png|jpe?g|gif|webp|bmp)$/i', '', $relative);
            if ($name === '') {
                continue;
            }
            $map[$name] = 'emojis/' . $relative;
            $baseName = basename($name);
            if ($baseName !== '' && !isset($map[$baseName])) {
                $map[$baseName] = 'emojis/' . $relative;
            }
        }
    } catch (Throwable $err) {
        // ignore
    }
    try {
        $pdo = db();
        $stmt = $pdo->prepare('SELECT asset_path FROM share_assets WHERE share_id = :sid AND asset_path LIKE :prefix');
        $stmt->execute([
            ':sid' => $shareId,
            ':prefix' => 'emojis/%',
        ]);
        $rows = $stmt->fetchAll(PDO::FETCH_COLUMN);
        foreach ($rows as $path) {
            $path = sanitize_asset_path((string)$path);
            if ($path === '' || !str_starts_with($path, 'emojis/')) {
                continue;
            }
            $relative = substr($path, strlen('emojis/'));
            if ($relative === '' || substr($relative, -1) === '/') {
                continue;
            }
            $name = preg_replace('/\.(svg|png|jpe?g|gif|webp|bmp)$/i', '', $relative);
            if ($name === '' || isset($map[$name])) {
                continue;
            }
            $map[$name] = $path;
            $baseName = basename($name);
            if ($baseName !== '' && !isset($map[$baseName])) {
                $map[$baseName] = $path;
            }
        }
    } catch (Throwable $err) {
        // ignore
    }
    $cache[$key] = $map;
    return $map;
}

function get_fence_marker(string $text, int $index): string {
    $ch = $text[$index] ?? '';
    if ($ch !== '`' && $ch !== '~') {
        return '';
    }
    $marker = substr($text, $index, 3);
    if ($marker !== '```' && $marker !== '~~~') {
        return '';
    }
    $i = $index - 1;
    while ($i >= 0 && $text[$i] === ' ') {
        $i--;
    }
    if ($i >= 0 && $text[$i] !== "\n") {
        return '';
    }
    return $marker;
}

function get_emoji_token_name_at(string $text, int $index): string {
    $len = strlen($text);
    if ($index < 0 || $index >= $len) {
        return '';
    }
    if ($text[$index] !== ':') {
        return '';
    }
    $end = strpos($text, ':', $index + 1);
    if ($end === false || $end <= $index + 1) {
        return '';
    }
    return sanitize_emoji_token_name(substr($text, $index, $end - $index + 1));
}

function replace_custom_emoji_tokens(string $markdown, int $shareId, string $assetBasePath): string {
    $source = (string)$markdown;
    if ($source === '') {
        return $source;
    }
    $len = strlen($source);
    $out = '';
    $inFence = false;
    $fenceMarker = '';
    $inInline = false;
    $inTag = false;
    $i = 0;
    while ($i < $len) {
        $fence = $inTag ? '' : get_fence_marker($source, $i);
        if (!$inFence && $fence !== '') {
            $inFence = true;
            $fenceMarker = $fence;
            $out .= $fence;
            $i += 3;
            continue;
        }
        if ($inFence && $fence !== '' && $fence === $fenceMarker) {
            $inFence = false;
            $fenceMarker = '';
            $out .= $fence;
            $i += 3;
            continue;
        }
        $ch = $source[$i];
        if (!$inFence) {
            if ($ch === '<') {
                $next = $source[$i + 1] ?? '';
                if ($next === '!' || $next === '/' || ctype_alpha($next)) {
                    $inTag = true;
                    $out .= $ch;
                    $i++;
                    continue;
                }
            }
            if ($inTag) {
                $out .= $ch;
                if ($ch === '>') {
                    $inTag = false;
                }
                $i++;
                continue;
            }
            if ($ch === '`') {
                $inInline = !$inInline;
                $out .= $ch;
                $i++;
                continue;
            }
            if ($ch === "\n") {
                $inInline = false;
            }
            if (!$inInline && $ch === ':') {
                $end = strpos($source, ':', $i + 1);
                if ($end !== false && $end > $i + 1) {
                    $token = substr($source, $i, $end - $i + 1);
                    $name = sanitize_emoji_token_name($token);
                    if ($name !== '') {
                        $src = resolve_custom_emoji_src($name, $shareId, $assetBasePath);
                        if ($src !== '') {
                            $out .= '![](<';
                            $out .= $src;
                            $out .= '>)';
                            $nextName = get_emoji_token_name_at($source, $end + 1);
                            if ($nextName !== '') {
                                $nextSrc = resolve_custom_emoji_src($nextName, $shareId, $assetBasePath);
                                if ($nextSrc !== '') {
                                    $out .= ' ';
                                }
                            }
                            $i = $end + 1;
                            continue;
                        }
                    }
                    $out .= $token;
                    $i = $end + 1;
                    continue;
                }
            }
        }
        $out .= $ch;
        $i++;
    }
    return $out;
}

function insert_adjacent_emoji_image_spacing(string $markdown): string {
    $source = (string)$markdown;
    if ($source === '') {
        return $source;
    }
    return preg_replace(
        '/(!\[[^\]]*]\((?:<)?[^)\s]*emojis\/[^)\s>]+(?:>)?\))(?=!\[[^\]]*]\((?:<)?[^)\s]*emojis\/)/',
        '$1 ',
        $source,
    ) ?? $source;
}

function strip_duplicate_title_heading(string $markdown, string $title): string {
    $title = trim($title);
    if ($title === '') {
        return $markdown;
    }
    $lines = preg_split("/\r\n|\r|\n/", $markdown);
    if (!is_array($lines)) {
        return $markdown;
    }
    $count = count($lines);
    $idx = 0;
    while ($idx < $count && trim($lines[$idx]) === '') {
        $idx++;
    }
    if ($idx >= $count) {
        return $markdown;
    }
    $line = trim($lines[$idx]);
    $next = $idx + 1 < $count ? trim($lines[$idx + 1]) : '';
    $headingText = '';
    $removeLines = 0;
    if (preg_match('/^#{1,6}\s+(.*)$/', $line, $match)) {
        $headingText = trim($match[1]);
        $removeLines = 1;
    } elseif ($line === $title && $next !== '' && preg_match('/^=+$/', $next)) {
        $headingText = $line;
        $removeLines = 2;
    }
    if ($headingText === '' || $headingText !== $title) {
        return $markdown;
    }
    $start = $idx;
    $end = $idx + $removeLines;
    while ($end < $count && trim($lines[$end]) === '') {
        $end++;
    }
    array_splice($lines, $start, $end - $start);
    return implode("\n", $lines);
}

function share_style_is_dangerous(string $style): bool {
    $value = strtolower((string)$style);
    $compact = preg_replace('/[\x00-\x1f\x7f]+/u', '', $value);
    if (!is_string($compact)) {
        $compact = $value;
    }
    return (bool)preg_match('/expression\s*\(|javascript\s*:|vbscript\s*:|url\s*\(\s*[\'"]?\s*data\s*:\s*text\/html/i', $compact);
}

function is_safe_share_url(string $value, string $tag = '', string $attr = ''): bool {
    $raw = trim((string)$value);
    if ($raw === '') {
        return true;
    }
    $compact = preg_replace('/[\x00-\x20\x7f\s]+/u', '', $raw);
    if (!is_string($compact) || $compact === '') {
        $compact = $raw;
    }
    $tag = strtolower($tag);
    $attr = strtolower($attr);

    if (preg_match('/^(?:javascript|vbscript)\s*:/i', $compact)) {
        return false;
    }
    if (preg_match('/^data\s*:/i', $compact)) {
        if ($tag === 'img' && $attr === 'src') {
            return (bool)preg_match('/^data:image\/(?:png|gif|jpe?g|webp|bmp|avif);base64,[a-z0-9+\/=\r\n]+$/i', $compact);
        }
        return false;
    }
    if ($tag === 'iframe' && $attr === 'src') {
        if ($compact === '') {
            return true;
        }
        if (preg_match('/^(?:https?:)?\/\//i', $compact)) {
            return true;
        }
        if (str_starts_with($compact, '/') || str_starts_with($compact, './') || str_starts_with($compact, '../')) {
            return true;
        }
        if (preg_match('/^about:blank(?:[?#].*)?$/i', $compact)) {
            return true;
        }
        return false;
    }
    if ($compact[0] === '#') {
        return true;
    }
    if (str_starts_with($compact, '/') && !str_starts_with($compact, '//')) {
        return true;
    }
    if (str_starts_with($compact, './') || str_starts_with($compact, '../')) {
        return true;
    }
    if (str_starts_with($compact, '//')) {
        return true;
    }
    if (preg_match('/^[a-zA-Z][a-zA-Z0-9+.\-]*:/', $compact)) {
        return (bool)preg_match('/^(?:https?|mailto|tel):/i', $compact);
    }
    return true;
}

function sanitize_share_html(string $html): string {
    $source = (string)$html;
    if ($source === '') {
        return '';
    }
    if (!class_exists('DOMDocument')) {
        return htmlspecialchars($source, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    }

    $libxmlBackup = libxml_use_internal_errors(true);
    $dom = new DOMDocument('1.0', 'UTF-8');
    $wrapperId = '__sps_share_html_root__';
    $loaded = $dom->loadHTML(
        '<?xml encoding="UTF-8"><!doctype html><html><body><div id="' . $wrapperId . '">' . $source . '</div></body></html>',
        LIBXML_HTML_NOIMPLIED | LIBXML_HTML_NODEFDTD | LIBXML_NOERROR | LIBXML_NOWARNING,
    );
    libxml_clear_errors();
    libxml_use_internal_errors($libxmlBackup);
    if (!$loaded) {
        return htmlspecialchars($source, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    }

    $root = null;
    $xpath = new DOMXPath($dom);
    $rootNodes = $xpath->query('//*[@id="' . $wrapperId . '"]');
    if ($rootNodes && $rootNodes->length > 0 && $rootNodes->item(0) instanceof DOMElement) {
        $root = $rootNodes->item(0);
    }
    if (!$root) {
        return htmlspecialchars($source, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    }

    $blockedTags = ['script', 'object', 'embed', 'svg', 'math', 'base', 'meta', 'link'];
    $katexSvgAllowedTags = ['svg', 'path', 'line', 'g'];
    $katexSvgAllowedAttrs = [
        'svg' => ['class', 'style', 'xmlns', 'xmlns:xlink', 'width', 'height', 'viewbox', 'preserveaspectratio', 'role', 'aria-hidden', 'focusable'],
        'path' => ['class', 'style', 'd', 'fill', 'fill-rule', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity', 'transform', 'opacity'],
        'line' => ['class', 'style', 'x1', 'y1', 'x2', 'y2', 'fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity', 'transform', 'opacity'],
        'g' => ['class', 'style', 'transform', 'fill', 'fill-rule', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity', 'opacity'],
    ];
    $urlAttrs = ['href', 'src', 'xlink:href', 'formaction', 'action', 'poster'];
    $iframeAllowedAttrs = [
        'src',
        'width',
        'height',
        'title',
        'allow',
        'allowfullscreen',
        'loading',
        'referrerpolicy',
        'sandbox',
        'frameborder',
    ];

    $elements = [];
    foreach ($root->getElementsByTagName('*') as $node) {
        $elements[] = $node;
    }

    foreach ($elements as $element) {
        if (!($element instanceof DOMElement)) {
            continue;
        }

        $tag = strtolower($element->tagName);
        // Parsedown renders SiYuan's table-cell IAL as literal text.
        // Apply the alignment to the actual cell before HTML sanitization.
        if (($tag === 'th' || $tag === 'td') && $element->firstChild instanceof DOMText) {
            $firstText = $element->firstChild;
            $match = [];
            if (preg_match('/^[ \t]*\{:\s*style\s*=\s*"\s*text-align\s*:\s*(left|center|right)\s*;?\s*"\s*\}[ \t]*/i', $firstText->data, $match)) {
                $firstText->data = substr($firstText->data, strlen($match[0]));
                $element->setAttribute('style', 'text-align: ' . strtolower($match[1]) . ';');
            }
        }

        $insideSvg = false;
        $insideKatex = false;
        $cursor = $element;
        while ($cursor instanceof DOMElement) {
            if (strtolower($cursor->tagName) === 'svg') {
                $insideSvg = true;
            }
            if (preg_match('/(?:^|\s)katex(?:\s|$)/i', (string)$cursor->getAttribute('class'))) {
                $insideKatex = true;
            }
            $parent = $cursor->parentNode;
            $cursor = $parent instanceof DOMElement ? $parent : null;
        }
        $isKatexSvgNode = $insideSvg && $insideKatex && in_array($tag, $katexSvgAllowedTags, true);
        if (in_array($tag, $blockedTags, true)) {
            if (!($tag === 'svg' && $isKatexSvgNode)) {
                if ($element->parentNode) {
                    $element->parentNode->removeChild($element);
                }
                continue;
            }
        } elseif ($insideSvg && !$isKatexSvgNode) {
            if ($element->parentNode) {
                $element->parentNode->removeChild($element);
            }
            continue;
        }

        $attrNames = [];
        if ($element->hasAttributes()) {
            foreach ($element->attributes as $attribute) {
                $attrNames[] = $attribute->name;
            }
        }
        $allowedSvgAttrs = $isKatexSvgNode ? ($katexSvgAllowedAttrs[$tag] ?? []) : [];

        foreach ($attrNames as $attrNameRaw) {
            $attrName = strtolower($attrNameRaw);
            $attrValue = (string)$element->getAttribute($attrNameRaw);

            if (str_starts_with($attrName, 'on')) {
                $element->removeAttribute($attrNameRaw);
                continue;
            }
            if ($attrName === 'srcdoc') {
                $element->removeAttribute($attrNameRaw);
                continue;
            }
            if ($isKatexSvgNode && !in_array($attrName, $allowedSvgAttrs, true)) {
                $element->removeAttribute($attrNameRaw);
                continue;
            }
            if ($attrName === 'style' && share_style_is_dangerous($attrValue)) {
                $element->removeAttribute($attrNameRaw);
                continue;
            }
            if ($isKatexSvgNode) {
                continue;
            }
            if ($tag === 'iframe' && !in_array($attrName, $iframeAllowedAttrs, true)) {
                $element->removeAttribute($attrNameRaw);
                continue;
            }
            if (in_array($attrName, $urlAttrs, true) && !is_safe_share_url($attrValue, $tag, $attrName)) {
                $element->removeAttribute($attrNameRaw);
            }
        }

        if ($tag === 'iframe') {
            $iframeSrc = trim((string)$element->getAttribute('src'));
            if ($iframeSrc !== '' && !is_safe_share_url($iframeSrc, 'iframe', 'src')) {
                if ($element->parentNode) {
                    $element->parentNode->removeChild($element);
                }
            }
        }
    }

    $output = '';
    foreach ($root->childNodes as $child) {
        $rendered = $dom->saveHTML($child);
        if (is_string($rendered)) {
            $output .= $rendered;
        }
    }

    return $output;
}

function render_markdown(string $markdown): string {
    static $parser = null;
    if (!$parser) {
        $parser = new Parsedown();
        if (method_exists($parser, 'setSafeMode')) {
            $parser->setSafeMode(false);
        }
    }
    return sanitize_share_html($parser->text($markdown));
}

function share_requires_password(array $share): bool {
    return !empty($share['password_hash']);
}

function share_is_expired(array $share): bool {
    if (empty($share['expires_at'])) {
        return false;
    }
    return time() > (int)$share['expires_at'];
}

function share_password_hash_by_id(int $shareId): string {
    static $cache = [];
    if ($shareId <= 0) {
        return '';
    }
    if (array_key_exists($shareId, $cache)) {
        return (string)$cache[$shareId];
    }
    $pdo = db();
    $stmt = $pdo->prepare('SELECT password_hash FROM shares WHERE id = :id AND deleted_at IS NULL LIMIT 1');
    $stmt->execute([':id' => $shareId]);
    $value = $stmt->fetchColumn();
    $hash = is_string($value) ? trim($value) : '';
    $cache[$shareId] = $hash;
    return $hash;
}

function share_access_signature(string $passwordHash): string {
    $raw = trim($passwordHash);
    if ($raw === '') {
        return '';
    }
    return hash('sha256', $raw);
}

function share_access_granted(int $shareId): bool {
    if ($shareId <= 0) {
        return false;
    }
    $entry = $_SESSION['share_access'][$shareId] ?? null;
    if (empty($entry)) {
        return false;
    }
    $passwordHash = share_password_hash_by_id($shareId);
    if ($passwordHash === '') {
        // No password now: old session entries are irrelevant.
        return true;
    }
    $expected = share_access_signature($passwordHash);
    if ($expected === '') {
        return false;
    }
    if ($entry === true) {
        // Legacy boolean session format; force one re-verification for protected shares.
        return false;
    }
    if (is_string($entry) && $entry !== '') {
        return hash_equals($expected, $entry);
    }
    if (is_array($entry)) {
        $token = trim((string)($entry['token'] ?? ''));
        if ($token !== '') {
            return hash_equals($expected, $token);
        }
    }
    return false;
}

function grant_share_access(int $shareId): void {
    if ($shareId <= 0) {
        return;
    }
    if (!isset($_SESSION['share_access']) || !is_array($_SESSION['share_access'])) {
        $_SESSION['share_access'] = [];
    }
    $passwordHash = share_password_hash_by_id($shareId);
    if ($passwordHash === '') {
        $_SESSION['share_access'][$shareId] = true;
        return;
    }
    $_SESSION['share_access'][$shareId] = share_access_signature($passwordHash);
}

function share_visitor_limit(array $share): int {
    return max(0, (int)($share['visitor_limit'] ?? 0));
}

function share_visitor_count(int $shareId): int {
    if ($shareId <= 0) {
        return 0;
    }
    $pdo = db();
    $stmt = $pdo->prepare('SELECT COUNT(*) FROM share_visitors WHERE share_id = :sid');
    $stmt->execute([':sid' => $shareId]);
    return (int)$stmt->fetchColumn();
}

function share_visitor_limit_reached(array $share): bool {
    $limit = share_visitor_limit($share);
    if ($limit <= 0) {
        return false;
    }
    $shareId = (int)($share['id'] ?? 0);
    if ($shareId <= 0) {
        return false;
    }
    $visitorId = get_visitor_id();
    $pdo = db();
    if ($visitorId !== '') {
        $stmt = $pdo->prepare('SELECT 1 FROM share_visitors WHERE share_id = :sid AND visitor_id = :vid LIMIT 1');
        $stmt->execute([
            ':sid' => $shareId,
            ':vid' => $visitorId,
        ]);
        if ($stmt->fetchColumn()) {
            return false;
        }
    }
    $stmt = $pdo->prepare('SELECT COUNT(*) FROM share_visitors WHERE share_id = :sid');
    $stmt->execute([':sid' => $shareId]);
    return (int)$stmt->fetchColumn() >= $limit;
}

function register_share_visitor(int $shareId, string $visitorId): void {
    if ($shareId <= 0 || $visitorId === '') {
        return;
    }
    $pdo = db();
    $pdo->prepare('INSERT OR IGNORE INTO share_visitors (share_id, visitor_id, created_at)
        VALUES (:sid, :vid, :created_at)')->execute([
        ':sid' => $shareId,
        ':vid' => $visitorId,
        ':created_at' => now(),
    ]);
}

function share_inline_asset_extensions(): array {
    return [
        // Images
        'apng',
        'avif',
        'bmp',
        'gif',
        'ico',
        'jpg',
        'jpeg',
        'jxl',
        'png',
        'svg',
        'tif',
        'tiff',
        'webp',
        // Audio
        'aac',
        'flac',
        'm4a',
        'mp3',
        'oga',
        'wav',
        'ogg',
        'opus',
        'weba',
        // Video
        'avi',
        'm4v',
        'mkv',
        'mov',
        'mp4',
        'ogv',
        'webm',
        // Text / documents
        'csv',
        'json',
        'log',
        'srt',
        'txt',
        'md',
        'pdf',
        'vtt',
        'xml',
        'yaml',
        'yml',
    ];
}

function share_executable_asset_extensions(): array {
    return [
        'bat',
        'cgi',
        'cmd',
        'com',
        'cpl',
        'dll',
        'exe',
        'hta',
        'htm',
        'html',
        'jar',
        'js',
        'jse',
        'mjs',
        'msi',
        'php',
        'php3',
        'php4',
        'php5',
        'php7',
        'php8',
        'phar',
        'phtml',
        'pl',
        'ps1',
        'psd1',
        'psm1',
        'py',
        'rb',
        'scr',
        'sh',
        'ts',
        'tsx',
        'vb',
        'vbe',
        'vbs',
        'wsf',
        'wsh',
        'xhtml',
    ];
}

function share_asset_is_executable(string $assetPath): bool {
    $ext = share_asset_extension($assetPath);
    if ($ext === '') {
        return false;
    }
    return in_array($ext, share_executable_asset_extensions(), true);
}

function share_asset_extension(string $assetPath): string {
    $ext = strtolower((string)pathinfo($assetPath, PATHINFO_EXTENSION));
    return $ext !== '' ? $ext : '';
}

function share_asset_allow_inline(string $assetPath): bool {
    if (share_asset_is_executable($assetPath)) {
        return false;
    }
    $ext = share_asset_extension($assetPath);
    if ($ext === '') {
        return false;
    }
    return in_array($ext, share_inline_asset_extensions(), true);
}

function detect_share_asset_mime(string $fullPath, string $assetPath): string {
    $ext = share_asset_extension($assetPath);
    $map = [
        'csv' => 'text/csv; charset=UTF-8',
        'json' => 'application/json; charset=UTF-8',
        'log' => 'text/plain; charset=UTF-8',
        'srt' => 'text/plain; charset=UTF-8',
        'txt' => 'text/plain; charset=UTF-8',
        'md' => 'text/markdown; charset=UTF-8',
        'vtt' => 'text/vtt; charset=UTF-8',
        'xml' => 'application/xml; charset=UTF-8',
        'yaml' => 'text/yaml; charset=UTF-8',
        'yml' => 'text/yaml; charset=UTF-8',
        'pdf' => 'application/pdf',
        'apng' => 'image/apng',
        'jpg' => 'image/jpeg',
        'jpeg' => 'image/jpeg',
        'png' => 'image/png',
        'gif' => 'image/gif',
        'ico' => 'image/x-icon',
        'jxl' => 'image/jxl',
        'svg' => 'image/svg+xml',
        'tif' => 'image/tiff',
        'tiff' => 'image/tiff',
        'webp' => 'image/webp',
        'bmp' => 'image/bmp',
        'avif' => 'image/avif',
        'aac' => 'audio/aac',
        'flac' => 'audio/flac',
        'm4a' => 'audio/mp4',
        'mp3' => 'audio/mpeg',
        'wav' => 'audio/wav',
        'oga' => 'audio/ogg',
        'ogg' => 'audio/ogg',
        'opus' => 'audio/ogg',
        'weba' => 'audio/webm',
        'avi' => 'video/x-msvideo',
        'm4v' => 'video/mp4',
        'mkv' => 'video/x-matroska',
        'mov' => 'video/quicktime',
        'mp4' => 'video/mp4',
        'ogv' => 'video/ogg',
        'webm' => 'video/webm',
    ];
    $fallback = $map[$ext] ?? 'application/octet-stream';
    if (function_exists('finfo_open')) {
        $finfo = @finfo_open(FILEINFO_MIME_TYPE);
        if ($finfo) {
            $detected = (string)@finfo_file($finfo, $fullPath);
            @finfo_close($finfo);
            if ($detected !== '' && strtolower($detected) !== 'application/octet-stream') {
                return $detected;
            }
        }
    }
    return $fallback;
}

function render_share_asset_not_found(): void {
    http_response_code(404);
    header('Content-Type: text/plain; charset=UTF-8');
    echo 'Resource not found';
    exit;
}

function build_share_asset_public_path(array $share, string $assetPath): string {
    $shareId = (int)($share['id'] ?? 0);
    $assetPath = sanitize_asset_path($assetPath);
    if ($shareId <= 0 || $assetPath === '') {
        return '';
    }
    if (str_starts_with($assetPath, 'comment-files/')) {
        return '/uploads/' . $assetPath;
    }
    return '/uploads/shares/' . $shareId . '/' . $assetPath;
}

function resolve_asset_resume_redirect_path(array $share): string {
    $raw = trim((string)($_GET['asset'] ?? ''));
    if ($raw === '') {
        return '';
    }
    $shareId = (int)($share['id'] ?? 0);
    if ($shareId <= 0) {
        return '';
    }
    $assetPath = sanitize_asset_path(rawurldecode($raw));
    if ($assetPath === '') {
        return '';
    }
    $asset = find_share_asset_row($shareId, $assetPath);
    if (!$asset) {
        return '';
    }
    return build_share_asset_public_path($share, $assetPath);
}

function redirect_to_share_page(array $share, string $assetPath = ''): void {
    $slug = trim((string)($share['slug'] ?? ''));
    if ($slug === '') {
        render_share_asset_not_found();
    }
    $path = '/s/' . rawurlencode($slug);
    $cleanAsset = sanitize_asset_path($assetPath);
    if ($cleanAsset !== '') {
        $path .= '?asset=' . rawurlencode($cleanAsset);
    }
    redirect($path);
}

function serve_share_asset(array $share, string $assetPath): void {
    global $config;
    $shareId = (int)($share['id'] ?? 0);
    if ($shareId <= 0) {
        render_share_asset_not_found();
    }
    $assetPath = sanitize_asset_path(rawurldecode($assetPath));
    if ($assetPath === '') {
        render_share_asset_not_found();
    }
    if (share_is_expired($share) || share_visitor_limit_reached($share)) {
        redirect_to_share_page($share, $assetPath);
    }
    if (share_requires_password($share) && !share_access_granted($shareId)) {
        redirect_to_share_page($share, $assetPath);
    }
    if (share_visitor_limit($share) > 0) {
        register_share_visitor($shareId, get_visitor_id());
    }
    $asset = find_share_asset_row($shareId, $assetPath);
    if (!$asset) {
        render_share_asset_not_found();
    }
    $filePath = sanitize_asset_path((string)($asset['file_path'] ?? ''));
    if ($filePath === '') {
        render_share_asset_not_found();
    }
    $uploadsDir = rtrim((string)($config['uploads_dir'] ?? (__DIR__ . '/uploads')), '/\\');
    $fullPath = $uploadsDir . '/' . ltrim($filePath, '/');
    if (!is_file($fullPath) || !is_readable($fullPath)) {
        render_share_asset_not_found();
    }
    $inline = share_asset_allow_inline($assetPath);
    $mime = $inline ? detect_share_asset_mime($fullPath, $assetPath) : 'application/octet-stream';
    $disposition = $inline ? 'inline' : 'attachment';
    $filename = basename($assetPath);
    if ($filename === '' || $filename === '.' || $filename === '..') {
        $filename = 'download.bin';
    }
    $escapedFilename = str_replace(
        ['\\', '"', "\r", "\n"],
        ['\\\\', '\\"', '', ''],
        $filename
    );
    $size = @filesize($fullPath);
    header('Content-Type: ' . $mime);
    header('X-Content-Type-Options: nosniff');
    header('Content-Disposition: ' . $disposition . '; filename="' . $escapedFilename . '"; filename*=UTF-8\'\'' . rawurlencode($filename));
    header('Cache-Control: private, max-age=3600');
    header('Accept-Ranges: bytes');
    if (is_int($size) && $size >= 0) {
        header('Content-Length: ' . (string)$size);
    }
    @readfile($fullPath);
    exit;
}

function parse_legacy_upload_asset_request(string $path): ?array {
    $normalized = ltrim(str_replace('\\', '/', $path), '/');
    if ($normalized === '' || !str_starts_with($normalized, 'uploads/')) {
        return null;
    }
    $relative = substr($normalized, strlen('uploads/'));
    if (!is_string($relative) || $relative === '') {
        return null;
    }
    if (preg_match('#^shares/(\d+)/(.*)$#', $relative, $matches)) {
        $shareId = (int)($matches[1] ?? 0);
        $assetSuffix = rawurldecode((string)($matches[2] ?? ''));
        $assetPath = sanitize_asset_path($assetSuffix);
        if ($shareId > 0 && $assetPath !== '') {
            return [
                'shareId' => $shareId,
                'assetPath' => $assetPath,
            ];
        }
    }
    // Legacy note attachments can still use this old upload layout.
    $legacyPrefix = 'comment-files';
    if ($legacyPrefix !== '' && preg_match('#^' . preg_quote($legacyPrefix, '#') . '/(\d+)/(.*)$#', $relative, $matches)) {
        $shareId = (int)($matches[1] ?? 0);
        $assetSuffix = rawurldecode((string)($matches[2] ?? ''));
        $assetPath = sanitize_asset_path($legacyPrefix . '/' . $shareId . '/' . $assetSuffix);
        if ($shareId > 0 && $assetPath !== '') {
            return [
                'shareId' => $shareId,
                'assetPath' => $assetPath,
            ];
        }
    }
    return null;
}

function handle_share_asset_request(string $slug, string $assetPath): void {
    $share = find_share_by_slug($slug);
    if (!$share) {
        render_share_asset_not_found();
    }
    serve_share_asset($share, $assetPath);
}

function handle_legacy_upload_asset_request(string $path): void {
    $parsed = parse_legacy_upload_asset_request($path);
    if (!$parsed) {
        render_share_asset_not_found();
    }
    $shareId = (int)($parsed['shareId'] ?? 0);
    $assetPath = (string)($parsed['assetPath'] ?? '');
    $share = find_share_by_id($shareId);
    if (!$share) {
        render_share_asset_not_found();
    }
    serve_share_asset($share, $assetPath);
}

function build_doc_tree(array $docs, ?string $activeId = null): array {
    $useParent = false;
    foreach ($docs as $doc) {
        if (isset($doc['parent_id']) && trim((string)$doc['parent_id']) !== '') {
            $useParent = true;
            break;
        }
    }
    if ($useParent) {
        $nodes = [];
        foreach ($docs as $docIndex => $doc) {
            $docId = trim((string)($doc['doc_id'] ?? ''));
            if ($docId === '') {
                continue;
            }
            $nodes[$docId] = [
                'title' => (string)($doc['title'] ?? $docId),
                'children' => [],
                'doc' => $doc,
                'contains_active' => false,
                'order' => is_numeric($doc['sort_index'] ?? null) ? (float)$doc['sort_index'] : $docIndex,
                'order_index' => $docIndex,
            ];
        }
        $tree = [];
        foreach ($nodes as $docId => &$node) {
            $parentId = trim((string)($node['doc']['parent_id'] ?? ''));
            if ($parentId !== '' && isset($nodes[$parentId]) && $parentId !== $docId) {
                $nodes[$parentId]['children'][$docId] =& $node;
            } else {
                $tree[$docId] =& $node;
            }
        }
        unset($node);
        mark_doc_tree_active($tree, $activeId);
        sort_doc_tree($tree);
        return $tree;
    }
    $root = ['children' => []];
    foreach ($docs as $docIndex => $doc) {
        $hpath = trim((string)($doc['hpath'] ?? ''), '/');
        $parts = $hpath !== '' ? array_values(array_filter(explode('/', $hpath))) : [];
        if (empty($parts)) {
            $parts = [trim((string)($doc['title'] ?? '')) ?: trim((string)($doc['doc_id'] ?? ''))];
        }
        $docOrder = isset($doc['sort_order']) ? (int)$doc['sort_order'] : $docIndex;
        $docOrderIndex = $docIndex;
        $node =& $root['children'];
        foreach ($parts as $idx => $part) {
            $isLast = $idx === count($parts) - 1;
            $key = $part;
            if (!isset($node[$key])) {
                $node[$key] = [
                    'title' => $part,
                    'children' => [],
                    'doc' => null,
                    'contains_active' => false,
                    'order' => $docOrder,
                    'order_index' => $docOrderIndex,
                ];
            } else {
                $existingOrder = $node[$key]['order'] ?? $docOrder;
                $existingIndex = $node[$key]['order_index'] ?? $docOrderIndex;
                if ($docOrder < $existingOrder || ($docOrder === $existingOrder && $docOrderIndex < $existingIndex)) {
                    $node[$key]['order'] = $docOrder;
                    $node[$key]['order_index'] = $docOrderIndex;
                }
            }
            if ($isLast) {
                $node[$key]['doc'] = $doc;
                $node[$key]['order'] = min($node[$key]['order'] ?? $docOrder, $docOrder);
                $node[$key]['order_index'] = min($node[$key]['order_index'] ?? $docOrderIndex, $docOrderIndex);
            }
            $node =& $node[$key]['children'];
        }
    }
    $tree = $root['children'];
    mark_doc_tree_active($tree, $activeId);
    sort_doc_tree($tree);
    return $tree;
}

function mark_doc_tree_active(array &$nodes, ?string $activeId = null): bool {
    $hasActive = false;
    foreach ($nodes as &$node) {
        $nodeHas = false;
        $doc = $node['doc'] ?? null;
        if ($activeId && $doc && (string)$doc['doc_id'] === (string)$activeId) {
            $nodeHas = true;
        }
        if (!empty($node['children'])) {
            $childHas = mark_doc_tree_active($node['children'], $activeId);
            $nodeHas = $nodeHas || $childHas;
        }
        $node['contains_active'] = $nodeHas;
        if ($nodeHas) {
            $hasActive = true;
        }
    }
    unset($node);
    return $hasActive;
}

function sort_doc_tree(array &$nodes): void {
    foreach ($nodes as &$node) {
        if (!empty($node['children'])) {
            sort_doc_tree($node['children']);
        }
    }
    unset($node);
    uasort($nodes, function ($a, $b) {
        $orderA = $a['order'] ?? PHP_INT_MAX;
        $orderB = $b['order'] ?? PHP_INT_MAX;
        if ($orderA === $orderB) {
            $idxA = $a['order_index'] ?? PHP_INT_MAX;
            $idxB = $b['order_index'] ?? PHP_INT_MAX;
            if ($idxA === $idxB) {
                return strcmp((string)($a['title'] ?? ''), (string)($b['title'] ?? ''));
            }
            return $idxA <=> $idxB;
        }
        return $orderA <=> $orderB;
    });
}

function decode_hex_emoji_string(string $value): string {
    $raw = trim($value);
    if ($raw === '') {
        return $raw;
    }
    $raw = preg_replace('/^u\+/i', '', $raw);
    $raw = str_replace(' ', '', $raw);
    if (!preg_match('/^(?:0x)?[0-9a-f]{4,6}(?:-(?:0x)?[0-9a-f]{4,6})*$/i', $raw)) {
        return $value;
    }
    $parts = explode('-', strtolower($raw));
    $out = '';
    foreach ($parts as $part) {
        $part = preg_replace('/^0x/', '', $part);
        if ($part === '') {
            continue;
        }
        $out .= html_entity_decode('&#x' . $part . ';', ENT_NOQUOTES, 'UTF-8');
    }
    return $out !== '' ? $out : $value;
}

function normalize_doc_icon_value($value): string {
    if ($value === null) {
        return '';
    }
    if (is_string($value)) {
        $trimmed = trim($value);
        if ($trimmed === '') {
            return '';
        }
        if ((str_starts_with($trimmed, '{') && str_ends_with($trimmed, '}')) ||
            (str_starts_with($trimmed, '[') && str_ends_with($trimmed, ']'))
        ) {
            $decoded = json_decode($trimmed, true);
            if (json_last_error() === JSON_ERROR_NONE && $decoded !== null) {
                return normalize_doc_icon_value($decoded);
            }
        }
        return decode_hex_emoji_string($trimmed);
    }
    if (is_numeric($value)) {
        return decode_hex_emoji_string((string)$value);
    }
    if (is_object($value)) {
        $value = (array)$value;
    }
    if (is_array($value)) {
        $keys = ['icon', 'value', 'emoji', 'iconEmoji', 'iconValue', 'path', 'file', 'asset', 'assetPath', 'src', 'url'];
        foreach ($keys as $key) {
            if (array_key_exists($key, $value)) {
                $candidate = normalize_doc_icon_value($value[$key]);
                if ($candidate !== '') {
                    return $candidate;
                }
            }
        }
        foreach ($value as $item) {
            $candidate = normalize_doc_icon_value($item);
            if ($candidate !== '') {
                return $candidate;
            }
        }
    }
    return '';
}

function is_doc_icon_image_value(string $icon): bool {
    if ($icon === '') {
        return false;
    }
    if (preg_match('/^data:image\//i', $icon)) {
        return true;
    }
    if (preg_match('/^https?:\/\//i', $icon)) {
        return true;
    }
    if (strpos($icon, '/') !== false || preg_match('/\.(svg|png|jpe?g|gif|webp|bmp)$/i', $icon)) {
        return true;
    }
    return false;
}

function build_doc_icon_src(string $icon, string $assetBasePath): string {
    if ($icon === '') {
        return '';
    }
    if (preg_match('/^data:image\//i', $icon) || preg_match('/^https?:\/\//i', $icon)) {
        return $icon;
    }
    $path = sanitize_asset_path($icon);
    if ($path === '') {
        return '';
    }
    $prefix = $assetBasePath;
    if ($prefix !== '' && substr($prefix, -1) !== '/') {
        $prefix .= '/';
    }
    return $prefix . encode_path_segments($path);
}

function render_doc_tree_icon(?array $doc, string $assetBasePath): string {
    $icon = $doc ? normalize_doc_icon_value($doc['icon'] ?? '') : '';
    if ($icon !== '' && is_doc_icon_image_value($icon)) {
        $src = build_doc_icon_src($icon, $assetBasePath);
        if ($src !== '') {
            return '<img class="kb-tree-icon kb-tree-icon--image" src="' . htmlspecialchars($src) . '" alt="">';
        }
    }
    if ($icon !== '' && !is_doc_icon_image_value($icon)) {
        return '<span class="kb-tree-icon kb-tree-icon--emoji">' . htmlspecialchars($icon) . '</span>';
    }
    return '';
}

function render_share_search_box(string $slug): string {
    $html  = '<div class="kb-search" data-share-search>';
    $html .= '<div class="kb-search-input-wrap">';
    $html .= '<svg class="kb-search-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35"/></svg>';
    $html .= '<input class="kb-search-input" type="search" placeholder="Search…" data-share-search-input autocomplete="off" spellcheck="false">';
    $html .= '<button class="kb-search-clear" type="button" data-share-search-clear hidden aria-label="Clear search">&times;</button>';
    $html .= '</div>';
    $html .= '<div class="kb-search-results" data-share-search-results hidden></div>';
    $html .= '</div>';
    return $html;
}

function render_doc_tree(array $nodes, string $slug, ?string $activeId = null, int $level = 0, string $path = '', string $assetBasePath = ''): string {
    if (empty($nodes)) {
        return '';
    }
    $html = '<ul class="kb-tree kb-tree-children" data-level="' . $level . '">';
    foreach ($nodes as $node) {
        $doc = $node['doc'] ?? null;
        $hasChildren = !empty($node['children']);
        $isActive = $doc && $activeId && (string)$doc['doc_id'] === (string)$activeId;
        $shouldOpen = false;
        $nodeLabel = $doc ? (string)($doc['doc_id'] ?? '') : (string)($node['title'] ?? '');
        $pathKey = trim($path . '/' . $nodeLabel, '/');
        $nodeKey = $doc ? ('doc:' . $nodeLabel) : ('folder:' . $pathKey);
        $nodeClass = 'kb-tree-node';
        if ($hasChildren) {
            $nodeClass .= $shouldOpen ? ' is-open' : ' is-collapsed';
        }
        $html .= '<li class="' . $nodeClass . '" data-tree-key="' . htmlspecialchars($nodeKey) . '">';
        $html .= '<div class="kb-tree-row">';
        if ($hasChildren) {
            $html .= '<button class="kb-tree-toggle" type="button" aria-label="Expand or collapse ' . htmlspecialchars((string)$node['title'], ENT_QUOTES, 'UTF-8') . '" aria-expanded="' . ($shouldOpen ? 'true' : 'false') . '">';
            $html .= '<svg class="kb-tree-toggle-icon kb-tree-toggle-icon--collapsed" viewBox="0 0 24 24" aria-hidden="true"><use href="#sps-tree-arrow-collapsed"></use></svg>';
            $html .= '<svg class="kb-tree-toggle-icon kb-tree-toggle-icon--open" viewBox="0 0 24 24" aria-hidden="true"><use href="#sps-tree-arrow-expanded"></use></svg>';
            $html .= '</button>';
        } else {
            $html .= '<span class="kb-tree-spacer"></span>';
        }
        if ($doc) {
            $docId = (string)$doc['doc_id'];
            $docTitle = htmlspecialchars($doc['title'] ?? $docId);
            $docPath = base_path() . '/s/' . $slug . '/' . rawurlencode($docId);
            $activeClass = $isActive ? ' is-active' : '';
            $docAttrs = ' href="' . $docPath . '" title="' . htmlspecialchars((string)($doc['title'] ?? $docId), ENT_QUOTES, 'UTF-8') . '" data-doc-id="' . htmlspecialchars($docId) . '" data-share-nav="doc"';
            $html .= '<a class="kb-tree-item' . $activeClass . '"' . $docAttrs . '>';
            $html .= render_doc_tree_icon($doc, $assetBasePath);
            $html .= '<span class="kb-tree-label">' . $docTitle . '</span></a>';
        } else {
            $html .= '<div class="kb-tree-folder">';
            $html .= render_doc_tree_icon(null, $assetBasePath);
            $html .= '<span class="kb-tree-label">' . htmlspecialchars((string)$node['title']) . '</span></div>';
        }
        $html .= '</div>';
        if ($hasChildren) {
            $html .= render_doc_tree($node['children'], $slug, $activeId, $level + 1, $pathKey, $assetBasePath);
        }
        $html .= '</li>';
    }
    $html .= '</ul>';
    return $html;
}

function build_breadcrumbs(string $hpath): array {
    $trimmed = trim($hpath, '/');
    if ($trimmed === '') {
        return [];
    }
    return array_values(array_filter(explode('/', $trimmed)));
}

function is_share_partial_request(): bool {
    if (!empty($_GET['partial']) && (string)$_GET['partial'] === '1') {
        return true;
    }
    if (!empty($_SERVER['HTTP_X_SPS_PARTIAL']) && (string)$_SERVER['HTTP_X_SPS_PARTIAL'] === '1') {
        return true;
    }
    return false;
}

// Compare share roots rather than individual documents, query strings or fragments.
function reader_home_url_key(string $url): string {
    $parts = parse_url($url);
    if (!is_array($parts) || empty($parts['host'])) return '';
    $scheme = strtolower((string)($parts['scheme'] ?? ''));
    if (!in_array($scheme, ['http', 'https'], true) || isset($parts['user']) || isset($parts['pass'])) return '';
    $port = (int)($parts['port'] ?? 0);
    if (($scheme === 'https' && $port === 443) || ($scheme === 'http' && $port === 80)) $port = 0;
    $path = (string)($parts['path'] ?? '/');
    if (preg_match('#^(.*?/s/[a-zA-Z0-9_-]+)(?:/|$)#', $path, $matches)) $path = $matches[1];
    // TLS may terminate at a reverse proxy while PHP sees HTTP. Share identity is unchanged.
    return strtolower((string)$parts['host']) . ($port ? ':' . $port : '') . rtrim($path, '/');
}

function render_reader_home_link(string $slug): string {
    $home = trim((string)get_setting('reader_home_url', ''));
    $homeKey = reader_home_url_key($home);
    if ($homeKey === '' || $homeKey === reader_home_url_key(base_url() . '/s/' . rawurlencode($slug))) return '';
    return '<a class="button ghost reader-home-link" data-reader-home href="' . htmlspecialchars($home, ENT_QUOTES, 'UTF-8') . '" aria-label="Return to home">Home</a>';
}

function render_share_document_actions(string $slug, string $docId): string {
    return '<div class="share-document-actions">' . render_reader_home_link($slug)
        . '<button class="button ghost share-view-toggle" type="button" data-share-toggle aria-pressed="false">Source</button>'
        . render_pdf_export_link(['slug' => $slug, 'doc_id' => $docId]) . '</div>';
}

function render_notebook_welcome(string $title, string $slug): string {
    $html = '<div class="kb-main" role="main"><section class="notebook-welcome" data-notebook-welcome>';
    $html .= '<p class="notebook-eyebrow">Notebook</p><h1 class="kb-title">' . htmlspecialchars($title) . '</h1>';
    $html .= '<p class="notebook-intro">Open the document tree to choose where to begin, or pick up where you left off.</p>';
    $html .= '<div class="notebook-actions">' . render_reader_home_link($slug) . '<button class="button primary" type="button" data-reader-show-tree>Browse documents</button>';
    $html .= '<a class="button" data-reader-resume hidden>Continue reading: <span></span></a></div>';
    $html .= '<p class="notebook-reading-hint">Your reading position stays in this browser. On smaller screens, use Navigation to explore the notebook.</p>';
    return $html . '</section></div>';
}

function route_share(string $slug, ?string $docId = null): void {
    $share = find_share_by_slug($slug);
    if (!$share) {
        render_share_not_found_page();
        return;
    }
    $shareId = (int)$share['id'];
    $shareTitleRaw = (string)$share['title'];
    $shareTitle = htmlspecialchars($shareTitleRaw);
    $redirectPath = '/s/' . $slug . ($docId ? '/' . rawurlencode($docId) : '');
    $resumeAssetPath = resolve_asset_resume_redirect_path($share);
    $isPartial = is_share_partial_request();

    if (share_is_expired($share)) {
        $content = '<div class="share-shell share-shell--single">';
        $content .= '<div class="share-content" role="main">';
        $content .= '<div class="share-header"><h1>' . $shareTitle . '</h1></div>';
        $content .= '<div class="share-empty">This share has expired.</div>';
        $content .= '</div></div>';
        render_page($shareTitleRaw, $content, null, '', ['layout' => 'share']);
        return;
    }

    if (share_visitor_limit_reached($share)) {
        $content = '<div class="share-shell share-shell--single">';
        $content .= '<div class="share-content" role="main">';
        $content .= '<div class="share-header"><h1>' . $shareTitle . '</h1></div>';
        $content .= '<div class="share-empty">This share has reached its visitor limit.</div>';
        $content .= '</div></div>';
        render_page($shareTitleRaw, $content, null, '', ['layout' => 'share']);
        return;
    }

    if (share_requires_password($share) && !share_access_granted($shareId)) {
        $error = '';
        if ($_SERVER['REQUEST_METHOD'] === 'POST') {
            $input = trim((string)($_POST['share_password'] ?? ''));
            if ($input !== '' && password_verify($input, (string)$share['password_hash'])) {
                grant_share_access($shareId);
                if ($resumeAssetPath !== '') {
                    redirect($resumeAssetPath);
                }
                redirect($redirectPath);
            }
            $error = 'Incorrect share password.';
        }
        $content = '<div class="share-shell share-shell--single">';
        $content .= '<div class="share-content" role="main">';
        $content .= '<div class="share-header"><h1>' . $shareTitle . '</h1></div>';
        $content .= '<div class="share-gate">';
        $content .= '<div class="share-gate-note">This share is password protected.</div>';
        if ($error) {
            $content .= '<div class="alert error">' . htmlspecialchars($error) . '</div>';
        }
        $content .= '<form method="post" class="share-gate-form">';
        $content .= '<input class="input" type="password" name="share_password" placeholder="Enter the share password" required>';
        $content .= '<button class="button primary" type="submit">Unlock</button>';
        $content .= '</form></div></div></div>';
        render_page($shareTitleRaw, $content, null, '', ['layout' => 'share']);
        return;
    }

    $pdo = db();
    $stmt = $pdo->prepare('SELECT id, doc_id, title, icon, hpath, parent_id, sort_index, sort_order, updated_at FROM share_docs WHERE share_id = :sid ORDER BY sort_order ASC, id ASC');
    $stmt->execute([':sid' => $shareId]);
    $docs = $stmt->fetchAll(PDO::FETCH_ASSOC);
    $docMarkdownStmt = $pdo->prepare('SELECT markdown FROM share_docs WHERE share_id = :sid AND id = :id LIMIT 1');
    $loadDocMarkdown = function (array $doc) use ($docMarkdownStmt, $shareId): string {
        $rowId = (int)($doc['id'] ?? 0);
        if ($rowId <= 0) {
            return '';
        }
        $docMarkdownStmt->execute([
            ':sid' => $shareId,
            ':id' => $rowId,
        ]);
        $markdown = $docMarkdownStmt->fetchColumn();
        return is_string($markdown) ? $markdown : '';
    };
    if (empty($docs)) {
        render_share_not_found_page();
        return;
    }
    $visitorRegistered = false;
    $registerShareVisitor = function () use (&$visitorRegistered, $share, $shareId): void {
        if ($visitorRegistered) {
            return;
        }
        if (share_visitor_limit($share) > 0) {
            register_share_visitor($shareId, get_visitor_id());
        }
        $visitorRegistered = true;
    };

    $assetBasePath = base_path() . '/uploads/shares/' . $shareId . '/';

    if ($share['type'] === 'doc') {
        if ($docId !== null && !in_array($docId, array_column($docs, 'doc_id'), true)) {
            render_share_not_found_page();
            return;
        }
        $hasMultipleDocs = count($docs) > 1;
        $activeDocId = $docId ?: (string)($share['doc_id'] ?? ($docs[0]['doc_id'] ?? ''));
        if ($hasMultipleDocs) {
            $doc = null;
            foreach ($docs as $item) {
                if ((string)($item['doc_id'] ?? '') === (string)$activeDocId) {
                    $doc = $item;
                    break;
                }
            }
            if (!$doc && !$docId && !empty($docs)) {
                $doc = $docs[0];
                $activeDocId = (string)($doc['doc_id'] ?? '');
            }
            if (!$doc) {
                render_share_not_found_page();
                return;
            }
            $docTitleRaw = trim((string)($doc['title'] ?? '')) ?: $shareTitleRaw;
            $docTitle = htmlspecialchars($docTitleRaw);
            $front = extract_front_matter($loadDocMarkdown($doc));
            $markdown = rewrite_asset_links((string)$front['body'], $assetBasePath);
            $markdown = strip_duplicate_title_heading($markdown, $docTitleRaw);
            $markdown = replace_custom_emoji_tokens($markdown, (int)$shareId, $assetBasePath);
            $markdown = insert_adjacent_emoji_image_spacing($markdown);
            $registerShareVisitor();
            $documentTree = build_doc_tree($docs, $activeDocId);
            $treeHtml = render_doc_tree($documentTree, $slug, $activeDocId, 0, '', $assetBasePath);
            $sidebar = '<aside class="kb-sidebar" data-share-sidebar data-share-slug="' . htmlspecialchars($slug) . '">';
            $sidebar .= render_share_search_box($slug);
            $sidebar .= '<div class="kb-side-tabs" data-share-tabs data-share-default="tree">';
            $sidebar .= '<button class="kb-side-tab is-active" type="button" data-share-tab="tree">Documents</button>';
            $sidebar .= '<button class="kb-side-tab" type="button" data-share-tab="toc">Contents</button>';
            $sidebar .= '<div class="kb-side-actions" data-share-tree-actions>';
            $sidebar .= '<button class="kb-side-action" type="button" data-tree-collapse title="Collapse all" aria-label="Collapse all"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#sps-tree-collapse-all"></use></svg></button>';
            $sidebar .= '<button class="kb-side-action" type="button" data-tree-expand title="Expand all" aria-label="Expand all"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#sps-tree-expand-all"></use></svg></button>';
            $sidebar .= '</div>';
            $sidebar .= '</div>';
            $sidebar .= '<div class="kb-side-panel" data-share-panel="tree">';
            $sidebar .= '<div class="kb-side-body">' . $treeHtml . '</div>';
            $sidebar .= '</div>';
            $sidebar .= '<div class="kb-side-panel" data-share-panel="toc" data-share-toc="doc" hidden>';
            $sidebar .= '<div class="kb-side-body share-toc-body"></div>';
            $sidebar .= '</div>';
            $sidebar .= '</aside>';
            $base = base_path();
            $crumbs = build_breadcrumbs((string)($doc['hpath'] ?? ''));
            if (!empty($crumbs)) {
                array_pop($crumbs);
            }
            if ($shareTitleRaw !== '' && !empty($crumbs)) {
                while (!empty($crumbs) && $crumbs[0] === $shareTitleRaw) {
                    array_shift($crumbs);
                }
            }
            $filteredCrumbs = [];
            $prevCrumb = null;
            foreach ($crumbs as $crumb) {
                if ($crumb === $prevCrumb) {
                    continue;
                }
                $filteredCrumbs[] = $crumb;
                $prevCrumb = $crumb;
            }
            $crumbs = $filteredCrumbs;
            $breadcrumbsHtml = '<div class="kb-breadcrumbs"><a class="kb-back" href="' . $base . '/s/' . $slug . '" data-doc-id="" data-share-nav="doc">' . htmlspecialchars($shareTitleRaw) . '</a>';
            foreach ($crumbs as $crumb) {
                $breadcrumbsHtml .= '<span>' . htmlspecialchars($crumb) . '</span>';
            }
            $breadcrumbsHtml .= '</div>';
            $mainHtml = '<div class="kb-main" role="main">';
            $mainHtml .= '<div class="share-article" data-share-view="preview">';
            $mainHtml .= '<div class="kb-header">' . $breadcrumbsHtml;
            $mainHtml .= '<div class="kb-title-row">';
            $mainHtml .= '<h1 class="kb-title">' . $docTitle . '</h1>';
            $mainHtml .= render_share_document_actions($slug, $activeDocId);
            $mainHtml .= '</div>';
            $mainHtml .= '</div>';
            $mainHtml .= '<div class="markdown-body" data-md-id="doc">' . render_markdown($markdown) . '</div>';
            $mainHtml .= '<textarea class="markdown-source" data-md-id="doc" readonly spellcheck="false" aria-label="Markdown source">' . htmlspecialchars($markdown) . '</textarea>';
            $mainHtml .= '</div></div>';
            if ($isPartial) {
                api_response(200, [
                    'title' => $docTitleRaw,
                    'docId' => $activeDocId,
                    'html' => $mainHtml,
                ]);
            }
            $content = '<div class="share-shell share-shell--notebook" data-share-doc-id="' . htmlspecialchars($activeDocId) . '">';
            $content .= $sidebar;
            $content .= $mainHtml;
            $content .= '</div>';
            render_page($docTitleRaw, $content, null, '', ['layout' => 'share', 'markdown' => true]);
            return;
        }

        $doc = $docs[0];
        $docTitleRaw = trim((string)($doc['title'] ?? '')) ?: $shareTitleRaw;
        $docTitle = htmlspecialchars($docTitleRaw);
        $front = extract_front_matter($loadDocMarkdown($doc));
        $markdown = rewrite_asset_links((string)$front['body'], $assetBasePath);
        $markdown = strip_duplicate_title_heading($markdown, $docTitleRaw);
        $markdown = replace_custom_emoji_tokens($markdown, (int)$shareId, $assetBasePath);
        $markdown = insert_adjacent_emoji_image_spacing($markdown);
        $registerShareVisitor();
        $sidebar = '<aside class="kb-sidebar" data-share-sidebar data-share-slug="' . htmlspecialchars($slug) . '">';
        $sidebar .= render_share_search_box($slug);
        $sidebar .= '<div class="kb-side-tabs" data-share-tabs data-share-default="toc">';
        $sidebar .= '<button class="kb-side-tab is-active" type="button" data-share-tab="toc">Contents</button>';
        $sidebar .= '</div>';
        $sidebar .= '<div class="kb-side-panel" data-share-panel="toc" data-share-toc="doc">';
        $sidebar .= '<div class="kb-side-body share-toc-body"></div>';
        $sidebar .= '</div>';
        $sidebar .= '</aside>';
        $content = '<div class="share-shell share-shell--notebook">';
        $content .= $sidebar;
        $content .= '<div class="kb-main" role="main">';
        $content .= '<div class="share-article" data-share-view="preview">';
        $content .= '<div class="kb-header">';
        $content .= '<div class="kb-title-row">';
        $content .= '<h1 class="kb-title">' . $docTitle . '</h1>';
        $content .= render_share_document_actions($slug, (string)$doc['doc_id']);
        $content .= '</div>';
        $content .= '</div>';
        $content .= '<div class="markdown-body" data-md-id="doc">' . render_markdown($markdown) . '</div>';
        $content .= '<textarea class="markdown-source" data-md-id="doc" readonly spellcheck="false" aria-label="Markdown source">' . htmlspecialchars($markdown) . '</textarea>';
        $content .= '</div></div></div>';
        render_page($docTitleRaw, $content, null, '', ['layout' => 'share', 'markdown' => true]);
    }

    if ($share['type'] === 'notebook') {
        $notebookTree = build_doc_tree($docs, $docId);
        $treeHtml = render_doc_tree($notebookTree, $slug, $docId, 0, '', $assetBasePath);
        $sidebar = '<aside class="kb-sidebar" data-share-sidebar data-share-slug="' . htmlspecialchars($slug) . '">';
        $sidebar .= render_share_search_box($slug);
        $sidebar .= '<div class="kb-side-tabs" data-share-tabs data-share-default="tree">';
        $sidebar .= '<button class="kb-side-tab is-active" type="button" data-share-tab="tree">Documents</button>';
        $sidebar .= '<button class="kb-side-tab" type="button" data-share-tab="toc">Contents</button>';
        $sidebar .= '<div class="kb-side-actions" data-share-tree-actions>';
        $sidebar .= '<button class="kb-side-action" type="button" data-tree-collapse title="Collapse all" aria-label="Collapse all"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#sps-tree-collapse-all"></use></svg></button>';
        $sidebar .= '<button class="kb-side-action" type="button" data-tree-expand title="Expand all" aria-label="Expand all"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#sps-tree-expand-all"></use></svg></button>';
        $sidebar .= '</div>';
        $sidebar .= '</div>';
        $sidebar .= '<div class="kb-side-panel" data-share-panel="tree">';
        $sidebar .= '<div class="kb-side-body">' . $treeHtml . '</div>';
        $sidebar .= '</div>';
        $sidebar .= '<div class="kb-side-panel" data-share-panel="toc" data-share-toc="doc" hidden>';
        $sidebar .= '<div class="kb-side-body share-toc-body"></div>';
        $sidebar .= '</div>';
        $sidebar .= '</aside>';
        $base = base_path();

        if ($docId) {
            $doc = null;
            foreach ($docs as $item) {
                if ((string)$item['doc_id'] === (string)$docId) {
                    $doc = $item;
                    break;
                }
            }
            if (!$doc) {
                render_share_not_found_page();
                return;
            }
            $docTitleRaw = trim((string)($doc['title'] ?? '')) ?: $shareTitleRaw;
            $docTitle = htmlspecialchars($docTitleRaw);
            $front = extract_front_matter($loadDocMarkdown($doc));
            $markdown = rewrite_asset_links((string)$front['body'], $assetBasePath);
            $markdown = strip_duplicate_title_heading($markdown, $docTitleRaw);
            $markdown = replace_custom_emoji_tokens($markdown, (int)$shareId, $assetBasePath);
            $markdown = insert_adjacent_emoji_image_spacing($markdown);
            $registerShareVisitor();
            $crumbs = build_breadcrumbs((string)($doc['hpath'] ?? ''));
            if (!empty($crumbs)) {
                array_pop($crumbs);
            }
            $breadcrumbsHtml = '<div class="kb-breadcrumbs"><a class="kb-back" href="' . $base . '/s/' . $slug . '" data-doc-id="" data-share-nav="doc">Contents</a>';
            foreach ($crumbs as $crumb) {
                $breadcrumbsHtml .= '<span>' . htmlspecialchars($crumb) . '</span>';
            }
            $breadcrumbsHtml .= '</div>';
            $mainHtml = '<div class="kb-main" role="main">';
            $mainHtml .= '<div class="share-article" data-share-view="preview">';
            $mainHtml .= '<div class="kb-header">' . $breadcrumbsHtml;
            $mainHtml .= '<div class="kb-title-row">';
            $mainHtml .= '<h1 class="kb-title">' . $docTitle . '</h1>';
            $mainHtml .= render_share_document_actions($slug, (string)$docId);
            $mainHtml .= '</div>';
            $mainHtml .= '</div>';
            $mainHtml .= '<div class="markdown-body" data-md-id="doc">' . render_markdown($markdown) . '</div>';
            $mainHtml .= '<textarea class="markdown-source" data-md-id="doc" readonly spellcheck="false" aria-label="Markdown source">' . htmlspecialchars($markdown) . '</textarea>';
            $mainHtml .= '</div></div>';
            if ($isPartial) {
                api_response(200, [
                    'title' => $docTitleRaw,
                    'docId' => $docId,
                    'html' => $mainHtml,
                ]);
            }
            $content = '<div class="share-shell share-shell--notebook" data-share-doc-id="' . htmlspecialchars((string)$docId) . '">';
            $content .= $sidebar;
            $content .= $mainHtml;
            $content .= '</div>';
            render_page($docTitleRaw, $content, null, '', ['layout' => 'share', 'markdown' => true]);
        }

        if (!$docId) {
            $registerShareVisitor();
            $mainHtml = render_notebook_welcome($shareTitleRaw, $slug);
            if ($isPartial) {
                api_response(200, [
                    'title' => $shareTitleRaw,
                    'docId' => '',
                    'html' => $mainHtml,
                ]);
            }
            $content = '<div class="share-shell share-shell--notebook" data-share-doc-id="">';
            $content .= $sidebar;
            $content .= $mainHtml;
            $content .= '</div>';
            render_page($shareTitleRaw, $content, null, '', ['layout' => 'share', 'markdown' => true]);
        }

    }

    render_share_not_found_page();
}
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) ?: '/';
$base = base_path();
if ($base && strpos($path, $base) === 0) {
    $path = substr($path, strlen($base));
    if ($path === '') {
        $path = '/';
    }
}

if (strpos($path, '/api/v1/') === 0) {
    handle_api($path);
}

if (preg_match('#^/s/([a-zA-Z0-9_-]+)/export(?:/(verify|release|claim|document|check|quota|captcha|captcha-verify))?$#', $path, $matches)) {
    route_pdf_export($matches[1], $matches[2] ?? '');
}

if (preg_match('#^/s/([a-zA-Z0-9_-]+)/res/(.+)$#', $path, $matches)) {
    handle_share_asset_request($matches[1], $matches[2]);
}

if (str_starts_with($path, '/uploads/')) {
    handle_legacy_upload_asset_request($path);
}

if (preg_match('#^/s/([a-zA-Z0-9_-]+)/search$#', $path, $matches) && $_SERVER['REQUEST_METHOD'] === 'GET') {
    handle_share_search($matches[1]);
}

if (preg_match('#^/s/([a-zA-Z0-9_-]+)(?:/([^/]+))?$#', $path, $matches)) {
    route_share($matches[1], $matches[2] ?? null);
}

require __DIR__ . '/admin.php';
render_404_page();
