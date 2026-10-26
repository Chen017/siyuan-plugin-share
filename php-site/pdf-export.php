<?php
declare(strict_types=1);
require_once __DIR__ . '/pdf-visitor.php';

// PDF composition is bounded here; the visitor's browser does the PDF rendering.
function pdf_export_fields(): array {
    return [
        'window_seconds' => ['min' => 60, 'max' => 86400, 'default' => 3600, 'scale' => 60, 'whole' => true, 'label' => '统计时长（分钟）'],
        'requests' => ['max' => 256, 'default' => 120, 'label' => '每位访客允许导出篇数'],
        'max_concurrent' => ['max' => 4, 'label' => '全站同时导出数量'],
        'lease_seconds' => ['max' => 180, 'label' => '导出预览有效期（秒）'],
        'max_docs' => ['max' => 30, 'label' => '单次批量文档数'],
        'max_markdown_bytes' => ['max' => 2097152, 'label' => '单批源内容上限（MiB）', 'scale' => 1048576],
        'max_html_bytes' => ['max' => 8388608, 'label' => '单批排版内容上限（MiB）', 'scale' => 1048576],
        'max_asset_bytes' => ['max' => 52428800, 'label' => '单批关联附件上限（MiB）', 'scale' => 1048576],
        'max_images' => ['max' => 200, 'label' => '单批图片数量'],
        'max_execution_seconds' => ['max' => 15, 'label' => '服务器整理时间上限（秒）'],
        'max_memory_bytes' => ['min' => 16777216, 'max' => 134217728, 'label' => '服务器整理内存上限（MiB）', 'scale' => 1048576],
        'max_window_events' => ['max' => 20000, 'label' => '全站在窗口内的导出次数'],
    ];
}

// Read files only during initial seeding; never call db() while migrating.
function pdf_export_initial_settings(): array {
    global $config;
    $settings = [
        'pdf_export_enabled' => ($config['pdf_export_enabled'] ?? true) === true ? '1' : '0',
        'pdf_export_trusted_proxies' => json_encode($config['pdf_export_trusted_proxies'] ?? []),
        'pdf_export_ip_header' => (string)($config['pdf_export_ip_header'] ?? 'HTTP_X_REAL_IP'),
        'pdf_export_cookie_key' => '',
    ];
    foreach (pdf_export_fields() as $key => $field) {
        $default = $field['default'] ?? $field['max'];
        $settings['pdf_export_' . $key] = (string)max($field['min'] ?? 1, min($field['max'], (int)($config['pdf_export'][$key] ?? $default)));
    }
    return $settings;
}

function seed_pdf_export_settings(PDO $pdo): void {
    $existing = $pdo->query("SELECT key, value FROM settings WHERE key LIKE 'pdf_export_%'")->fetchAll(PDO::FETCH_KEY_PAIR);
    $initial = pdf_export_initial_settings();
    if (!array_diff_key($initial, $existing) && !isset($existing['pdf_export_ip_requests']) && !isset($existing['pdf_export_fingerprint_requests'])
        && preg_match('/^[a-f0-9]{64}$/D', $existing['pdf_export_cookie_key'] ?? '')) return;
    $ownTransaction = !$pdo->inTransaction();
    if ($ownTransaction) $pdo->exec('BEGIN IMMEDIATE');
    try {
        // Re-read after taking the write lock: upgrades may run in several workers.
        $existing = $pdo->query("SELECT key, value FROM settings WHERE key LIKE 'pdf_export_%'")->fetchAll(PDO::FETCH_KEY_PAIR);
        if (!isset($existing['pdf_export_requests']) && (isset($existing['pdf_export_ip_requests']) || isset($existing['pdf_export_fingerprint_requests']))) {
            $initial['pdf_export_requests'] = (string)max(1, min((int)$initial['pdf_export_requests'],
                (int)($existing['pdf_export_ip_requests'] ?? 10), (int)($existing['pdf_export_fingerprint_requests'] ?? 6)));
            if (($existing['pdf_export_window_seconds'] ?? '') === '600'
                && ($existing['pdf_export_ip_requests'] ?? '') === '10'
                && ($existing['pdf_export_fingerprint_requests'] ?? '') === '6') {
                $pdo->exec("UPDATE settings SET value = '3600' WHERE key = 'pdf_export_window_seconds'");
            }
        }
        foreach ($initial as $key => $value) ensure_setting($pdo, $key, $value);
        $pdo->prepare("UPDATE settings SET value = ? WHERE key = 'pdf_export_cookie_key' AND value = ''")->execute([bin2hex(random_bytes(32))]);
        $pdo->exec("DELETE FROM settings WHERE key IN ('pdf_export_ip_requests', 'pdf_export_fingerprint_requests')");
        if ($ownTransaction) $pdo->exec('COMMIT');
    } catch (Throwable $error) {
        if ($ownTransaction) $pdo->exec('ROLLBACK');
        throw $error;
    }
}

