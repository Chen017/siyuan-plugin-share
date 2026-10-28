<?php
declare(strict_types=1);

/** New bytes never overwrite a published file. Only committed DB references publish them. */
final class ShareFileWrite {
    private bool $active = true;
    private array $directories = [];
    private array $previousFiles = [];
    private string $generation;
    private $generationLock;

    public function __construct(private PDO $pdo) {
        $this->generation = bin2hex(random_bytes(16));
        $pdo->exec('BEGIN IMMEDIATE');
        $this->generationLock = lock_upload_session($this->generation);
        register_shutdown_function(fn() => $this->rollback());
    }

    public function rememberShare(int $shareId): void {
        $stmt = $this->pdo->prepare('SELECT file_path FROM share_assets WHERE share_id = ?');
        $stmt->execute([$shareId]);
        $this->previousFiles = array_merge($this->previousFiles, $stmt->fetchAll(PDO::FETCH_COLUMN));
    }

    public function stage(string $source, int $shareId, string $assetPath, bool $uploaded = false): string {
        global $config;
        $path = sanitize_asset_path($assetPath);
        if ($path === '' || str_ends_with($path, '/') || !is_file($source)) {
            throw new RuntimeException('Invalid attachment source');
        }
        $directory = 'shares/' . $shareId . '/versions/' . $this->generation;
        $targetRoot = $config['uploads_dir'] . '/' . $directory;
        $this->directories[$targetRoot] = true;
        $target = $targetRoot . '/' . $path;
        require_upload_space((int)filesize($source));
        ensure_dir(dirname($target));
        $hash = hash_file('sha256', $source);
        if (!($uploaded ? move_uploaded_file($source, $target) : copy($source, $target))
            || $hash === false || hash_file('sha256', $target) !== $hash) {
            throw new RuntimeException('Attachment write failed');
        }
        return $directory . '/' . $path;
    }

    public function commit(): void {
        $this->pdo->exec('COMMIT');
        $this->active = false;
        // Failure to reclaim space after commit must never turn a committed upload into a retry.
        try { remove_unreferenced_asset_files($this->previousFiles); }
        catch (Throwable $error) { error_log('Attachment cleanup deferred: ' . $error->getMessage()); }
    }

    public function rollback(): void {
        if (!$this->active) return;
        $this->active = false;
        try { $this->pdo->exec('ROLLBACK'); }
        finally { foreach (array_keys($this->directories) as $directory) remove_dir($directory); }
    }
}

function remove_unreferenced_asset_files(array $paths): void {
    global $config;
    $root = realpath($config['uploads_dir']);
    if ($root === false) return;
    $referenced = db()->prepare('SELECT 1 FROM share_assets WHERE file_path = ? LIMIT 1');
    foreach (array_unique($paths) as $path) {
        $referenced->execute([$path]);
        if ($referenced->fetchColumn()) continue;
        $file = realpath($root . '/' . $path);
        if ($file === false || !str_starts_with($file, $root . DIRECTORY_SEPARATOR) || !is_file($file)) continue;
        if (!@unlink($file)) { error_log('Unable to reclaim attachment: ' . $path); continue; }
        // rmdir only removes empty parents, never a sibling attachment or the uploads root.
        $parent = dirname($file);
        while ($parent !== $root && str_starts_with($parent, $root . DIRECTORY_SEPARATOR) && @rmdir($parent)) {
            $parent = dirname($parent);
        }
    }
}

function require_upload_space(int $bytes): void {
    global $config;
    ensure_dir($config['uploads_dir']);
    $free = disk_free_space($config['uploads_dir']);
    if ($free !== false && $free < $bytes + 16 * 1024 * 1024) {
        throw new RuntimeException('Insufficient free storage', 413);
    }
}

/** Lock the entire chunk/complete/cancel lifecycle, including stale cleanup. */
function lock_upload_session(string $uploadId, bool $wait = true) {
    global $config;
    $directory = $config['uploads_dir'] . '/.locks';
    ensure_dir($directory);
    $lock = fopen($directory . '/' . $uploadId . '.lock', 'c');
    if ($lock === false) throw new RuntimeException('Unable to lock upload');
    if (!flock($lock, LOCK_EX | ($wait ? 0 : LOCK_NB))) { fclose($lock); return false; }
    return $lock; // Kept open by the caller until the request ends.
}

