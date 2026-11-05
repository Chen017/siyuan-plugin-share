<?php
declare(strict_types=1);

/**
 * Image compression engine for SiYuan Share.
 * Provides perceptually lossless compression (TinyPNG-like) for PNG, JPEG, and WebP using:
 * 1. CLI tools: pngquant (quantization for PNG) and jpegoptim (lossless/near-lossless optimization for JPEG).
 * 2. PHP GD fallback: Native palette quantization, PNG recompression, and JPEG quality tuning.
 */

function image_compression_supported_extensions(): array {
    return ['png', 'jpg', 'jpeg', 'webp'];
}

function is_compressible_image_path(string $path): bool {
    $path = trim(str_replace('\\', '/', $path));
    $ext = strtolower(pathinfo($path, PATHINFO_EXTENSION));
    return in_array($ext, image_compression_supported_extensions(), true);
}

function image_compression_tools_status(): array {
    static $status = null;
    if ($status !== null) {
        return $status;
    }

    $hasPngquant = false;
    $pngquantVersion = '';
    $hasJpegoptim = false;
    $jpegoptimVersion = '';
    $hasCwebp = false;
    $cwebpVersion = '';

    if (function_exists('exec')) {
        $out = [];
        $code = 0;
        @exec('pngquant --version 2>&1', $out, $code);
        if ($code === 0 && !empty($out[0])) {
            $hasPngquant = true;
            $pngquantVersion = trim((string)$out[0]);
        }

        $out = [];
        $code = 0;
        @exec('jpegoptim --version 2>&1', $out, $code);
        if ($code === 0 && !empty($out[0])) {
            $hasJpegoptim = true;
            $jpegoptimVersion = trim((string)$out[0]);
        }

        $out = [];
        $code = 0;
        @exec('cwebp -version 2>&1', $out, $code);
        if ($code === 0 && !empty($out[0])) {
            $hasCwebp = true;
            $cwebpVersion = trim((string)$out[0]);
        }
    }

    $gdLoaded = extension_loaded('gd');
    $gdInfo = $gdLoaded && function_exists('gd_info') ? gd_info() : [];
    $hasGdPng = !empty($gdInfo['PNG Support']);
    $hasGdJpeg = !empty($gdInfo['JPEG Support']) || !empty($gdInfo['JPG Support']);
    $hasGdWebp = !empty($gdInfo['WebP Support']);

    $status = [
        'pngquant' => [
            'available' => $hasPngquant,
            'version' => $pngquantVersion,
        ],
        'jpegoptim' => [
            'available' => $hasJpegoptim,
            'version' => $jpegoptimVersion,
        ],
        'cwebp' => [
            'available' => $hasCwebp,
            'version' => $cwebpVersion,
        ],
        'gd' => [
            'available' => $gdLoaded,
            'png' => $hasGdPng,
            'jpeg' => $hasGdJpeg,
            'webp' => $hasGdWebp,
        ],
    ];
    return $status;
}

/**
 * Safely compress an image file on disk in place.
 * Returns an array with details:
 * [
 *   'status' => 'compressed' | 'optimal' | 'skipped' | 'failed',
 *   'original_size' => int,
 *   'compressed_size' => int,
 *   'saved_bytes' => int,
 *   'tool' => string,
 *   'error' => ?string,
 * ]
 */