function pdf_export_settings(): array {
    $stored = db()->query("SELECT key, value FROM settings WHERE key LIKE 'pdf_export_%'")->fetchAll(PDO::FETCH_KEY_PAIR);
    $values = array_merge(pdf_export_initial_settings(), $stored);
    $limits = [];
    foreach (pdf_export_fields() as $key => $field) {
        $limits[$key] = max($field['min'] ?? 1, min($field['max'], (int)$values['pdf_export_' . $key]));
    }
    $proxies = json_decode((string)$values['pdf_export_trusted_proxies'], true);
    return [
        'enabled' => $values['pdf_export_enabled'] === '1',
        'limits' => $limits,
        'trusted_proxies' => is_array($proxies) ? array_values(array_filter($proxies, static fn($ip) => is_string($ip) && filter_var($ip, FILTER_VALIDATE_IP))) : [],
        'ip_header' => in_array($values['pdf_export_ip_header'], ['HTTP_X_REAL_IP', 'HTTP_CF_CONNECTING_IP'], true) ? $values['pdf_export_ip_header'] : 'HTTP_X_REAL_IP',
    ];
}

function pdf_export_limits(): array {
    return pdf_export_settings()['limits'];
}

function pdf_export_setting_number(float $value): string {
    return rtrim(rtrim(sprintf('%.8F', $value), '0'), '.');
}

function render_pdf_export_limit_inputs(array $keys, array $limits): string {
    $html = '<div class="grid" style="margin-top:12px">';
    $fields = pdf_export_fields();
    foreach ($keys as $key) {
        $field = $fields[$key];
        $scale = $field['scale'] ?? 1;
        $min = $field['min'] ?? 1;
        $whole = $field['whole'] ?? ($scale === 1);
        $id = 'pdf-export-' . $key;
        $html .= '<div><label for="' . $id . '">' . $field['label'] . '</label><input class="input" id="' . $id . '" name="limits[' . $key . ']" type="number" required step="' . ($whole ? '1' : 'any')
            . '" min="' . pdf_export_setting_number($min / $scale) . '" max="' . pdf_export_setting_number($field['max'] / $scale)
            . '" value="' . pdf_export_setting_number($limits[$key] / $scale) . '"></div>';
    }
    return $html . '</div>';
}

