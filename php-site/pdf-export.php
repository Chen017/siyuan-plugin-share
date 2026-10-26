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
        'max_docs' => ['max' => 120, 'label' => '单次批量文档数'],
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
        $content = '<main class="pdf-export-panel"><h1>Unable to export PDF</h1><p role="alert">' . htmlspecialchars($message)
            . '</p><a class="button" href="' . htmlspecialchars($back) . '">Back to share</a></main>';
        render_page('Unable to export PDF', $content, null, '', ['layout' => 'share', 'pdf_export' => true]);
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
        . '?doc=' . rawurlencode($context['doc_id']) . '">Export PDF</a>';
}

function pdf_export_lease(int $shareId, string $visitor, string $token, bool $renew = false): array {
    $now = time();
    $stmt = db()->prepare('SELECT * FROM pdf_export_leases WHERE token = ? AND share_id = ? AND session_hash = ? AND visitor_hash = ? AND expires_at > ?');
    $stmt->execute([$token, $shareId, hash('sha256', session_id()), $visitor, $now]);
    $lease = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$lease || (int)$lease['created_at'] + 1800 <= $now) throw new RuntimeException('导出任务已失效，请重新打开弹窗。', 410);
    // Renew at most once per minute, rather than once per generated page.
    if ($renew && (int)$lease['expires_at'] <= $now + (int)floor(pdf_export_limits()['lease_seconds'] * 2 / 3)) {
        $expires = min((int)$lease['created_at'] + 1800, $now + pdf_export_limits()['lease_seconds']);
        if ($expires <= $now) throw new RuntimeException('导出任务已失效，请重新打开弹窗。', 410);
        $stmt = db()->prepare('UPDATE pdf_export_leases SET expires_at = ? WHERE token = ? AND expires_at > ?');
        $stmt->execute([$expires, $token, $now]);
        if ($stmt->rowCount() !== 1) throw new RuntimeException('导出任务已失效，请重新打开弹窗。', 410);
        $lease['expires_at'] = $expires;
    }
    return $lease;
}

function pdf_export_worker_attributes(string $url, string $lease): string {
    return ' data-pdf-library="' . htmlspecialchars(site_asset_url('vendor/html2pdf.bundle.min.js'))
        . '" data-pdf-font="' . htmlspecialchars(site_asset_url('vendor/fonts/pdf-provenance.ttf'))
        . '" data-pdf-text-library="' . htmlspecialchars(site_asset_url('pdf-text-layer.js'))
        . '" data-export-url="' . htmlspecialchars($url) . '" data-lease="' . htmlspecialchars($lease)
        . '" data-csrf="' . csrf_token() . '"';
}