function create_upload_session(array $user, ?array $existing, array $values, array $docs, array $assets, array $docChunks): string {
    global $config;
    $pdo = db();
    $bytes = array_sum(array_column($docs, 'size')) + array_sum(array_column($assets, 'size'));
    $budget = max(1, (int)($config['upload_staging_limit_mb'] ?? 1024)) * 1024 * 1024;
    $limit = get_user_limit_bytes($user);
    if ($limit > 0) $budget = min($budget, $limit);
    $uploadId = generate_upload_id();
    $pdo->exec('BEGIN IMMEDIATE');
    try {
        $stmt = $pdo->prepare('SELECT COUNT(*), COALESCE(SUM(reserved_bytes),0) FROM share_uploads WHERE user_id = ?');
        $stmt->execute([$user['id']]);
        [$pending, $reserved] = $stmt->fetch(PDO::FETCH_NUM);
        if ((int)$pending >= max(1, (int)($config['upload_pending_limit'] ?? 32)) || (int)$reserved + $bytes > $budget) {
            throw new RuntimeException('Pending uploads exceed the staging limit; cancel an upload or retry after cleanup', 413);
        }
        $stmt = $pdo->prepare('INSERT INTO share_uploads
            (upload_id,user_id,share_id,share_revision,reserved_bytes,type,doc_id,notebook_id,slug,title,password_hash,expires_at,asset_manifest,doc_manifest,upload_mode,patch_manifest,status,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,"pending",?,?)');
        $stmt->execute([$uploadId,$user['id'],$existing['id'] ?? null,$existing['revision'] ?? -1,$bytes,
            $values['type'],$values['doc_id'] ?? null,$values['notebook_id'] ?? null,$values['slug'],$values['title'],
            $values['password_hash'],$values['expires_at'],json_encode($assets, JSON_THROW_ON_ERROR),
            json_encode($docChunks, JSON_THROW_ON_ERROR),$values['upload_mode'],$values['patch_manifest'],now(),now()]);
        $insert = $pdo->prepare('INSERT INTO share_upload_docs
            (upload_id,doc_id,title,icon,hpath,parent_id,sort_index,markdown,sort_order,size_bytes,content_hash,meta_hash,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
        foreach ($docs as $doc) $insert->execute([$uploadId,$doc['docId'],$doc['title'],$doc['icon'] ?: null,$doc['hPath'],
            $doc['parentId'] ?: null,$doc['sortIndex'],$doc['markdown'],$doc['sortOrder'],$doc['size'],
            normalize_hash_hex($doc['contentHash'] ?? ''),normalize_hash_hex($doc['metaHash'] ?? ''),now(),now()]);
        $pdo->exec('COMMIT');
        return $uploadId;
    } catch (Throwable $error) {
        $pdo->exec('ROLLBACK');
        if ($error->getCode() === 413) api_response(413, null, $error->getMessage());
        throw $error;
    }
}

function cleanup_stale_uploads(int $ttl, int $limit): void {
    $pdo = db();
    $cutoff = date('Y-m-d H:i:s', time() - $ttl);
    $stmt = $pdo->prepare('SELECT upload_id FROM share_uploads WHERE updated_at < ? ORDER BY updated_at LIMIT ?');
    $stmt->bindValue(1, $cutoff);
    $stmt->bindValue(2, $limit, PDO::PARAM_INT);
    $stmt->execute();
    foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $id) {
        $lock = lock_upload_session($id, false);
        if ($lock === false) continue;
        try {
            $pdo->exec('BEGIN IMMEDIATE');
            $check = $pdo->prepare('SELECT 1 FROM share_uploads WHERE upload_id = ? AND updated_at < ?');
            $check->execute([$id, $cutoff]);
            $stale = (bool)$check->fetchColumn();
            if ($stale) {
                $pdo->prepare('DELETE FROM share_upload_docs WHERE upload_id = ?')->execute([$id]);
                $pdo->prepare('DELETE FROM share_uploads WHERE upload_id = ?')->execute([$id]);
            }
            $pdo->exec('COMMIT');
            if ($stale) purge_upload_session_files($id);
        } catch (Throwable $error) { $pdo->exec('ROLLBACK'); throw $error; }
        finally { fclose($lock); }
    }
}

/** Reclaim generations orphaned by a process crash; committed references and active writers win. */
function cleanup_asset_generations(int $ttl, int $limit): void {
    global $config;
    $referenced = [];
    foreach (db()->query('SELECT file_path FROM share_assets')->fetchAll(PDO::FETCH_COLUMN) as $path) {
        if (preg_match('#^(shares/\d+/versions/[a-f0-9]{32})/#', $path, $match)) $referenced[$match[1]] = true;
    }
    $check = db()->prepare('SELECT 1 FROM share_assets WHERE file_path LIKE ? LIMIT 1');
    $deleted = 0;
    foreach (glob($config['uploads_dir'] . '/shares/*/versions/*', GLOB_ONLYDIR) ?: [] as $directory) {
        $id = sanitize_upload_id(basename($directory));
        $modified = @filemtime($directory);
        if ($id === '' || $modified === false || time() - $modified < $ttl) continue;
        $relative = 'shares/' . basename(dirname(dirname($directory))) . '/versions/' . $id;
        if (isset($referenced[$relative])) continue;
        $lock = lock_upload_session($id, false);
        if ($lock === false) continue;
        try {
            $check->execute([$relative . '/%']);
            $exists = (bool)$check->fetchColumn();
            $check->closeCursor();
            if (!$exists) { remove_dir($directory); if (++$deleted >= $limit) break; }
        } finally { fclose($lock); }
    }
}
