<?php
declare(strict_types=1);

// Database schema, settings seeding and administrator bootstrap.
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
    $pdo->exec('PRAGMA busy_timeout = 3000;');
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

    if (!table_has_column($pdo, 'shares', 'revision') || !table_has_column($pdo, 'share_uploads', 'share_revision')
        || !table_has_column($pdo, 'share_uploads', 'reserved_bytes')) {
        $pdo->exec('BEGIN IMMEDIATE');
        try {
            // Another first request may have migrated while this worker waited for the write lock.
            ensure_column($pdo, 'shares', 'revision', 'INTEGER NOT NULL DEFAULT 0');
            ensure_column($pdo, 'share_uploads', 'share_revision', 'INTEGER NOT NULL DEFAULT -1');
            ensure_column($pdo, 'share_uploads', 'reserved_bytes', 'INTEGER NOT NULL DEFAULT 0');
            $pdo->exec('COMMIT');
        } catch (Throwable $error) { $pdo->exec('ROLLBACK'); throw $error; }
    }
    $pdo->exec('CREATE INDEX IF NOT EXISTS idx_share_uploads_updated ON share_uploads(updated_at)');
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
