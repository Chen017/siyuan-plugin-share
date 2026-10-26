<?php
declare(strict_types=1);

// Attachment storage, upload staging, chunk cleanup and sync metadata.
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

