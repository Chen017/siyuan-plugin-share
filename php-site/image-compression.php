<?php
declare(strict_types=1);

// Published attachments are optimized through ShareFileWrite; only unpublished copies
// may be replaced in place. Client hashes always describe the original upload.
function image_compression_supported_extensions(): array {
    return ['png', 'jpg', 'jpeg', 'webp'];
}

function is_compressible_image_path(string $path): bool {
    return in_array(strtolower(pathinfo(str_replace('\\', '/', $path), PATHINFO_EXTENSION)), image_compression_supported_extensions(), true);
}

function image_compression_filter(): string {
    return "(LOWER(SUBSTR(asset_path, -4)) IN ('.png', '.jpg') OR LOWER(SUBSTR(asset_path, -5)) IN ('.jpeg', '.webp'))";
}

function image_compression_tools_status(): array {
    static $status = null;
    if ($status !== null) return $status;
    $status = [];
    foreach (['pngquant' => '--version', 'jpegoptim' => '--version', 'cwebp' => '-version'] as $tool => $flag) {
        $out = [];
        $code = 1;
        if (function_exists('exec')) @exec($tool . ' ' . $flag . ' 2>&1', $out, $code);
        $status[$tool] = ['available' => $code === 0 && !empty($out[0]) && function_exists('proc_open'), 'version' => $code === 0 ? trim((string)($out[0] ?? '')) : ''];
    }
    $info = extension_loaded('gd') && function_exists('gd_info') ? gd_info() : [];
    $status['gd'] = ['available' => !empty($info), 'png' => !empty($info['PNG Support']),
        'jpeg' => !empty($info['JPEG Support']), 'webp' => !empty($info['WebP Support'])];
    return $status;
}

/** No shell interpretation, no unbounded child output, and a deadline per image. */
function run_image_compression_tool(array $arguments, float $timeout = 20.0): bool {
    if (!function_exists('proc_open')) return false;
    $null = PHP_OS_FAMILY === 'Windows' ? 'NUL' : '/dev/null';
    $process = @proc_open($arguments, [0 => ['file', $null, 'r'], 1 => ['file', $null, 'w'], 2 => ['file', $null, 'w']], $pipes, null, null, ['bypass_shell' => true]);
    if (!is_resource($process)) return false;
    $deadline = microtime(true) + $timeout;
    do {
        $state = proc_get_status($process);
        if (!$state['running']) {
            $code = $state['exitcode'];
            proc_close($process);
            return $code === 0;
        }
        if (microtime(true) >= $deadline) {
            proc_terminate($process, 9);
            proc_close($process);
            return false;
        }
        usleep(10000);
    } while (true);
}

/** Skip animation and metadata that a raster fallback cannot preserve. */
function image_compression_png_is_plain(string $path): bool {
    $stream = @fopen($path, 'rb');
    if ($stream === false) return false;
    try {
        if (fread($stream, 8) !== "\x89PNG\r\n\x1a\n") return false;
        $size = (int)filesize($path);
        for ($n = 0; $n < 10000 && ftell($stream) + 12 <= $size; $n++) {
            $header = fread($stream, 8);
            if (strlen($header) !== 8) return false;
            $length = unpack('N', substr($header, 0, 4))[1];
            $type = substr($header, 4, 4);
            if (in_array($type, ['acTL', 'eXIf', 'iCCP', 'cHRM', 'gAMA', 'sRGB'], true)) return false;
            if ($length > $size - ftell($stream) - 4) return false;
            if ($type === 'IEND') return true;
            if (fseek($stream, $length + 4, SEEK_CUR) !== 0) return false;
        }
        return false;
    } finally { fclose($stream); }
}

function image_compression_webp_is_static(string $path): bool {
    $stream = @fopen($path, 'rb');
    if ($stream === false) return false;
    try {
        $header = fread($stream, 12);
        if (strlen($header) !== 12 || substr($header, 0, 4) !== 'RIFF' || substr($header, 8, 4) !== 'WEBP') return false;
        $size = (int)filesize($path);
        for ($n = 0; $n < 10000 && ftell($stream) + 8 <= $size; $n++) {
            $chunk = fread($stream, 8);
            if (strlen($chunk) !== 8) return false;
            $type = substr($chunk, 0, 4);
            $length = unpack('V', substr($chunk, 4, 4))[1];
            if ($length > $size - ftell($stream)) return false;
            if ($type === 'ANIM' || $type === 'ANMF') return false;
            if (fseek($stream, $length + ($length % 2), SEEK_CUR) !== 0) return false;
        }
        return true;
    } finally { fclose($stream); }
}