function render_pdf_export_settings(): string {
    $settings = pdf_export_settings();
    $html = '<section id="pdf-export-settings" style="margin-top:28px"><h2>访客 PDF 导出</h2>';
    $html .= '<p class="muted">通常只需设置统计时长和允许次数。并发、内存与批量大小已预设，可直接使用。</p>';
    $html .= '<form method="post" action="' . base_path() . '/admin/pdf-export-settings" data-pdf-settings-form>';
    $html .= render_hidden_inputs(['csrf' => csrf_token()]);
    $html .= '<label><input type="checkbox" name="pdf_export_enabled" value="1"' . ($settings['enabled'] ? ' checked' : '') . '> 允许访客导出 PDF</label>';
    $html .= render_pdf_export_limit_inputs(['window_seconds', 'requests'], $settings['limits']);
    $html .= '<p class="muted">这是每个访客 Cookie 的独立篇数额度，不是全站共享额度。同一校园网或公司网络下的访客互不占用额度。例如 60 分钟 120 篇表示每位访客滚动一小时最多开始导出 120 篇，不另加每分钟 2 篇限制。批量中的每篇计 1 篇；同一任务重试该篇不重复计数。匿名 Cookie 只能近似识别浏览器访客，不能可靠识别自然人。</p>';
    $html .= '<p class="muted">不同 Cookie 在统计时长内出现完全相同的指纹时，要求一次验证码。通过后新 Cookie 使用自己的额度，在该 Cookie 有效期内不重复验证；指纹不直接用于共享或封禁个人额度。</p>';
    $html .= '<details data-pdf-advanced style="margin-top:16px"><summary>高级设置（已预设，通常无需修改）</summary><p class="muted">以下参数用于保护服务器，可保持默认值。容量单位为 MiB，1 MiB = 1024 KiB；已有更低内存限制时继续遵守。</p>';
    $html .= render_pdf_export_limit_inputs(array_values(array_diff(array_keys(pdf_export_fields()), ['window_seconds', 'requests'])), $settings['limits']);
    $html .= '<details data-pdf-proxy-settings style="margin-top:16px"><summary>反向代理真实 IP</summary><p class="muted">仅信任这里明确填写的代理地址。代理必须覆盖写入真实 IP 请求头，不能直接转发访客传入的同名头。留空时按直连地址限流，经过同一代理的访客会共用 IP 配额。</p>';
    $html .= '<label for="pdf-trusted-proxies">可信代理 IP（每行一个，也可用逗号分隔）</label><textarea class="input" id="pdf-trusted-proxies" name="pdf_export_trusted_proxies" rows="3" placeholder="例如：127.0.0.1&#10;::1">' . htmlspecialchars(implode("\n", $settings['trusted_proxies'])) . '</textarea>';
    $html .= '<label for="pdf-ip-header">代理覆盖写入的真实 IP 请求头</label><select class="input" id="pdf-ip-header" name="pdf_export_ip_header">';
    foreach (['HTTP_X_REAL_IP' => 'X-Real-IP', 'HTTP_CF_CONNECTING_IP' => 'CF-Connecting-IP'] as $key => $label) {
        $html .= '<option value="' . $key . '"' . ($settings['ip_header'] === $key ? ' selected' : '') . '>' . $label . '</option>';
    }
    $html .= '</select><p class="muted">仅接受精确 IPv4 / IPv6 地址，不接受通配符、网段或域名。请填写 PHP 实际看到的代理对端 IP。</p></details></details>';
    $html .= '<div style="margin-top:16px"><button class="button primary" type="submit">保存 PDF 导出设置</button></div></form></section>';
    return $html;
}

