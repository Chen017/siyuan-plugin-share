<?php
declare(strict_types=1);

// Attachment delivery and legacy upload links with share access checks.
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
    if (share_is_expired($share)) {
        redirect_to_share_page($share, $assetPath);
    }
    if (share_requires_password($share) && !share_access_granted($shareId)) {
        redirect_to_share_page($share, $assetPath);
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
    if (!share_read_access_allowed($shareId)) redirect_to_share_page($share, $assetPath);
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