function compress_image_file(string $filePath): array {
    clearstatcache(true, $filePath);
    $size = is_file($filePath) ? (int)filesize($filePath) : 0;
    $result = ['status' => 'skipped', 'original_size' => $size, 'compressed_size' => $size,
        'saved_bytes' => 0, 'tool' => 'none', 'error' => null];
    if (!is_file($filePath) || !is_readable($filePath) || !is_writable($filePath)) {
        return array_replace($result, ['status' => 'failed', 'error' => 'File is not readable or writable']);
    }
    if ($size <= 0 || !is_compressible_image_path($filePath)) return $result;
    $ext = strtolower(pathinfo($filePath, PATHINFO_EXTENSION));
    $info = @getimagesize($filePath);
    $expected = ['png' => IMAGETYPE_PNG, 'jpg' => IMAGETYPE_JPEG, 'jpeg' => IMAGETYPE_JPEG, 'webp' => IMAGETYPE_WEBP];
    if (!$info || $info[2] !== $expected[$ext]) return $result;
    // Bound decoded memory before CLI/GD allocation (including copies and encoder work).
    $pixels = (float)$info[0] * (float)$info[1];
    $memoryLimit = ini_parse_quantity(ini_get('memory_limit'));
    if ($pixels <= 0 || $pixels > 16000000 || ($memoryLimit > 0 && $pixels * 12 + memory_get_usage(true) + 16777216 > $memoryLimit)) return $result;
    if ($ext === 'png' && !image_compression_png_is_plain($filePath)) return $result;
    if ($ext === 'webp' && !image_compression_webp_is_static($filePath)) return $result;
    $tmp = dirname($filePath) . '/.comp_' . bin2hex(random_bytes(8)) . '.' . $ext;
    $tools = image_compression_tools_status();
    $attempted = false;
    try {
        $ok = false;
        if ($ext === 'png' && $tools['pngquant']['available']) {
            $attempted = true;
            $result['tool'] = 'pngquant';
            // pngquant is lossy; the quality threshold is not a proof of visual identity.
            $ok = run_image_compression_tool(['pngquant', '--quality=75-90', '--skip-if-larger', '--force', '--output', $tmp, '--', $filePath]);
        } elseif (($ext === 'jpg' || $ext === 'jpeg') && $tools['jpegoptim']['available']) {
            $attempted = true;
            $result['tool'] = 'jpegoptim';
            // Lossless optimization keeps EXIF orientation and ICC profiles.
            $ok = copy($filePath, $tmp) && run_image_compression_tool(['jpegoptim', $tmp]);
        } elseif ($ext === 'webp' && $tools['cwebp']['available']) {
            $attempted = true;
            $result['tool'] = 'cwebp';
            $ok = run_image_compression_tool(['cwebp', '-lossless', '-exact', '-metadata', 'all', '-o', $tmp, $filePath]);
        }
        if (!$ok && $ext === 'png' && $tools['gd']['png']) {
            $attempted = true;
            $result['tool'] = 'gd';
            $image = @imagecreatefrompng($filePath);
            if ($image !== false) {
                try {
                    imagealphablending($image, false);
                    imagesavealpha($image, true);
                    $ok = @imagepng($image, $tmp, 9);
                } finally { imagedestroy($image); }
            }
        }
        clearstatcache(true, $tmp);
        if ($ok && is_file($tmp) && ($newSize = (int)filesize($tmp)) > 0 && $newSize < $size) {
            $outputInfo = @getimagesize($tmp);
            if (!$outputInfo || array_slice($outputInfo, 0, 3) !== array_slice($info, 0, 3)) {
                return array_replace($result, ['status' => 'failed', 'error' => 'Invalid optimizer output']);
            }
            if (!@rename($tmp, $filePath)) throw new RuntimeException('Unable to replace staged image');
            return array_replace($result, ['status' => 'compressed', 'compressed_size' => $newSize, 'saved_bytes' => $size - $newSize]);
        }
        // Without an encoder this remains pending and can be retried after installing tools.
        return array_replace($result, ['status' => $ok ? 'optimal' : 'failed',
            'error' => !$attempted ? 'No safe encoder is available for this format' : ($ok ? null : 'Encoder failed or timed out')]);
    } catch (Throwable $error) {
        return array_replace($result, ['status' => 'failed', 'error' => $error->getMessage()]);
    } finally { if (is_file($tmp)) @unlink($tmp); }
}

