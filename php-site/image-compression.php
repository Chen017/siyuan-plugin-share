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

function render_image_compression_admin_section(): string {
    $pdo = db();
    $stats = get_image_compression_stats($pdo);
    $tools = $stats['tools'];

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
    $html .= '<p class="muted">Perceptually lossless image compression (TinyPNG-like pngquant, jpegoptim & GD fallback). New uploads are compressed automatically; use the button below to inspect and compress existing or previously failed images.</p>';

    $html .= '<div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 12px; margin: 16px 0;">';
    $html .= '<div style="padding:12px; background:var(--panel-bg, #f8f9fa); border:1px solid var(--border, #eee); border-radius:8px;">';
    $html .= '<span style="font-size:0.75rem; color:var(--muted); display:block;">Total images</span>';
    $html .= '<strong style="font-size:1.35rem; font-variant-numeric:tabular-nums;">' . $stats['total_images'] . '</strong>';
    $html .= '</div>';

    $html .= '<div style="padding:12px; background:var(--panel-bg, #f8f9fa); border:1px solid var(--border, #eee); border-radius:8px;">';
    $html .= '<span style="font-size:0.75rem; color:var(--muted); display:block;">Compressed</span>';
    $html .= '<strong style="font-size:1.35rem; font-variant-numeric:tabular-nums; color:#2e7d32;">' . $stats['compressed_images'] . '</strong>';
    $html .= '</div>';

    $html .= '<div style="padding:12px; background:var(--panel-bg, #f8f9fa); border:1px solid var(--border, #eee); border-radius:8px;">';
    $html .= '<span style="font-size:0.75rem; color:var(--muted); display:block;">Pending / uncompressed</span>';
    $html .= '<strong style="font-size:1.35rem; font-variant-numeric:tabular-nums; color:' . ($stats['pending_images'] > 0 ? '#e65100' : 'inherit') . ';">' . $stats['pending_images'] . '</strong>';
    $html .= '</div>';

    $html .= '<div style="padding:12px; background:var(--panel-bg, #f8f9fa); border:1px solid var(--border, #eee); border-radius:8px;">';
    $html .= '<span style="font-size:0.75rem; color:var(--muted); display:block;">Space saved</span>';
    $html .= '<strong style="font-size:1.35rem; font-variant-numeric:tabular-nums; color:#1976d2;">' . $savedFormatted . '</strong>';
    $html .= '</div>';
    $html .= '</div>';

    $html .= '<div style="margin: 12px 0; display:flex; gap:8px; flex-wrap:wrap;">' . implode(' ', $toolsList) . '</div>';

    $html .= '<form class="settings-form" method="post" action="' . $base . '/admin/images/compress" style="margin-top:16px;">';
    $html .= render_hidden_inputs(['csrf' => csrf_token()]);
    $buttonLabel = $stats['pending_images'] > 0
        ? ('Check & compress ' . $stats['pending_images'] . ' pending image' . ($stats['pending_images'] > 1 ? 's' : ''))
        : 'Check & compress all images';
    $html .= '<button class="button primary" type="submit">' . htmlspecialchars($buttonLabel) . '</button>';
    $html .= '</form>';
    $html .= '</section>';

    return $html;
}