function compress_image_file(string $filePath): array {
    if (!is_file($filePath) || !is_readable($filePath) || !is_writable($filePath)) {
        return [
            'status' => 'failed',
            'original_size' => 0,
            'compressed_size' => 0,
            'saved_bytes' => 0,
            'tool' => 'none',
            'error' => 'File is not readable or writable',
        ];
    }

    $ext = strtolower(pathinfo($filePath, PATHINFO_EXTENSION));
    if (!is_compressible_image_path($filePath)) {
        $size = (int)filesize($filePath);
        return [
            'status' => 'skipped',
            'original_size' => $size,
            'compressed_size' => $size,
            'saved_bytes' => 0,
            'tool' => 'none',
            'error' => null,
        ];
    }

    $origSize = (int)filesize($filePath);
    if ($origSize <= 0) {
        return [
            'status' => 'skipped',
            'original_size' => 0,
            'compressed_size' => 0,
            'saved_bytes' => 0,
            'tool' => 'none',
            'error' => null,
        ];
    }

    $dir = dirname($filePath);
    $tmpOutput = $dir . '/.comp_' . bin2hex(random_bytes(8)) . '.' . $ext;
    $tools = image_compression_tools_status();
    $usedTool = 'none';
    $compressed = false;

    try {
        if ($ext === 'png') {
            if ($tools['pngquant']['available']) {
                // pngquant: TinyPNG equivalent quantization algorithm.
                // --quality=75-90: High-fidelity visual quality range.
                // --skip-if-larger: Do not write output if it exceeds input size.
                // --strip: Remove optional metadata chunks.
                $cmd = 'pngquant --quality=75-90 --skip-if-larger --strip --force --output ' . escapeshellarg($tmpOutput) . ' ' . escapeshellarg($filePath) . ' 2>&1';
                $out = [];
                $code = 0;
                @exec($cmd, $out, $code);
                if ($code === 0 && is_file($tmpOutput)) {
                    $newSize = (int)filesize($tmpOutput);
                    if ($newSize > 0 && $newSize < $origSize) {
                        $usedTool = 'pngquant';
                        $compressed = true;
                    }
                }
            }

            // Fallback to PHP GD if pngquant was not available or did not produce smaller output
            if (!$compressed && $tools['gd']['available'] && $tools['gd']['png'] && function_exists('imagecreatefrompng') && function_exists('imagepng')) {
                $im = @imagecreatefrompng($filePath);
                if ($im !== false) {
                    imagealphablending($im, false);
                    imagesavealpha($im, true);
                    if (@imagepng($im, $tmpOutput, 9)) {
                        $newSize = (int)filesize($tmpOutput);
                        if ($newSize > 0 && $newSize < $origSize) {
                            $usedTool = 'gd';
                            $compressed = true;
                        }
                    }
                    imagedestroy($im);
                }
            }
        } elseif ($ext === 'jpg' || $ext === 'jpeg') {
            if ($tools['jpegoptim']['available']) {
                if (@copy($filePath, $tmpOutput)) {
                    $cmd = 'jpegoptim --strip-all -m85 ' . escapeshellarg($tmpOutput) . ' 2>&1';
                    $out = [];
                    $code = 0;
                    @exec($cmd, $out, $code);
                    if ($code === 0 && is_file($tmpOutput)) {
                        $newSize = (int)filesize($tmpOutput);
                        if ($newSize > 0 && $newSize < $origSize) {
                            $usedTool = 'jpegoptim';
                            $compressed = true;
                        }
                    }
                }
            }

            // Fallback to PHP GD
            if (!$compressed && $tools['gd']['available'] && $tools['gd']['jpeg'] && function_exists('imagecreatefromjpeg') && function_exists('imagejpeg')) {
                $im = @imagecreatefromjpeg($filePath);
                if ($im !== false) {
                    if (@imagejpeg($im, $tmpOutput, 85)) {
                        $newSize = (int)filesize($tmpOutput);
                        if ($newSize > 0 && $newSize < $origSize) {
                            $usedTool = 'gd';
                            $compressed = true;
                        }
                    }
                    imagedestroy($im);
                }
            }
        } elseif ($ext === 'webp') {
            if ($tools['cwebp']['available']) {
                $cmd = 'cwebp -q 85 ' . escapeshellarg($filePath) . ' -o ' . escapeshellarg($tmpOutput) . ' 2>&1';
                $out = [];
                $code = 0;
                @exec($cmd, $out, $code);
                if ($code === 0 && is_file($tmpOutput)) {
                    $newSize = (int)filesize($tmpOutput);
                    if ($newSize > 0 && $newSize < $origSize) {
                        $usedTool = 'cwebp';
                        $compressed = true;
                    }
                }
            }

            if (!$compressed && $tools['gd']['available'] && $tools['gd']['webp'] && function_exists('imagecreatefromwebp') && function_exists('imagewebp')) {
                $im = @imagecreatefromwebp($filePath);
                if ($im !== false) {
                    imagealphablending($im, false);
                    imagesavealpha($im, true);
                    if (@imagewebp($im, $tmpOutput, 85)) {
                        $newSize = (int)filesize($tmpOutput);
                        if ($newSize > 0 && $newSize < $origSize) {
                            $usedTool = 'gd';
                            $compressed = true;
                        }
                    }
                    imagedestroy($im);
                }
            }
        }

        if ($compressed && is_file($tmpOutput)) {
            $finalSize = (int)filesize($tmpOutput);
            if ($finalSize > 0 && $finalSize < $origSize) {
                if (!@rename($tmpOutput, $filePath)) {
                    @unlink($tmpOutput);
                    return [
                        'status' => 'failed',
                        'original_size' => $origSize,
                        'compressed_size' => $origSize,
                        'saved_bytes' => 0,
                        'tool' => $usedTool,
                        'error' => 'Failed to replace file with compressed version',
                    ];
                }
                return [
                    'status' => 'compressed',
                    'original_size' => $origSize,
                    'compressed_size' => $finalSize,
                    'saved_bytes' => $origSize - $finalSize,
                    'tool' => $usedTool,
                    'error' => null,
                ];
            }
        }
    } catch (Throwable $e) {
        if (is_file($tmpOutput)) {
            @unlink($tmpOutput);
        }
        return [
            'status' => 'failed',
            'original_size' => $origSize,
            'compressed_size' => $origSize,
            'saved_bytes' => 0,
            'tool' => $usedTool,
            'error' => $e->getMessage(),
        ];
    } finally {
        if (is_file($tmpOutput)) {
            @unlink($tmpOutput);
        }
    }

    return [
        'status' => 'optimal',
        'original_size' => $origSize,
        'compressed_size' => $origSize,
        'saved_bytes' => 0,
        'tool' => $usedTool,
        'error' => null,
    ];
}