function optimize_share_asset_row(PDO $pdo, array $assetRow, bool $force = false): array {
    global $config;
    if (!$force && !empty($assetRow['compressed_at'])) return ['status' => 'already_compressed', 'saved_bytes' => 0];
    $root = realpath($config['uploads_dir']);
    $source = $root === false ? false : realpath($root . '/' . ($assetRow['file_path'] ?? ''));
    if ($source === false || !str_starts_with($source, $root . DIRECTORY_SEPARATOR) || !is_file($source)) {
        return ['status' => 'failed', 'saved_bytes' => 0, 'error' => 'Attachment is missing or outside uploads'];
    }
    $scratch = $root . '/staging/image-compression-' . bin2hex(random_bytes(16));
    $write = null;
    try {
        require_upload_space((int)filesize($source) * 2);
        ensure_dir($scratch);
        $copy = $scratch . '/' . basename($source);
        $sourceHash = hash_file('sha256', $source);
        if (!@copy($source, $copy) || hash_file('sha256', $copy) !== $sourceHash) throw new RuntimeException('Unable to copy attachment');
        $res = compress_image_file($copy);
        if ($res['status'] === 'failed') return $res;
        // Compression runs before the short SQLite write transaction. Recheck the row
        // after taking the existing publication lock so a concurrent sync always wins.
        $write = new ShareFileWrite($pdo);
        $stmt = $pdo->prepare('SELECT * FROM share_assets WHERE id = ?');
        $stmt->execute([(int)$assetRow['id']]);
        $current = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$current || $current['file_path'] !== $assetRow['file_path'] || (!$force && !empty($current['compressed_at']))
            || !is_file($source) || hash_file('sha256', $source) !== $sourceHash) {
            $write->rollback();
            return ['status' => 'stale', 'saved_bytes' => 0];
        }
        $original = (int)$current['original_size_bytes'] ?: (int)$res['original_size'];
        $filePath = $current['file_path'];
        if ($res['status'] === 'compressed') {
            $write->rememberFile($current['file_path']);
            $filePath = $write->stage($copy, (int)$current['share_id'], $current['asset_path']);
        }
        $pdo->prepare('UPDATE share_assets SET file_path = ?, size_bytes = ?, original_size_bytes = ?, compressed_at = ? WHERE id = ?')
            ->execute([$filePath, $res['compressed_size'], $original, now(), $current['id']]);
        if ($res['status'] === 'compressed') {
            recalculate_share_size((int)$current['share_id']);
            $owner = $pdo->prepare('SELECT user_id FROM shares WHERE id = ?');
            $owner->execute([$current['share_id']]);
            recalculate_user_storage((int)$owner->fetchColumn());
        }
        $write->commit();
        return $res;
    } catch (Throwable $error) {
        if ($write !== null) $write->rollback();
        return ['status' => 'failed', 'saved_bytes' => 0, 'error' => $error->getMessage()];
    } finally { if (is_dir($scratch)) remove_dir($scratch); }
}

