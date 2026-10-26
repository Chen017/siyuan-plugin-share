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
date_default_timezone_set('Asia/Shanghai');

require_once __DIR__ . '/vendor/Parsedown.php';
require_once __DIR__ . '/pdf-export.php';
require_once __DIR__ . '/legacy-cleanup.php';
require_once __DIR__ . '/database.php';
require_once __DIR__ . '/storage.php';
require_once __DIR__ . '/sync.php';
require_once __DIR__ . '/markdown.php';
require_once __DIR__ . '/share-access.php';
require_once __DIR__ . '/share-assets.php';
require_once __DIR__ . '/reader.php';

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