function optimize_share_asset_row(PDO $pdo, array $assetRow, bool $force = false): array {
    global $config;
    if (!$force && !empty($assetRow['compressed_at'])) {
        return ['status' => 'already_compressed', 'saved_bytes' => 0];
    }
    $filePath = (string)($assetRow['file_path'] ?? '');
    if ($filePath === '') {
        return ['status' => 'missing_file', 'saved_bytes' => 0];
    }
    $uploadsDir = rtrim((string)($config['uploads_dir'] ?? (__DIR__ . '/uploads')), '/\\');
    $fullPath = $uploadsDir . '/' . ltrim($filePath, '/\\');
    if (!is_file($fullPath)) {
        return ['status' => 'missing_file', 'saved_bytes' => 0];
    }

    $assetPath = (string)($assetRow['asset_path'] ?? '');
    if (!is_compressible_image_path($assetPath)) {
        $stmt = $pdo->prepare('UPDATE share_assets SET compressed_at = :at, original_size_bytes = :orig WHERE id = :id');
        $stmt->execute([
            ':at' => now(),
            ':orig' => (int)($assetRow['size_bytes'] ?? 0),
            ':id' => (int)$assetRow['id'],
        ]);
        return ['status' => 'skipped', 'saved_bytes' => 0];
    }

    $res = compress_image_file($fullPath);
    $orig = (int)($assetRow['original_size_bytes'] ?? 0);
    if ($orig <= 0) {
        $orig = (int)($res['original_size'] ?? $assetRow['size_bytes'] ?? 0);
    }

    if ($res['status'] === 'compressed') {
        $stmt = $pdo->prepare('UPDATE share_assets SET size_bytes = :size, original_size_bytes = :orig, compressed_at = :at WHERE id = :id');
        $stmt->execute([
            ':size' => (int)$res['compressed_size'],
            ':orig' => $orig,
            ':at' => now(),
            ':id' => (int)$assetRow['id'],
        ]);
    } elseif ($res['status'] === 'optimal') {
        $stmt = $pdo->prepare('UPDATE share_assets SET original_size_bytes = :orig, compressed_at = :at WHERE id = :id');
        $stmt->execute([
            ':orig' => $orig,
            ':at' => now(),
            ':id' => (int)$assetRow['id'],
        ]);
    }
    return $res;
}

