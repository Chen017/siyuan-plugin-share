<?php
declare(strict_types=1);

/** One-time local/database upgrade. Never removes shares, documents or owner records. */
function retire_legacy_modules(PDO $pdo): void {
    if (fetch_setting($pdo, 'admin_only_schema_v1') === '1') return;
    $tables = $pdo->query("SELECT name FROM sqlite_master WHERE type='table'")->fetchAll(PDO::FETCH_COLUMN);
    $pdo->beginTransaction();
    try {
        retire_unreferenced_comment_files($pdo);
        foreach (['share_access_logs', 'share_access_geo_cache', 'user_settings', 'share_comments', 'share_reports',
            'announcements', 'email_codes', 'password_resets', 'instance_heartbeats'] as $table) {
            $pdo->exec('DROP TABLE IF EXISTS ' . $table);
        }
        foreach (['users' => ['email', 'email_verified', 'last_active_at'], 'shares' => ['access_count', 'comment_notify']] as $table => $columns) {
            foreach ($columns as $column) if (table_has_column($pdo, $table, $column)) $pdo->exec('ALTER TABLE ' . $table . ' DROP COLUMN ' . $column);
        }
        $pdo->exec("DELETE FROM settings WHERE key IN ('allow_registration', 'captcha_enabled', 'banned_words', 'site_icp', 'site_contact_email', 'central_stats_url')
            OR key LIKE 'access_stats_%' OR key LIKE 'email_%' OR key LIKE 'smtp_%' OR key LIKE 'central_stats_%'
            OR key LIKE 'instance_%' OR key LIKE 'release_%' OR key LIKE 'scan_%'");
        // Storage remains notes + attachment bytes. Deleted shares retain their files but not active quota.
        $pdo->exec('UPDATE shares SET size_bytes = COALESCE((SELECT SUM(size_bytes) FROM share_docs WHERE share_id = shares.id), 0)
            + COALESCE((SELECT SUM(size_bytes) FROM share_assets WHERE share_id = shares.id), 0)');
        $pdo->exec('UPDATE users SET storage_used_bytes = COALESCE((SELECT SUM(size_bytes) FROM shares WHERE user_id = users.id AND deleted_at IS NULL), 0)');
        global $config;
        $cache = dirname($config['db_path']) . '/release_cache.json';
        if (is_file($cache) && !unlink($cache)) throw new RuntimeException('Unable to remove retired release cache.');
        ensure_setting($pdo, 'admin_only_schema_v1', '1');
        $pdo->commit();
    } catch (Throwable $error) {
        $pdo->rollBack();
        throw $error;
    }
}

/** Retain old uploads if any note or another asset still references them. */
function retire_unreferenced_comment_files(PDO $pdo): void {
    global $config;
    $assets = $pdo->query("SELECT id, asset_path, file_path FROM share_assets WHERE asset_path LIKE 'comment-files/%'")->fetchAll(PDO::FETCH_ASSOC);
    $noteReference = $pdo->prepare('SELECT 1 FROM share_docs WHERE instr(markdown, ?) > 0 OR instr(markdown, ?) > 0 OR instr(markdown, ?) > 0 LIMIT 1');
    $otherReference = $pdo->prepare('SELECT 1 FROM share_assets WHERE file_path = ? AND id != ? LIMIT 1');
    $delete = $pdo->prepare('DELETE FROM share_assets WHERE id = ?');
    $root = realpath($config['uploads_dir']);
    foreach ($assets as $asset) {
        $path = (string)$asset['asset_path'];
        $noteReference->execute([$path, encode_path_segments($path), basename($path)]);
        if ($noteReference->fetchColumn()) continue;
        $otherReference->execute([$asset['file_path'], $asset['id']]);
        if ($otherReference->fetchColumn()) continue;
        $file = realpath($config['uploads_dir'] . '/' . ltrim((string)$asset['file_path'], '/'));
        if ($file !== false) {
            if ($root === false || !str_starts_with(strtolower($file), strtolower($root . DIRECTORY_SEPARATOR))) continue;
            if (is_file($file) && !unlink($file)) throw new RuntimeException('Unable to remove a retired comment upload.');
        }
        $delete->execute([$asset['id']]);
    }
}
