<?php
declare(strict_types=1);

// Versioned plugin API. Keep response formats and ownership rules compatible.
function handle_api(string $path): void {
    if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
        api_response(200, null, '');
    }
    $user = require_api_user();
    $pdo = db();
    global $config;
    maybe_cleanup_chunks(str_ends_with($path, '/init'));

    if ($path === '/api/v1/auth/verify') {
        [$minChunk, $maxChunk] = chunk_size_limits();
        api_response(200, ['user' => [
            'id' => $user['id'],
            'username' => $user['username'],
            'role' => $user['role'],
        ], 'limits' => [
            'minChunkSize' => $minChunk,
            'maxChunkSize' => $maxChunk,
        ], 'features' => [
            'incrementalShare' => true,
            'docChunkUpload' => true,
        ]]);
    }

    if ($path === '/api/v1/shares' && $_SERVER['REQUEST_METHOD'] === 'GET') {
        $stmt = $pdo->prepare('SELECT shares.*, COALESCE(doc_counts.doc_count, 0) AS doc_count
            FROM shares
            LEFT JOIN (SELECT share_id, COUNT(*) AS doc_count FROM share_docs GROUP BY share_id) doc_counts
                ON shares.id = doc_counts.share_id
            WHERE shares.user_id = :uid AND shares.deleted_at IS NULL
            ORDER BY shares.updated_at DESC');
        $stmt->execute([':uid' => $user['id']]);
        $shares = [];
        while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
            $shares[] = [
                'id' => $row['id'],
                'slug' => $row['slug'],
                'type' => $row['type'],
                'title' => $row['title'],
                'docId' => $row['doc_id'],
                'notebookId' => $row['notebook_id'],
                'updatedAt' => strtotime($row['updated_at']) * 1000,
                'createdAt' => strtotime($row['created_at']) * 1000,
                'hasPassword' => !empty($row['password_hash']),
                'expiresAt' => $row['expires_at'] ? ((int)$row['expires_at'] * 1000) : null,
                'visitorLimit' => (int)($row['visitor_limit'] ?? 0),
                'includeChildren' => ((string)($row['type'] ?? '') === 'doc') && ((int)($row['doc_count'] ?? 0) > 1),
                'path' => '/s/' . $row['slug'],
                'url' => share_url($row['slug']),
            ];
        }
        api_response(200, ['shares' => $shares]);
    }

    if ($path === '/api/v1/shares/snapshot' && $_SERVER['REQUEST_METHOD'] === 'POST') {
        $payload = parse_json_body();
        $shareId = (int)($payload['shareId'] ?? 0);
        if ($shareId <= 0) {
            api_response(400, null, 'Missing share id');
        }
        $stmt = $pdo->prepare('SELECT * FROM shares WHERE id = :id AND user_id = :uid AND deleted_at IS NULL LIMIT 1');
        $stmt->execute([
            ':id' => $shareId,
            ':uid' => $user['id'],
        ]);
        $share = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$share) {
            api_response(404, null, 'Share not found');
        }

        $docs = [];
        $docStmt = $pdo->prepare('SELECT id, doc_id, title, icon, hpath, parent_id, sort_index, sort_order, size_bytes, content_hash, meta_hash
            FROM share_docs WHERE share_id = :sid ORDER BY sort_order ASC, id ASC');
        $docStmt->execute([':sid' => $shareId]);
        $docHashUpdate = $pdo->prepare('UPDATE share_docs SET content_hash = :content_hash, meta_hash = :meta_hash WHERE id = :id');
        $docMarkdownStmt = $pdo->prepare('SELECT markdown FROM share_docs WHERE share_id = :sid AND id = :id LIMIT 1');
        while ($row = $docStmt->fetch(PDO::FETCH_ASSOC)) {
            $contentHash = normalize_hash_hex($row['content_hash'] ?? '');
            $metaHash = normalize_hash_hex($row['meta_hash'] ?? '');
            if ($contentHash === '') {
                $docMarkdownStmt->execute([
                    ':sid' => $shareId,
                    ':id' => (int)($row['id'] ?? 0),
                ]);
                $docMarkdown = (string)($docMarkdownStmt->fetchColumn() ?: '');
                $contentHash = compute_doc_content_hash($docMarkdown);
                unset($docMarkdown);
            }
            if ($metaHash === '') {
                $metaHash = compute_doc_meta_hash($row);
            }
            if (($row['content_hash'] ?? '') !== $contentHash || ($row['meta_hash'] ?? '') !== $metaHash) {
                $docHashUpdate->execute([
                    ':content_hash' => $contentHash,
                    ':meta_hash' => $metaHash,
                    ':id' => (int)($row['id'] ?? 0),
                ]);
            }
            $docs[] = [
                'docId' => (string)($row['doc_id'] ?? ''),
                'title' => (string)($row['title'] ?? ''),
                'icon' => (string)($row['icon'] ?? ''),
                'hPath' => (string)($row['hpath'] ?? ''),
                'parentId' => (string)($row['parent_id'] ?? ''),
                'sortIndex' => (float)($row['sort_index'] ?? 0),
                'sortOrder' => max(0, (int)($row['sort_order'] ?? 0)),
                'contentHash' => $contentHash,
                'metaHash' => $metaHash,
            ];
            unset($row);
        }

        $assets = [];
        $assetStmt = $pdo->prepare('SELECT id, asset_path, doc_id, file_path, size_bytes, asset_hash FROM share_assets
            WHERE share_id = :sid ORDER BY id ASC');
        $assetStmt->execute([
            ':sid' => $shareId,
        ]);
        $assetHashUpdate = $pdo->prepare('UPDATE share_assets SET asset_hash = :asset_hash WHERE id = :id');
        while ($row = $assetStmt->fetch(PDO::FETCH_ASSOC)) {
            $assetHash = normalize_hash_hex($row['asset_hash'] ?? '');
            if ($assetHash === '') {
                $filePath = (string)($row['file_path'] ?? '');
                $fullPath = $config['uploads_dir'] . '/' . ltrim($filePath, '/');
                if ($filePath !== '' && is_file($fullPath)) {
                    $computed = @hash_file('sha256', $fullPath);
                    $assetHash = normalize_hash_hex($computed ?: '');
                }
            }
            if ($assetHash !== '' && ($row['asset_hash'] ?? '') !== $assetHash) {
                $assetHashUpdate->execute([
                    ':asset_hash' => $assetHash,
                    ':id' => (int)($row['id'] ?? 0),
                ]);
            }
            $assets[] = [
                'path' => (string)($row['asset_path'] ?? ''),
                'docId' => (string)($row['doc_id'] ?? ''),
                'size' => max(0, (int)($row['size_bytes'] ?? 0)),
                'hash' => $assetHash,
            ];
            unset($row);
        }

        api_response(200, [
            'share' => [
                'id' => (int)($share['id'] ?? 0),
                'type' => (string)($share['type'] ?? ''),
                'docId' => (string)($share['doc_id'] ?? ''),
                'notebookId' => (string)($share['notebook_id'] ?? ''),
            ],
            'docs' => $docs,
            'assets' => $assets,
        ]);
    }

    if ($path === '/api/v1/shares/delete') {
        $payload = parse_json_body();
        $shareId = (int)($payload['shareId'] ?? 0);
        $hardDelete = !empty($payload['hardDelete']);
        if (!$shareId) {
            api_response(400, null, '缺少分享 ID');
        }
        if ($hardDelete) {
            $check = $pdo->prepare('SELECT id FROM shares WHERE id = :id AND user_id = :uid');
            $check->execute([
                ':id' => $shareId,
                ':uid' => $user['id'],
            ]);
            if (!$check->fetchColumn()) {
                api_response(404, null, '分享不存在');
            }
            hard_delete_share($shareId);
            api_response(200, ['ok' => true, 'hard' => true]);
        }
        $stmt = $pdo->prepare('UPDATE shares SET revision = revision + 1, deleted_at = :deleted_at WHERE id = :id AND user_id = :uid');
        $stmt->execute([
            ':deleted_at' => now(),
            ':id' => $shareId,
            ':uid' => $user['id'],
        ]);
        recalculate_user_storage((int)$user['id']);
        api_response(200, ['ok' => true]);
    }

    if ($path === '/api/v1/shares/access/update' && $_SERVER['REQUEST_METHOD'] === 'POST') {
        $payload = parse_json_body();
        $shareId = (int)($payload['shareId'] ?? 0);
        if (!$shareId) {
            api_response(400, null, 'Missing share id');
        }
        $stmt = $pdo->prepare('SELECT * FROM shares WHERE id = :id AND user_id = :uid AND deleted_at IS NULL LIMIT 1');
        $stmt->execute([
            ':id' => $shareId,
            ':uid' => $user['id'],
        ]);
        $share = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$share) {
            api_response(404, null, 'Share not found');
        }
        $password = trim((string)($payload['password'] ?? ''));
        $clearPassword = !empty($payload['clearPassword']);
        $expiresAt = parse_expires_at($payload['expiresAt'] ?? null);
        $clearExpires = !empty($payload['clearExpires']);
        $visitorLimit = parse_visitor_limit($payload['visitorLimit'] ?? null);
        $clearVisitorLimit = !empty($payload['clearVisitorLimit']);
        $slug = parse_requested_share_slug_or_fail($payload['slug'] ?? '');

        $passwordHash = $share['password_hash'] ?? null;
        $expiresValue = isset($share['expires_at']) ? (int)$share['expires_at'] : null;
        $visitorValue = isset($share['visitor_limit']) ? (int)$share['visitor_limit'] : 0;
        if ($clearPassword) {
            $passwordHash = null;
        } elseif ($password !== '') {
            $passwordHash = password_hash($password, PASSWORD_DEFAULT);
        }
        if ($clearExpires) {
            $expiresValue = null;
        } elseif ($expiresAt !== null) {
            $expiresValue = $expiresAt;
        }
        if ($clearVisitorLimit) {
            $visitorValue = 0;
        } elseif ($visitorLimit !== null) {
            $visitorValue = $visitorLimit;
        }
        $newSlug = (string)($share['slug'] ?? '');
        if ($slug !== '' && $slug !== $newSlug) {
            ensure_share_slug_available_or_fail($pdo, $slug, (int)$share['id']);
            $newSlug = $slug;
        }

        $stmt = $pdo->prepare('UPDATE shares SET revision = revision + 1, slug = :slug, password_hash = :password_hash, expires_at = :expires_at, visitor_limit = :visitor_limit, updated_at = :updated_at WHERE id = :id AND user_id = :uid AND revision = :revision');
        $stmt->execute([
            ':slug' => $newSlug,
            ':password_hash' => $passwordHash,
            ':expires_at' => $expiresValue,
            ':visitor_limit' => $visitorValue,
            ':updated_at' => now(),
            ':id' => $shareId,
            ':uid' => $user['id'],
            ':revision' => (int)$share['revision'],
        ]);
        if ($stmt->rowCount() !== 1) api_response(409, null, 'Share changed; refresh before updating access settings');

        api_response(200, ['share' => [
            'id' => (int)$share['id'],
            'slug' => $newSlug,
            'url' => share_url($newSlug),
            'hasPassword' => !empty($passwordHash),
            'expiresAt' => $expiresValue ? ($expiresValue * 1000) : null,
            'visitorLimit' => $visitorValue,
        ]]);
    }

    if ($path === '/api/v1/shares/doc/init' && $_SERVER['REQUEST_METHOD'] === 'POST') {
        $payload = parse_json_body();
        $meta = $payload['metadata'] ?? $payload;
        if (!is_array($meta)) {
            api_response(400, null, 'Invalid metadata');
        }
        $docId = trim((string)($meta['docId'] ?? ''));
        $title = trim((string)($meta['title'] ?? ''));
        $markdown = (string)($meta['markdown'] ?? '');
        $hPath = (string)($meta['hPath'] ?? '');
        $sortOrder = max(0, (int)($meta['sortOrder'] ?? 0));
        $password = trim((string)($meta['password'] ?? ''));
        $clearPassword = !empty($meta['clearPassword']);
        $expiresAt = parse_expires_at($meta['expiresAt'] ?? null);
        $clearExpires = !empty($meta['clearExpires']);
        $visitorLimit = parse_visitor_limit($meta['visitorLimit'] ?? null);
        $clearVisitorLimit = !empty($meta['clearVisitorLimit']);
        $docs = $meta['docs'] ?? [];
        $hasDocs = is_array($docs) && count($docs) > 0;
        $incrementalPatch = normalize_incremental_patch($meta['incremental'] ?? []);
        $docChunks = normalize_doc_manifest($payload['docChunks'] ?? []);
        $docChunkById = [];
        foreach ($docChunks as $item) {
            $docChunkById[(string)($item['docId'] ?? '')] = $item;
        }
        $hasDocChunks = !empty($docChunkById);
        $stmt = $pdo->prepare('SELECT * FROM shares WHERE user_id = :uid AND type = "doc" AND doc_id = :doc_id ORDER BY id DESC LIMIT 1');
        $stmt->execute([':uid' => $user['id'], ':doc_id' => $docId]);
        $existing = $stmt->fetch(PDO::FETCH_ASSOC) ?: null;
        $useIncremental = !empty($incrementalPatch['enabled']) && !!$existing;
        if ($docId === '' || (!$hasDocs && $markdown === '' && !$hasDocChunks && !$useIncremental)) {
            api_response(400, null, 'Missing document content');
        }

        $slug = parse_requested_share_slug_or_fail($meta['slug'] ?? '');
        $assets = normalize_asset_manifest($payload['assets'] ?? []);
        $assetSize = 0;
        foreach ($assets as $asset) {
            $assetSize += (int)($asset['size'] ?? 0);
        }
        $docRows = [];
        $docSizeTotal = 0;
        if ($hasDocs) {
            foreach ($docs as $index => $doc) {
                $rowDocId = trim((string)($doc['docId'] ?? ''));
                $rowTitle = trim((string)($doc['title'] ?? ''));
                $rowIcon = trim((string)($doc['icon'] ?? ''));
                $rowHpath = (string)($doc['hPath'] ?? '');
                $rowMarkdown = (string)($doc['markdown'] ?? '');
                $rowSort = max(0, (int)($doc['sortOrder'] ?? $index));
                $rowParent = trim((string)($doc['parentId'] ?? ''));
                $rowSortIndex = (float)($doc['sortIndex'] ?? $index);
                if ($rowDocId === '') {
                    continue;
                }
                $chunkMeta = $docChunkById[$rowDocId] ?? null;
                $size = strlen($rowMarkdown);
                if ($size === 0 && $chunkMeta) {
                    $size = max(0, (int)($chunkMeta['size'] ?? 0));
                }
                $rowContentHash = normalize_hash_hex($doc['contentHash'] ?? '');
                if ($rowContentHash === '' && $chunkMeta) {
                    $rowContentHash = normalize_hash_hex($chunkMeta['hash'] ?? '');
                }
                if ($rowContentHash === '') {
                    $rowContentHash = ($rowMarkdown !== '' || !$chunkMeta)
                        ? compute_doc_content_hash($rowMarkdown)
                        : '';
                }
                $rowMetaHash = normalize_hash_hex($doc['metaHash'] ?? '');
                if ($rowMetaHash === '') {
                    $rowMetaHash = compute_doc_meta_hash([
                        'title' => $rowTitle ?: $rowDocId,
                        'icon' => $rowIcon,
                        'hPath' => $rowHpath,
                        'parentId' => $rowParent,
                        'sortIndex' => $rowSortIndex,
                        'sortOrder' => $rowSort,
                    ]);
                }
                $docSizeTotal += $size;
                $docRows[] = [
                    'docId' => $rowDocId,
                    'title' => $rowTitle ?: $rowDocId,
                    'icon' => $rowIcon,
                    'hPath' => $rowHpath,
                    'parentId' => $rowParent,
                    'sortIndex' => $rowSortIndex,
                    'markdown' => $rowMarkdown,
                    'sortOrder' => $rowSort,
                    'size' => $size,
                    'contentHash' => $rowContentHash,
                    'metaHash' => $rowMetaHash,
                ];
            }
            if (empty($docRows) && !$useIncremental) {
                api_response(400, null, 'Missing document content');
            }
        } elseif ($markdown !== '') {
            $docSizeTotal = strlen($markdown);
            $docIcon = trim((string)($meta['icon'] ?? ''));
            $docContentHash = normalize_hash_hex($meta['contentHash'] ?? '');
            if ($docContentHash === '') {
                $docContentHash = compute_doc_content_hash($markdown);
            }
            $docMetaHash = normalize_hash_hex($meta['metaHash'] ?? '');
            if ($docMetaHash === '') {
                $docMetaHash = compute_doc_meta_hash([
                    'title' => $title ?: $docId,
                    'icon' => $docIcon,
                    'hPath' => $hPath,
                    'parentId' => '',
                    'sortIndex' => 0,
                    'sortOrder' => $sortOrder,
                ]);
            }
            $docRows[] = [
                'docId' => $docId,
                'title' => $title ?: $docId,
                'icon' => $docIcon,
                'hPath' => $hPath,
                'parentId' => null,
                'sortIndex' => 0,
                'markdown' => $markdown,
                'sortOrder' => $sortOrder,
                'size' => $docSizeTotal,
                'contentHash' => $docContentHash,
                'metaHash' => $docMetaHash,
            ];
        } elseif ($hasDocChunks && isset($docChunkById[$docId])) {
            $docIcon = trim((string)($meta['icon'] ?? ''));
            $chunkMeta = $docChunkById[$docId];
            $docContentHash = normalize_hash_hex($meta['contentHash'] ?? '');
            if ($docContentHash === '') {
                $docContentHash = normalize_hash_hex($chunkMeta['hash'] ?? '');
            }
            $docMetaHash = normalize_hash_hex($meta['metaHash'] ?? '');
            if ($docMetaHash === '') {
                $docMetaHash = compute_doc_meta_hash([
                    'title' => $title ?: $docId,
                    'icon' => $docIcon,
                    'hPath' => $hPath,
                    'parentId' => '',
                    'sortIndex' => 0,
                    'sortOrder' => $sortOrder,
                ]);
            }
            $docSizeTotal = max(0, (int)($chunkMeta['size'] ?? 0));
            $docRows[] = [
                'docId' => $docId,
                'title' => $title ?: $docId,
                'icon' => $docIcon,
                'hPath' => $hPath,
                'parentId' => null,
                'sortIndex' => 0,
                'markdown' => '',
                'sortOrder' => $sortOrder,
                'size' => $docSizeTotal,
                'contentHash' => $docContentHash,
                'metaHash' => $docMetaHash,
            ];
        }
        if (empty($docRows) && !$useIncremental) {
            api_response(400, null, 'Missing document content');
        }
        $baseShareSize = $docSizeTotal + $assetSize;
        $existingSize = $existing ? (int)($existing['size_bytes'] ?? 0) : 0;
        $newShareSize = $baseShareSize;
        $used = recalculate_user_storage((int)$user['id']);
        $limit = get_user_limit_bytes($user);
        $usedWithout = max(0, $used - $existingSize);
        if (!$useIncremental && $limit > 0 && ($usedWithout + $newShareSize) > $limit) {
            api_response(413, null, 'Storage limit reached');
        }

        $passwordHash = $existing['password_hash'] ?? null;
        $expiresValue = isset($existing['expires_at']) ? (int)$existing['expires_at'] : null;
        $visitorValue = isset($existing['visitor_limit']) ? (int)$existing['visitor_limit'] : 0;
        if ($clearPassword) {
            $passwordHash = null;
        } elseif ($password !== '') {
            $passwordHash = password_hash($password, PASSWORD_DEFAULT);
        }
        if ($clearExpires) {
            $expiresValue = null;
        } elseif ($expiresAt !== null) {
            $expiresValue = $expiresAt;
        }
        if ($clearVisitorLimit) {
            $visitorValue = 0;
        } elseif ($visitorLimit !== null) {
            $visitorValue = $visitorLimit;
        }

        $finalSlug = $slug;
        if ($existing) {
            if ($finalSlug && $finalSlug !== $existing['slug']) {
                ensure_share_slug_available_or_fail($pdo, $finalSlug, (int)$existing['id']);
            }
            if (!$finalSlug) {
                $finalSlug = (string)$existing['slug'];
            }
        } else {
            if (!$finalSlug) {
                $finalSlug = allocate_random_share_slug_or_fail($pdo);
            } else {
                ensure_share_slug_available_or_fail($pdo, $finalSlug);
            }
        }

        $finalTitle = $title ?: ($existing['title'] ?? $docId);
        $uploadMode = $useIncremental ? 'incremental' : 'full';
        $patchManifest = json_encode(
            $useIncremental
                ? $incrementalPatch
                : ['enabled' => false, 'deletedDocIds' => [], 'deletedAssetPaths' => []],
            JSON_UNESCAPED_SLASHES
        );
        $uploadId = create_upload_session($user, $existing, [
            'type' => 'doc', 'doc_id' => $docId,
            'slug' => $finalSlug, 'title' => $finalTitle, 'password_hash' => $passwordHash,
            'expires_at' => $expiresValue, 'visitor_limit' => $visitorValue,
            'upload_mode' => $uploadMode, 'patch_manifest' => $patchManifest,
        ], $docRows, $assets, $docChunks);
        api_response(200, ['uploadId' => $uploadId, 'slug' => $finalSlug]);
    }

    if ($path === '/api/v1/shares/notebook/init' && $_SERVER['REQUEST_METHOD'] === 'POST') {
        $payload = parse_json_body();
        $meta = $payload['metadata'] ?? $payload;
        if (!is_array($meta)) {
            api_response(400, null, 'Invalid metadata');
        }
        $notebookId = trim((string)($meta['notebookId'] ?? ''));
        $title = trim((string)($meta['title'] ?? ''));
        $docs = $meta['docs'] ?? [];
        $password = trim((string)($meta['password'] ?? ''));
        $clearPassword = !empty($meta['clearPassword']);
        $expiresAt = parse_expires_at($meta['expiresAt'] ?? null);
        $clearExpires = !empty($meta['clearExpires']);
        $visitorLimit = parse_visitor_limit($meta['visitorLimit'] ?? null);
        $clearVisitorLimit = !empty($meta['clearVisitorLimit']);
        $incrementalPatch = normalize_incremental_patch($meta['incremental'] ?? []);
        $docChunks = normalize_doc_manifest($payload['docChunks'] ?? []);
        $docChunkById = [];
        foreach ($docChunks as $item) {
            $docChunkById[(string)($item['docId'] ?? '')] = $item;
        }
        $stmt = $pdo->prepare('SELECT * FROM shares WHERE user_id = :uid AND type = "notebook" AND notebook_id = :nid ORDER BY id DESC LIMIT 1');
        $stmt->execute([':uid' => $user['id'], ':nid' => $notebookId]);
        $existing = $stmt->fetch(PDO::FETCH_ASSOC) ?: null;
        $useIncremental = !empty($incrementalPatch['enabled']) && !!$existing;
        if ($notebookId === '' || !is_array($docs) || (count($docs) === 0 && !$useIncremental)) {
            api_response(400, null, 'Missing notebook or documents');
        }

        $slug = parse_requested_share_slug_or_fail($meta['slug'] ?? '');
        $assets = normalize_asset_manifest($payload['assets'] ?? []);
        $assetSize = 0;
        foreach ($assets as $asset) {
            $assetSize += (int)($asset['size'] ?? 0);
        }
        $docRows = [];
        $docSizeTotal = 0;
        foreach ($docs as $index => $doc) {
            $docId = trim((string)($doc['docId'] ?? ''));
            $docTitle = trim((string)($doc['title'] ?? ''));
            $docIcon = trim((string)($doc['icon'] ?? ''));
            $docHpath = (string)($doc['hPath'] ?? '');
            $docMarkdown = (string)($doc['markdown'] ?? '');
            $docSort = max(0, (int)($doc['sortOrder'] ?? $index));
            $docParent = trim((string)($doc['parentId'] ?? ''));
            $docSortIndex = (float)($doc['sortIndex'] ?? $index);
            if ($docId === '') {
                continue;
            }
            $chunkMeta = $docChunkById[$docId] ?? null;
            $size = strlen($docMarkdown);
            if ($size === 0 && $chunkMeta) {
                $size = max(0, (int)($chunkMeta['size'] ?? 0));
            }
            $docContentHash = normalize_hash_hex($doc['contentHash'] ?? '');
            if ($docContentHash === '' && $chunkMeta) {
                $docContentHash = normalize_hash_hex($chunkMeta['hash'] ?? '');
            }
            if ($docContentHash === '') {
                $docContentHash = ($docMarkdown !== '' || !$chunkMeta)
                    ? compute_doc_content_hash($docMarkdown)
                    : '';
            }
            $docMetaHash = normalize_hash_hex($doc['metaHash'] ?? '');
            if ($docMetaHash === '') {
                $docMetaHash = compute_doc_meta_hash([
                    'title' => $docTitle ?: $docId,
                    'icon' => $docIcon,
                    'hPath' => $docHpath,
                    'parentId' => $docParent,
                    'sortIndex' => $docSortIndex,
                    'sortOrder' => $docSort,
                ]);
            }
            $docSizeTotal += $size;
            $docRows[] = [
                'docId' => $docId,
                'title' => $docTitle ?: $docId,
                'icon' => $docIcon,
                'hPath' => $docHpath,
                'parentId' => $docParent,
                'sortIndex' => $docSortIndex,
                'markdown' => $docMarkdown,
                'sortOrder' => $docSort,
                'size' => $size,
                'contentHash' => $docContentHash,
                'metaHash' => $docMetaHash,
            ];
        }
        if (empty($docRows) && !$useIncremental) {
            api_response(400, null, 'No documents to share');
        }
        $baseShareSize = $docSizeTotal + $assetSize;
        $existingSize = $existing ? (int)($existing['size_bytes'] ?? 0) : 0;
        $newShareSize = $baseShareSize;
        $used = recalculate_user_storage((int)$user['id']);
        $limit = get_user_limit_bytes($user);
        $usedWithout = max(0, $used - $existingSize);
        if (!$useIncremental && $limit > 0 && ($usedWithout + $newShareSize) > $limit) {
            api_response(413, null, 'Storage limit reached');
        }

        $passwordHash = $existing['password_hash'] ?? null;
        $expiresValue = isset($existing['expires_at']) ? (int)$existing['expires_at'] : null;
        $visitorValue = isset($existing['visitor_limit']) ? (int)$existing['visitor_limit'] : 0;
        if ($clearPassword) {
            $passwordHash = null;
        } elseif ($password !== '') {
            $passwordHash = password_hash($password, PASSWORD_DEFAULT);
        }
        if ($clearExpires) {
            $expiresValue = null;
        } elseif ($expiresAt !== null) {
            $expiresValue = $expiresAt;
        }
        if ($clearVisitorLimit) {
            $visitorValue = 0;
        } elseif ($visitorLimit !== null) {
            $visitorValue = $visitorLimit;
        }

        $finalSlug = $slug;
        if ($existing) {
            if ($finalSlug && $finalSlug !== $existing['slug']) {
                ensure_share_slug_available_or_fail($pdo, $finalSlug, (int)$existing['id']);
            }
            if (!$finalSlug) {
                $finalSlug = (string)$existing['slug'];
            }
        } else {
            if (!$finalSlug) {
                $finalSlug = allocate_random_share_slug_or_fail($pdo);
            } else {
                ensure_share_slug_available_or_fail($pdo, $finalSlug);
            }
        }

        $finalTitle = $title ?: ($existing['title'] ?? $notebookId);
        $uploadMode = $useIncremental ? 'incremental' : 'full';
        $patchManifest = json_encode(
            $useIncremental
                ? $incrementalPatch
                : ['enabled' => false, 'deletedDocIds' => [], 'deletedAssetPaths' => []],
            JSON_UNESCAPED_SLASHES
        );
        $uploadId = create_upload_session($user, $existing, [
            'type' => 'notebook', 'notebook_id' => $notebookId,
            'slug' => $finalSlug, 'title' => $finalTitle, 'password_hash' => $passwordHash,
            'expires_at' => $expiresValue, 'visitor_limit' => $visitorValue,
            'upload_mode' => $uploadMode, 'patch_manifest' => $patchManifest,
        ], $docRows, $assets, $docChunks);
        api_response(200, ['uploadId' => $uploadId, 'slug' => $finalSlug]);
    }

    if ($path === '/api/v1/shares/asset/chunk' && $_SERVER['REQUEST_METHOD'] === 'POST') {
        $uploadId = sanitize_upload_id((string)($_POST['uploadId'] ?? ''));
        $assetPath = sanitize_asset_path((string)($_POST['assetPath'] ?? ''));
        $docId = trim((string)($_POST['assetDocId'] ?? ''));
        $chunkIndex = (int)($_POST['chunkIndex'] ?? -1);
        $totalChunks = (int)($_POST['totalChunks'] ?? 0);
        if ($uploadId === '' || $assetPath === '' || $chunkIndex < 0 || $totalChunks <= 0 || $chunkIndex >= $totalChunks) {
            api_response(400, null, 'Invalid chunk request');
        }
        $uploadLock = lock_upload_session($uploadId);
        $check = $pdo->prepare('SELECT * FROM share_uploads WHERE upload_id = :upload_id AND user_id = :uid AND status = "pending" LIMIT 1');
        $check->execute([
            ':upload_id' => $uploadId,
            ':uid' => $user['id'],
        ]);
        $upload = $check->fetch(PDO::FETCH_ASSOC);
        if (!$upload) {
            api_response(404, null, 'Upload not found');
        }
        $manifest = normalize_asset_manifest(json_decode((string)($upload['asset_manifest'] ?? ''), true));
        $docManifest = normalize_doc_manifest(json_decode((string)($upload['doc_manifest'] ?? ''), true));
        $manifestItem = null;
        $isDocChunk = false;
        foreach ($manifest as $item) {
            $path = sanitize_asset_path((string)($item['path'] ?? ''));
            if ($path !== '' && $path === $assetPath) {
                $manifestItem = $item;
                break;
            }
        }
        if (!$manifestItem) {
            foreach ($docManifest as $item) {
                $path = sanitize_asset_path((string)($item['path'] ?? ''));
                if ($path !== '' && $path === $assetPath) {
                    $manifestItem = $item;
                    $isDocChunk = true;
                    break;
                }
            }
        }
        if (!$manifestItem) {
            api_response(400, null, 'Asset not allowed');
        }
        if ($isDocChunk) {
            $expectedDocId = trim((string)($manifestItem['docId'] ?? ''));
            if ($expectedDocId !== '' && $docId !== '' && $expectedDocId !== $docId) {
                api_response(400, null, 'Document chunk mismatch');
            }
        }
        if (empty($_FILES['chunk'])) {
            api_response(400, null, 'Missing chunk file');
        }
        $file = $_FILES['chunk'];
        $chunkSize = (int)($file['size'] ?? 0);
        [$minChunk, $maxChunk] = chunk_size_limits();
        if ($maxChunk > 0 && $chunkSize > $maxChunk) {
            api_response(413, null, 'Chunk too large');
        }
        if ($minChunk > 0 && $chunkIndex < ($totalChunks - 1) && $chunkSize > 0 && $chunkSize < $minChunk) {
            api_response(400, null, 'Chunk too small');
        }
        $tmp = $file['tmp_name'] ?? '';
        if ($tmp === '' || !is_uploaded_file($tmp)) {
            api_response(400, null, 'Invalid chunk upload');
        }

        $expectedSize = max(0, (int)($manifestItem['size'] ?? 0));
        if ($totalChunks > max(1, (int)ceil($expectedSize / max(1, $minChunk)))
            || $chunkSize > $expectedSize) api_response(413, null, 'Chunk exceeds declared asset size');
        try { require_upload_space($chunkSize); }
        catch (RuntimeException $error) { api_response(413, null, $error->getMessage()); }
        $chunkDir = upload_chunks_dir($uploadId);
        $chunkPath = $chunkDir . '/' . $assetPath . '.part' . $chunkIndex;
        ensure_dir(dirname($chunkPath));
        $stored = 0;
        $partPrefix = basename($assetPath) . '.part';
        foreach (new DirectoryIterator(dirname($chunkPath)) as $partFile) {
            $name = $partFile->getFilename();
            if ($partFile->isFile() && str_starts_with($name, $partPrefix)
                && ctype_digit(substr($name, strlen($partPrefix)))) $stored += $partFile->getSize();
        }
        if ($stored - (is_file($chunkPath) ? (int)filesize($chunkPath) : 0) + $chunkSize > $expectedSize) {
            api_response(413, null, 'Chunks exceed declared asset size');
        }
        if (!move_uploaded_file($tmp, $chunkPath)) {
            api_response(500, null, 'Chunk save failed');
        }

        $complete = false;
        if ($chunkIndex === $totalChunks - 1) {
            $missing = [];
            for ($i = 0; $i < $totalChunks; $i++) {
                $part = $chunkDir . '/' . $assetPath . '.part' . $i;
                if (!is_file($part)) {
                    $missing[] = $i;
                }
            }
            if (!empty($missing)) {
                api_response(409, [
                    'missingChunks' => $missing,
                    'uploadId' => $uploadId,
                    'assetPath' => $assetPath,
                    'totalChunks' => $totalChunks,
                ], 'Missing chunk');
            }
            $targetFile = upload_staging_dir($uploadId) . '/' . $assetPath;
            ensure_dir(dirname($targetFile));
            $out = fopen($targetFile, 'wb');
            if ($out === false) {
                api_response(500, null, 'Failed to open target file');
            }
            for ($i = 0; $i < $totalChunks; $i++) {
                $part = $chunkDir . '/' . $assetPath . '.part' . $i;
                $in = fopen($part, 'rb');
                if ($in === false) {
                    fclose($out);
                    api_response(500, null, 'Failed to read chunk');
                }
                $copied = stream_copy_to_stream($in, $out);
                fclose($in);
                if ($copied === false || $copied !== filesize($part)) {
                    fclose($out);
                    @unlink($targetFile);
                    api_response(500, null, 'Chunk assembly failed');
                }
            }
            if (!fclose($out)) api_response(500, null, 'Chunk flush failed');
            for ($i = 0; $i < $totalChunks; $i++) @unlink($chunkDir . '/' . $assetPath . '.part' . $i);
            $complete = true;
        }
        $stmt = $pdo->prepare('UPDATE share_uploads SET updated_at = :updated_at WHERE upload_id = :upload_id');
        $stmt->execute([
            ':updated_at' => now(),
            ':upload_id' => $uploadId,
        ]);
        api_response(200, ['complete' => $complete]);
    }

    if ($path === '/api/v1/shares/upload/complete' && $_SERVER['REQUEST_METHOD'] === 'POST') {
        $payload = parse_json_body();
        $uploadId = sanitize_upload_id((string)($payload['uploadId'] ?? ''));
        if ($uploadId === '') {
            api_response(400, null, 'Missing upload id');
        }
        $uploadLock = lock_upload_session($uploadId);
        $stmt = $pdo->prepare('SELECT * FROM share_uploads WHERE upload_id = :upload_id AND user_id = :uid AND status = "pending" LIMIT 1');
        $stmt->execute([
            ':upload_id' => $uploadId,
            ':uid' => $user['id'],
        ]);
        $upload = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$upload) {
            api_response(404, null, 'Upload not found');
        }

        $stagingDir = upload_staging_dir($uploadId);
        $docManifest = normalize_doc_manifest(json_decode((string)($upload['doc_manifest'] ?? ''), true));
        $docChunkById = [];
        foreach ($docManifest as $item) {
            $docChunkById[(string)($item['docId'] ?? '')] = $item;
        }

        $docStmt = $pdo->prepare('SELECT id, doc_id, title, icon, hpath, parent_id, sort_index, sort_order, size_bytes, content_hash, meta_hash, LENGTH(markdown) AS markdown_len FROM share_upload_docs WHERE upload_id = :upload_id ORDER BY id ASC');
        $docStmt->execute([':upload_id' => $uploadId]);
        $docRows = [];
        $docSizeTotal = 0;
        while ($row = $docStmt->fetch(PDO::FETCH_ASSOC)) {
            $docIdKey = trim((string)($row['doc_id'] ?? ''));
            $docTitle = (string)($row['title'] ?? '');
            $docIcon = (string)($row['icon'] ?? '');
            $docHpath = (string)($row['hpath'] ?? '');
            $docParent = (string)($row['parent_id'] ?? '');
            $docSortIndex = normalize_sort_index_value($row['sort_index'] ?? 0);
            $docSortOrder = max(0, (int)($row['sort_order'] ?? 0));
            $docChunk = $docIdKey !== '' ? ($docChunkById[$docIdKey] ?? null) : null;
            $chunkHash = '';
            $chunkSize = -1;
            $chunkFilePath = null;
            if ($docChunk) {
                $chunkPath = sanitize_asset_path((string)($docChunk['path'] ?? ''));
                $fullChunkPath = $chunkPath !== '' ? ($stagingDir . '/' . $chunkPath) : '';
                if ($fullChunkPath === '' || !is_file($fullChunkPath)) {
                    api_response(400, null, 'Missing document: ' . $docIdKey);
                }
                $chunkSize = (int)filesize($fullChunkPath);
                if ($chunkSize < 0) {
                    $chunkSize = 0;
                }
                $expectedSize = max(0, (int)($docChunk['size'] ?? 0));
                if ($expectedSize > 0 && $chunkSize !== $expectedSize) {
                    api_response(400, null, 'Document size mismatch: ' . $docIdKey);
                }
                $chunkHash = normalize_hash_hex($docChunk['hash'] ?? '');
                if ($chunkHash !== '') {
                    $computedChunkHash = normalize_hash_hex(hash_file('sha256', $fullChunkPath));
                    if ($computedChunkHash !== $chunkHash) {
                        api_response(400, null, 'Document hash mismatch: ' . $docIdKey);
                    }
                }
                $chunkFilePath = $fullChunkPath;

            } else {

            }
            $docContentHash = normalize_hash_hex($row['content_hash'] ?? '');
            if ($chunkHash !== '') {
                $docContentHash = $chunkHash;
            }
            if ($docContentHash === '' && $chunkFilePath) {
                $docContentHash = normalize_hash_hex(hash_file('sha256', $chunkFilePath));
            }
            if ($docContentHash === '' && !$chunkFilePath) {
                $inlineMdStmt2 = $pdo->prepare('SELECT markdown FROM share_upload_docs WHERE id = :id LIMIT 1');
                $inlineMdStmt2->execute([':id' => (int)$row['id']]);
                $inlineMd2 = (string)($inlineMdStmt2->fetchColumn() ?: '');
                $docContentHash = compute_doc_content_hash($inlineMd2);
                unset($inlineMd2);
            }
            $docMetaHash = normalize_hash_hex($row['meta_hash'] ?? '');
            if ($docMetaHash === '') {
                $docMetaHash = compute_doc_meta_hash([
                    'title' => $docTitle,
                    'icon' => $docIcon,
                    'hPath' => $docHpath,
                    'parentId' => $docParent,
                    'sortIndex' => $docSortIndex,
                    'sortOrder' => $docSortOrder,
                ]);
            }
            $rowSize = (int)($row['size_bytes'] ?? 0);
            if ($chunkSize >= 0) {
                $rowSize = $chunkSize;
            } elseif ($rowSize <= 0) {
                $rowSize = (int)($row['markdown_len'] ?? 0);
            }
            $docRows[] = [
                'doc_id' => $docIdKey,
                'title' => $docTitle,
                'icon' => $docIcon,
                'hpath' => $docHpath,
                'parent_id' => $docParent !== '' ? $docParent : null,
                'sort_index' => $docSortIndex,
                'sort_order' => $docSortOrder,
                'size_bytes' => $rowSize,
                'content_hash' => $docContentHash,
                'meta_hash' => $docMetaHash,
                '_chunk_file' => $chunkFilePath,
                '_upload_row_id' => (int)$row['id'],
            ];
            $docSizeTotal += $rowSize;
            unset($row);
        }

        $manifest = normalize_asset_manifest(json_decode((string)($upload['asset_manifest'] ?? ''), true));
        $assetSizeTotal = 0;
        $manifestEntries = [];
        foreach ($manifest as $item) {
            $path = sanitize_asset_path((string)($item['path'] ?? ''));
            if ($path === '') {
                continue;
            }
            $full = $stagingDir . '/' . $path;
            if (!is_file($full)) {
                api_response(400, null, 'Missing asset: ' . $path);
            }
            $size = (int)filesize($full);
            if ($size !== (int)$item['size']) api_response(400, null, 'Asset size mismatch: ' . $path);
            $assetSizeTotal += $size;
            $assetHash = normalize_hash_hex($item['hash'] ?? '');
            $computed = normalize_hash_hex(hash_file('sha256', $full));
            if ($assetHash !== '' && $assetHash !== $computed) api_response(400, null, 'Asset hash mismatch: ' . $path);
            $assetHash = $computed;
            $manifestEntries[] = [
                'path' => $path,
                'docId' => isset($item['docId']) ? trim((string)$item['docId']) : null,
                'size' => $size,
                'hash' => $assetHash,
            ];
        }

        $share = null;
        $shareId = (int)($upload['share_id'] ?? 0);
        if ($shareId > 0) {
            $check = $pdo->prepare('SELECT * FROM shares WHERE id = :id AND user_id = :uid LIMIT 1');
            $check->execute([
                ':id' => $shareId,
                ':uid' => $user['id'],
            ]);
            $share = $check->fetch(PDO::FETCH_ASSOC) ?: null;
            if (!$share) {
                $shareId = 0;
            }
        }

        $uploadMode = strtolower(trim((string)($upload['upload_mode'] ?? '')));
        $uploadMode = $uploadMode === 'incremental' ? 'incremental' : 'full';
        if ($uploadMode === 'incremental' && !$share) {
            $uploadMode = 'full';
        }
        if ($uploadMode === 'full' && empty($docRows)) {
            api_response(400, null, 'Missing documents');
        }
        $patchManifest = normalize_incremental_patch(json_decode((string)($upload['patch_manifest'] ?? ''), true));
        $changedDocSet = [];
        foreach ($docRows as $row) {
            $docKey = trim((string)($row['doc_id'] ?? ''));
            if ($docKey !== '') {
                $changedDocSet[$docKey] = true;
            }
        }
        $changedAssetSet = [];
        foreach ($manifestEntries as $entry) {
            $assetKey = sanitize_asset_path((string)($entry['path'] ?? ''));
            if ($assetKey !== '') {
                $changedAssetSet[$assetKey] = true;
            }
        }
        $deletedDocIds = [];
        foreach (($patchManifest['deletedDocIds'] ?? []) as $docKey) {
            $docKey = trim((string)$docKey);
            if ($docKey === '' || isset($changedDocSet[$docKey])) {
                continue;
            }
            $deletedDocIds[] = $docKey;
        }
        $deletedAssetPaths = [];
        foreach (($patchManifest['deletedAssetPaths'] ?? []) as $assetPath) {
            $assetPath = sanitize_asset_path((string)$assetPath);
            if ($assetPath === '' || isset($changedAssetSet[$assetPath])) {
                continue;
            }
            $deletedAssetPaths[] = $assetPath;
        }

        $baseShareSize = $docSizeTotal + $assetSizeTotal;
        $newShareSize = $baseShareSize;
        $existingSize = $share ? (int)($share['size_bytes'] ?? 0) : 0;
        $used = recalculate_user_storage((int)$user['id']);
        $limit = get_user_limit_bytes($user);
        $usedWithout = max(0, $used - $existingSize);
        if ($uploadMode === 'full') {
            if ($limit > 0 && ($usedWithout + $newShareSize) > $limit) {
                api_response(413, null, 'Storage limit reached');
            }
        } elseif ($share) {
            $oldDocSizes = [];
            $stmt = $pdo->prepare('SELECT doc_id, size_bytes FROM share_docs WHERE share_id = :sid');
            $stmt->execute([':sid' => (int)$share['id']]);
            foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
                $oldDocSizes[(string)($row['doc_id'] ?? '')] = (int)($row['size_bytes'] ?? 0);
            }
            $oldAssetSizes = [];
            $stmt = $pdo->prepare('SELECT asset_path, size_bytes FROM share_assets WHERE share_id = :sid');
            $stmt->execute([
                ':sid' => (int)$share['id'],
            ]);
            foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
                $oldAssetSizes[(string)($row['asset_path'] ?? '')] = (int)($row['size_bytes'] ?? 0);
            }
            $docDelta = 0;
            foreach ($docRows as $row) {
                $key = (string)($row['doc_id'] ?? '');
                if ($key === '') {
                    continue;
                }
                $docDelta += (int)($row['size_bytes'] ?? 0);
                if (isset($oldDocSizes[$key])) {
                    $docDelta -= (int)$oldDocSizes[$key];
                }
            }
            foreach ($deletedDocIds as $key) {
                if (isset($oldDocSizes[$key])) {
                    $docDelta -= (int)$oldDocSizes[$key];
                }
            }
            $assetDelta = 0;
            foreach ($manifestEntries as $entry) {
                $key = (string)($entry['path'] ?? '');
                if ($key === '') {
                    continue;
                }
                $assetDelta += (int)($entry['size'] ?? 0);
                if (isset($oldAssetSizes[$key])) {
                    $assetDelta -= (int)$oldAssetSizes[$key];
                }
            }
            foreach ($deletedAssetPaths as $key) {
                if (isset($oldAssetSizes[$key])) {
                    $assetDelta -= (int)$oldAssetSizes[$key];
                }
            }
            $projectedSize = max(0, $existingSize + $docDelta + $assetDelta);
            if ($limit > 0 && ($usedWithout + $projectedSize) > $limit) {
                api_response(413, null, 'Storage limit reached');
            }
        }

        $slug = sanitize_slug((string)($upload['slug'] ?? ''));
        if ($slug === '') {
            $slug = allocate_random_share_slug_or_fail($pdo);
        } else {
            ensure_share_slug_available_or_fail($pdo, $slug, $share ? (int)$share['id'] : 0);
        }

        $title = trim((string)($upload['title'] ?? ''));
        $passwordHash = $upload['password_hash'] ?? null;
        $expiresValue = isset($upload['expires_at']) ? (int)$upload['expires_at'] : null;
        $visitorValue = isset($upload['visitor_limit']) ? (int)$upload['visitor_limit'] : 0;
        $type = (string)($upload['type'] ?? 'doc');
        $docId = trim((string)($upload['doc_id'] ?? ''));
        $notebookId = trim((string)($upload['notebook_id'] ?? ''));

        $fileWrite = new ShareFileWrite($pdo);
        try {
            if ($share) {
                $fresh = $pdo->prepare('SELECT * FROM shares WHERE id = ? AND user_id = ?');
                $fresh->execute([$shareId, $user['id']]);
                $current = $fresh->fetch(PDO::FETCH_ASSOC);
                if (!$current || (int)$current['revision'] !== (int)$upload['share_revision']) {
                    throw new RuntimeException('Share changed during upload; restart the upload', 409);
                }
                $share = $current;
            } else {
                $sameRoot = $pdo->prepare('SELECT 1 FROM shares WHERE user_id = ? AND type = ? AND ' . ($type === 'doc' ? 'doc_id' : 'notebook_id') . ' = ? LIMIT 1');
                $sameRoot->execute([$user['id'], $type, $type === 'doc' ? $docId : $notebookId]);
                if ($sameRoot->fetchColumn()) throw new RuntimeException('Share was created during upload; restart the upload', 409);
            }
            $currentUsed = recalculate_user_storage((int)$user['id']);
            $replacementSize = $uploadMode === 'full' ? $newShareSize : $projectedSize;
            if ($limit > 0 && max(0, $currentUsed - $existingSize) + $replacementSize > $limit) {
                throw new RuntimeException('Storage limit reached', 413);
            }
            if ($share) {
                $fileWrite->rememberShare($shareId);
                $update = $pdo->prepare('UPDATE shares SET revision = revision + 1, title = :title, slug = :slug, password_hash = :password_hash, expires_at = :expires_at, visitor_limit = :visitor_limit, updated_at = :updated_at, deleted_at = NULL WHERE id = :id');
                $update->execute([
                    ':title' => $title !== '' ? $title : ($share['title'] ?? $slug),
                    ':slug' => $slug,
                    ':password_hash' => $passwordHash,
                    ':expires_at' => $expiresValue,
                    ':visitor_limit' => $visitorValue,
                    ':updated_at' => now(),
                    ':id' => $share['id'],
                ]);
                $shareId = (int)$share['id'];
                if ($uploadMode === 'full') {
                    $pdo->prepare('DELETE FROM share_assets WHERE share_id = ?')->execute([$shareId]);
                    $pdo->prepare('DELETE FROM share_docs WHERE share_id = :share_id')->execute([':share_id' => $shareId]);
                }
            } else {
                $shareId = allocate_share_id($pdo);
                if ($shareId > 0) {
                    $stmt = $pdo->prepare('INSERT INTO shares (id, user_id, type, slug, title, doc_id, notebook_id, password_hash, expires_at, visitor_limit, created_at, updated_at)
                        VALUES (:id, :uid, :type, :slug, :title, :doc_id, :notebook_id, :password_hash, :expires_at, :visitor_limit, :created_at, :updated_at)');
                    $stmt->execute([
                        ':id' => $shareId,
                        ':uid' => $user['id'],
                        ':type' => $type,
                        ':slug' => $slug,
                        ':title' => $title !== '' ? $title : $slug,
                        ':doc_id' => $type === 'doc' ? $docId : null,
                        ':notebook_id' => $type === 'notebook' ? $notebookId : null,
                        ':password_hash' => $passwordHash,
                        ':expires_at' => $expiresValue,
                        ':visitor_limit' => $visitorValue,
                        ':created_at' => now(),
                        ':updated_at' => now(),
                    ]);
                } else {
                    $stmt = $pdo->prepare('INSERT INTO shares (user_id, type, slug, title, doc_id, notebook_id, password_hash, expires_at, visitor_limit, created_at, updated_at)
                        VALUES (:uid, :type, :slug, :title, :doc_id, :notebook_id, :password_hash, :expires_at, :visitor_limit, :created_at, :updated_at)');
                    $stmt->execute([
                        ':uid' => $user['id'],
                        ':type' => $type,
                        ':slug' => $slug,
                        ':title' => $title !== '' ? $title : $slug,
                        ':doc_id' => $type === 'doc' ? $docId : null,
                        ':notebook_id' => $type === 'notebook' ? $notebookId : null,
                        ':password_hash' => $passwordHash,
                        ':expires_at' => $expiresValue,
                        ':visitor_limit' => $visitorValue,
                        ':created_at' => now(),
                        ':updated_at' => now(),
                    ]);
                    $shareId = (int)$pdo->lastInsertId();
                }
            }

            $assetFiles = [];
            foreach ($manifestEntries as $entry) {
                $assetFiles[$entry['path']] = $fileWrite->stage($stagingDir . '/' . $entry['path'], $shareId, $entry['path']);
            }
            if ($uploadMode === 'full') {
                $insertDoc = $pdo->prepare('INSERT INTO share_docs (share_id, doc_id, title, icon, hpath, parent_id, sort_index, markdown, sort_order, size_bytes, content_hash, meta_hash, created_at, updated_at)
                    VALUES (:share_id, :doc_id, :title, :icon, :hpath, :parent_id, :sort_index, :markdown, :sort_order, :size_bytes, :content_hash, :meta_hash, :created_at, :updated_at)');
                $fetchMdStmt = $pdo->prepare('SELECT markdown FROM share_upload_docs WHERE id = :id LIMIT 1');
                foreach ($docRows as $row) {
                    $docMarkdown = '';
                    if (!empty($row['_chunk_file']) && is_file($row['_chunk_file'])) {
                        $docMarkdown = file_get_contents($row['_chunk_file']);
                        if ($docMarkdown === false) throw new RuntimeException('Document staging read failed');
                    } else {
                        $fetchMdStmt->execute([':id' => (int)$row['_upload_row_id']]);
                        $docMarkdown = (string)($fetchMdStmt->fetchColumn() ?: '');
                    }
                    $insertDoc->execute([
                        ':share_id' => $shareId,
                        ':doc_id' => $row['doc_id'],
                        ':title' => $row['title'],
                        ':icon' => isset($row['icon']) && trim((string)$row['icon']) !== '' ? $row['icon'] : null,
                        ':hpath' => $row['hpath'],
                        ':parent_id' => $row['parent_id'] ?? null,
                        ':sort_index' => $row['sort_index'] ?? 0,
                        ':markdown' => $docMarkdown,
                        ':sort_order' => $row['sort_order'] ?? 0,
                        ':size_bytes' => $row['size_bytes'] ?? 0,
                        ':content_hash' => normalize_hash_hex($row['content_hash'] ?? ''),
                        ':meta_hash' => normalize_hash_hex($row['meta_hash'] ?? ''),
                        ':created_at' => now(),
                        ':updated_at' => now(),
                    ]);
                    unset($docMarkdown);
                }
                if (!empty($manifestEntries)) {
                    $assetStmt = $pdo->prepare('INSERT OR REPLACE INTO share_assets (share_id, doc_id, asset_path, file_path, size_bytes, asset_hash, created_at)
                        VALUES (:share_id, :doc_id, :asset_path, :file_path, :size_bytes, :asset_hash, :created_at)');
                    foreach ($manifestEntries as $entry) {
                        $assetStmt->execute([
                            ':share_id' => $shareId,
                            ':doc_id' => $entry['docId'] !== '' ? $entry['docId'] : null,
                            ':asset_path' => $entry['path'],
                            ':file_path' => $assetFiles[$entry['path']],
                            ':size_bytes' => $entry['size'],
                            ':asset_hash' => normalize_hash_hex($entry['hash'] ?? ''),
                            ':created_at' => now(),
                        ]);
                    }
                }
                $updateSize = $pdo->prepare('UPDATE shares SET size_bytes = :size_bytes, updated_at = :updated_at WHERE id = :id');
                $updateSize->execute([
                    ':size_bytes' => $newShareSize,
                    ':updated_at' => now(),
                    ':id' => $shareId,
                ]);
            } else {
                if (!empty($deletedDocIds)) {
                    $placeholders = implode(',', array_fill(0, count($deletedDocIds), '?'));
                    $params = $deletedDocIds;
                    array_unshift($params, $shareId);
                    $stmt = $pdo->prepare('DELETE FROM share_docs WHERE share_id = ? AND doc_id IN (' . $placeholders . ')');
                    $stmt->execute($params);
                }

                $findDoc = $pdo->prepare('SELECT id FROM share_docs WHERE share_id = :share_id AND doc_id = :doc_id LIMIT 1');
                $updateDoc = $pdo->prepare('UPDATE share_docs SET title = :title, icon = :icon, hpath = :hpath, parent_id = :parent_id, sort_index = :sort_index, markdown = :markdown, sort_order = :sort_order, size_bytes = :size_bytes, content_hash = :content_hash, meta_hash = :meta_hash, updated_at = :updated_at WHERE id = :id');
                $insertDoc = $pdo->prepare('INSERT INTO share_docs (share_id, doc_id, title, icon, hpath, parent_id, sort_index, markdown, sort_order, size_bytes, content_hash, meta_hash, created_at, updated_at)
                    VALUES (:share_id, :doc_id, :title, :icon, :hpath, :parent_id, :sort_index, :markdown, :sort_order, :size_bytes, :content_hash, :meta_hash, :created_at, :updated_at)');
                $fetchMdStmt2 = $pdo->prepare('SELECT markdown FROM share_upload_docs WHERE id = :id LIMIT 1');
                foreach ($docRows as $row) {
                    $docKey = trim((string)($row['doc_id'] ?? ''));
                    if ($docKey === '') {
                        continue;
                    }
                    $docMarkdown = '';
                    if (!empty($row['_chunk_file']) && is_file($row['_chunk_file'])) {
                        $docMarkdown = file_get_contents($row['_chunk_file']);
                        if ($docMarkdown === false) throw new RuntimeException('Document staging read failed');
                    } else {
                        $fetchMdStmt2->execute([':id' => (int)$row['_upload_row_id']]);
                        $docMarkdown = (string)($fetchMdStmt2->fetchColumn() ?: '');
                    }
                    $findDoc->execute([
                        ':share_id' => $shareId,
                        ':doc_id' => $docKey,
                    ]);
                    $docRowId = (int)($findDoc->fetchColumn() ?: 0);
                    $bind = [
                        ':title' => $row['title'],
                        ':icon' => isset($row['icon']) && trim((string)$row['icon']) !== '' ? $row['icon'] : null,
                        ':hpath' => $row['hpath'],
                        ':parent_id' => $row['parent_id'] ?? null,
                        ':sort_index' => $row['sort_index'] ?? 0,
                        ':markdown' => $docMarkdown,
                        ':sort_order' => $row['sort_order'] ?? 0,
                        ':size_bytes' => $row['size_bytes'] ?? 0,
                        ':content_hash' => normalize_hash_hex($row['content_hash'] ?? ''),
                        ':meta_hash' => normalize_hash_hex($row['meta_hash'] ?? ''),
                        ':updated_at' => now(),
                    ];
                    unset($docMarkdown);
                    if ($docRowId > 0) {
                        $bind[':id'] = $docRowId;
                        $updateDoc->execute($bind);
                    } else {
                        $insertDoc->execute(array_merge($bind, [
                            ':share_id' => $shareId,
                            ':doc_id' => $docKey,
                            ':created_at' => now(),
                        ]));
                    }
                }

                if (!empty($deletedAssetPaths)) {
                    $placeholders = implode(',', array_fill(0, count($deletedAssetPaths), '?'));
                    $params = $deletedAssetPaths;
                    array_unshift($params, $shareId);
                    $deleteAsset = $pdo->prepare('DELETE FROM share_assets WHERE share_id = ? AND asset_path IN (' . $placeholders . ')');
                    $deleteAsset->execute($params);
                }

                if (!empty($manifestEntries)) {
                    $assetStmt = $pdo->prepare('INSERT OR REPLACE INTO share_assets (share_id, doc_id, asset_path, file_path, size_bytes, asset_hash, created_at)
                        VALUES (:share_id, :doc_id, :asset_path, :file_path, :size_bytes, :asset_hash, :created_at)');
                    foreach ($manifestEntries as $entry) {
                        $assetStmt->execute([
                            ':share_id' => $shareId,
                            ':doc_id' => $entry['docId'] !== '' ? $entry['docId'] : null,
                            ':asset_path' => $entry['path'],
                            ':file_path' => $assetFiles[$entry['path']],
                            ':size_bytes' => $entry['size'],
                            ':asset_hash' => normalize_hash_hex($entry['hash'] ?? ''),
                            ':created_at' => now(),
                        ]);
                    }
                }
                recalculate_share_size($shareId);
            }

            $pdo->prepare('DELETE FROM share_upload_docs WHERE upload_id = :upload_id')->execute([':upload_id' => $uploadId]);
            $pdo->prepare('DELETE FROM share_uploads WHERE upload_id = :upload_id')->execute([':upload_id' => $uploadId]);
            $fileWrite->commit();
        } catch (Throwable $e) {
            $fileWrite->rollback();
            error_log('Upload finalize failed for uploadId=' . $uploadId . ': ' . $e->getMessage() . ' in ' . $e->getFile() . ':' . $e->getLine());
            $status = in_array($e->getCode(), [409, 413], true) ? $e->getCode() : 500;
            api_response($status, null, $status === 500 ? 'Upload finalize failed' : $e->getMessage());
        }

        purge_upload_session_files($uploadId);
        recalculate_user_storage((int)$user['id']);
        api_response(200, [
            'shareId' => $shareId,
            'slug' => $slug,
            'url' => share_url($slug),
        ]);
    }

    if ($path === '/api/v1/shares/upload/cancel' && $_SERVER['REQUEST_METHOD'] === 'POST') {
        $payload = parse_json_body();
        $uploadId = sanitize_upload_id((string)($payload['uploadId'] ?? ''));
        if ($uploadId === '') {
            api_response(400, null, 'Missing upload id');
        }
        $uploadLock = lock_upload_session($uploadId);
        $stmt = $pdo->prepare('SELECT id FROM share_uploads WHERE upload_id = :upload_id AND user_id = :uid LIMIT 1');
        $stmt->execute([
            ':upload_id' => $uploadId,
            ':uid' => $user['id'],
        ]);
        if (!$stmt->fetchColumn()) {
            api_response(404, null, 'Upload not found');
        }
        $pdo->prepare('DELETE FROM share_upload_docs WHERE upload_id = :upload_id')->execute([':upload_id' => $uploadId]);
        $pdo->prepare('DELETE FROM share_uploads WHERE upload_id = :upload_id')->execute([':upload_id' => $uploadId]);
        purge_upload_session_files($uploadId);
        api_response(200, ['ok' => true]);
    }

    if ($path === '/api/v1/shares/doc') {
        $metaRaw = $_POST['metadata'] ?? '';
        if (!$metaRaw) {
            $metaRaw = json_encode(parse_json_body());
        }
        $meta = json_decode($metaRaw, true);
        if (!is_array($meta)) {
            api_response(400, null, '数据格式错误');
        }
        $docId = trim((string)($meta['docId'] ?? ''));
        $title = trim((string)($meta['title'] ?? ''));
        $markdown = (string)($meta['markdown'] ?? '');
        $hPath = (string)($meta['hPath'] ?? '');
        $sortOrder = max(0, (int)($meta['sortOrder'] ?? 0));
        $password = trim((string)($meta['password'] ?? ''));
        $clearPassword = !empty($meta['clearPassword']);
        $expiresAt = parse_expires_at($meta['expiresAt'] ?? null);
        $clearExpires = !empty($meta['clearExpires']);
        $visitorLimit = parse_visitor_limit($meta['visitorLimit'] ?? null);
        $clearVisitorLimit = !empty($meta['clearVisitorLimit']);
        $docs = $meta['docs'] ?? [];
        $hasDocs = is_array($docs) && count($docs) > 0;
        if ($docId === '' || (!$hasDocs && $markdown === '')) {
            api_response(400, null, '缺少文档内容');
        }

        $slug = parse_requested_share_slug_or_fail($meta['slug'] ?? '');
        $paths = $_POST['assetPaths'] ?? [];
        $docIds = $_POST['assetDocIds'] ?? [];
        $paths = is_array($paths) ? $paths : [$paths];
        $docIds = is_array($docIds) ? $docIds : [$docIds];
        $entries = [];
        if (!empty($_FILES['assets'])) {
            $entries = collect_asset_entries($_FILES['assets'], $paths, $docIds);
        }
        $assetSize = 0;
        foreach ($entries as $entry) {
            $assetSize += (int)($entry['size'] ?? 0);
        }
        $docRows = [];
        $docSizeTotal = 0;
        if ($hasDocs) {
            foreach ($docs as $index => $doc) {
                $rowDocId = trim((string)($doc['docId'] ?? ''));
                $rowTitle = trim((string)($doc['title'] ?? ''));
                $rowIcon = trim((string)($doc['icon'] ?? ''));
                $rowHpath = (string)($doc['hPath'] ?? '');
                $rowMarkdown = (string)($doc['markdown'] ?? '');
                $rowSort = max(0, (int)($doc['sortOrder'] ?? $index));
                $rowParent = trim((string)($doc['parentId'] ?? ''));
                $rowSortIndex = (float)($doc['sortIndex'] ?? $index);
                if ($rowDocId === '') {
                    continue;
                }
                $size = strlen($rowMarkdown);
                $rowContentHash = compute_doc_content_hash($rowMarkdown);
                $rowMetaHash = compute_doc_meta_hash([
                    'title' => $rowTitle ?: $rowDocId,
                    'icon' => $rowIcon,
                    'hPath' => $rowHpath,
                    'parentId' => $rowParent,
                    'sortIndex' => $rowSortIndex,
                    'sortOrder' => $rowSort,
                ]);
                $docSizeTotal += $size;
                $docRows[] = [
                    'docId' => $rowDocId,
                    'title' => $rowTitle ?: $rowDocId,
                    'icon' => $rowIcon,
                    'hPath' => $rowHpath,
                    'parentId' => $rowParent,
                    'sortIndex' => $rowSortIndex,
                    'markdown' => $rowMarkdown,
                    'sortOrder' => $rowSort,
                    'size' => $size,
                    'contentHash' => $rowContentHash,
                    'metaHash' => $rowMetaHash,
                ];
            }
            if (empty($docRows)) {
                api_response(400, null, '缺少文档内容');
            }
        } else {
            $docSizeTotal = strlen($markdown);
            $docIcon = trim((string)($meta['icon'] ?? ''));
            $docContentHash = compute_doc_content_hash($markdown);
            $docMetaHash = compute_doc_meta_hash([
                'title' => $title ?: $docId,
                'icon' => $docIcon,
                'hPath' => $hPath,
                'parentId' => '',
                'sortIndex' => 0,
                'sortOrder' => $sortOrder,
            ]);
            $docRows[] = [
                'docId' => $docId,
                'title' => $title ?: $docId,
                'icon' => $docIcon,
                'hPath' => $hPath,
                'parentId' => null,
                'sortIndex' => 0,
                'markdown' => $markdown,
                'sortOrder' => $sortOrder,
                'size' => $docSizeTotal,
                'contentHash' => $docContentHash,
                'metaHash' => $docMetaHash,
            ];
        }
        $fileWrite = new ShareFileWrite($pdo);
        try {
        $baseShareSize = $docSizeTotal + $assetSize;
        $stmt = $pdo->prepare('SELECT * FROM shares WHERE user_id = :uid AND type = "doc" AND doc_id = :doc_id ORDER BY id DESC LIMIT 1');
        $stmt->execute([':uid' => $user['id'], ':doc_id' => $docId]);
        $existing = $stmt->fetch(PDO::FETCH_ASSOC) ?: null;
        $existingSize = $existing ? (int)($existing['size_bytes'] ?? 0) : 0;
        $newShareSize = $baseShareSize;
        $used = recalculate_user_storage((int)$user['id']);
        $limit = get_user_limit_bytes($user);
        $usedWithout = max(0, $used - $existingSize);
        if ($limit > 0 && ($usedWithout + $newShareSize) > $limit) {
            api_response(413, null, '存储空间不足，请清理后重试');
        }

        $passwordHash = $existing['password_hash'] ?? null;
        $expiresValue = isset($existing['expires_at']) ? (int)$existing['expires_at'] : null;
        $visitorValue = isset($existing['visitor_limit']) ? (int)$existing['visitor_limit'] : 0;
        if ($clearPassword) {
            $passwordHash = null;
        } elseif ($password !== '') {
            $passwordHash = password_hash($password, PASSWORD_DEFAULT);
        }
        if ($clearExpires) {
            $expiresValue = null;
        } elseif ($expiresAt !== null) {
            $expiresValue = $expiresAt;
        }
        if ($clearVisitorLimit) {
            $visitorValue = 0;
        } elseif ($visitorLimit !== null) {
            $visitorValue = $visitorLimit;
        }

        if ($existing) {
            if ($slug && $slug !== $existing['slug']) {
                ensure_share_slug_available_or_fail($pdo, $slug, (int)$existing['id']);
            }
            $newSlug = $slug ?: $existing['slug'];
            $stmt = $pdo->prepare('UPDATE shares SET revision = revision + 1, title = :title, slug = :slug, password_hash = :password_hash, expires_at = :expires_at, visitor_limit = :visitor_limit, updated_at = :updated_at, deleted_at = NULL WHERE id = :id');
            $stmt->execute([
                ':title' => $title ?: $existing['title'],
                ':slug' => $newSlug,
                ':password_hash' => $passwordHash,
                ':expires_at' => $expiresValue,
                ':visitor_limit' => $visitorValue,
                ':updated_at' => now(),
                ':id' => $existing['id'],
            ]);
            $shareId = (int)$existing['id'];
            $slug = $newSlug;
        } else {
            if (!$slug) {
                $slug = allocate_random_share_slug_or_fail($pdo);
            } else {
                ensure_share_slug_available_or_fail($pdo, $slug);
            }
            $shareId = allocate_share_id($pdo);
            if ($shareId > 0) {
                $stmt = $pdo->prepare('INSERT INTO shares (id, user_id, type, slug, title, doc_id, password_hash, expires_at, visitor_limit, created_at, updated_at)
                    VALUES (:id, :uid, "doc", :slug, :title, :doc_id, :password_hash, :expires_at, :visitor_limit, :created_at, :updated_at)');
                $stmt->execute([
                    ':id' => $shareId,
                    ':uid' => $user['id'],
                    ':slug' => $slug,
                    ':title' => $title ?: $docId,
                    ':doc_id' => $docId,
                    ':password_hash' => $passwordHash,
                    ':expires_at' => $expiresValue,
                    ':visitor_limit' => $visitorValue,
                    ':created_at' => now(),
                    ':updated_at' => now(),
                ]);
            } else {
                $stmt = $pdo->prepare('INSERT INTO shares (user_id, type, slug, title, doc_id, password_hash, expires_at, visitor_limit, created_at, updated_at)
                    VALUES (:uid, "doc", :slug, :title, :doc_id, :password_hash, :expires_at, :visitor_limit, :created_at, :updated_at)');
                $stmt->execute([
                    ':uid' => $user['id'],
                    ':slug' => $slug,
                    ':title' => $title ?: $docId,
                    ':doc_id' => $docId,
                    ':password_hash' => $passwordHash,
                    ':expires_at' => $expiresValue,
                    ':visitor_limit' => $visitorValue,
                    ':created_at' => now(),
                    ':updated_at' => now(),
                ]);
                $shareId = (int)$pdo->lastInsertId();
            }
        }

        if ($existing) {
            $fileWrite->rememberShare($shareId);
            $pdo->prepare('DELETE FROM share_assets WHERE share_id = ?')->execute([$shareId]);
        }

        $pdo->prepare('DELETE FROM share_docs WHERE share_id = :share_id')->execute([':share_id' => $shareId]);
        $insertDoc = $pdo->prepare('INSERT INTO share_docs (share_id, doc_id, title, icon, hpath, parent_id, sort_index, markdown, sort_order, size_bytes, content_hash, meta_hash, created_at, updated_at)
            VALUES (:share_id, :doc_id, :title, :icon, :hpath, :parent_id, :sort_index, :markdown, :sort_order, :size_bytes, :content_hash, :meta_hash, :created_at, :updated_at)');
        foreach ($docRows as $row) {
            $insertDoc->execute([
                ':share_id' => $shareId,
                ':doc_id' => $row['docId'],
                ':title' => $row['title'],
                ':icon' => $row['icon'] !== '' ? $row['icon'] : null,
                ':hpath' => $row['hPath'],
                ':parent_id' => $row['parentId'] !== '' ? $row['parentId'] : null,
                ':sort_index' => $row['sortIndex'],
                ':markdown' => $row['markdown'],
                ':sort_order' => $row['sortOrder'],
                ':size_bytes' => $row['size'],
                ':content_hash' => normalize_hash_hex($row['contentHash'] ?? ''),
                ':meta_hash' => normalize_hash_hex($row['metaHash'] ?? ''),
                ':created_at' => now(),
                ':updated_at' => now(),
            ]);
        }

        $actualAssets = handle_asset_uploads($shareId, $entries, $fileWrite);
        $finalSize = $docSizeTotal + $actualAssets;
        $stmt = $pdo->prepare('UPDATE shares SET size_bytes = :size_bytes, updated_at = :updated_at WHERE id = :id');
        $stmt->execute([
            ':size_bytes' => $finalSize,
            ':updated_at' => now(),
            ':id' => $shareId,
        ]);
        recalculate_user_storage((int)$user['id']);

        $fileWrite->commit();
        } catch (Throwable $error) {
            $fileWrite->rollback();
            error_log('Direct upload failed: ' . $error->getMessage());
            api_response(500, null, 'Upload failed; previous share preserved');
        }

        api_response(200, ['share' => [
            'id' => $shareId,
            'slug' => $slug,
            'url' => share_url($slug),
        ]]);
    }

    if ($path === '/api/v1/shares/notebook') {
        $metaRaw = $_POST['metadata'] ?? '';
        if (!$metaRaw) {
            $metaRaw = json_encode(parse_json_body());
        }
        $meta = json_decode($metaRaw, true);
        if (!is_array($meta)) {
            api_response(400, null, '数据格式错误');
        }
        $notebookId = trim((string)($meta['notebookId'] ?? ''));
        $title = trim((string)($meta['title'] ?? ''));
        $docs = $meta['docs'] ?? [];
        $password = trim((string)($meta['password'] ?? ''));
        $clearPassword = !empty($meta['clearPassword']);
        $expiresAt = parse_expires_at($meta['expiresAt'] ?? null);
        $clearExpires = !empty($meta['clearExpires']);
        $visitorLimit = parse_visitor_limit($meta['visitorLimit'] ?? null);
        $clearVisitorLimit = !empty($meta['clearVisitorLimit']);
        if ($notebookId === '' || !is_array($docs) || count($docs) === 0) {
            api_response(400, null, '缺少笔记本 ID 或文档数据');
        }

        $slug = parse_requested_share_slug_or_fail($meta['slug'] ?? '');
        $paths = $_POST['assetPaths'] ?? [];
        $docIds = $_POST['assetDocIds'] ?? [];
        $paths = is_array($paths) ? $paths : [$paths];
        $docIds = is_array($docIds) ? $docIds : [$docIds];
        $entries = [];
        if (!empty($_FILES['assets'])) {
            $entries = collect_asset_entries($_FILES['assets'], $paths, $docIds);
        }
        $assetSize = 0;
        foreach ($entries as $entry) {
            $assetSize += (int)($entry['size'] ?? 0);
        }
        $docRows = [];
        $docSizeTotal = 0;
        foreach ($docs as $index => $doc) {
            $docId = trim((string)($doc['docId'] ?? ''));
            $docTitle = trim((string)($doc['title'] ?? ''));
            $docIcon = trim((string)($doc['icon'] ?? ''));
            $docHpath = (string)($doc['hPath'] ?? '');
            $docMarkdown = (string)($doc['markdown'] ?? '');
            $docSort = max(0, (int)($doc['sortOrder'] ?? $index));
            $docParent = trim((string)($doc['parentId'] ?? ''));
            $docSortIndex = (float)($doc['sortIndex'] ?? $index);
            if ($docId === '') {
                continue;
            }
            $size = strlen($docMarkdown);
            $docContentHash = compute_doc_content_hash($docMarkdown);
            $docMetaHash = compute_doc_meta_hash([
                'title' => $docTitle ?: $docId,
                'icon' => $docIcon,
                'hPath' => $docHpath,
                'parentId' => $docParent,
                'sortIndex' => $docSortIndex,
                'sortOrder' => $docSort,
            ]);
            $docSizeTotal += $size;
            $docRows[] = [
                'docId' => $docId,
                'title' => $docTitle ?: $docId,
                'icon' => $docIcon,
                'hPath' => $docHpath,
                'parentId' => $docParent,
                'sortIndex' => $docSortIndex,
                'markdown' => $docMarkdown,
                'sortOrder' => $docSort,
                'size' => $size,
                'contentHash' => $docContentHash,
                'metaHash' => $docMetaHash,
            ];
        }
        if (empty($docRows)) {
            api_response(400, null, '没有可用的文档');
        }
        $fileWrite = new ShareFileWrite($pdo);
        try {
        $baseShareSize = $docSizeTotal + $assetSize;
        $stmt = $pdo->prepare('SELECT * FROM shares WHERE user_id = :uid AND type = "notebook" AND notebook_id = :nid ORDER BY id DESC LIMIT 1');
        $stmt->execute([':uid' => $user['id'], ':nid' => $notebookId]);
        $existing = $stmt->fetch(PDO::FETCH_ASSOC) ?: null;
        $existingSize = $existing ? (int)($existing['size_bytes'] ?? 0) : 0;
        $newShareSize = $baseShareSize;
        $used = recalculate_user_storage((int)$user['id']);
        $limit = get_user_limit_bytes($user);
        $usedWithout = max(0, $used - $existingSize);
        if ($limit > 0 && ($usedWithout + $newShareSize) > $limit) {
            api_response(413, null, '存储空间不足，请清理后重试');
        }

        $passwordHash = $existing['password_hash'] ?? null;
        $expiresValue = isset($existing['expires_at']) ? (int)$existing['expires_at'] : null;
        $visitorValue = isset($existing['visitor_limit']) ? (int)$existing['visitor_limit'] : 0;
        if ($clearPassword) {
            $passwordHash = null;
        } elseif ($password !== '') {
            $passwordHash = password_hash($password, PASSWORD_DEFAULT);
        }
        if ($clearExpires) {
            $expiresValue = null;
        } elseif ($expiresAt !== null) {
            $expiresValue = $expiresAt;
        }
        if ($clearVisitorLimit) {
            $visitorValue = 0;
        } elseif ($visitorLimit !== null) {
            $visitorValue = $visitorLimit;
        }

        if ($existing) {
            if ($slug && $slug !== $existing['slug']) {
                ensure_share_slug_available_or_fail($pdo, $slug, (int)$existing['id']);
            }
            $newSlug = $slug ?: $existing['slug'];
            $stmt = $pdo->prepare('UPDATE shares SET revision = revision + 1, title = :title, slug = :slug, password_hash = :password_hash, expires_at = :expires_at, visitor_limit = :visitor_limit, updated_at = :updated_at, deleted_at = NULL WHERE id = :id');
            $stmt->execute([
                ':title' => $title ?: $existing['title'],
                ':slug' => $newSlug,
                ':password_hash' => $passwordHash,
                ':expires_at' => $expiresValue,
                ':visitor_limit' => $visitorValue,
                ':updated_at' => now(),
                ':id' => $existing['id'],
            ]);
            $shareId = (int)$existing['id'];
            $slug = $newSlug;
        } else {
            if (!$slug) {
                $slug = allocate_random_share_slug_or_fail($pdo);
            } else {
                ensure_share_slug_available_or_fail($pdo, $slug);
            }
            $shareId = allocate_share_id($pdo);
            if ($shareId > 0) {
                $stmt = $pdo->prepare('INSERT INTO shares (id, user_id, type, slug, title, notebook_id, password_hash, expires_at, visitor_limit, created_at, updated_at)
                    VALUES (:id, :uid, "notebook", :slug, :title, :notebook_id, :password_hash, :expires_at, :visitor_limit, :created_at, :updated_at)');
                $stmt->execute([
                    ':id' => $shareId,
                    ':uid' => $user['id'],
                    ':slug' => $slug,
                    ':title' => $title ?: $notebookId,
                    ':notebook_id' => $notebookId,
                    ':password_hash' => $passwordHash,
                    ':expires_at' => $expiresValue,
                    ':visitor_limit' => $visitorValue,
                    ':created_at' => now(),
                    ':updated_at' => now(),
                ]);
            } else {
                $stmt = $pdo->prepare('INSERT INTO shares (user_id, type, slug, title, notebook_id, password_hash, expires_at, visitor_limit, created_at, updated_at)
                    VALUES (:uid, "notebook", :slug, :title, :notebook_id, :password_hash, :expires_at, :visitor_limit, :created_at, :updated_at)');
                $stmt->execute([
                    ':uid' => $user['id'],
                    ':slug' => $slug,
                    ':title' => $title ?: $notebookId,
                    ':notebook_id' => $notebookId,
                    ':password_hash' => $passwordHash,
                    ':expires_at' => $expiresValue,
                    ':visitor_limit' => $visitorValue,
                    ':created_at' => now(),
                    ':updated_at' => now(),
                ]);
                $shareId = (int)$pdo->lastInsertId();
            }
        }

        if ($existing) {
            $fileWrite->rememberShare($shareId);
            $pdo->prepare('DELETE FROM share_assets WHERE share_id = ?')->execute([$shareId]);
        }

        $pdo->prepare('DELETE FROM share_docs WHERE share_id = :share_id')->execute([':share_id' => $shareId]);
        $stmt = $pdo->prepare('INSERT INTO share_docs (share_id, doc_id, title, icon, hpath, parent_id, sort_index, markdown, sort_order, size_bytes, content_hash, meta_hash, created_at, updated_at)
            VALUES (:share_id, :doc_id, :title, :icon, :hpath, :parent_id, :sort_index, :markdown, :sort_order, :size_bytes, :content_hash, :meta_hash, :created_at, :updated_at)');
        foreach ($docRows as $row) {
            $stmt->execute([
                ':share_id' => $shareId,
                ':doc_id' => $row['docId'],
                ':title' => $row['title'],
                ':icon' => $row['icon'] !== '' ? $row['icon'] : null,
                ':hpath' => $row['hPath'],
                ':parent_id' => $row['parentId'] !== '' ? $row['parentId'] : null,
                ':sort_index' => $row['sortIndex'],
                ':markdown' => $row['markdown'],
                ':sort_order' => (int)$row['sortOrder'],
                ':size_bytes' => $row['size'],
                ':content_hash' => normalize_hash_hex($row['contentHash'] ?? ''),
                ':meta_hash' => normalize_hash_hex($row['metaHash'] ?? ''),
                ':created_at' => now(),
                ':updated_at' => now(),
            ]);
        }

        $actualAssets = handle_asset_uploads($shareId, $entries, $fileWrite);
        $finalSize = $docSizeTotal + $actualAssets;
        $stmt = $pdo->prepare('UPDATE shares SET size_bytes = :size_bytes, updated_at = :updated_at WHERE id = :id');
        $stmt->execute([
            ':size_bytes' => $finalSize,
            ':updated_at' => now(),
            ':id' => $shareId,
        ]);
        recalculate_user_storage((int)$user['id']);

        $fileWrite->commit();
        } catch (Throwable $error) {
            $fileWrite->rollback();
            error_log('Direct upload failed: ' . $error->getMessage());
            api_response(500, null, 'Upload failed; previous share preserved');
        }

        api_response(200, ['share' => [
            'id' => $shareId,
            'slug' => $slug,
            'url' => share_url($slug),
        ]]);
    }

    api_response(404, null, '接口不存在');
}
