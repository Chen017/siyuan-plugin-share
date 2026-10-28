<?php
declare(strict_types=1);

// Read data only: do not load index.php or run application migrations.
$path = $argv[1] ?? '';
if (!is_file($path)) {
    throw new RuntimeException('Database does not exist');
}
$pdo = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
$pdo->exec('PRAGMA query_only = ON');
$coreOnly = in_array('--core-only', $argv, true);
if ($pdo->query('PRAGMA integrity_check')->fetchAll(PDO::FETCH_COLUMN) !== ['ok']) {
    throw new RuntimeException('SQLite integrity check failed');
}
$result = ['integrity' => 'ok', 'foreign_key_violations' => count($pdo->query('PRAGMA foreign_key_check')->fetchAll()), 'counts' => [], 'fingerprints' => []];
$queries = [
    'users' => 'SELECT id, username, password_hash, role, disabled, api_key_hash, api_key_prefix, api_key_last4, must_change_password FROM users ORDER BY id',
    'shares' => 'SELECT id, user_id, type, slug, title, doc_id, notebook_id, password_hash, expires_at, deleted_at FROM shares ORDER BY id',
    'share_docs' => 'SELECT * FROM share_docs ORDER BY id',
    'share_assets' => 'SELECT * FROM share_assets ORDER BY id',
];
if ($coreOnly) {
    $queries['settings'] = "SELECT key,value FROM settings WHERE key IN ('site_base_url','reader_home_url','site_head_html',
        'site_custom_css_enabled','site_custom_css','site_custom_js_enabled','site_custom_js','default_storage_limit_bytes')
        OR key LIKE 'pdf_export_%' ORDER BY key";
    $noteReference = $pdo->prepare('SELECT 1 FROM share_docs WHERE instr(markdown, ?) > 0 OR instr(markdown, ?) > 0 OR instr(markdown, ?) > 0 LIMIT 1');
    $uploads = realpath(dirname(dirname($path)) . '/uploads');
}
foreach ($queries as $table => $query) {
    $exists = $pdo->prepare('SELECT 1 FROM sqlite_master WHERE type = "table" AND name = ?');
    $exists->execute([$table]);
    if (!$exists->fetchColumn()) {
        continue;
    }
    $context = hash_init('sha256');
    $count = 0;
    foreach ($pdo->query($query, PDO::FETCH_ASSOC) as $row) {
        if ($coreOnly && $table === 'share_assets') {
            $assetPath = (string)$row['asset_path'];
            if (str_starts_with($assetPath, 'comment-files/')) {
                $encoded = implode('/', array_map('rawurlencode', explode('/', $assetPath)));
                $noteReference->execute([$assetPath, $encoded, basename($assetPath)]);
                if (!$noteReference->fetchColumn()) continue;
            }
            $file = $uploads === false ? false : realpath($uploads . '/' . ltrim((string)$row['file_path'], '/'));
            if ($file !== false && !str_starts_with(strtolower($file), strtolower($uploads . DIRECTORY_SEPARATOR))) throw new RuntimeException('Attachment path escapes uploads');
            $row['file_sha256'] = $file !== false && is_file($file) ? hash_file('sha256', $file) : null;
        }
        hash_update($context, json_encode($row, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE) . "\n");
        $count++;
    }
    $result['counts'][$table] = $count;
    $result['fingerprints'][$table] = hash_final($context);
}
echo json_encode($result, JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR), "\n";
