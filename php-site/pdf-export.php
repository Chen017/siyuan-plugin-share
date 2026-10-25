<?php
declare(strict_types=1);

// PDF composition is bounded here; the visitor's browser does the PDF rendering.
function pdf_export_limits(): array {
    global $config;
    $defaults = [
        'window_seconds' => 600, 'ip_requests' => 10, 'fingerprint_requests' => 6,
        'max_concurrent' => 4, 'lease_seconds' => 180, 'max_docs' => 30,
        'max_markdown_bytes' => 2097152, 'max_html_bytes' => 8388608,
        'max_asset_bytes' => 52428800, 'max_images' => 200,
    ];
    foreach ($defaults as $key => $value) {
        // Clamp configuration values to hard safety ceilings.
        $defaults[$key] = max(1, min($value, (int)($config['pdf_export'][$key] ?? $value)));
    }
    return $defaults;
}

function pdf_export_migrate(PDO $pdo): void {
    $pdo->exec('CREATE TABLE IF NOT EXISTS pdf_export_events (
        id INTEGER PRIMARY KEY, ip_hash TEXT NOT NULL, fingerprint_hash TEXT NOT NULL, created_at INTEGER NOT NULL
    )');
    $pdo->exec('CREATE INDEX IF NOT EXISTS pdf_export_events_ip ON pdf_export_events(ip_hash, created_at)');
    $pdo->exec('CREATE INDEX IF NOT EXISTS pdf_export_events_fp ON pdf_export_events(fingerprint_hash, created_at)');
    $pdo->exec('CREATE INDEX IF NOT EXISTS pdf_export_events_time ON pdf_export_events(created_at)');
    $pdo->exec('CREATE TABLE IF NOT EXISTS pdf_export_leases (
        token TEXT PRIMARY KEY, share_id INTEGER NOT NULL, session_hash TEXT NOT NULL,
        ip_hash TEXT NOT NULL, fingerprint_hash TEXT NOT NULL, expires_at INTEGER NOT NULL,
        FOREIGN KEY(share_id) REFERENCES shares(id) ON DELETE CASCADE
    )');
}

function pdf_export_fail(int $status, string $message): never {
    http_response_code($status);
    header('Cache-Control: private, no-store');
    // Normal form submissions get a readable error page; fetch clients get JSON.
    if (str_contains((string)($_SERVER['HTTP_ACCEPT'] ?? ''), 'text/html')) {
        $path = (string)parse_url((string)($_SERVER['REQUEST_URI'] ?? ''), PHP_URL_PATH);
        $back = base_path() . '/';
        if (preg_match('#^(.*?/s/[a-zA-Z0-9_-]+)/export(?:/.*)?$#', $path, $matches)) $back = $matches[1];
        $content = '<main class="pdf-export-panel"><h1>无法导出 PDF</h1><p role="alert">' . htmlspecialchars($message)
            . '</p><a class="button" href="' . htmlspecialchars($back) . '">返回分享页</a></main>';
        render_page('无法导出 PDF', $content, null, '', ['layout' => 'share', 'pdf_export' => true]);
    }
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['error' => $message], JSON_UNESCAPED_UNICODE);
    exit;
}

function pdf_export_share(string $slug): array {
    global $config;
    if (($config['pdf_export_enabled'] ?? true) !== true) {
        pdf_export_fail(404, 'PDF 导出未开启。');
    }
    $share = find_share_by_slug($slug);
    if (!$share) pdf_export_fail(404, '分享不存在。');
    if (share_is_expired($share)) pdf_export_fail(410, '分享已过期。');
    if (share_visitor_limit_reached($share)) pdf_export_fail(403, '访客数已达上限。');
    if (share_requires_password($share)) {
        // Compare with this fresh row, not the request-local password hash cache.
        $entry = $_SESSION['share_access'][(int)$share['id']] ?? '';
        $token = is_array($entry) ? ($entry['token'] ?? '') : $entry;
        if (!is_string($token) || !hash_equals(share_access_signature((string)$share['password_hash']), $token)) {
            pdf_export_fail(403, '请先在分享页验证访问密码。');
        }
    }
    return $share;
}

function pdf_export_csrf(): void {
    $token = $_POST['csrf'] ?? null;
    if (!is_string($token) || $token === '' || !hash_equals(csrf_token(), $token)) {
        pdf_export_fail(400, '页面验证已失效，请刷新分享页后重试。');
    }
}