function save_pdf_export_settings(array $input): void {
    $limits = $input['limits'] ?? null;
    if (!is_array($limits)) throw new InvalidArgumentException('请完整填写 PDF 导出限制。');
    $values = [];
    foreach (pdf_export_fields() as $key => $field) {
        $raw = $limits[$key] ?? null;
        $scale = $field['scale'] ?? 1;
        $whole = $field['whole'] ?? ($scale === 1);
        $pattern = $whole ? '/^[0-9]{1,10}$/D' : '/^[0-9]{1,10}(?:\.[0-9]{1,8})?$/D';
        if (!is_string($raw) || !preg_match($pattern, $raw) || round((float)$raw * $scale) < ($field['min'] ?? 1) || (float)$raw * $scale > $field['max']) {
            throw new InvalidArgumentException('「' . $field['label'] . '」必须在允许范围内。');
        }
        $values['pdf_export_' . $key] = (string)(int)round((float)$raw * $scale);
    }
    $enabled = $input['pdf_export_enabled'] ?? '0';
    if (!is_string($enabled) || !in_array($enabled, ['0', '1'], true)) throw new InvalidArgumentException('无效的导出开关。');
    $rawProxies = $input['pdf_export_trusted_proxies'] ?? '';
    if (!is_string($rawProxies) || strlen($rawProxies) > 4096) throw new InvalidArgumentException('可信代理地址过长或格式无效。');
    $proxies = preg_split('/[\s,]+/', trim($rawProxies), -1, PREG_SPLIT_NO_EMPTY);
    if (count($proxies) > 32) throw new InvalidArgumentException('可信代理最多填写 32 个 IP。');
    foreach ($proxies as &$ip) {
        if (!filter_var($ip, FILTER_VALIDATE_IP)) throw new InvalidArgumentException('可信代理只接受精确 IP 地址，不接受网段、通配符或域名。');
        $ip = inet_ntop(inet_pton($ip));
    }
    unset($ip);
    $header = $input['pdf_export_ip_header'] ?? '';
    if (!is_string($header) || !in_array($header, ['HTTP_X_REAL_IP', 'HTTP_CF_CONNECTING_IP'], true)) throw new InvalidArgumentException('请选择支持的真实 IP 请求头。');
    $values['pdf_export_enabled'] = $enabled;
    $values['pdf_export_trusted_proxies'] = json_encode(array_values(array_unique($proxies)));
    $values['pdf_export_ip_header'] = $header;
    $pdo = db();
    $pdo->beginTransaction();
    try {
        foreach ($values as $key => $value) set_setting($key, $value);
        $pdo->commit();
    } catch (Throwable $error) {
        $pdo->rollBack();
        throw $error;
    }
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
    pdf_visitor_migrate($pdo);
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
    if (!pdf_export_settings()['enabled']) {
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
    $settings = pdf_export_settings();
    $peer = (string)($_SERVER['REMOTE_ADDR'] ?? '');
    // Never accept an arbitrary client's X-Forwarded-For/CF-Connecting-IP.
    // Only use one proxy-overwritten header from explicitly trusted peers.
    $trusted = array_map('inet_pton', $settings['trusted_proxies']);
    $header = $settings['ip_header'];
    $packedPeer = @inet_pton($peer);
    if ($packedPeer !== false && in_array($packedPeer, $trusted, true)) {
        $candidate = (string)($_SERVER[$header] ?? '');
        if (filter_var($candidate, FILTER_VALIDATE_IP)) $peer = $candidate;
    }
    $packed = @inet_pton($peer);
    if ($packed === false) return 'unknown';
    // Normalize IPv6 diagnostic metadata; visitor quotas are owned by Cookie.
    if (strlen($packed) === 16) $packed = substr($packed, 0, 8) . str_repeat("\0", 8);
    return bin2hex($packed);
}

function pdf_export_admit(int $shareId, string $fingerprint, int $documentCount = 1): string {
    $limits = pdf_export_limits();
    $pdo = db();
    $visitor = pdf_visitor_id(true);
    $ip = hash('sha256', pdf_export_client_ip());
    $fp = pdf_visitor_fingerprint($fingerprint);
    pdf_visitor_quota($visitor, $limits, $documentCount);
    if (pdf_visitor_needs_captcha($visitor, $fp)) throw new RuntimeException('导出过于频繁，请先完成一次验证码。', 428);
    $now = time();
    $pdo->exec('PRAGMA busy_timeout = 3000');
    $pdo->exec('BEGIN IMMEDIATE');
    try {
        $pdo->prepare('DELETE FROM pdf_export_events WHERE created_at <= ?')->execute([$now - $limits['window_seconds']]);
        $pdo->prepare('DELETE FROM pdf_export_leases WHERE expires_at <= ?')->execute([$now]);
        pdf_visitor_quota($visitor, $limits, $documentCount);
        $stmt = $pdo->prepare('SELECT COUNT(*) AS total,
            SUM(CASE WHEN visitor_hash = ? THEN 1 ELSE 0 END) AS own FROM pdf_export_leases');
        $stmt->execute([$visitor]);
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
        $token = bin2hex(random_bytes(24));
        $pdo->prepare('INSERT INTO pdf_export_events(ip_hash, fingerprint_hash, created_at, visitor_hash, doc_count, job_token) VALUES (?, ?, ?, ?, 0, ?)')->execute([$ip, $fp, $now, $visitor, $token]);
        $pdo->prepare('INSERT INTO pdf_export_leases(token, share_id, session_hash, ip_hash, fingerprint_hash, expires_at, visitor_hash, document_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')->execute([
            $token, $shareId, hash('sha256', session_id()), $ip, $fp, $now + $limits['lease_seconds'], $visitor, $documentCount, $now,
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
    if (!pdf_export_settings()['enabled']) return '';
    $url = base_path() . '/s/' . rawurlencode($context['slug']) . '/export';
    return '<a class="button ghost share-view-toggle" data-pdf-export-link href="' . htmlspecialchars($url)
        . '?doc=' . rawurlencode($context['doc_id']) . '">导出 PDF</a>';
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
    try {
        $visitor = pdf_visitor_id($method !== 'GET');
        if ($action === 'claim' && $method === 'POST') {
            $token = $_POST['lease'] ?? '';
            $index = $_POST['index'] ?? '';
            if (!is_string($token) || !is_string($index) || !preg_match('/^[0-9]{1,3}$/D', $index)) throw new RuntimeException('无效的文档编号。', 400);
            pdf_visitor_claim($shareId, $token, (int)$index);
            header('Content-Type: application/json; charset=utf-8');
            echo '{"ok":true}';
            exit;
        }
        if (in_array($action, ['check', 'captcha', 'captcha-verify'], true) && $method === 'POST') {
            $fp = pdf_visitor_fingerprint($_POST['fingerprint'] ?? null);
            pdf_visitor_quota($visitor, pdf_export_limits());
            $required = pdf_visitor_needs_captcha($visitor, $fp);
            header('Content-Type: application/json; charset=utf-8');
            if ($action === 'captcha-verify') {
                pdf_visitor_verify_captcha($visitor, $fp, $_POST['token'] ?? null, $_POST['answer'] ?? null);
                echo '{"ok":true}';
            } elseif (!$required) {
                echo '{"ok":true}';
            } elseif ($action === 'captcha') {
                echo json_encode(pdf_visitor_challenge($visitor, $fp));
            } else {
                http_response_code(428);
                echo json_encode(['captcha_required' => true, 'error' => '导出过于频繁，请完成一次验证码后继续。'], JSON_UNESCAPED_UNICODE);
            }
            exit;
        }
    } catch (RuntimeException $error) {
        if ($error->getCode() === 429) header('Retry-After: 300');
        pdf_export_fail(in_array($error->getCode(), [400, 409, 410, 428, 429, 503], true) ? $error->getCode() : 503, $error->getMessage());
    }
    if ($action === 'verify' && $method === 'POST') {
        $token = $_POST['lease'] ?? '';
        if (!is_string($token)) pdf_export_fail(400, '无效的导出凭据。');
        $stmt = db()->prepare('SELECT 1 FROM pdf_export_leases WHERE token = ? AND share_id = ? AND session_hash = ? AND visitor_hash = ? AND expires_at > ?');
        $stmt->execute([$token, $shareId, hash('sha256', session_id()), $visitor, time()]);
        if (!$stmt->fetchColumn()) pdf_export_fail(410, '导出预览已失效，请返回分享页重新导出。');
        if (($_POST['renew'] ?? '') === '1') {
            $renew = db()->prepare('UPDATE pdf_export_leases SET expires_at = MIN(created_at + 1800, CAST(? AS INTEGER)) WHERE token = ? AND share_id = ? AND session_hash = ? AND visitor_hash = ? AND expires_at > ? AND created_at + 1800 > CAST(? AS INTEGER)');
            $renew->execute([time() + pdf_export_limits()['lease_seconds'], $token, $shareId, hash('sha256', session_id()), $visitor, time(), time()]);
            if ($renew->rowCount() !== 1) pdf_export_fail(410, '导出任务已失效，请重新打开预览。');
        }
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
        $content = '<main class="pdf-export-panel"><h1>导出 PDF</h1><p>选择范围后打开预览，点击保存即可逐篇下载。每篇文档是一个独立 PDF 文件，不会合并。</p>';
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
        $content .= '<fieldset data-pdf-challenge hidden><legend>安全验证（此 Cookie 只需一次）</legend><p>导出过于频繁，请输入图片中的验证码。</p><img data-pdf-captcha-image alt="安全验证码"><button class="button ghost" type="button" data-pdf-captcha-refresh>换一张</button><label>验证码 <input class="input" name="captcha_answer" autocomplete="off" maxlength="8"></label></fieldset>';
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
        $docs = pdf_export_select_docs($shareId, $_POST);
        $lease = pdf_export_admit($shareId, $fingerprint, count($docs));
        set_time_limit($limits['max_execution_seconds']);
        $memory = ini_parse_quantity((string)ini_get('memory_limit'));
        ini_set('memory_limit', (string)($memory > 0 ? min($memory, $limits['max_memory_bytes']) : $limits['max_memory_bytes']));
        $docIds = array_column($docs, 'doc_id');
        $stmt = db()->prepare('SELECT COALESCE(SUM(size_bytes), 0) FROM share_assets WHERE share_id = ? AND
            (doc_id IS NULL OR doc_id = \'\' OR doc_id IN (' . implode(',', array_fill(0, count($docs), '?')) . '))');
        $stmt->execute(array_merge([$shareId], $docIds));
        if ((int)$stmt->fetchColumn() > $limits['max_asset_bytes']) throw new RuntimeException('关联附件过大，请减少单次导出篇数。', 413);
        $stmt = db()->prepare('SELECT substr(CAST(markdown AS BLOB), 1, ?) FROM share_docs WHERE share_id = ? AND id = ?');
        $content = '<div class="pdf-export-toolbar" data-pdf-preview data-pdf-library="' . htmlspecialchars(site_asset_url('vendor/html2pdf.bundle.min.js')) . '" data-pdf-font="' . htmlspecialchars(site_asset_url('vendor/fonts/pdf-provenance.ttf')) . '" data-pdf-text-library="' . htmlspecialchars(site_asset_url('pdf-text-layer.js')) . '" data-export-url="' . htmlspecialchars($url) . '" data-lease="' . $lease . '" data-csrf="' . csrf_token() . '">';
        $content .= '<p data-pdf-status role="status">正在准备公式、字体和图片…</p><button class="button primary" type="button" data-pdf-download disabled>' . (count($docs) > 1 ? '保存全部 PDF（逐篇下载）' : '保存 PDF') . '</button><p>每篇分别下载。若浏览器询问，请允许连续下载多个文件。保存的 PDF 支持选择、复制和搜索正文，并保留隐藏来源与版权信息。</p><p>关闭预览释放任务；同一访客跨标签页也只能同时导出一个任务。</p></div><main class="pdf-document">';
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
            $sourceUrl = base_path() . build_share_redirect_path($slug, (string)$doc['doc_id'], '');
            $content .= '<section class="pdf-doc" data-pdf-doc="' . htmlspecialchars((string)$doc['doc_id']) . '" data-pdf-title="' . htmlspecialchars($title) . '" data-pdf-source="' . htmlspecialchars($sourceUrl) . '"><h1>' . htmlspecialchars($title) . '</h1>';
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
        $status = in_array($error->getCode(), [400, 403, 404, 409, 410, 413, 428, 429], true) ? $error->getCode() : 503;
        pdf_export_fail($status, $status === 503 ? '导出服务繁忙，请稍后重试。' : $error->getMessage());
    }
}