/** A cursor advances even on failure. Each job reviews its initial ID range once. */
function batch_compress_pending_images(PDO $pdo, int $limit = 100, int $afterId = 0, int $maxId = PHP_INT_MAX, ?callable $onAsset = null): array {
    $stmt = $pdo->prepare('SELECT * FROM share_assets WHERE compressed_at IS NULL AND ' . image_compression_filter() . ' AND id > :after AND id <= :max ORDER BY id LIMIT :limit');
    $stmt->bindValue(':after', $afterId, PDO::PARAM_INT);
    $stmt->bindValue(':max', $maxId, PDO::PARAM_INT);
    $stmt->bindValue(':limit', max(1, min(1000, $limit)), PDO::PARAM_INT);
    $stmt->execute();
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    $res = ['checked' => 0, 'compressed' => 0, 'optimal' => 0, 'failed' => 0, 'skipped' => 0, 'saved_bytes' => 0, 'last_id' => $afterId];
    foreach ($rows as $row) {
        $item = optimize_share_asset_row($pdo, $row);
        $res['checked']++;
        $res['last_id'] = (int)$row['id'];
        $key = in_array($item['status'], ['compressed', 'optimal', 'failed'], true) ? $item['status'] : 'skipped';
        $res[$key]++;
        $res['saved_bytes'] += (int)$item['saved_bytes'];
        if ($onAsset !== null && !$onAsset($res)) break;
    }
    $res['remaining_pending'] = count_pending_images($pdo);
    return $res;
}

function count_pending_images(PDO $pdo): int {
    return (int)$pdo->query('SELECT COUNT(*) FROM share_assets WHERE compressed_at IS NULL AND ' . image_compression_filter())->fetchColumn();
}