function batch_compress_pending_images(PDO $pdo, int $limit = 100): array {
    $stmt = $pdo->prepare('SELECT id, share_id, doc_id, asset_path, file_path, size_bytes, original_size_bytes, compressed_at
        FROM share_assets
        WHERE compressed_at IS NULL
        ORDER BY id ASC
        LIMIT :limit');
    $stmt->bindValue(':limit', max(1, $limit), PDO::PARAM_INT);
    $stmt->execute();
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

    $checked = 0;
    $compressed = 0;
    $optimal = 0;
    $failed = 0;
    $skipped = 0;
    $savedBytes = 0;
    $affectedShares = [];

    foreach ($rows as $row) {
        $checked++;
        $res = optimize_share_asset_row($pdo, $row);
        $status = $res['status'] ?? '';
        if ($status === 'compressed') {
            $compressed++;
            $savedBytes += (int)($res['saved_bytes'] ?? 0);
            $affectedShares[(int)$row['share_id']] = true;
        } elseif ($status === 'optimal') {
            $optimal++;
        } elseif ($status === 'skipped') {
            $skipped++;
        } else {
            $failed++;
        }
    }

    if (!empty($affectedShares)) {
        $userStmt = $pdo->prepare('SELECT DISTINCT user_id FROM shares WHERE id = ?');
        foreach (array_keys($affectedShares) as $shareId) {
            recalculate_share_size((int)$shareId);
            $userStmt->execute([$shareId]);
            $uid = (int)$userStmt->fetchColumn();
            if ($uid > 0) {
                recalculate_user_storage($uid);
            }
        }
    }

    $imageFilter = " (LOWER(SUBSTR(asset_path, -4)) IN ('.png', '.jpg', '.gif') OR LOWER(SUBSTR(asset_path, -5)) IN ('.jpeg', '.webp'))";
    $pendingStmt = $pdo->query("SELECT COUNT(*) FROM share_assets WHERE compressed_at IS NULL AND {$imageFilter}");
    $remaining = (int)($pendingStmt ? $pendingStmt->fetchColumn() : 0);

    return [
        'checked' => $checked,
        'compressed' => $compressed,
        'optimal' => $optimal,
        'failed' => $failed,
        'skipped' => $skipped,
        'saved_bytes' => $savedBytes,
        'remaining_pending' => $remaining,
    ];
}

function get_image_compression_stats(PDO $pdo): array {
    $imageFilter = " (LOWER(SUBSTR(asset_path, -4)) IN ('.png', '.jpg', '.gif') OR LOWER(SUBSTR(asset_path, -5)) IN ('.jpeg', '.webp'))";

    $totalStmt = $pdo->query("SELECT COUNT(*) FROM share_assets WHERE {$imageFilter}");
    $totalCount = (int)($totalStmt ? $totalStmt->fetchColumn() : 0);

    $compStmt = $pdo->query("SELECT COUNT(*) AS cnt,
            COALESCE(SUM(CASE WHEN original_size_bytes > 0 THEN original_size_bytes ELSE size_bytes END), 0) AS total_orig,
            COALESCE(SUM(size_bytes), 0) AS total_curr
        FROM share_assets
        WHERE compressed_at IS NOT NULL AND {$imageFilter}");
    $compRow = $compStmt ? $compStmt->fetch(PDO::FETCH_ASSOC) : [];
    $compressedCount = (int)($compRow['cnt'] ?? 0);
    $totalOriginal = (int)($compRow['total_orig'] ?? 0);
    $totalCurrent = (int)($compRow['total_curr'] ?? 0);
    $savedBytes = max(0, $totalOriginal - $totalCurrent);

    $pendingStmt = $pdo->query("SELECT COUNT(*) FROM share_assets WHERE compressed_at IS NULL AND {$imageFilter}");
    $pendingCount = (int)($pendingStmt ? $pendingStmt->fetchColumn() : 0);

    return [
        'total_images' => $totalCount,
        'compressed_images' => $compressedCount,
        'pending_images' => $pendingCount,
        'saved_bytes' => $savedBytes,
        'total_original_bytes' => $totalOriginal,
        'total_current_bytes' => $totalCurrent,
        'tools' => image_compression_tools_status(),
    ];
}

function image_compression_task_file(): string {
    global $config;
    $storageDir = isset($config['db_path']) ? dirname((string)$config['db_path']) : (__DIR__ . '/storage');
    if (!is_dir($storageDir)) {
        @mkdir($storageDir, 0775, true);
    }
    return $storageDir . '/image-compression-task.json';
}

function get_background_compression_status(): array {
    $file = image_compression_task_file();
    $default = [
        'status' => 'idle',
        'pid' => 0,
        'started_at' => null,
        'updated_at' => null,
        'completed_at' => null,
        'total' => 0,
        'checked' => 0,
        'compressed' => 0,
        'optimal' => 0,
        'skipped' => 0,
        'failed' => 0,
        'saved_bytes' => 0,
        'remaining' => 0,
        'stop_requested' => false,
        'error' => null,
    ];

    if (!is_file($file)) {
        return $default;
    }

    $raw = @file_get_contents($file);
    if (!is_string($raw) || trim($raw) === '') {
        return $default;
    }

    $data = json_decode($raw, true);
    if (!is_array($data)) {
        return $default;
    }

    $status = array_merge($default, $data);

    // Stale task recovery: if marked 'running' but no heartbeat for > 120s or PID is dead
    if ($status['status'] === 'running') {
        $now = time();
        $updatedAt = (int)($status['updated_at'] ?? 0);
        $pid = (int)($status['pid'] ?? 0);

        $isDead = false;
        if ($updatedAt > 0 && ($now - $updatedAt) > 120) {
            $isDead = true;
        } elseif ($pid > 0 && function_exists('posix_kill')) {
            if (!@posix_kill($pid, 0)) {
                $isDead = true;
            }
        }

        if ($isDead) {
            $status['status'] = 'stopped';
            $status['error'] = 'Process stopped unexpectedly or heartbeat timed out.';
            set_background_compression_status($status);
        }
    }

    return $status;
}

function set_background_compression_status(array $data): void {
    $file = image_compression_task_file();
    $tmp = $file . '.' . bin2hex(random_bytes(6)) . '.tmp';
    @file_put_contents($tmp, json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));
    @rename($tmp, $file);
}

function start_background_compression_job(): array {
    $task = get_background_compression_status();
    if ($task['status'] === 'running') {
        return [
            'success' => false,
            'message' => 'A background compression task is already running (PID ' . ($task['pid'] ?: '?') . ').',
            'data' => $task,
        ];
    }

    $pdo = db();
    $stats = get_image_compression_stats($pdo);
    if ($stats['pending_images'] === 0) {
        return [
            'success' => false,
            'message' => 'All images are already compressed. Nothing to do.',
            'data' => $task,
        ];
    }

    $initial = [
        'status' => 'running',
        'pid' => 0,
        'started_at' => time(),
        'updated_at' => time(),
        'completed_at' => null,
        'total' => $stats['pending_images'],
        'checked' => 0,
        'compressed' => 0,
        'optimal' => 0,
        'skipped' => 0,
        'failed' => 0,
        'saved_bytes' => 0,
        'remaining' => $stats['pending_images'],
        'stop_requested' => false,
        'error' => null,
    ];
    set_background_compression_status($initial);

    // Identify PHP CLI executable
    $phpBin = PHP_BINARY;
    if (str_contains(strtolower($phpBin), 'fpm') || !is_executable($phpBin)) {
        if (is_executable('/usr/local/bin/php')) {
            $phpBin = '/usr/local/bin/php';
        } elseif (is_executable('/usr/bin/php')) {
            $phpBin = '/usr/bin/php';
        } else {
            $phpBin = 'php';
        }
    }

    $scriptPath = __DIR__ . '/background-compress.php';
    $logPath = dirname(image_compression_task_file()) . '/image-compression.log';

    if (stripos(PHP_OS, 'WIN') === 0) {
        $cmd = 'start /B ' . escapeshellarg($phpBin) . ' ' . escapeshellarg($scriptPath) . ' > ' . escapeshellarg($logPath) . ' 2>&1';
        @pclose(@popen($cmd, 'r'));
    } else {
        $cmd = sprintf('%s %s > %s 2>&1 &', escapeshellarg($phpBin), escapeshellarg($scriptPath), escapeshellarg($logPath));
        @exec($cmd);
    }

    usleep(80000); // 80ms to allow script to write PID
    $task = get_background_compression_status();

    return [
        'success' => true,
        'message' => 'Background image optimization started! You can close or navigate away from this page; optimization will continue until all images are compressed.',
        'data' => $task,
    ];
}

function request_stop_background_compression(): array {
    $task = get_background_compression_status();
    if ($task['status'] !== 'running') {
        return [
            'success' => false,
            'message' => 'No background compression task is currently running.',
        ];
    }

    $task['stop_requested'] = true;
    set_background_compression_status($task);

    $pid = (int)($task['pid'] ?? 0);
    if ($pid > 0 && function_exists('posix_kill')) {
        @posix_kill($pid, 15); // SIGTERM
    }

    return [
        'success' => true,
        'message' => 'Stop signal sent. The background process will stop after finishing its current batch.',
    ];
}

function render_image_compression_admin_section(): string {
    $pdo = db();
    $stats = get_image_compression_stats($pdo);
    $tools = $stats['tools'];
    $task = get_background_compression_status();

    $toolsList = [];
    if ($tools['pngquant']['available']) {
        $toolsList[] = '<span class="status-badge" style="display:inline-block; padding:3px 8px; border-radius:4px; font-size:0.75rem; background:#e8f5e9; color:#2e7d32; border:1px solid #c8e6c9;" title="' . htmlspecialchars($tools['pngquant']['version']) . '">✓ pngquant (TinyPNG engine)</span>';
    } else {
        $toolsList[] = '<span class="status-badge" style="display:inline-block; padding:3px 8px; border-radius:4px; font-size:0.75rem; background:#f5f5f5; color:#757575; border:1px solid #e0e0e0;" title="CLI binary not detected in PATH">pngquant (not installed)</span>';
    }
    if ($tools['jpegoptim']['available']) {
        $toolsList[] = '<span class="status-badge" style="display:inline-block; padding:3px 8px; border-radius:4px; font-size:0.75rem; background:#e8f5e9; color:#2e7d32; border:1px solid #c8e6c9;" title="' . htmlspecialchars($tools['jpegoptim']['version']) . '">✓ jpegoptim</span>';
    } else {
        $toolsList[] = '<span class="status-badge" style="display:inline-block; padding:3px 8px; border-radius:4px; font-size:0.75rem; background:#f5f5f5; color:#757575; border:1px solid #e0e0e0;" title="CLI binary not detected in PATH">jpegoptim (not installed)</span>';
    }
    if ($tools['gd']['available']) {
        $toolsList[] = '<span class="status-badge" style="display:inline-block; padding:3px 8px; border-radius:4px; font-size:0.75rem; background:#e8f5e9; color:#2e7d32; border:1px solid #c8e6c9;">✓ PHP GD fallback</span>';
    }

    $base = base_path();
    $savedFormatted = format_bytes((float)$stats['saved_bytes']);

    $html = '<section class="card settings-section" id="image-compression">';
    $html .= '<h2>Image compression</h2>';
    $html .= '<p class="muted">Perceptually lossless image compression (TinyPNG-like pngquant, jpegoptim & GD fallback). New uploads are compressed automatically; use background optimization to compress all existing or historical images in a single run.</p>';

    $html .= '<div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 12px; margin: 16px 0;">';
    $html .= '<div style="padding:12px; background:var(--panel-bg, #f8f9fa); border:1px solid var(--border, #eee); border-radius:8px;">';
    $html .= '<span style="font-size:0.75rem; color:var(--muted); display:block;">Total images</span>';
    $html .= '<strong id="img-stat-total" style="font-size:1.35rem; font-variant-numeric:tabular-nums;">' . $stats['total_images'] . '</strong>';
    $html .= '</div>';

    $html .= '<div style="padding:12px; background:var(--panel-bg, #f8f9fa); border:1px solid var(--border, #eee); border-radius:8px;">';
    $html .= '<span style="font-size:0.75rem; color:var(--muted); display:block;">Compressed</span>';
    $html .= '<strong id="img-stat-compressed" style="font-size:1.35rem; font-variant-numeric:tabular-nums; color:#2e7d32;">' . $stats['compressed_images'] . '</strong>';
    $html .= '</div>';

    $html .= '<div style="padding:12px; background:var(--panel-bg, #f8f9fa); border:1px solid var(--border, #eee); border-radius:8px;">';
    $html .= '<span style="font-size:0.75rem; color:var(--muted); display:block;">Pending / uncompressed</span>';
    $html .= '<strong id="img-stat-pending" style="font-size:1.35rem; font-variant-numeric:tabular-nums; color:' . ($stats['pending_images'] > 0 ? '#e65100' : 'inherit') . ';">' . $stats['pending_images'] . '</strong>';
    $html .= '</div>';

    $html .= '<div style="padding:12px; background:var(--panel-bg, #f8f9fa); border:1px solid var(--border, #eee); border-radius:8px;">';
    $html .= '<span style="font-size:0.75rem; color:var(--muted); display:block;">Space saved</span>';
    $html .= '<strong id="img-stat-saved" style="font-size:1.35rem; font-variant-numeric:tabular-nums; color:#1976d2;">' . $savedFormatted . '</strong>';
    $html .= '</div>';
    $html .= '</div>';

    $html .= '<div style="margin: 12px 0; display:flex; gap:8px; flex-wrap:wrap;">' . implode(' ', $toolsList) . '</div>';

    // Background Task Status Banner
    if ($task['status'] === 'running') {
        $pct = $task['total'] > 0 ? round(($task['checked'] / $task['total']) * 100) : 0;
        $html .= '<div class="notice" style="margin: 16px 0; padding:16px; background:#e3f2fd; border:1px solid #90caf9; border-radius:8px; color:#0d47a1;">';
        $html .= '<div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">';
        $html .= '<strong>Background optimization in progress</strong>';
        if (!empty($task['pid'])) {
            $html .= '<small style="opacity:0.8;">PID: ' . htmlspecialchars((string)$task['pid']) . '</small>';
        }
        $html .= '</div>';
        $html .= '<progress id="bg-task-progress-bar" value="' . (int)$task['checked'] . '" max="' . max(1, (int)$task['total']) . '" style="width:100%; height:12px; margin: 10px 0; border-radius:4px;"></progress>';
        $html .= '<p id="bg-task-progress-text" style="margin:4px 0 8px; font-size:0.875rem;">Processed ' . (int)$task['checked'] . ' / ' . (int)$task['total'] . ' (' . $pct . '%) · ' . (int)$task['remaining'] . ' remaining</p>';
        $html .= '<p style="font-size:0.82rem; margin:0 0 12px; opacity:0.85;">This task is running detached in the background on the server. You can safely close your browser or navigate away from this page; optimization will continue until complete.</p>';
        $html .= '<form method="post" action="' . $base . '/admin/images/compress-stop" style="display:inline-block; margin:0;">';
        $html .= render_hidden_inputs(['csrf' => csrf_token()]);
        $html .= '<button class="button danger" type="submit">Stop background task</button>';
        $html .= '</form>';
        $html .= '</div>';

        // Auto-refresh script for live progress updates while the page is open
        $html .= '<script>
(function() {
    var checkInterval = setInterval(function() {
        fetch("' . $base . '/admin/images/status", { credentials: "same-origin", headers: { "Accept": "application/json" } })
        .then(function(r) { return r.json(); })
        .then(function(res) {
            var data = res.data || res;
            var task = data.background_task;
            if (!task) return;
            var bar = document.getElementById("bg-task-progress-bar");
            var txt = document.getElementById("bg-task-progress-text");
            var pendingEl = document.getElementById("img-stat-pending");
            var compEl = document.getElementById("img-stat-compressed");
            var savedEl = document.getElementById("img-stat-saved");
            if (bar && task.total > 0) {
                bar.value = task.checked || 0;
                bar.max = task.total;
            }
            if (txt) {
                var pct = task.total > 0 ? Math.round((task.checked / task.total) * 100) : 0;
                txt.textContent = "Processed " + (task.checked || 0) + " / " + task.total + " (" + pct + "%) · " + (task.remaining || 0) + " remaining";
            }
            if (pendingEl && typeof task.remaining === "number") pendingEl.textContent = task.remaining;
            if (compEl && typeof data.compressed_images === "number") compEl.textContent = data.compressed_images;
            if (task.status !== "running") {
                clearInterval(checkInterval);
                window.location.reload();
            }
        }).catch(function() {});
    }, 3000);
})();
</script>';
    } elseif ($task['status'] === 'completed') {
        $html .= '<div style="margin:16px 0; padding:12px; background:#e8f5e9; border:1px solid #c8e6c9; border-radius:8px; color:#2e7d32; font-size:0.875rem;">';
        $html .= '✓ Background optimization completed. All ' . (int)$task['checked'] . ' images processed. Space saved: ' . format_bytes((float)$task['saved_bytes']) . '.';
        $html .= '</div>';
    } elseif ($task['status'] === 'stopped') {
        $html .= '<div style="margin:16px 0; padding:12px; background:#fff3e0; border:1px solid #ffe0b2; border-radius:8px; color:#e65100; font-size:0.875rem;">';
        $html .= '⏸ Background optimization stopped. ' . (int)$task['remaining'] . ' images remaining.';
        $html .= '</div>';
    } elseif ($task['status'] === 'failed') {
        $html .= '<div style="margin:16px 0; padding:12px; background:#ffebee; border:1px solid #ffcdd2; border-radius:8px; color:#b71c1c; font-size:0.875rem;">';
        $html .= '⚠ Background optimization stopped with error: ' . htmlspecialchars((string)($task['error'] ?? 'Unknown error'));
        $html .= '</div>';
    }

    if ($task['status'] !== 'running') {
        $hasPending = $stats['pending_images'] > 0;
        $html .= '<form class="settings-form" method="post" action="' . $base . '/admin/images/compress" style="margin-top:16px;">';
        $html .= render_hidden_inputs(['csrf' => csrf_token()]);
        $btnLabel = $hasPending
            ? ('Compress ' . $stats['pending_images'] . ' pending image' . ($stats['pending_images'] > 1 ? 's' : '') . ' in background')
            : 'All images are optimal';
        $html .= '<button class="button primary" type="submit" style="background:#2e7d32; border-color:#2e7d32; font-weight:600;"' . ($hasPending ? '' : ' disabled') . '>' . htmlspecialchars($btnLabel) . '</button>';
        $html .= '<p class="muted" style="margin:4px 0 0; font-size:0.8rem;">Runs asynchronously in the background on the server. You can safely close or navigate away from this page immediately after starting.</p>';
        $html .= '</form>';
    }

    $html .= '</section>';

    return $html;
}
