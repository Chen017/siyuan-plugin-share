<?php
declare(strict_types=1);

// Read data only: do not load index.php or run application migrations.
$path = $argv[1] ?? '';
if (!is_file($path)) {
    throw new RuntimeException('Database does not exist');
}
$pdo = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
$pdo->exec('PRAGMA query_only = ON');
if ($pdo->query('PRAGMA integrity_check')->fetchAll(PDO::FETCH_COLUMN) !== ['ok']) {
    throw new RuntimeException('SQLite integrity check failed');
}
$result = ['integrity' => 'ok', 'foreign_key_violations' => count($pdo->query('PRAGMA foreign_key_check')->fetchAll()), 'counts' => [], 'fingerprints' => []];
$queries = [
    'users' => 'SELECT id, username, email, password_hash, role, disabled FROM users ORDER BY id',
    'shares' => 'SELECT id, user_id, type, slug, title, doc_id, notebook_id, password_hash, expires_at, visitor_limit, deleted_at FROM shares ORDER BY id',
    'share_docs' => 'SELECT * FROM share_docs ORDER BY id',
    'share_assets' => 'SELECT * FROM share_assets ORDER BY id',
    'share_comments' => 'SELECT * FROM share_comments ORDER BY id',
    'share_reports' => 'SELECT * FROM share_reports ORDER BY id',
];
foreach ($queries as $table => $query) {
    $exists = $pdo->prepare('SELECT 1 FROM sqlite_master WHERE type = "table" AND name = ?');
    $exists->execute([$table]);
    if (!$exists->fetchColumn()) {
        continue;
    }
    $context = hash_init('sha256');
    $count = 0;
    foreach ($pdo->query($query, PDO::FETCH_ASSOC) as $row) {
        hash_update($context, json_encode($row, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE) . "\n");
        $count++;
    }
    $result['counts'][$table] = $count;
    $result['fingerprints'][$table] = hash_final($context);
}
echo json_encode($result, JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR), "\n";