function get_image_compression_stats(PDO $pdo): array {
    $filter = image_compression_filter();
    $row = $pdo->query("SELECT COUNT(*) AS total,
        COALESCE(SUM(compressed_at IS NOT NULL), 0) AS reviewed,
        COALESCE(SUM(compressed_at IS NOT NULL AND original_size_bytes > size_bytes), 0) AS compressed,
        COALESCE(SUM(CASE WHEN original_size_bytes > 0 THEN original_size_bytes ELSE size_bytes END), 0) AS original,
        COALESCE(SUM(size_bytes), 0) AS current FROM share_assets WHERE {$filter}")->fetch(PDO::FETCH_ASSOC);
    return ['total_images' => (int)$row['total'], 'processed_images' => (int)$row['reviewed'],
        'compressed_images' => (int)$row['compressed'], 'pending_images' => (int)$row['total'] - (int)$row['reviewed'],
        'saved_bytes' => max(0, (int)$row['original'] - (int)$row['current']),
        'total_original_bytes' => (int)$row['original'], 'total_current_bytes' => (int)$row['current'],
        'tools' => image_compression_tools_status()];
}

function image_compression_task_file(): string {
    global $config;
    $directory = dirname($config['db_path']);
    ensure_dir($directory);
    return $directory . '/image-compression-task.json';
}

function image_compression_worker_lock() {
    $lock = fopen(dirname(image_compression_task_file()) . '/image-compression-worker.lock', 'c');
    if ($lock === false) throw new RuntimeException('Unable to open compression worker lock');
    if (!flock($lock, LOCK_EX | LOCK_NB)) { fclose($lock); return false; }
    return $lock;
}

function image_compression_default_task(): array {
    return ['status' => 'idle', 'job_id' => '', 'pid' => 0, 'started_at' => null, 'updated_at' => null, 'completed_at' => null,
        'total' => 0, 'checked' => 0, 'compressed' => 0, 'optimal' => 0, 'skipped' => 0, 'failed' => 0,
        'saved_bytes' => 0, 'remaining' => 0, 'last_id' => 0, 'max_id' => 0, 'stop_requested' => false, 'error' => null];
}

/** All control and heartbeat updates share one lock and preserve stop requests. */
function update_image_compression_task(callable $change): array {
    $file = image_compression_task_file();
    $lock = fopen($file . '.lock', 'c');
    if ($lock === false) throw new RuntimeException('Unable to open compression status lock');
    $tmp = null;
    try {
        if (!flock($lock, LOCK_EX)) throw new RuntimeException('Unable to lock compression status');
        $data = is_file($file) ? json_decode((string)file_get_contents($file), true) : [];
        $task = array_replace(image_compression_default_task(), is_array($data) ? $data : []);
        $updated = $change($task);
        if ($updated !== $task) {
            $tmp = $file . '.' . bin2hex(random_bytes(6)) . '.tmp';
            if (file_put_contents($tmp, json_encode($updated, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE)) === false || !rename($tmp, $file)) {
                throw new RuntimeException('Unable to save compression status');
            }
        }
        return $updated;
    } finally {
        if ($tmp !== null && is_file($tmp)) @unlink($tmp);
        fclose($lock);
    }
}

function get_background_compression_status(): array {
    return update_image_compression_task(function (array $task): array {
        if ($task['status'] !== 'running') return $task;
        $lock = image_compression_worker_lock();
        if ($lock !== false) {
            fclose($lock);
            if ((int)$task['pid'] > 0 || time() - (int)$task['started_at'] > 30) {
                $task['status'] = 'failed';
                $task['error'] = 'The worker stopped. Pending images can be retried.';
                $task['updated_at'] = time();
            }
        }
        return $task;
    });
}

/** Upload publication stays fast: encoding begins only after commit and response. */
function schedule_image_compression_after_response(): void {
    if (PHP_SAPI === 'cli' || defined('SIYUAN_CLI_BOOTSTRAP_ONLY')) return;
    static $scheduled = false;
    if ($scheduled) return;
    $scheduled = true;
    register_shutdown_function(function (): void {
        if (function_exists('fastcgi_finish_request')) fastcgi_finish_request();
        try { start_background_compression_job(); }
        catch (Throwable $error) { error_log('Image optimization deferred: ' . $error->getMessage()); }
    });
}

function create_image_compression_job(): array {
    get_background_compression_status();
    $id = bin2hex(random_bytes(16));
    $pendingCount = count_pending_images(db());
    $task = update_image_compression_task(function (array $task) use ($id, $pendingCount): array {
        if ($task['status'] === 'running' || $pendingCount === 0) return $task;
        $lock = image_compression_worker_lock();
        if ($lock === false) return $task;
        fclose($lock);
        $pending = db()->query('SELECT COUNT(*) AS total, COALESCE(MAX(id), 0) AS max_id FROM share_assets WHERE compressed_at IS NULL AND ' . image_compression_filter())->fetch(PDO::FETCH_ASSOC);
        return array_replace(image_compression_default_task(), ['status' => 'running', 'job_id' => $id,
            'started_at' => time(), 'updated_at' => time(), 'total' => (int)$pending['total'], 'remaining' => (int)$pending['total'],
            'max_id' => (int)$pending['max_id']]);
    });
    if ($task['job_id'] !== $id) return ['success' => false, 'message' => $pendingCount === 0 ? 'No pending images to optimize.' : 'A background optimization task is already running.', 'data' => $task];
    return ['success' => true, 'data' => $task];
}

function start_background_compression_job(): array {
    if (!function_exists('exec') || !function_exists('proc_open')) return ['success' => false, 'message' => 'Background execution is unavailable on this server.'];
    $created = create_image_compression_job();
    // A finishing worker publishes terminal state just before releasing its lease.
    for ($n = 0; !$created['success'] && ($created['data']['status'] ?? 'running') !== 'running' && count_pending_images(db()) > 0 && $n < 5; $n++) {
        usleep(20000);
        $created = create_image_compression_job();
    }
    if (!$created['success']) return $created;
    $id = $created['data']['job_id'];
    $php = PHP_BINARY;
    if (str_contains(strtolower($php), 'fpm')) $php = is_executable('/usr/local/bin/php') ? '/usr/local/bin/php' : '/usr/bin/php';
    $script = __DIR__ . '/background-compress.php';
    $log = dirname(image_compression_task_file()) . '/image-compression.log';
    if (PHP_OS_FAMILY === 'Windows') {
        // cmd start requires a separate empty window title. /B keeps the process hidden.
        $cmd = 'start "" /B ' . escapeshellarg($php) . ' ' . escapeshellarg($script) . ' ' . escapeshellarg($id) . ' > ' . escapeshellarg($log) . ' 2>&1';
        $handle = @popen($cmd, 'r');
        if (is_resource($handle)) pclose($handle);
    } else {
        @exec(escapeshellarg($php) . ' ' . escapeshellarg($script) . ' ' . escapeshellarg($id) . ' > ' . escapeshellarg($log) . ' 2>&1 &');
    }
    // Confirm the worker acknowledged this job; do not report a failed spawn as success.
    for ($n = 0; $n < 100; $n++) {
        usleep(20000);
        $task = get_background_compression_status();
        if ((int)$task['pid'] > 0 || $task['status'] !== 'running') break;
    }
    if ((int)$task['pid'] === 0) {
        $task = update_image_compression_task(function (array $task) use ($id): array {
            if ($task['job_id'] === $id && (int)$task['pid'] === 0) {
                $task['status'] = 'failed';
                $task['error'] = 'Unable to start the background worker. Check the private server log.';
            }
            return $task;
        });
    }
    $success = (int)$task['pid'] > 0;
    return ['success' => $success, 'message' => $success ? 'Background image optimization started. You can leave this page.' : (string)$task['error'], 'data' => $task];
}

function request_stop_background_compression(): array {
    $task = update_image_compression_task(function (array $task): array {
        if ($task['status'] === 'running') $task['stop_requested'] = true;
        return $task;
    });
    return ['success' => $task['status'] === 'running', 'message' => $task['status'] === 'running'
        ? 'Stop requested. The worker will finish its current image safely.' : 'No background optimization task is running.'];
}

/** Shared worker for HTTP and CLI. The OS lock, never a reusable PID, owns the job. */
function run_background_compression_job(string $id, int $limit = 20): int {
    $lock = image_compression_worker_lock();
    if ($lock === false) return 1;
    try {
        $task = update_image_compression_task(function (array $task) use ($id): array {
            if ($task['job_id'] === $id && $task['status'] === 'running') {
                $task['pid'] = getmypid();
                $task['updated_at'] = time();
            }
            return $task;
        });
        if ($task['job_id'] !== $id || $task['status'] !== 'running') return 1;
        while (true) {
            if ($task['stop_requested']) {
                update_image_compression_task(function (array $current) use ($id): array {
                    if ($current['job_id'] === $id) $current['status'] = 'stopped';
                    return $current;
                });
                return 0;
            }
            $base = $task;
            $res = batch_compress_pending_images(db(), $limit, (int)$task['last_id'], (int)$task['max_id'], function (array $progress) use ($id, $base): bool {
                // Exact remaining counts are refreshed per batch and by status polls.
                $remaining = max(0, (int)$base['remaining'] - $progress['compressed'] - $progress['optimal'] - $progress['skipped']);
                $task = update_image_compression_task(function (array $task) use ($id, $base, $progress, $remaining): array {
                    if ($task['job_id'] !== $id) throw new RuntimeException('Compression job was replaced');
                    foreach (['checked', 'compressed', 'optimal', 'skipped', 'failed', 'saved_bytes'] as $key) $task[$key] = (int)$base[$key] + $progress[$key];
                    $task['last_id'] = $progress['last_id'];
                    $task['remaining'] = $remaining;
                    $task['updated_at'] = time();
                    return $task;
                });
                return !$task['stop_requested'];
            });
            $task = update_image_compression_task(function (array $task) use ($id, $res): array {
                if ($task['job_id'] !== $id) throw new RuntimeException('Compression job was replaced');
                $task['remaining'] = $res['remaining_pending'];
                if ($task['stop_requested']) $task['status'] = 'stopped';
                elseif ($res['checked'] === 0) {
                    // Uploads committed during the job are reviewed too; failures at
                    // earlier IDs stay pending until a new, explicitly bounded retry.
                    $next = db()->prepare('SELECT COUNT(*) AS total, COALESCE(MAX(id), 0) AS max_id FROM share_assets WHERE compressed_at IS NULL AND ' . image_compression_filter() . ' AND id > ?');
                    $next->execute([(int)$task['max_id']]);
                    $pending = $next->fetch(PDO::FETCH_ASSOC);
                    if ((int)$pending['total'] > 0) {
                        $task['total'] += (int)$pending['total'];
                        $task['max_id'] = (int)$pending['max_id'];
                        $task['updated_at'] = time();
                        return $task;
                    }
                    $task['status'] = $task['failed'] > 0 ? 'failed' : 'completed';
                    $task['completed_at'] = time();
                    if ($task['failed'] > 0) $task['error'] = 'Some images could not be optimized. Check files and encoders, then retry.';
                }
                $task['updated_at'] = time();
                return $task;
            });
            if ($task['status'] !== 'running') return $task['status'] === 'failed' ? 1 : 0;
        }
    } catch (Throwable $error) {
        update_image_compression_task(function (array $task) use ($id, $error): array {
            if ($task['job_id'] === $id) {
                $task['status'] = 'failed';
                $task['error'] = $error->getMessage();
                $task['updated_at'] = time();
            }
            return $task;
        });
        return 1;
    } finally { fclose($lock); }
}

function render_image_compression_admin_section(): string {
    $stats = get_image_compression_stats(db());
    $task = get_background_compression_status();
    $base = htmlspecialchars(base_path(), ENT_QUOTES, 'UTF-8');
    $statusUrl = $task['status'] === 'running' ? ' data-status-url="' . htmlspecialchars(base_path() . '/admin/images/status', ENT_QUOTES, 'UTF-8') . '"' : '';
    $html = '<section class="card settings-section" id="image-compression" aria-labelledby="image-compression-heading"' . $statusUrl . '>';
    $html .= '<h2 id="image-compression-heading">Image compression</h2><p class="muted">New uploads are optimized automatically. Review existing PNG, JPEG and WebP images in the background; you can leave this page after starting.</p>';
    $html .= '<p class="field-hint">PNG optimization may change colors slightly. Animated images and images requiring special color or orientation handling are preserved. Images are replaced only when the result is smaller.</p>';
    $html .= '<dl class="image-compression-stats">';
    foreach (['total' => ['Total images', $stats['total_images']], 'compressed' => ['Smaller images', $stats['compressed_images']],
        'pending' => ['Pending review', $stats['pending_images']], 'saved' => ['Space saved', format_bytes((float)$stats['saved_bytes'])]] as $id => [$label, $value]) {
        $html .= '<div><dt>' . $label . '</dt><dd id="img-stat-' . $id . '">' . htmlspecialchars((string)$value) . '</dd></div>';
    }
    $html .= '</dl><details><summary>Optimization support</summary><p class="muted">';
    $tools = [];
    foreach (['pngquant', 'jpegoptim', 'cwebp'] as $name) $tools[] = $name . ': ' . ($stats['tools'][$name]['available'] ? 'available' : 'unavailable');
    $tools[] = 'PNG fallback: ' . ($stats['tools']['gd']['png'] ? 'available' : 'unavailable');
    $html .= htmlspecialchars(implode(' · ', $tools)) . '</p></details>';
    if ($task['status'] === 'running') {
        $html .= '<div class="image-compression-status"><p><strong>Background optimization in progress</strong></p>';
        $html .= '<progress id="bg-task-progress-bar" aria-label="Images reviewed" value="' . (int)$task['checked'] . '" max="' . max(1, (int)$task['total']) . '"></progress>';
        $html .= '<p id="bg-task-progress-text" role="status" aria-live="polite">Reviewed ' . (int)$task['checked'] . ' / ' . (int)$task['total'] . ' · ' . (int)$task['remaining'] . ' pending</p>';
        $html .= '<form class="inline-form" method="post" action="' . $base . '/admin/images/compress-stop">' . render_hidden_inputs(['csrf' => csrf_token()]);
        $html .= '<button class="button" type="submit"' . ($task['stop_requested'] ? ' disabled' : '') . '>' . ($task['stop_requested'] ? 'Stopping after current image…' : 'Stop optimization') . '</button></form></div>';
    } elseif ($task['status'] === 'completed') {
        $html .= '<p role="status">Optimization review completed. Reviewed ' . (int)$task['checked'] . ' images; ' . (int)$task['compressed'] . ' became smaller. Space saved: ' . format_bytes((float)$task['saved_bytes']) . '.</p>';
    } elseif ($task['status'] === 'stopped') {
        $html .= '<p role="status">Optimization stopped safely. ' . (int)$stats['pending_images'] . ' images are pending review.</p>';
    } elseif ($task['status'] === 'failed') {
        $html .= '<p role="status">Optimization needs attention. ' . htmlspecialchars((string)$task['error']) . '</p>';
    }
    if ($task['status'] !== 'running') {
        $html .= '<form class="settings-form" method="post" action="' . $base . '/admin/images/compress">' . render_hidden_inputs(['csrf' => csrf_token()]);
        $html .= '<button class="button primary" type="submit"' . ($stats['pending_images'] === 0 ? ' disabled' : '') . '>' . ($stats['pending_images'] > 0 ? 'Optimize pending images' : 'No images pending review') . '</button></form>';
    }
    $html .= '<p id="image-compression-connection" class="field-hint" role="status"></p></section>';
    return $html;
}