function pdf_export_client_ip(): string {
    global $config;
    $peer = (string)($_SERVER['REMOTE_ADDR'] ?? '');
    // Never accept an arbitrary client's X-Forwarded-For/CF-Connecting-IP.
    // Only use one proxy-overwritten header from explicitly trusted peers.
    $trusted = $config['pdf_export_trusted_proxies'] ?? [];
    $header = (string)($config['pdf_export_ip_header'] ?? 'HTTP_X_REAL_IP');
    if (is_array($trusted) && in_array($peer, $trusted, true)
        && in_array($header, ['HTTP_X_REAL_IP', 'HTTP_CF_CONNECTING_IP'], true)) {
        $candidate = (string)($_SERVER[$header] ?? '');
        if (filter_var($candidate, FILTER_VALIDATE_IP)) $peer = $candidate;
    }
    $packed = @inet_pton($peer);
    if ($packed === false) return 'unknown';
    // IPv6 privacy addresses within one /64 share an allowance.
    if (strlen($packed) === 16) $packed = substr($packed, 0, 8) . str_repeat("\0", 8);
    return bin2hex($packed);
}

function pdf_export_admit(int $shareId, string $fingerprint): string {
    $limits = pdf_export_limits();
    $pdo = db();
    $ip = hash('sha256', pdf_export_client_ip());
    $fp = hash('sha256', $fingerprint . '|' . substr((string)($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 512));
    $now = time();
    $pdo->exec('PRAGMA busy_timeout = 3000');
    $pdo->exec('BEGIN IMMEDIATE');
    try {
        $pdo->prepare('DELETE FROM pdf_export_events WHERE created_at <= ?')->execute([$now - $limits['window_seconds']]);
        $pdo->prepare('DELETE FROM pdf_export_leases WHERE expires_at <= ?')->execute([$now]);
        $stmt = $pdo->prepare('SELECT
            SUM(CASE WHEN ip_hash = ? THEN 1 ELSE 0 END) AS ip_count,
            SUM(CASE WHEN fingerprint_hash = ? THEN 1 ELSE 0 END) AS fp_count, COUNT(*) AS total
            FROM pdf_export_events');
        $stmt->execute([$ip, $fp]);
        $counts = $stmt->fetch(PDO::FETCH_ASSOC);
        if ((int)$counts['ip_count'] >= $limits['ip_requests'] || (int)$counts['fp_count'] >= $limits['fingerprint_requests']
            || (int)$counts['total'] >= 20000) {
            throw new RuntimeException('导出次数已达上限，请稍后再试。', 429);
        }
        $stmt = $pdo->prepare('SELECT COUNT(*) AS total,
            SUM(CASE WHEN ip_hash = ? OR fingerprint_hash = ? THEN 1 ELSE 0 END) AS own FROM pdf_export_leases');
        $stmt->execute([$ip, $fp]);
        $counts = $stmt->fetch(PDO::FETCH_ASSOC);
        if ((int)$counts['total'] >= $limits['max_concurrent'] || (int)$counts['own'] > 0) {
            throw new RuntimeException('已有导出正在进行，请关闭预览或稍后再试。', 429);
        }
        // Reserve a limited visitor slot under the same write transaction, so
        // simultaneous direct export requests cannot oversubscribe the share.
        $share = find_share_by_id($shareId);
        if (!$share) throw new RuntimeException('分享不存在。', 404);
        if (share_is_expired($share)) throw new RuntimeException('分享已过期。', 410);
        if (share_visitor_limit_reached($share)) throw new RuntimeException('访客数已达上限。', 403);
        if (share_visitor_limit($share) > 0) register_share_visitor($shareId, get_visitor_id());
        $pdo->prepare('INSERT INTO pdf_export_events(ip_hash, fingerprint_hash, created_at) VALUES (?, ?, ?)')->execute([$ip, $fp, $now]);
        $token = bin2hex(random_bytes(24));
        $pdo->prepare('INSERT INTO pdf_export_leases VALUES (?, ?, ?, ?, ?, ?)')->execute([
            $token, $shareId, hash('sha256', session_id()), $ip, $fp, $now + $limits['lease_seconds'],
        ]);
        $pdo->exec('COMMIT');
        return $token;
    } catch (Throwable $error) {
        $pdo->exec('ROLLBACK');
        throw $error;
    }
}

function pdf_export_release(string $token): void {
    db()->prepare('DELETE FROM pdf_export_leases WHERE token = ? AND session_hash = ?')
        ->execute([$token, hash('sha256', session_id())]);
}

function pdf_export_select_docs(int $shareId, array $input): array {
    $limit = pdf_export_limits()['max_docs'];
    $scope = $input['scope'] ?? 'single';
    $root = $input['doc_id'] ?? '';
    if (!is_string($scope) || !is_string($root) || strlen($root) > 200) {
        throw new RuntimeException('无效的导出范围。', 400);
    }
    $params = [$shareId];
    $where = '';
    $cte = '';
    if ($scope === 'single' || $scope === 'tree') {
        if ($root === '') throw new RuntimeException('请选择文档。', 400);
        if ($scope === 'tree') {
            // UNION also terminates malformed parent cycles. LIMIT bounds recursion.
            $cte = 'WITH RECURSIVE subtree(doc_id) AS (
                SELECT doc_id FROM share_docs WHERE share_id = ? AND doc_id = ?
                UNION SELECT d.doc_id FROM share_docs d JOIN subtree t ON d.parent_id = t.doc_id
                WHERE d.share_id = ? LIMIT ' . ($limit + 1) . ') ';
            $params = [$shareId, $root, $shareId, $shareId];
            $where = ' AND doc_id IN (SELECT doc_id FROM subtree)';
        } else {
            $where = ' AND doc_id = ?';
            $params[] = $root;
        }
    } elseif ($scope === 'selected') {
        $ids = $input['doc_ids'] ?? [];
        if (!is_array($ids) || count($ids) === 0 || count($ids) > $limit) {
            throw new RuntimeException('请选择 1 至 ' . $limit . ' 篇文档。', 400);
        }
        foreach ($ids as $id) {
            if (!is_string($id) || $id === '' || strlen($id) > 200) throw new RuntimeException('无效的文档编号。', 400);
        }
        $ids = array_values(array_unique($ids));
        $where = ' AND doc_id IN (' . implode(',', array_fill(0, count($ids), '?')) . ')';
        $params = array_merge($params, $ids);
    } elseif ($scope !== 'all') {
        throw new RuntimeException('无效的导出范围。', 400);
    }
    $stmt = db()->prepare($cte . 'SELECT id, doc_id, title, parent_id, sort_order,
        length(CAST(markdown AS BLOB)) AS markdown_bytes FROM share_docs WHERE share_id = ?' . $where . '
        ORDER BY sort_order, id LIMIT ' . ($limit + 1));
    $stmt->execute($params);
    $docs = $stmt->fetchAll(PDO::FETCH_ASSOC);
    if (!$docs || ($scope === 'selected' && count($docs) !== count($ids))) {
        throw new RuntimeException('所选文档不在当前分享范围内。', 404);
    }
    if (count($docs) > $limit) throw new RuntimeException('单次最多导出 ' . $limit . ' 篇，请分批选择。', 413);
    if (array_sum(array_column($docs, 'markdown_bytes')) > pdf_export_limits()['max_markdown_bytes']) {
        throw new RuntimeException('文档内容过大，请减少单次导出篇数。', 413);
    }
    // Stable pre-order with parents before children, including orphan/cyclic data.
    $ordered = $seen = [];
    $visit = function (array $doc) use (&$visit, &$ordered, &$seen, $docs): void {
        $key = (string)$doc['doc_id'];
        if (isset($seen[$key])) return;
        $seen[$key] = true;
        $ordered[] = $doc;
        foreach ($docs as $child) if ((string)$child['parent_id'] === $key) $visit($child);
    };
    $keys = array_column($docs, 'doc_id');
    foreach ($docs as $doc) if (!in_array($doc['parent_id'], $keys, true)) $visit($doc);
    foreach ($docs as $doc) $visit($doc);
    return $ordered;
}

function render_pdf_export_link(array $context): string {
    global $config;
    if (($config['pdf_export_enabled'] ?? true) !== true) return '';
    $url = base_path() . '/s/' . rawurlencode($context['slug']) . '/export';
    return '<div class="pdf-share-tools"><a class="button ghost" data-pdf-export-link href="' . htmlspecialchars($url)
        . '?doc=' . rawurlencode($context['doc_id']) . '">导出 PDF / 批量导出</a></div>';
}

function route_pdf_export(string $slug, string $action = ''): never {
    header('Cache-Control: private, no-store');
    header('X-Robots-Tag: noindex, nofollow');
    header('Referrer-Policy: same-origin');
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if ($action !== '' || $method === 'POST') pdf_export_csrf();
    if ($action === 'release' && $method === 'POST') {
        $token = $_POST['lease'] ?? '';
        if (is_string($token)) pdf_export_release($token);
        http_response_code(204);
        exit;
    }
    $share = pdf_export_share($slug);
    $shareId = (int)$share['id'];
    if ($action === 'verify' && $method === 'POST') {
        $token = $_POST['lease'] ?? '';
        if (!is_string($token)) pdf_export_fail(400, '无效的导出凭据。');
        $stmt = db()->prepare('SELECT 1 FROM pdf_export_leases WHERE token = ? AND share_id = ? AND session_hash = ? AND expires_at > ?');
        $stmt->execute([$token, $shareId, hash('sha256', session_id()), time()]);
        if (!$stmt->fetchColumn()) pdf_export_fail(410, '导出预览已失效，请返回分享页重新导出。');
        header('Content-Type: application/json; charset=utf-8');
        echo '{"ok":true}';
        exit;
    }
    if ($action !== '') pdf_export_fail(405, '不支持此请求。');
    $limits = pdf_export_limits();
    $url = base_path() . '/s/' . rawurlencode($slug) . '/export';
    if ($method === 'GET') {
        $stmt = db()->prepare('SELECT doc_id, title, hpath FROM share_docs WHERE share_id = ? ORDER BY sort_order, id LIMIT 2001');
        $stmt->execute([$shareId]);
        $docs = $stmt->fetchAll(PDO::FETCH_ASSOC);
        $active = $_GET['doc'] ?? (string)($share['doc_id'] ?? '');
        if (!is_string($active)) $active = '';
        // Include a requested document beyond the first 2000 without enumerating the notebook.
        if ($active !== '' && !in_array($active, array_column($docs, 'doc_id'), true)) {
            $activeStmt = db()->prepare('SELECT doc_id, title, hpath FROM share_docs WHERE share_id = ? AND doc_id = ? LIMIT 1');
            $activeStmt->execute([$shareId, $active]);
            $activeDoc = $activeStmt->fetch(PDO::FETCH_ASSOC);
            if ($activeDoc) array_unshift($docs, $activeDoc);
        }
        $active = in_array($active, array_column($docs, 'doc_id'), true) ? $active : (string)($docs[0]['doc_id'] ?? '');
        $content = '<main class="pdf-export-panel"><h1>导出 PDF</h1><p>选择范围后打开预览，再在打印窗口选择“另存为 PDF”。批量文档合并为一份 PDF，每篇从新页开始。</p>';
        $content .= '<p>每批最多 ' . $limits['max_docs'] . ' 篇；较大的笔记本请分批勾选。</p>';
        $content .= '<form method="post" action="' . htmlspecialchars($url) . '" target="_blank" rel="noopener" data-pdf-export-form>';
        $content .= render_hidden_inputs(['csrf' => csrf_token(), 'fingerprint' => '']);
        $content .= '<label>导出范围 <select class="input" name="scope" data-pdf-scope><option value="single">单篇文档</option><option value="tree">此文档及子文档</option><option value="all">整个分享范围</option><option value="selected">勾选多篇文档</option></select></label>';
        $content .= '<label data-pdf-root>文档 <select class="input" name="doc_id">';
        foreach (array_slice($docs, 0, 2000) as $doc) {
            $content .= '<option value="' . htmlspecialchars((string)$doc['doc_id']) . '"' . ($doc['doc_id'] === $active ? ' selected' : '') . '>' . htmlspecialchars((string)($doc['hpath'] ?: $doc['title'])) . '</option>';
        }
        $content .= '</select></label><fieldset data-pdf-selection hidden><legend>选择文档</legend>';
        foreach (array_slice($docs, 0, 2000) as $doc) {
            $content .= '<label><input type="checkbox" name="doc_ids[]" value="' . htmlspecialchars((string)$doc['doc_id']) . '"> ' . htmlspecialchars((string)($doc['hpath'] ?: $doc['title'])) . '</label>';
        }
        $content .= '</fieldset>';
        if (count($docs) > 2000) $content .= '<p>仅列出前 2000 篇；其余文档请从分享页打开后导出。</p>';
        $content .= '<button class="button primary" type="submit">打开导出预览</button><p data-pdf-form-status role="status"></p></form>';
        $content .= '<a href="' . htmlspecialchars(base_path() . '/s/' . rawurlencode($slug)) . '">返回分享页</a></main>';
        render_page('导出 PDF', $content, null, '', ['layout' => 'share', 'pdf_export' => true]);
    }
    if ($method !== 'POST') pdf_export_fail(405, '不支持此请求。');
    $fingerprint = $_POST['fingerprint'] ?? '';
    if (!is_string($fingerprint) || !preg_match('/^[a-f0-9]{64}$/D', $fingerprint)) {
        pdf_export_fail(400, '无法识别浏览器，请启用 JavaScript 后重试。');
    }
    $lease = '';
    $complete = false;
    register_shutdown_function(static function () use (&$lease, &$complete): void {
        if ($lease !== '' && !$complete) pdf_export_release($lease);
    });
    try {
        $lease = pdf_export_admit($shareId, $fingerprint);
        set_time_limit(15);
        $memory = ini_parse_quantity((string)ini_get('memory_limit'));
        ini_set('memory_limit', (string)($memory > 0 ? min($memory, 134217728) : 134217728));
        $docs = pdf_export_select_docs($shareId, $_POST);
        $docIds = array_column($docs, 'doc_id');
        $stmt = db()->prepare('SELECT COALESCE(SUM(size_bytes), 0) FROM share_assets WHERE share_id = ? AND
            (doc_id IS NULL OR doc_id = \'\' OR doc_id IN (' . implode(',', array_fill(0, count($docs), '?')) . '))');
        $stmt->execute(array_merge([$shareId], $docIds));
        if ((int)$stmt->fetchColumn() > $limits['max_asset_bytes']) throw new RuntimeException('关联附件过大，请减少单次导出篇数。', 413);
        $stmt = db()->prepare('SELECT substr(CAST(markdown AS BLOB), 1, ?) FROM share_docs WHERE share_id = ? AND id = ?');
        $content = '<div class="pdf-print-toolbar" data-pdf-preview data-export-url="' . htmlspecialchars($url) . '" data-lease="' . $lease . '" data-csrf="' . csrf_token() . '">';
        $content .= '<p data-pdf-status role="status">正在准备公式、字体和图片…</p><button class="button primary" type="button" data-pdf-print disabled>保存为 PDF</button><p>在打印窗口选择“另存为 PDF”。预览有效期 ' . $limits['lease_seconds'] . ' 秒，关闭预览可释放导出名额。</p></div><main class="pdf-document">';
        $images = 0;
        $sourceBytes = 0;
        foreach ($docs as $index => $doc) {
            $remaining = $limits['max_markdown_bytes'] - $sourceBytes;
            $stmt->execute([$remaining + 1, $shareId, (int)$doc['id']]);
            $markdown = (string)$stmt->fetchColumn();
            $sourceBytes += strlen($markdown);
            if ($sourceBytes > $limits['max_markdown_bytes']) throw new RuntimeException('文档内容过大，请分批导出。', 413);
            $title = (string)$doc['title'];
            $markdown = (string)extract_front_matter($markdown)['body'];
            $markdown = rewrite_asset_links($markdown, base_path() . '/s/' . rawurlencode($slug) . '/res/');
            $markdown = strip_duplicate_title_heading($markdown, $title);
            $markdown = replace_custom_emoji_tokens($markdown, $shareId, base_path() . '/s/' . rawurlencode($slug) . '/res/');
            $markdown = insert_adjacent_emoji_image_spacing($markdown);
            $html = render_markdown($markdown);
            $images += substr_count($html, '<img');
            $content .= '<section class="pdf-doc" data-pdf-doc="' . htmlspecialchars((string)$doc['doc_id']) . '"><h1>' . htmlspecialchars($title) . '</h1>';
            $content .= '<div class="markdown-body" data-md-id="pdf-' . $index . '">' . $html . '</div><textarea class="markdown-source" data-md-id="pdf-' . $index . '" hidden>' . htmlspecialchars($markdown) . '</textarea></section>';
            if (strlen($content) > $limits['max_html_bytes'] || $images > $limits['max_images']) throw new RuntimeException('排版内容或图片过多，请分批导出。', 413);
        }
        // Recheck after composition, including an expiry crossed during preparation.
        pdf_export_share($slug);
        if (share_visitor_limit($share) > 0) register_share_visitor($shareId, get_visitor_id());
        $content .= '</main>';
        $complete = true;
        render_page(count($docs) === 1 ? (string)$docs[0]['title'] : (string)$share['title'], $content, null, '', ['layout' => 'share', 'markdown' => true, 'pdf_export' => true]);
    } catch (Throwable $error) {
        if ($error->getCode() === 429) header('Retry-After: ' . $limits['window_seconds']);
        $status = in_array($error->getCode(), [400, 403, 404, 410, 413, 429], true) ? $error->getCode() : 503;
        pdf_export_fail($status, $status === 503 ? '导出服务繁忙，请稍后重试。' : $error->getMessage());
    }
}