function pdf_export_document(array $share, string $slug, string $visitor, string $token, int $index): never {
    $pdo = db();
    $shareId = (int)$share['id'];
    $limits = pdf_export_limits();
    $started = hrtime(true);
    $reserved = false;
    try {
        $pdo->exec('BEGIN IMMEDIATE');
        try {
            $lease = pdf_export_lease($shareId, $visitor, $token, true);
            $stmt = $pdo->prepare('SELECT * FROM pdf_export_documents WHERE job_token = ? AND doc_index = ?');
            $stmt->execute([$token, $index]);
            $entry = $stmt->fetch(PDO::FETCH_ASSOC);
            if (!$entry) throw new RuntimeException('无效的文档编号。', 400);
            $stmt = $pdo->prepare('SELECT SUM(active) FROM pdf_export_documents WHERE job_token = ?');
            $stmt->execute([$token]);
            $parallel = (int)$lease['document_count'] > 1 ? 3 : 1;
            if ((int)$entry['active'] || (int)$stmt->fetchColumn() >= $parallel) throw new RuntimeException('当前正在生成其他文档，请稍后重试。', 409);
            $pdo->prepare('UPDATE pdf_export_documents SET active = 1 WHERE job_token = ? AND doc_index = ?')->execute([$token, $index]);
            $pdo->exec('COMMIT');
            $reserved = true;
        } catch (Throwable $error) {
            $pdo->exec('ROLLBACK');
            throw $error;
        }
        $stmt = $pdo->prepare('SELECT COALESCE(SUM(prepare_millis), 0) FROM pdf_export_documents WHERE job_token = ?');
        $stmt->execute([$token]);
        $remainingMillis = $limits['max_execution_seconds'] * 1000 - (int)$stmt->fetchColumn();
        if ($remainingMillis <= 0) throw new RuntimeException('整理文档耗时过长，请减少单次导出篇数。', 413);
        set_time_limit(max(1, (int)ceil($remainingMillis / 1000)));
        $memory = ini_parse_quantity((string)ini_get('memory_limit'));
        ini_set('memory_limit', (string)($memory > 0 ? min($memory, $limits['max_memory_bytes']) : $limits['max_memory_bytes']));
        // Only IDs admitted into this job can be prepared. Never accept a client doc_id.
        $stmt = $pdo->prepare('SELECT doc_id, substr(CAST(markdown AS BLOB), 1, ?) AS markdown FROM share_docs WHERE share_id = ? AND id = ? AND doc_id = ?');
        $stmt->execute([$limits['max_markdown_bytes'] + 1, $shareId, $entry['document_id'], $entry['doc_id']]);
        $doc = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$doc) throw new RuntimeException('This document was removed. Choose the export scope again.', 404);
        $sourceBytes = strlen((string)$doc['markdown']);
        $stmt = $pdo->prepare('SELECT COALESCE(SUM(source_bytes), 0) FROM pdf_export_documents WHERE job_token = ? AND doc_index != ?');
        $stmt->execute([$token, $index]);
        if ($sourceBytes + (int)$stmt->fetchColumn() > $limits['max_markdown_bytes']) throw new RuntimeException('文档内容过大，请分批导出。', 413);
        $stmt = $pdo->prepare('SELECT COALESCE(SUM(size_bytes), 0) FROM share_assets WHERE share_id = ? AND
            (doc_id IS NULL OR doc_id = \'\' OR doc_id IN (SELECT d.doc_id FROM share_docs d JOIN pdf_export_documents p ON p.document_id = d.id AND p.doc_id = d.doc_id WHERE p.job_token = ? AND d.share_id = ?))');
        $stmt->execute([$shareId, $token, $shareId]);
        if ((int)$stmt->fetchColumn() > $limits['max_asset_bytes']) throw new RuntimeException('关联附件过大，请减少单次导出篇数。', 413);
        $title = (string)$entry['title'];
        $markdown = (string)extract_front_matter((string)$doc['markdown'])['body'];
        $markdown = rewrite_asset_links($markdown, base_path() . '/s/' . rawurlencode($slug) . '/res/');
        $markdown = strip_duplicate_title_heading($markdown, $title);
        $markdown = replace_custom_emoji_tokens($markdown, $shareId, base_path() . '/s/' . rawurlencode($slug) . '/res/');
        $markdown = insert_adjacent_emoji_image_spacing($markdown);
        $html = render_markdown($markdown);
        $sourceUrl = base_path() . build_share_redirect_path($slug, (string)$doc['doc_id'], '');
        $section = '<section class="pdf-doc" data-pdf-doc="' . htmlspecialchars((string)$doc['doc_id']) . '" data-pdf-title="' . htmlspecialchars($title) . '" data-pdf-source="' . htmlspecialchars($sourceUrl) . '"><h1>' . htmlspecialchars($title) . '</h1>';
        $section .= '<div class="markdown-body" data-md-id="pdf-' . $index . '">' . $html . '</div><textarea class="markdown-source" data-md-id="pdf-' . $index . '" hidden>' . htmlspecialchars($markdown) . '</textarea></section>';
        $pdo->exec('BEGIN IMMEDIATE');
        try {
            $lease = pdf_export_lease($shareId, $visitor, $token);
            $pdo->prepare('UPDATE pdf_export_documents SET source_bytes = ?, html_bytes = ?, image_count = ?, prepare_millis = prepare_millis + ? WHERE job_token = ? AND doc_index = ?')
                ->execute([$sourceBytes, strlen($section), substr_count($html, '<img'), (int)ceil((hrtime(true) - $started) / 1000000), $token, $index]);
            $stmt = $pdo->prepare('SELECT SUM(source_bytes) AS source, SUM(html_bytes) AS html, SUM(image_count) AS images, SUM(prepare_millis) AS millis FROM pdf_export_documents WHERE job_token = ?');
            $stmt->execute([$token]);
            $sum = $stmt->fetch(PDO::FETCH_ASSOC);
            if ($sum['source'] > $limits['max_markdown_bytes'] || $sum['html'] > $limits['max_html_bytes'] || $sum['images'] > $limits['max_images'] || $sum['millis'] > $limits['max_execution_seconds'] * 1000) {
                throw new RuntimeException('文档内容、图片或整理耗时超出限制，请分批导出。', 413);
            }
            $pdo->exec('COMMIT');
        } catch (Throwable $error) {
            $pdo->exec('ROLLBACK');
            throw $error;
        }
        pdf_export_share($slug);
        pdf_visitor_claim($shareId, $token, $index);
        $url = base_path() . '/s/' . rawurlencode($slug) . '/export';
        $content = '<div data-pdf-preview data-pdf-child="1" data-pdf-index="' . $index . '"' . pdf_export_worker_attributes($url, $token) . '><p data-pdf-status role="status">正在准备排版…</p><button type="button" data-pdf-download disabled>生成 PDF</button></div><main class="pdf-document">' . $section . '</main>';
        render_page($title, $content, null, '', ['layout' => 'share', 'markdown' => true, 'pdf_export' => true]);
    } catch (Throwable $error) {
        if ($reserved) $pdo->prepare('UPDATE pdf_export_documents SET active = 0 WHERE job_token = ? AND doc_index = ?')->execute([$token, $index]);
        $code = in_array($error->getCode(), [400, 403, 404, 409, 410, 413, 428, 429], true) ? $error->getCode() : 503;
        if (in_array($code, [404, 413], true)) pdf_export_release($token);
        pdf_export_fail($code, $code === 503 ? '文档准备失败，请稍后重试。' : $error->getMessage());
    }
}

