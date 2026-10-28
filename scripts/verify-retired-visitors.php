<?php
declare(strict_types=1);

// Deployment postcondition; read only, independent of application bootstrap.
$pdo = new PDO('sqlite:' . ($argv[1] ?? ''), null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
$pdo->exec('PRAGMA query_only = ON');
if ($pdo->query("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='share_visitors'")->fetchColumn() != 0) {
    throw new RuntimeException('Share visitor history was not retired');
}
foreach (['shares', 'share_uploads'] as $table) {
    $columns = $pdo->query('PRAGMA table_info(' . $table . ')')->fetchAll(PDO::FETCH_ASSOC);
    if (!$columns || in_array('visitor_limit', array_column($columns, 'name'), true)) {
        throw new RuntimeException('Unexpected share visitor schema: ' . $table);
    }
}
echo "SHARE_VISITORS_RETIRED=1\n";
