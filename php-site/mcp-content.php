<?php
declare(strict_types=1);

// Read-only MCP content access: public share filtering, hierarchical tree drill-down,
// code/math-safe Markdown normalization, outline offsets, chunked reading, and search.

function mcp_public_share_where(string $alias = ''): string {
    $p = $alias !== '' ? $alias . '.' : '';
    return "{$p}deleted_at IS NULL AND ({$p}password_hash IS NULL OR {$p}password_hash = '') "
         . "AND ({$p}expires_at IS NULL OR {$p}expires_at = 0 OR {$p}expires_at > :now) "
         . "AND {$p}user_id = :uid";
}

function mcp_find_public_share(int $userId, string $slug): ?array {
    if ($userId <= 0 || $slug === '') {
        return null;
    }
    $pdo = db();
    $sql = 'SELECT * FROM shares WHERE slug = :slug AND ' . mcp_public_share_where() . ' LIMIT 1';
    $stmt = $pdo->prepare($sql);
    $stmt->execute([
        ':slug' => $slug,
        ':now' => time(),
        ':uid' => $userId,
    ]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}

function mcp_validate_doc_id(string $docId): string {
    $docId = trim($docId);
    if ($docId === '' || strlen($docId) > 128 || !mb_check_encoding($docId, 'UTF-8')) {
        throw new InvalidArgumentException('Invalid doc_id parameter.');
    }
    if (preg_match('/[\x00-\x1F\x7F\s\/\\\\]/u', $docId)) {
        throw new InvalidArgumentException('Invalid characters in doc_id parameter.');
    }
    return $docId;
}

function mcp_parse_share_target(string $shareInput, ?string $docIdInput = null): array {
    $raw = trim($shareInput);
    if ($raw === '') {
        throw new InvalidArgumentException('share parameter is required.');
    }
    $slug = '';
    $urlDocId = null;
    if (preg_match('#^(?:https?://|/)#i', $raw)) {
        $parts = parse_url($raw);
        if (!is_array($parts)) {
            throw new InvalidArgumentException('Invalid share URL.');
        }
        $urlPath = (string)($parts['path'] ?? '');
        if (!preg_match('~(?:^|/)s/([a-zA-Z0-9_-]+)(?:/([^/?#]+))?~', $urlPath, $matches)) {
            throw new InvalidArgumentException('Share URL must point to /s/<slug> or /s/<slug>/<doc_id>.');
        }
        $slug = (string)$matches[1];
        if (isset($matches[2]) && $matches[2] !== '') {
            $decoded = rawurldecode((string)$matches[2]);
            if ($decoded !== '') {
                $urlDocId = $decoded;
            }
        }
    } else {
        $slug = $raw;
    }
    if ($slug === '' || strlen($slug) > 128 || !preg_match('/^[a-zA-Z0-9_-]+$/D', $slug)) {
        throw new InvalidArgumentException('Invalid share slug.');
    }
    $docId = null;
    if ($docIdInput !== null && trim($docIdInput) !== '') {
        $docId = mcp_validate_doc_id($docIdInput);
    } elseif ($urlDocId !== null) {
        $docId = mcp_validate_doc_id($urlDocId);
    }
    return ['slug' => $slug, 'doc_id' => $docId];
}

function mcp_share_doc_url(string $slug, ?string $docId = null): string {
    $url = base_url() . '/s/' . rawurlencode($slug);
    if ($docId !== null && $docId !== '') {
        $url .= '/' . rawurlencode($docId);
    }
    return $url;
}

function mcp_load_share_doc_meta(int $shareId): array {
    $pdo = db();
    $stmt = $pdo->prepare(
        'SELECT id, doc_id, title, icon, hpath, parent_id, sort_index, sort_order,
                updated_at, LENGTH(markdown) AS char_count
         FROM share_docs
         WHERE share_id = :sid
         ORDER BY sort_order ASC, id ASC'
    );
    $stmt->execute([':sid' => $shareId]);
    return $stmt->fetchAll(PDO::FETCH_ASSOC);
}

function mcp_node_summary(array $node, string $slug): array {
    $doc = is_array($node['doc'] ?? null) ? $node['doc'] : null;
    $docId = $doc !== null ? (string)($doc['doc_id'] ?? '') : '';
    $title = (string)($node['title'] ?? $docId);
    $children = is_array($node['children'] ?? null) ? $node['children'] : [];
    $charCount = $doc !== null ? (int)($doc['char_count'] ?? 0) : 0;
    return [
        'doc_id' => $docId,
        'title' => $title,
        'child_count' => count($children),
        'char_count' => $charCount,
        'url' => $docId !== '' ? mcp_share_doc_url($slug, $docId) : null,
    ];
}

function mcp_find_tree_node(array $nodes, string $targetDocId): ?array {
    foreach ($nodes as $node) {
        $doc = is_array($node['doc'] ?? null) ? $node['doc'] : null;
        if ($doc !== null && (string)($doc['doc_id'] ?? '') === $targetDocId) {
            return $node;
        }
        if (!empty($node['children']) && is_array($node['children'])) {
            $found = mcp_find_tree_node($node['children'], $targetDocId);
            if ($found !== null) {
                return $found;
            }
        }
    }
    return null;
}

function mcp_collect_subtree_doc_ids(array $node, array &$ids): void {
    $doc = is_array($node['doc'] ?? null) ? $node['doc'] : null;
    if ($doc !== null) {
        $docId = (string)($doc['doc_id'] ?? '');
        if ($docId !== '') {
            $ids[$docId] = true;
        }
    }
    if (!empty($node['children']) && is_array($node['children'])) {
        foreach ($node['children'] as $child) {
            mcp_collect_subtree_doc_ids($child, $ids);
        }
    }
}

function mcp_parse_cursor(?string $cursor): int {
    if ($cursor === null || trim($cursor) === '') {
        return 0;
    }
    $cursor = trim($cursor);
    if (ctype_digit($cursor)) {
        return max(0, (int)$cursor);
    }
    $decoded = base64_decode(strtr($cursor, '-_', '+/'), true);
    if ($decoded !== false) {
        $data = json_decode($decoded, true);
        if (is_array($data) && isset($data['offset']) && is_int($data['offset']) && $data['offset'] >= 0) {
            return $data['offset'];
        }
    }
    throw new InvalidArgumentException('Invalid pagination cursor.');
}

function mcp_encode_cursor(int $offset): string {
    return rtrim(strtr(base64_encode(json_encode(['offset' => $offset])), '+/', '-_'), '=');
}

function mcp_list_shares(int $userId, ?string $cursor = null, int $pageSize = 50): array {
    $offset = mcp_parse_cursor($cursor);
    $pageSize = max(1, min(100, $pageSize));
    $pdo = db();
    $sql = 'SELECT id, slug, title, type, doc_id, updated_at, created_at
            FROM shares
            WHERE ' . mcp_public_share_where() . '
            ORDER BY updated_at DESC, id DESC
            LIMIT :limit OFFSET :offset';
    $stmt = $pdo->prepare($sql);
    $stmt->bindValue(':now', time(), PDO::PARAM_INT);
    $stmt->bindValue(':uid', $userId, PDO::PARAM_INT);
    $stmt->bindValue(':limit', $pageSize + 1, PDO::PARAM_INT);
    $stmt->bindValue(':offset', $offset, PDO::PARAM_INT);
    $stmt->execute();
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

    $hasMore = count($rows) > $pageSize;
    if ($hasMore) {
        array_pop($rows);
    }

    $homeKey = reader_home_url_key(trim((string)get_setting('reader_home_url', '')));
    $shares = [];
    foreach ($rows as $row) {
        $slug = (string)$row['slug'];
        $shareUrl = mcp_share_doc_url($slug);
        $isHome = $homeKey !== '' && $homeKey === reader_home_url_key($shareUrl);
        $docs = mcp_load_share_doc_meta((int)$row['id']);
        $docCount = count($docs);
        $topLevelDocs = [];
        $hasMoreRoots = false;
        if ($docCount > 0) {
            $tree = build_doc_tree($docs);
            $rootCount = 0;
            foreach ($tree as $rootNode) {
                if ($rootCount >= 50) {
                    $hasMoreRoots = true;
                    break;
                }
                $topLevelDocs[] = mcp_node_summary($rootNode, $slug);
                $rootCount++;
            }
        }
        $shares[] = [
            'slug' => $slug,
            'title' => (string)$row['title'],
            'type' => (string)$row['type'],
            'is_home' => $isHome,
            'doc_count' => $docCount,
            'updated_at' => (string)$row['updated_at'],
            'url' => $shareUrl,
            'top_level_docs' => $topLevelDocs,
            'has_more_roots' => $hasMoreRoots,
        ];
    }

    return [
        'shares' => $shares,
        'total_returned' => count($shares),
        'next_cursor' => $hasMore ? mcp_encode_cursor($offset + $pageSize) : null,
    ];
}

function mcp_serialize_tree_nodes(array $nodes, string $slug, int $currentDepth, int $maxDepth, int &$count, int $maxNodes, bool &$truncated): array {
    $result = [];
    foreach ($nodes as $node) {
        if ($count >= $maxNodes) {
            $truncated = true;
            break;
        }
        $count++;
        $entry = mcp_node_summary($node, $slug);
        $children = is_array($node['children'] ?? null) ? $node['children'] : [];
        if ($currentDepth < $maxDepth && !empty($children)) {
            $entry['children'] = mcp_serialize_tree_nodes($children, $slug, $currentDepth + 1, $maxDepth, $count, $maxNodes, $truncated);
        } else {
            $entry['children'] = [];
        }
        $result[] = $entry;
    }
    return $result;
}

function mcp_get_share_tree(int $userId, string $shareInput, ?string $parentDocId = null, ?int $maxDepth = null): array {
    $target = mcp_parse_share_target($shareInput, null);
    $slug = $target['slug'];
    $share = mcp_find_public_share($userId, $slug);
    if (!$share) {
        throw new RuntimeException('Public share not found or not accessible.');
    }
    $docs = mcp_load_share_doc_meta((int)$share['id']);
    $tree = build_doc_tree($docs);

    $parentInfo = null;
    if ($parentDocId !== null && trim($parentDocId) !== '') {
        $validParentId = mcp_validate_doc_id($parentDocId);
        $found = mcp_find_tree_node($tree, $validParentId);
        if ($found === null) {
            throw new RuntimeException('Parent document not found in this public share.');
        }
        $parentInfo = mcp_node_summary($found, $slug);
        $startNodes = is_array($found['children'] ?? null) ? $found['children'] : [];
        $effectiveMaxDepth = $maxDepth !== null ? $maxDepth : 1;
    } else {
        $startNodes = $tree;
        $effectiveMaxDepth = $maxDepth !== null ? $maxDepth : 2;
    }
    $effectiveMaxDepth = max(1, min(6, $effectiveMaxDepth));

    $count = 0;
    $truncated = false;
    $nodes = mcp_serialize_tree_nodes($startNodes, $slug, 1, $effectiveMaxDepth, $count, 150, $truncated);

    return [
        'share_slug' => $slug,
        'share_title' => (string)$share['title'],
        'share_url' => mcp_share_doc_url($slug),
        'doc_count' => count($docs),
        'parent' => $parentInfo,
        'max_depth' => $effectiveMaxDepth,
        'returned_nodes' => $count,
        'truncated' => $truncated,
        'hint' => $truncated
            ? 'Tree truncated at 150 nodes. Call get_share_tree with a specific parent_doc_id to drill down further.'
            : null,
        'nodes' => $nodes,
    ];
}

function mcp_rewrite_asset_path_url(string $rawPath, string $assetBase): string {
    $path = trim($rawPath);
    if (str_starts_with($path, './')) {
        $path = substr($path, 2);
    } elseif (str_starts_with($path, '/')) {
        $path = substr($path, 1);
    }
    $query = '';
    $fragment = '';
    $hashPos = strpos($path, '#');
    if ($hashPos !== false) {
        $fragment = substr($path, $hashPos);
        $path = substr($path, 0, $hashPos);
    }
    $qPos = strpos($path, '?');
    if ($qPos !== false) {
        $query = substr($path, $qPos);
        $path = substr($path, 0, $qPos);
    }
    $encoded = encode_path_segments(rawurldecode($path));
    return $assetBase . $encoded . $query . $fragment;
}

function mcp_rewrite_markdown_segment_assets(string $segment, string $assetBase): string {
    // Angle-bracketed Markdown links: ](<assets/...> "title")
    $segment = preg_replace_callback(
        '/\]\(<(\.?\/?(?:assets|emojis)\/[^>]+)>(\s+[^)]*)?\)/u',
        static function (array $m) use ($assetBase): string {
            $url = mcp_rewrite_asset_path_url($m[1], $assetBase);
            $suffix = $m[2] ?? '';
            return '](' . $url . $suffix . ')';
        },
        $segment
    ) ?? $segment;

    // Standard Markdown links/images: ](assets/... "title")
    $segment = preg_replace_callback(
        '/\]\((\.?\/?(?:assets|emojis)\/[^)\r\n]+?)(?:(\s+(?:"[^"]*"|\'[^\']*\'))?)\)/u',
        static function (array $m) use ($assetBase): string {
            $url = mcp_rewrite_asset_path_url($m[1], $assetBase);
            $suffix = $m[2] ?? '';
            return '](' . $url . $suffix . ')';
        },
        $segment
    ) ?? $segment;

    // HTML src/href attributes: src="assets/..." or href="./assets/..."
    $segment = preg_replace_callback(
        '/\b(src|href)=(["\'])(\.?\/?(?:assets|emojis)\/[^"\']+)\2/iu',
        static function (array $m) use ($assetBase): string {
            $url = mcp_rewrite_asset_path_url($m[3], $assetBase);
            return $m[1] . '=' . $m[2] . $url . $m[2];
        },
        $segment
    ) ?? $segment;

    return $segment;
}

function mcp_clean_inline_line(string $line, string $assetBase): string {
    // Split out inline backtick code spans so sample paths and {: ...} inside `...` are never modified.
    $parts = preg_split('/(`+[^`\r\n]*`+)/u', $line, -1, PREG_SPLIT_DELIM_CAPTURE);
    if (!is_array($parts)) {
        $cleaned = preg_replace('/\s*\{:\s+(?:[a-zA-Z0-9_-]+="[^"]*"\s*)+\}/u', '', $line) ?? $line;
        return mcp_rewrite_markdown_segment_assets($cleaned, $assetBase);
    }
    $out = '';
    foreach ($parts as $idx => $part) {
        if ($idx % 2 === 1) {
            $out .= $part;
        } else {
            $cleaned = preg_replace('/\s*\{:\s+(?:[a-zA-Z0-9_-]+="[^"]*"\s*)+\}/u', '', $part) ?? $part;
            $out .= mcp_rewrite_markdown_segment_assets($cleaned, $assetBase);
        }
    }
    return $out;
}

function mcp_prepare_doc_markdown(string $rawMarkdown, string $title, string $slug): string {
    $front = extract_front_matter($rawMarkdown);
    $body = (string)($front['body'] ?? $rawMarkdown);
    $body = strip_duplicate_title_heading($body, $title);
    $body = str_replace(["\r\n", "\r"], "\n", $body);

    $lines = explode("\n", $body);
    $assetBase = base_url() . '/s/' . rawurlencode($slug) . '/res/';

    $inFence = false;
    $fenceChar = '';
    $fenceLen = 0;
    $inMathBlock = false;
    $outLines = [];

    foreach ($lines as $line) {
        if (!$inMathBlock) {
            if (!$inFence && preg_match('/^\s{0,3}(`{3,}|~{3,})/', $line, $fm)) {
                $inFence = true;
                $fenceChar = $fm[1][0];
                $fenceLen = strlen($fm[1]);
                $outLines[] = $line;
                continue;
            }
            if ($inFence) {
                if (preg_match('/^\s{0,3}' . preg_quote($fenceChar, '/') . '{' . $fenceLen . ',}\s*$/', $line)) {
                    $inFence = false;
                    $fenceChar = '';
                    $fenceLen = 0;
                }
                $outLines[] = $line;
                continue;
            }
        }

        $trimmed = trim($line);
        if (!$inMathBlock && $trimmed === '$$') {
            $inMathBlock = true;
            $outLines[] = $line;
            continue;
        }
        if ($inMathBlock) {
            if ($trimmed === '$$') {
                $inMathBlock = false;
            }
            $outLines[] = $line;
            continue;
        }
        // Single-line display math block $$ ... $$
        if (strlen($trimmed) >= 4 && str_starts_with($trimmed, '$$') && str_ends_with($trimmed, '$$')) {
            $outLines[] = $line;
            continue;
        }

        // Skip standalone SiYuan IAL attribute lines: {: id="..." updated="..."}
        if (preg_match('/^\s*\{:\s+(?:[a-zA-Z0-9_-]+="[^"]*"\s*)+\}\s*$/u', $line)) {
            continue;
        }

        // Strip inline SiYuan IAL attributes and rewrite asset paths safely outside inline code spans
        $outLines[] = mcp_clean_inline_line($line, $assetBase);
    }

    return implode("\n", $outLines);
}

function mcp_resolve_document_row(array $share, ?string $docId): array {
    $pdo = db();
    $shareId = (int)$share['id'];
    $countStmt = $pdo->prepare('SELECT COUNT(*) FROM share_docs WHERE share_id = :sid');
    $countStmt->execute([':sid' => $shareId]);
    $totalDocs = (int)$countStmt->fetchColumn();
    if ($totalDocs === 0) {
        throw new RuntimeException('No documents found in this public share.');
    }

    if ($docId !== null && $docId !== '') {
        $stmt = $pdo->prepare(
            'SELECT id, doc_id, title, hpath, markdown, updated_at
             FROM share_docs
             WHERE share_id = :sid AND doc_id = :doc_id
             LIMIT 1'
        );
        $stmt->execute([':sid' => $shareId, ':doc_id' => $docId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            throw new RuntimeException('Document not found in this public share.');
        }
        return ['doc' => $row, 'total_docs' => $totalDocs, 'defaulted' => false];
    }

    $shareRootDocId = trim((string)($share['doc_id'] ?? ''));
    if ($shareRootDocId !== '') {
        $stmt = $pdo->prepare(
            'SELECT id, doc_id, title, hpath, markdown, updated_at
             FROM share_docs
             WHERE share_id = :sid AND doc_id = :doc_id
             LIMIT 1'
        );
        $stmt->execute([':sid' => $shareId, ':doc_id' => $shareRootDocId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if ($row) {
            return ['doc' => $row, 'total_docs' => $totalDocs, 'defaulted' => $totalDocs > 1];
        }
    }

    $stmt = $pdo->prepare(
        'SELECT id, doc_id, title, hpath, markdown, updated_at
         FROM share_docs
         WHERE share_id = :sid
         ORDER BY sort_order ASC, id ASC
         LIMIT 1'
    );
    $stmt->execute([':sid' => $shareId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row) {
        throw new RuntimeException('No documents found in this public share.');
    }
    return ['doc' => $row, 'total_docs' => $totalDocs, 'defaulted' => $totalDocs > 1];
}

function mcp_get_document_outline(int $userId, string $shareInput, ?string $docIdInput = null): array {
    $target = mcp_parse_share_target($shareInput, $docIdInput);
    $slug = $target['slug'];
    $share = mcp_find_public_share($userId, $slug);
    if (!$share) {
        throw new RuntimeException('Public share not found or not accessible.');
    }
    $resolved = mcp_resolve_document_row($share, $target['doc_id']);
    $doc = $resolved['doc'];
    $clean = mcp_prepare_doc_markdown((string)$doc['markdown'], (string)$doc['title'], $slug);
    $totalChars = mb_strlen($clean, 'UTF-8');

    $lines = explode("\n", $clean);
    $inFence = false;
    $fenceChar = '';
    $fenceLen = 0;
    $inMathBlock = false;
    $charOffset = 0;
    $headings = [];

    foreach ($lines as $line) {
        $lineLen = mb_strlen($line, 'UTF-8');
        $trimmed = trim($line);

        if (!$inMathBlock) {
            if (!$inFence && preg_match('/^\s{0,3}(`{3,}|~{3,})/', $line, $fm)) {
                $inFence = true;
                $fenceChar = $fm[1][0];
                $fenceLen = strlen($fm[1]);
                $charOffset += $lineLen + 1;
                continue;
            }
            if ($inFence) {
                if (preg_match('/^\s{0,3}' . preg_quote($fenceChar, '/') . '{' . $fenceLen . ',}\s*$/', $line)) {
                    $inFence = false;
                    $fenceChar = '';
                    $fenceLen = 0;
                }
                $charOffset += $lineLen + 1;
                continue;
            }
        }

        if (!$inMathBlock && $trimmed === '$$') {
            $inMathBlock = true;
            $charOffset += $lineLen + 1;
            continue;
        }
        if ($inMathBlock) {
            if ($trimmed === '$$') {
                $inMathBlock = false;
            }
            $charOffset += $lineLen + 1;
            continue;
        }

        if (preg_match('/^(#{1,6})\s+(.+?)\s*#*$/u', $line, $hm)) {
            $headings[] = [
                'level' => strlen($hm[1]),
                'title' => trim($hm[2]),
                'offset' => $charOffset,
            ];
        }

        $charOffset += $lineLen + 1;
    }

    return [
        'share_slug' => $slug,
        'share_title' => (string)$share['title'],
        'doc_id' => (string)$doc['doc_id'],
        'title' => (string)$doc['title'],
        'hpath' => (string)($doc['hpath'] ?? ''),
        'url' => mcp_share_doc_url($slug, (string)$doc['doc_id']),
        'total_chars' => $totalChars,
        'headings' => $headings,
    ];
}

function mcp_protected_block_state(string $prefix): array {
    $lines = explode("\n", $prefix);
    $inFence = false;
    $fenceChar = '';
    $fenceLen = 0;
    $inMathBlock = false;
    $blockStartOffset = null;
    $offset = 0;

    foreach ($lines as $idx => $line) {
        $trimmed = trim($line);
        if (!$inMathBlock) {
            if (!$inFence && preg_match('/^\s{0,3}(`{3,}|~{3,})/', $line, $fm)) {
                $inFence = true;
                $fenceChar = $fm[1][0];
                $fenceLen = strlen($fm[1]);
                $blockStartOffset = $offset;
                $offset += mb_strlen($line, 'UTF-8') + 1;
                continue;
            }
            if ($inFence) {
                if (preg_match('/^\s{0,3}' . preg_quote($fenceChar, '/') . '{' . $fenceLen . ',}\s*$/', $line)) {
                    $inFence = false;
                    $fenceChar = '';
                    $fenceLen = 0;
                    $blockStartOffset = null;
                }
                $offset += mb_strlen($line, 'UTF-8') + 1;
                continue;
            }
        }

        if (!$inMathBlock && $trimmed === '$$') {
            $inMathBlock = true;
            $blockStartOffset = $offset;
        } elseif ($inMathBlock && $trimmed === '$$') {
            $inMathBlock = false;
            $blockStartOffset = null;
        }

        $offset += mb_strlen($line, 'UTF-8') + 1;
    }

    return [
        'in_block' => $inFence || $inMathBlock,
        'block_start' => $blockStartOffset,
    ];
}

function mcp_find_safe_split_offset(string $text, int $start, int $maxChars): int {
    $total = mb_strlen($text, 'UTF-8');
    $hardEnd = min($total, $start + $maxChars);
    if ($hardEnd >= $total) {
        return $total;
    }

    $window = mb_substr($text, $start, $hardEnd - $start, 'UTF-8');
    $windowLen = mb_strlen($window, 'UTF-8');
    $minRel = (int)floor($windowLen * 0.75);

    // Collect candidate split points (prefer paragraph breaks "\n\n", then line breaks "\n").
    $candidateRel = null;
    $searchFrom = $windowLen;
    while ($searchFrom > $minRel) {
        $sub = mb_substr($window, 0, $searchFrom, 'UTF-8');
        $pos = mb_strrpos($sub, "\n\n", 0, 'UTF-8');
        if ($pos === false || $pos < $minRel) {
            break;
        }
        $candidate = $pos + 2;
        $state = mcp_protected_block_state(mb_substr($text, 0, $start + $candidate, 'UTF-8'));
        if (!$state['in_block']) {
            $candidateRel = $candidate;
            break;
        }
        $searchFrom = $pos;
    }

    if ($candidateRel !== null && $candidateRel > 0) {
        return $start + $candidateRel;
    }

    // Check if hardEnd falls inside a fenced code block or $$ math block.
    $endState = mcp_protected_block_state(mb_substr($text, 0, $hardEnd, 'UTF-8'));
    if ($endState['in_block'] && $endState['block_start'] !== null && $endState['block_start'] > $start) {
        // Safely back up to just before the unclosed block starts.
        return $endState['block_start'];
    }

    // Otherwise try a clean newline near the end of the window.
    $nlPos = mb_strrpos($window, "\n", 0, 'UTF-8');
    if ($nlPos !== false && $nlPos >= $minRel) {
        return $start + $nlPos + 1;
    }

    return $hardEnd;
}

function mcp_read_document(int $userId, string $shareInput, ?string $docIdInput = null, int $offset = 0, int $maxChars = 20000): array {
    if ($offset < 0) {
        throw new InvalidArgumentException('offset must be a non-negative integer.');
    }
    $maxChars = max(1000, min(50000, $maxChars));

    $target = mcp_parse_share_target($shareInput, $docIdInput);
    $slug = $target['slug'];
    $share = mcp_find_public_share($userId, $slug);
    if (!$share) {
        throw new RuntimeException('Public share not found or not accessible.');
    }
    $resolved = mcp_resolve_document_row($share, $target['doc_id']);
    $doc = $resolved['doc'];
    $clean = mcp_prepare_doc_markdown((string)$doc['markdown'], (string)$doc['title'], $slug);
    $totalChars = mb_strlen($clean, 'UTF-8');

    if ($offset >= $totalChars) {
        $chunk = '';
        $nextOffset = null;
    } else {
        $endOffset = mcp_find_safe_split_offset($clean, $offset, $maxChars);
        $chunk = mb_substr($clean, $offset, $endOffset - $offset, 'UTF-8');
        $nextOffset = $endOffset < $totalChars ? $endOffset : null;
    }

    $note = null;
    if ($resolved['defaulted']) {
        $otherCount = $resolved['total_docs'] - 1;
        $note = "This share contains {$resolved['total_docs']} documents ({$otherCount} more). Use get_share_tree to browse other documents.";
    }

    return [
        'content' => $chunk,
        'title' => (string)$doc['title'],
        'hpath' => (string)($doc['hpath'] ?? ''),
        'doc_id' => (string)$doc['doc_id'],
        'share_slug' => $slug,
        'share_title' => (string)$share['title'],
        'updated_at' => (string)$doc['updated_at'],
        'url' => mcp_share_doc_url($slug, (string)$doc['doc_id']),
        'offset' => $offset,
        'returned_chars' => mb_strlen($chunk, 'UTF-8'),
        'next_offset' => $nextOffset,
        'total_chars' => $totalChars,
        'note' => $note,
    ];
}

function mcp_escape_like(string $word): string {
    return str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $word);
}

function mcp_search_notes(int $userId, string $query, ?string $shareInput = null, ?string $parentDocId = null, int $limit = 20): array {
    $q = trim($query);
    if ($q === '' || mb_strlen($q, 'UTF-8') > 200) {
        throw new InvalidArgumentException('query must be a non-empty string up to 200 characters.');
    }
    $limit = max(1, min(50, $limit));

    $words = preg_split('/\s+/u', $q, -1, PREG_SPLIT_NO_EMPTY);
    if (!is_array($words) || empty($words)) {
        throw new InvalidArgumentException('query must contain at least one search term.');
    }
    $words = array_slice($words, 0, 8);

    $scopeShare = null;
    $allowedDocIds = null;
    if ($parentDocId !== null && trim($parentDocId) !== '') {
        if ($shareInput === null || trim($shareInput) === '') {
            throw new InvalidArgumentException('share is required when parent_doc_id is provided.');
        }
        $target = mcp_parse_share_target($shareInput, null);
        $scopeShare = mcp_find_public_share($userId, $target['slug']);
        if (!$scopeShare) {
            throw new RuntimeException('Public share not found or not accessible.');
        }
        $validParentId = mcp_validate_doc_id($parentDocId);
        $docs = mcp_load_share_doc_meta((int)$scopeShare['id']);
        $tree = build_doc_tree($docs);
        $found = mcp_find_tree_node($tree, $validParentId);
        if ($found === null) {
            throw new RuntimeException('Parent document not found in this public share.');
        }
        $allowedDocIds = [];
        mcp_collect_subtree_doc_ids($found, $allowedDocIds);
    } elseif ($shareInput !== null && trim($shareInput) !== '') {
        $target = mcp_parse_share_target($shareInput, null);
        $scopeShare = mcp_find_public_share($userId, $target['slug']);
        if (!$scopeShare) {
            throw new RuntimeException('Public share not found or not accessible.');
        }
    }

    if ($allowedDocIds !== null && empty($allowedDocIds)) {
        return [
            'query' => $q,
            'total_returned' => 0,
            'results' => [],
        ];
    }

    $params = [
        ':now' => time(),
        ':uid' => $userId,
    ];
    $wordConds = [];
    $titleAllConds = [];
    $hpathAnyConds = [];

    foreach ($words as $i => $word) {
        $pk = ':qw' . $i;
        $params[$pk] = '%' . mcp_escape_like($word) . '%';
        $wordConds[] = "(d.title LIKE {$pk} ESCAPE '\\' OR COALESCE(d.hpath, '') LIKE {$pk} ESCAPE '\\' OR d.markdown LIKE {$pk} ESCAPE '\\')";
        $titleAllConds[] = "d.title LIKE {$pk} ESCAPE '\\'";
        $hpathAnyConds[] = "COALESCE(d.hpath, '') LIKE {$pk} ESCAPE '\\'";
    }

    $whereParts = [mcp_public_share_where('s'), implode(' AND ', $wordConds)];
    if ($scopeShare !== null) {
        $whereParts[] = 's.id = :scope_sid';
        $params[':scope_sid'] = (int)$scopeShare['id'];
    }

    $sqlLimitClause = "LIMIT {$limit}";
    if ($allowedDocIds !== null) {
        if (count($allowedDocIds) <= 500) {
            $inPlaceholders = [];
            $adIndex = 0;
            foreach (array_keys($allowedDocIds) as $allowedId) {
                $adKey = ':ad' . $adIndex++;
                $inPlaceholders[] = $adKey;
                $params[$adKey] = (string)$allowedId;
            }
            $whereParts[] = 'd.doc_id IN (' . implode(', ', $inPlaceholders) . ')';
        } else {
            $sqlLimitClause = '';
        }
    }

    $titleAllExpr = implode(' AND ', $titleAllConds);
    $hpathAnyExpr = implode(' OR ', $hpathAnyConds);

    $sql = "SELECT s.slug AS share_slug, s.title AS share_title,
                   d.doc_id, d.title, d.hpath, d.markdown, d.updated_at, d.sort_order,
                   CASE
                       WHEN ({$titleAllExpr}) THEN 0
                       WHEN ({$hpathAnyExpr}) THEN 1
                       ELSE 2
                   END AS match_rank
            FROM share_docs d
            INNER JOIN shares s ON s.id = d.share_id
            WHERE " . implode(' AND ', $whereParts) . "
            ORDER BY match_rank ASC, d.updated_at DESC, d.sort_order ASC, d.id ASC
            {$sqlLimitClause}";

    $pdo = db();
    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);

    $firstWord = $words[0];
    $results = [];
    while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
        if ($allowedDocIds !== null && !isset($allowedDocIds[(string)$row['doc_id']])) {
            continue;
        }
        $slug = (string)$row['share_slug'];
        $docId = (string)$row['doc_id'];
        $results[] = [
            'share_slug' => $slug,
            'share_title' => (string)$row['share_title'],
            'doc_id' => $docId,
            'title' => (string)$row['title'],
            'hpath' => (string)($row['hpath'] ?? ''),
            'snippet' => search_summary((string)($row['markdown'] ?? ''), $firstWord),
            'url' => mcp_share_doc_url($slug, $docId),
        ];
        if (count($results) >= $limit) {
            break;
        }
    }

    return [
        'query' => $q,
        'total_returned' => count($results),
        'results' => $results,
    ];
}