function route_pdf_export(string $slug, string $action = ''): never {
    header('Cache-Control: private, no-store');
    header('X-Robots-Tag: noindex, nofollow');
    header('Referrer-Policy: same-origin');
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if ($action !== '' || $method === 'POST') pdf_export_csrf();
    if ($action === 'release' && $method === 'POST') {
        $ticket = $_POST['ticket'] ?? '';
        if (is_string($ticket) && isset($_SESSION['pdf_export_tickets'][$ticket])) {
            $entry = &$_SESSION['pdf_export_tickets'][$ticket];
            try { $owner = pdf_visitor_id(true); } catch (RuntimeException $error) { $owner = ''; }
            if ($entry['visitor'] === $owner && $entry['slug'] === $slug) {
                $entry['cancelled'] = true;
                if ($entry['token'] !== '') pdf_export_release($entry['token']);
            }
        }
        $token = $_POST['lease'] ?? '';
        if (is_string($token)) pdf_export_release($token);
        http_response_code(204);
        exit;
    }
    $share = pdf_export_share($slug);
    $shareId = (int)$share['id'];
    try {
        $visitor = pdf_visitor_id($method !== 'GET');
        if ($action === 'quota' && $method === 'POST') {
            header('Content-Type: application/json; charset=utf-8');
            echo json_encode(['ok' => true, 'quota' => pdf_visitor_usage($visitor)]);
            exit;
        }
        if ($action === 'claim' && $method === 'POST') {
            $token = $_POST['lease'] ?? '';
            $index = $_POST['index'] ?? '';
            if (!is_string($token) || !is_string($index) || !preg_match('/^[0-9]{1,3}$/D', $index)) throw new RuntimeException('无效的文档编号。', 400);
            pdf_visitor_claim($shareId, $token, (int)$index);
            header('Content-Type: application/json; charset=utf-8');
            echo '{"ok":true}';
            exit;
        }
        if ($action === 'document' && $method === 'POST') {
            $token = $_POST['lease'] ?? '';
            $index = $_POST['index'] ?? '';
            if (!is_string($token) || !is_string($index) || !preg_match('/^[0-9]{1,3}$/D', $index)) throw new RuntimeException('无效的文档编号。', 400);
            pdf_export_document($share, $slug, $visitor, $token, (int)$index);
        }
        if ($action === 'verify' && $method === 'POST') {
            $token = $_POST['lease'] ?? '';
            if (!is_string($token)) throw new RuntimeException('无效的导出凭据。', 400);
            $lease = pdf_export_lease($shareId, $visitor, $token, ($_POST['renew'] ?? '') === '1');
            if (isset($_POST['finish'])) {
                $index = $_POST['finish'];
                if (!is_string($index) || !preg_match('/^[0-9]{1,3}$/D', $index) || (int)$index >= (int)$lease['document_count']) throw new RuntimeException('无效的文档编号。', 400);
                db()->prepare('UPDATE pdf_export_documents SET active = 0 WHERE job_token = ? AND doc_index = ?')->execute([$token, (int)$index]);
            }
            if (($_POST['abandon'] ?? '') === '1') db()->prepare('UPDATE pdf_export_documents SET active = 0 WHERE job_token = ?')->execute([$token]);
            header('Content-Type: application/json; charset=utf-8');
            echo json_encode(['ok' => true, 'expires_at' => (int)$lease['expires_at'], 'server_time' => time(),
                'renew_after' => max(1, (int)$lease['expires_at'] - time() - (int)floor(pdf_export_limits()['lease_seconds'] * 2 / 3))]);
            exit;
        }
        if (in_array($action, ['check', 'captcha', 'captcha-verify'], true) && $method === 'POST') {
            $fp = pdf_visitor_fingerprint($_POST['fingerprint'] ?? null);
            pdf_visitor_quota($visitor, pdf_export_limits());
            $required = pdf_visitor_needs_captcha($visitor, $fp);
            header('Content-Type: application/json; charset=utf-8');
            if ($action === 'captcha-verify') {
                pdf_visitor_verify_captcha($visitor, $fp, $_POST['token'] ?? null, $_POST['answer'] ?? null);
                echo json_encode(['ok' => true, 'quota' => pdf_visitor_usage($visitor)]);
            } elseif (!$required) {
                echo json_encode(['ok' => true, 'quota' => pdf_visitor_usage($visitor)]);
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
        $dialog = ($_GET['dialog'] ?? '') === '1';
        $tickets = array_filter($_SESSION['pdf_export_tickets'] ?? [], static fn($entry) => is_array($entry) && (int)($entry['created'] ?? 0) > time() - 1800);
        while (count($tickets) >= 32) array_shift($tickets);
        $ticket = bin2hex(random_bytes(16));
        $tickets[$ticket] = ['created' => time(), 'visitor' => $visitor, 'slug' => $slug, 'token' => '', 'cancelled' => false];
        $_SESSION['pdf_export_tickets'] = $tickets;
        $usage = htmlspecialchars(json_encode(pdf_visitor_usage($visitor)), ENT_QUOTES, 'UTF-8');
        $content = '<main class="pdf-export-panel">' . ($dialog ? '' : '<h1>Export PDF</h1>') . '<p>Choose a scope to download each document as a separate PDF.</p>';
        $content .= '<div class="pdf-quota-notice" data-pdf-quota="' . $usage . '" role="status"></div>';
        $content .= '<p>Maximum ' . $limits['max_docs'] . ' documents per batch. Select large notebooks in smaller batches.</p>';
        $content .= '<form method="post" action="' . htmlspecialchars($url) . '" target="sps-pdf-worker" data-pdf-export-form' . pdf_export_worker_attributes($url, '') . '>';
        $content .= render_hidden_inputs(['csrf' => csrf_token(), 'fingerprint' => '', 'auto_download' => '1', 'ticket' => $ticket]);
        $content .= '<label>Export scope <select class="input" name="scope" data-pdf-scope><option value="single">Single document</option><option value="tree">This document and its subpages</option><option value="all">Entire share</option><option value="selected">Select documents</option></select></label>';
        $content .= '<label data-pdf-root>Document <select class="input" name="doc_id">';
        foreach (array_slice($docs, 0, 2000) as $doc) {
            $content .= '<option value="' . htmlspecialchars((string)$doc['doc_id']) . '"' . ($doc['doc_id'] === $active ? ' selected' : '') . '>' . htmlspecialchars((string)($doc['hpath'] ?: $doc['title'])) . '</option>';
        }
        $content .= '</select></label><fieldset data-pdf-selection hidden><legend>Select documents</legend>';
        foreach (array_slice($docs, 0, 2000) as $doc) {
            $content .= '<label><input type="checkbox" name="doc_ids[]" value="' . htmlspecialchars((string)$doc['doc_id']) . '"> ' . htmlspecialchars((string)($doc['hpath'] ?: $doc['title'])) . '</label>';
        }
        $content .= '</fieldset>';
        if (count($docs) > 2000) $content .= '<p>Only the first 2,000 documents are listed. Open other documents from the share page to export them.</p>';
        $content .= '<fieldset data-pdf-challenge hidden><legend>Security check (once per browser cookie)</legend><p>Enter the verification code to continue exporting.</p><img data-pdf-captcha-image alt="Verification code"><button class="button ghost" type="button" data-pdf-captcha-refresh>Refresh code</button><label>Verification code <input class="input" name="captcha_answer" autocomplete="off" maxlength="8"></label></fieldset>';
        $content .= '<button class="button primary" type="submit">Export</button><p data-pdf-form-status role="status" aria-live="polite"></p></form>';
        $content .= '<iframe class="pdf-export-worker" name="sps-pdf-worker" data-pdf-worker title="PDF generation task" aria-hidden="true" tabindex="-1"></iframe>';
        if (!$dialog) $content .= '<a href="' . htmlspecialchars(base_path() . '/s/' . rawurlencode($slug)) . '">Back to share</a>';
        $content .= '</main>';
        render_page('Export PDF', $content, null, '', ['layout' => 'share', 'pdf_export' => true, 'pdf_embedded' => $dialog]);
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
        $ticket = $_POST['ticket'] ?? '';
        if (($_POST['auto_download'] ?? '') === '1') {
            $entry = is_string($ticket) ? ($_SESSION['pdf_export_tickets'][$ticket] ?? null) : null;
            if (!$entry || $entry['visitor'] !== $visitor || $entry['slug'] !== $slug || $entry['cancelled'] || $entry['created'] <= time() - 1800) {
                throw new RuntimeException('导出任务已取消或选项已过期，请关闭弹窗后重试。', 409);
            }
        }
        $docs = pdf_export_select_docs($shareId, $_POST);
        $lease = pdf_export_admit($shareId, $fingerprint, count($docs));
        if (($_POST['auto_download'] ?? '') === '1') $_SESSION['pdf_export_tickets'][$ticket]['token'] = $lease;
        set_time_limit($limits['max_execution_seconds']);
        $memory = ini_parse_quantity((string)ini_get('memory_limit'));
        ini_set('memory_limit', (string)($memory > 0 ? min($memory, $limits['max_memory_bytes']) : $limits['max_memory_bytes']));
        $docIds = array_column($docs, 'doc_id');
        $stmt = db()->prepare('SELECT COALESCE(SUM(size_bytes), 0) FROM share_assets WHERE share_id = ? AND
            (doc_id IS NULL OR doc_id = \'\' OR doc_id IN (' . implode(',', array_fill(0, count($docs), '?')) . '))');
        $stmt->execute(array_merge([$shareId], $docIds));
        if ((int)$stmt->fetchColumn() > $limits['max_asset_bytes']) throw new RuntimeException('关联附件过大，请减少单次导出篇数。', 413);
        // Persist only the admitted manifest. Prepare Markdown lazily per document.
        $pdo = db();
        $pdo->exec('BEGIN IMMEDIATE');
        try {
            pdf_export_lease($shareId, $visitor, $lease);
            $stmt = $pdo->prepare('INSERT INTO pdf_export_documents(job_token, doc_index, document_id, doc_id, title, source_bytes) VALUES (?, ?, ?, ?, ?, ?)');
            foreach ($docs as $index => $doc) $stmt->execute([$lease, $index, (int)$doc['id'], (string)$doc['doc_id'], (string)$doc['title'], (int)$doc['markdown_bytes']]);
            $pdo->exec('COMMIT');
        } catch (Throwable $error) {
            $pdo->exec('ROLLBACK');
            throw $error;
        }
        pdf_export_share($slug);
        $expires = pdf_export_lease($shareId, $visitor, $lease);
        $manifest = json_encode(array_map(static fn($doc) => ['title' => (string)$doc['title'],
            'source' => base_path() . build_share_redirect_path($slug, (string)$doc['doc_id'], '')], $docs), JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT | JSON_THROW_ON_ERROR);
        $auto = ($_POST['auto_download'] ?? '') === '1' ? '1' : '0';
        $renewAfter = max(1, (int)$expires['expires_at'] - time() - (int)floor($limits['lease_seconds'] * 2 / 3));
        $content = '<div class="pdf-export-toolbar" data-pdf-preview data-pdf-job="1" data-pdf-auto="' . $auto . '" data-pdf-renew-after="' . $renewAfter . '"' . pdf_export_worker_attributes($url, $lease) . '>';
        $content .= '<p data-pdf-status role="status">正在逐篇准备文档…</p><button class="button primary" type="button" data-pdf-download>下载 PDF</button></div><script type="application/json" data-pdf-manifest>' . $manifest . '</script>';
        $complete = true;
        render_page(count($docs) === 1 ? (string)$docs[0]['title'] : (string)$share['title'], $content, null, '', ['layout' => 'share', 'pdf_export' => true]);
    } catch (Throwable $error) {
        if ($error->getCode() === 429) header('Retry-After: ' . $limits['window_seconds']);
        $status = in_array($error->getCode(), [400, 403, 404, 409, 410, 413, 428, 429], true) ? $error->getCode() : 503;
        pdf_export_fail($status, $status === 503 ? '导出服务繁忙，请稍后重试。' : $error->getMessage());
    }
}
