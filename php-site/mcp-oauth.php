<?php
declare(strict_types=1);

// OAuth 2.1 Authorization Server, discovery metadata, rate limiting, debug logging,
// and admin panel management for the read-only MCP service.

function mcp_oauth_migrate(PDO $pdo): void {
    $pdo->exec('CREATE TABLE IF NOT EXISTS oauth_clients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id TEXT NOT NULL UNIQUE,
        secret_hash TEXT NOT NULL,
        name TEXT NOT NULL,
        redirect_uris_json TEXT NOT NULL DEFAULT "[]",
        require_pkce INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT
    );');

    $pdo->exec('CREATE TABLE IF NOT EXISTS oauth_codes (
        code_hash TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT,
        scope TEXT NOT NULL,
        resource TEXT,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        family_id TEXT NOT NULL,
        created_at TEXT NOT NULL
    );');

    $pdo->exec('CREATE TABLE IF NOT EXISTS oauth_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_hash TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        client_id TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        scope TEXT NOT NULL,
        resource TEXT,
        family_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        rotated_at INTEGER,
        revoked_at INTEGER,
        created_at TEXT NOT NULL,
        last_used_at INTEGER
    );');
    $pdo->exec('CREATE INDEX IF NOT EXISTS idx_oauth_tokens_family ON oauth_tokens(family_id)');
    $pdo->exec('CREATE INDEX IF NOT EXISTS idx_oauth_tokens_client ON oauth_tokens(client_id, revoked_at)');

    $pdo->exec('CREATE TABLE IF NOT EXISTS oauth_redirect_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        seen_at TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 1,
        UNIQUE(client_id, redirect_uri)
    );');

    $pdo->exec('CREATE TABLE IF NOT EXISTS oauth_rate_limits (
        bucket_key TEXT PRIMARY KEY,
        window_start INTEGER NOT NULL,
        count INTEGER NOT NULL DEFAULT 0
    );');

    $pdo->exec('CREATE TABLE IF NOT EXISTS mcp_debug_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        rpc_method TEXT,
        protocol_version TEXT,
        user_agent TEXT,
        status_code INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        note TEXT,
        output_chars INTEGER NOT NULL DEFAULT 0,
        est_tokens INTEGER NOT NULL DEFAULT 0
    );');
    ensure_column($pdo, 'mcp_debug_logs', 'output_chars', 'INTEGER NOT NULL DEFAULT 0');
    ensure_column($pdo, 'mcp_debug_logs', 'est_tokens', 'INTEGER NOT NULL DEFAULT 0');

    $pdo->exec('CREATE TABLE IF NOT EXISTS mcp_usage_stats (
        metric_key TEXT PRIMARY KEY,
        call_count INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        total_duration_ms INTEGER NOT NULL DEFAULT 0,
        max_duration_ms INTEGER NOT NULL DEFAULT 0,
        total_chars INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        last_called_at TEXT NOT NULL
    );');
}

function mcp_seed_default_settings(PDO $pdo): void {
    ensure_setting($pdo, 'mcp_enabled', '0');
    ensure_setting($pdo, 'mcp_learning_mode', '0');
    ensure_setting($pdo, 'mcp_debug_logs_enabled', '0');
}

function mcp_is_enabled(): bool {
    return get_bool_setting('mcp_enabled', false);
}

function mcp_base64url(string $bytes): string {
    return rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
}

function mcp_generate_credential(string $prefix, bool $hex = false): string {
    $bytes = random_bytes(32);
    return $prefix . ($hex ? bin2hex($bytes) : mcp_base64url($bytes));
}

function mcp_hash_secret(string $raw): string {
    return hash('sha256', $raw, false);
}

function mcp_is_safe_oauth_return_to(?string $url): bool {
    if (!is_string($url) || $url === '' || strlen($url) > 4096) {
        return false;
    }
    if (!str_starts_with($url, '/oauth/authorize?')) {
        return false;
    }
    if (str_contains($url, '\\') || preg_match('/[\x00-\x1F\x7F]/', $url)) {
        return false;
    }
    $parts = parse_url($url);
    if (!is_array($parts) || isset($parts['scheme']) || isset($parts['host']) || isset($parts['user']) || isset($parts['pass'])) {
        return false;
    }
    return ($parts['path'] ?? '') === '/oauth/authorize' && isset($parts['query']) && $parts['query'] !== '';
}

function mcp_expected_resource(): string {
    return rtrim(base_url(), '/') . '/mcp';
}

function mcp_normalize_resource(?string $resource): string {
    return rtrim(trim((string)$resource), '/');
}

function mcp_resource_matches(?string $resource): bool {
    if ($resource === null || trim($resource) === '') {
        return true;
    }
    return mcp_normalize_resource($resource) === mcp_expected_resource();
}

function mcp_is_valid_redirect_uri(string $uri): bool {
    $uri = trim($uri);
    if ($uri === '' || strlen($uri) > 2048 || preg_match('/[\x00-\x1F\x7F\s]/', $uri)) {
        return false;
    }
    $parts = parse_url($uri);
    if (!is_array($parts) || empty($parts['scheme']) || empty($parts['host'])) {
        return false;
    }
    if (isset($parts['fragment']) || isset($parts['user']) || isset($parts['pass'])) {
        return false;
    }
    $scheme = strtolower((string)$parts['scheme']);
    $host = strtolower((string)$parts['host']);
    if ($scheme === 'https') {
        return true;
    }
    if ($scheme === 'http' && in_array($host, ['localhost', '127.0.0.1', '[::1]'], true)) {
        return true;
    }
    return false;
}

function mcp_normalize_scope(?string $rawScope): ?string {
    $raw = trim((string)$rawScope);
    if ($raw === '') {
        return 'notes:read';
    }
    $parts = preg_split('/\s+/', $raw, -1, PREG_SPLIT_NO_EMPTY);
    if (!is_array($parts) || empty($parts)) {
        return 'notes:read';
    }
    foreach ($parts as $scope) {
        if ($scope !== 'notes:read') {
            return null;
        }
    }
    return 'notes:read';
}

function mcp_json_response(int $status, array $payload, array $extraHeaders = []): never {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header('Pragma: no-cache');
    foreach ($extraHeaders as $header) {
        header($header);
    }
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function mcp_rate_limit_check(string $bucketKey, int $limit, int $windowSeconds = 60, int $cost = 1): array {
    $cost = max(1, $cost);
    $now = time();
    $pdo = db();
    $pdo->exec('BEGIN IMMEDIATE');
    $inTx = true;
    try {
        $stmt = $pdo->prepare('SELECT window_start, count FROM oauth_rate_limits WHERE bucket_key = :k LIMIT 1');
        $stmt->execute([':k' => $bucketKey]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);

        if (!$row || ($now - (int)$row['window_start']) >= $windowSeconds) {
            $newCount = $cost;
            $windowStart = $now;
            $upsert = $pdo->prepare(
                'INSERT INTO oauth_rate_limits (bucket_key, window_start, count) VALUES (:k, :ws, :c)
                 ON CONFLICT(bucket_key) DO UPDATE SET window_start = :ws2, count = :c2'
            );
            $upsert->execute([
                ':k' => $bucketKey,
                ':ws' => $windowStart,
                ':c' => $newCount,
                ':ws2' => $windowStart,
                ':c2' => $newCount,
            ]);
            // Opportunistic cleanup of stale buckets (> 10 minutes old).
            if (($now % 17) === 0) {
                $pdo->prepare('DELETE FROM oauth_rate_limits WHERE window_start < :cutoff')
                    ->execute([':cutoff' => $now - 600]);
            }
            $pdo->exec('COMMIT');
            $inTx = false;
            return [
                'allowed' => $newCount <= $limit,
                'retry_after' => $windowSeconds,
                'remaining' => max(0, $limit - $newCount),
            ];
        }

        $currentCount = (int)$row['count'];
        $windowStart = (int)$row['window_start'];
        $retryAfter = max(1, ($windowStart + $windowSeconds) - $now);
        if ($currentCount + $cost > $limit) {
            $pdo->exec('COMMIT');
            $inTx = false;
            return [
                'allowed' => false,
                'retry_after' => $retryAfter,
                'remaining' => 0,
            ];
        }

        $newCount = $currentCount + $cost;
        $pdo->prepare('UPDATE oauth_rate_limits SET count = :c WHERE bucket_key = :k')
            ->execute([':c' => $newCount, ':k' => $bucketKey]);
        $pdo->exec('COMMIT');
        $inTx = false;
        return [
            'allowed' => true,
            'retry_after' => $retryAfter,
            'remaining' => max(0, $limit - $newCount),
        ];
    } catch (Throwable $error) {
        if ($inTx) {
            try {
                $pdo->exec('ROLLBACK');
            } catch (Throwable $ignored) {
            }
        }
        throw $error;
    }
}

function mcp_estimate_tokens(string $text): array {
    if ($text === '') {
        return ['chars' => 0, 'tokens' => 0];
    }
    $totalChars = mb_strlen($text, 'UTF-8');
    $asciiOnly = preg_replace('/[^\x00-\x7F]+/', '', $text);
    $asciiChars = is_string($asciiOnly) ? strlen($asciiOnly) : 0;
    $nonAsciiChars = max(0, $totalChars - $asciiChars);
    $tokens = max(1, (int)ceil($nonAsciiChars * 0.75 + $asciiChars * 0.25));
    return ['chars' => $totalChars, 'tokens' => $tokens];
}

function mcp_record_usage_stat(
    string $metricKey,
    int $durationMs,
    bool $isError = false,
    int $chars = 0,
    int $tokens = 0
): void {
    try {
        $metricKey = substr(trim($metricKey), 0, 64);
        if ($metricKey === '') {
            return;
        }
        $allowedKeys = [
            'tools/call:list_shares',
            'tools/call:get_share_tree',
            'tools/call:read_document',
            'tools/call:get_document_outline',
            'tools/call:search_notes',
            'tools/call:unknown',
            'tools/call',
            'initialize',
            'notifications/initialized',
            'notifications/cancelled',
            'tools/list',
            'resources/list',
            'prompts/list',
            'ping',
        ];
        if (!in_array($metricKey, $allowedKeys, true)) {
            $metricKey = 'other_rpc';
        }
        $dur = max(0, $durationMs);
        $err = $isError ? 1 : 0;
        $c = max(0, $chars);
        $t = max(0, $tokens);
        $ts = now();
        $pdo = db();
        $stmt = $pdo->prepare(
            'INSERT INTO mcp_usage_stats (metric_key, call_count, error_count, total_duration_ms, max_duration_ms, total_chars, total_tokens, last_called_at)
             VALUES (:k, 1, :err, :dur, :max_dur, :chars, :tokens, :ts)
             ON CONFLICT(metric_key) DO UPDATE SET
                 call_count = call_count + 1,
                 error_count = error_count + :err2,
                 total_duration_ms = total_duration_ms + :dur2,
                 max_duration_ms = MAX(max_duration_ms, :max_dur2),
                 total_chars = total_chars + :chars2,
                 total_tokens = total_tokens + :tokens2,
                 last_called_at = :ts2'
        );
        $stmt->execute([
            ':k' => $metricKey,
            ':err' => $err,
            ':dur' => $dur,
            ':max_dur' => $dur,
            ':chars' => $c,
            ':tokens' => $t,
            ':ts' => $ts,
            ':err2' => $err,
            ':dur2' => $dur,
            ':max_dur2' => $dur,
            ':chars2' => $c,
            ':tokens2' => $t,
            ':ts2' => $ts,
        ]);
    } catch (Throwable $ignored) {
        // Usage statistics must never break production requests.
    }
}

function mcp_debug_log(
    string $method,
    string $path,
    int $statusCode,
    int $durationMs,
    ?string $rpcMethod = null,
    ?string $protocolVersion = null,
    ?string $note = null,
    int $estTokens = 0,
    int $outputChars = 0
): void {
    try {
        if (!get_bool_setting('mcp_debug_logs_enabled', false)) {
            return;
        }
        $pdo = db();
        $ua = substr((string)($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 200);
        $cleanNote = $note !== null && $note !== '' ? substr($note, 0, 200) : null;
        $stmt = $pdo->prepare(
            'INSERT INTO mcp_debug_logs (created_at, method, path, rpc_method, protocol_version, user_agent, status_code, duration_ms, note, output_chars, est_tokens)
             VALUES (:created_at, :method, :path, :rpc_method, :protocol_version, :user_agent, :status_code, :duration_ms, :note, :output_chars, :est_tokens)'
        );
        $stmt->execute([
            ':created_at' => now(),
            ':method' => substr($method, 0, 16),
            ':path' => substr($path, 0, 128),
            ':rpc_method' => $rpcMethod !== null ? substr($rpcMethod, 0, 64) : null,
            ':protocol_version' => $protocolVersion !== null ? substr($protocolVersion, 0, 32) : null,
            ':user_agent' => $ua,
            ':status_code' => $statusCode,
            ':duration_ms' => max(0, $durationMs),
            ':note' => $cleanNote,
            ':output_chars' => max(0, $outputChars),
            ':est_tokens' => max(0, $estTokens),
        ]);
        // Keep only the latest 200 log entries.
        $pdo->exec(
            'DELETE FROM mcp_debug_logs WHERE id NOT IN (SELECT id FROM mcp_debug_logs ORDER BY id DESC LIMIT 200)'
        );
    } catch (Throwable $ignored) {
        // Debug logging must never break production requests.
    }
}

function mcp_handle_well_known(string $path): void {
    $start = microtime(true);
    if (!mcp_is_enabled()) {
        mcp_json_response(404, ['error' => 'not_found']);
    }
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if ($method !== 'GET' && $method !== 'HEAD') {
        mcp_json_response(405, ['error' => 'method_not_allowed'], ['Allow: GET, HEAD']);
    }

    $issuer = rtrim(base_url(), '/');
    if ($path === '/.well-known/oauth-protected-resource' || $path === '/.well-known/oauth-protected-resource/mcp') {
        $payload = [
            'resource' => $issuer . '/mcp',
            'authorization_servers' => [$issuer],
            'scopes_supported' => ['notes:read'],
            'bearer_methods_supported' => ['header'],
            'resource_name' => 'Etalib Notes',
        ];
        mcp_debug_log($method, $path, 200, (int)round((microtime(true) - $start) * 1000));
        mcp_json_response(200, $payload);
    }

    if ($path === '/.well-known/oauth-authorization-server' || $path === '/.well-known/openid-configuration') {
        $payload = [
            'issuer' => $issuer,
            'authorization_endpoint' => $issuer . '/oauth/authorize',
            'token_endpoint' => $issuer . '/oauth/token',
            'revocation_endpoint' => $issuer . '/oauth/revoke',
            'response_types_supported' => ['code'],
            'grant_types_supported' => ['authorization_code', 'refresh_token'],
            'code_challenge_methods_supported' => ['S256'],
            'token_endpoint_auth_methods_supported' => ['client_secret_basic', 'client_secret_post'],
            'scopes_supported' => ['notes:read'],
            'authorization_response_iss_parameter_supported' => true,
        ];
        mcp_debug_log($method, $path, 200, (int)round((microtime(true) - $start) * 1000));
        mcp_json_response(200, $payload);
    }

    mcp_json_response(404, ['error' => 'not_found']);
}

function mcp_extract_bearer_token(): string {
    $auth = (string)($_SERVER['HTTP_AUTHORIZATION'] ?? ($_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? ''));
    if (preg_match('/^\s*Bearer\s+(\S+)\s*$/i', $auth, $matches)) {
        return trim($matches[1]);
    }
    return '';
}

function mcp_www_authenticate_header(?string $error = null): string {
    $metaUrl = rtrim(base_url(), '/') . '/.well-known/oauth-protected-resource/mcp';
    $parts = [];
    if ($error !== null && $error !== '') {
        $parts[] = 'error="' . $error . '"';
    }
    $parts[] = 'resource_metadata="' . $metaUrl . '"';
    $parts[] = 'scope="notes:read"';
    return 'WWW-Authenticate: Bearer ' . implode(', ', $parts);
}

function mcp_authenticate_bearer_request(): array {
    $rawToken = mcp_extract_bearer_token();
    if ($rawToken === '') {
        mcp_debug_log((string)($_SERVER['REQUEST_METHOD'] ?? 'POST'), '/mcp', 401, 0, null, null, 'missing_bearer');
        mcp_json_response(
            401,
            ['error' => 'unauthorized', 'error_description' => 'Bearer token required.'],
            [mcp_www_authenticate_header(null)]
        );
    }

    $tokenHash = mcp_hash_secret($rawToken);
    $pdo = db();
    $stmt = $pdo->prepare(
        'SELECT * FROM oauth_tokens WHERE token_hash = :hash AND kind = "access" LIMIT 1'
    );
    $stmt->execute([':hash' => $tokenHash]);
    $token = $stmt->fetch(PDO::FETCH_ASSOC);

    $now = time();
    if (
        !$token
        || !hash_equals((string)$token['token_hash'], $tokenHash)
        || $token['revoked_at'] !== null
        || (int)$token['expires_at'] <= $now
        || !mcp_resource_matches($token['resource'] !== null ? (string)$token['resource'] : null)
    ) {
        mcp_debug_log((string)($_SERVER['REQUEST_METHOD'] ?? 'POST'), '/mcp', 401, 0, null, null, 'invalid_token');
        mcp_json_response(
            401,
            ['error' => 'invalid_token', 'error_description' => 'Access token is invalid, expired, or revoked.'],
            [mcp_www_authenticate_header('invalid_token')]
        );
    }

    $clientStmt = $pdo->prepare('SELECT * FROM oauth_clients WHERE client_id = :cid AND revoked_at IS NULL LIMIT 1');
    $clientStmt->execute([':cid' => (string)$token['client_id']]);
    $client = $clientStmt->fetch(PDO::FETCH_ASSOC);

    $userStmt = $pdo->prepare('SELECT * FROM users WHERE id = :uid AND role = "admin" AND disabled = 0 LIMIT 1');
    $userStmt->execute([':uid' => (int)$token['user_id']]);
    $user = $userStmt->fetch(PDO::FETCH_ASSOC);

    if (!$client || !$user) {
        mcp_debug_log((string)($_SERVER['REQUEST_METHOD'] ?? 'POST'), '/mcp', 401, 0, null, null, 'client_or_user_inactive');
        mcp_json_response(
            401,
            ['error' => 'invalid_token', 'error_description' => 'Associated client or account is no longer active.'],
            [mcp_www_authenticate_header('invalid_token')]
        );
    }

    // Throttle SQLite last_used_at updates to once every 5 minutes to reduce write-lock contention.
    $lastUsed = $token['last_used_at'] !== null ? (int)$token['last_used_at'] : 0;
    if ($lastUsed === 0 || ($now - $lastUsed) >= 300) {
        try {
            $pdo->prepare('UPDATE oauth_tokens SET last_used_at = :now WHERE id = :id')
                ->execute([':now' => $now, ':id' => (int)$token['id']]);
            $pdo->prepare('UPDATE oauth_clients SET last_used_at = :ts WHERE id = :id')
                ->execute([':ts' => now(), ':id' => (int)$client['id']]);
        } catch (Throwable $ignored) {
            // Non-fatal metadata update.
        }
    }

    return [
        'token' => $token,
        'client' => $client,
        'user' => $user,
    ];
}

function mcp_render_oauth_error_page(string $title, string $message, int $status = 400): never {
    http_response_code($status);
    header('X-Frame-Options: DENY');
    header("Content-Security-Policy: frame-ancestors 'none'");
    header('Cache-Control: no-store');
    header('Referrer-Policy: no-referrer');
    $content = '<div class="auth-card">'
        . '<h1>' . htmlspecialchars($title, ENT_QUOTES, 'UTF-8') . '</h1>'
        . '<p class="flash error" role="alert">' . htmlspecialchars($message, ENT_QUOTES, 'UTF-8') . '</p>'
        . '<p class="muted">You can close this window or return to <a href="' . base_path() . '/admin#mcp-connection">Site settings</a>.</p>'
        . '</div>';
    render_page($title, $content, null, '', ['layout' => 'auth']);
}

function mcp_redirect_with_params(string $redirectUri, array $params): never {
    $sep = str_contains($redirectUri, '?') ? '&' : '?';
    header('Location: ' . $redirectUri . $sep . http_build_query($params, '', '&', PHP_QUERY_RFC3986));
    exit;
}

function mcp_record_redirect_attempt(string $clientId, string $redirectUri): void {
    if (!get_bool_setting('mcp_learning_mode', false)) {
        return;
    }
    if (!mcp_is_valid_redirect_uri($redirectUri)) {
        return;
    }
    $pdo = db();
    $pdo->exec('BEGIN IMMEDIATE');
    $inTx = true;
    try {
        $stmt = $pdo->prepare(
            'INSERT INTO oauth_redirect_attempts (client_id, redirect_uri, seen_at, count)
             VALUES (:cid, :uri, :seen_at, 1)
             ON CONFLICT(client_id, redirect_uri) DO UPDATE SET seen_at = :seen_at2, count = count + 1'
        );
        $ts = now();
        $stmt->execute([
            ':cid' => $clientId,
            ':uri' => $redirectUri,
            ':seen_at' => $ts,
            ':seen_at2' => $ts,
        ]);
        $pdo->exec(
            'DELETE FROM oauth_redirect_attempts
             WHERE id NOT IN (SELECT id FROM oauth_redirect_attempts ORDER BY seen_at DESC, id DESC LIMIT 20)'
        );
        $pdo->exec('COMMIT');
        $inTx = false;
    } catch (Throwable $error) {
        if ($inTx) {
            try {
                $pdo->exec('ROLLBACK');
            } catch (Throwable $ignored) {
            }
        }
    }
}

function mcp_handle_oauth_authorize(): void {
    $start = microtime(true);
    if (!mcp_is_enabled()) {
        render_404_page();
    }
    header('X-Frame-Options: DENY');
    header("Content-Security-Policy: frame-ancestors 'none'");
    header('Cache-Control: no-store');
    header('Referrer-Policy: no-referrer');

    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if ($method !== 'GET' && $method !== 'POST') {
        http_response_code(405);
        header('Allow: GET, POST');
        exit;
    }

    $src = $method === 'POST' ? $_POST : $_GET;
    $clientId = trim((string)($src['client_id'] ?? ''));
    $redirectUri = trim((string)($src['redirect_uri'] ?? ''));
    $responseType = trim((string)($src['response_type'] ?? ''));
    $state = (string)($src['state'] ?? '');
    $scopeRaw = trim((string)($src['scope'] ?? ''));
    $codeChallenge = trim((string)($src['code_challenge'] ?? ''));
    $codeChallengeMethod = trim((string)($src['code_challenge_method'] ?? ''));
    $resource = trim((string)($src['resource'] ?? ''));

    if ($clientId === '' || $redirectUri === '') {
        mcp_debug_log($method, '/oauth/authorize', 400, (int)round((microtime(true) - $start) * 1000), null, null, 'missing_client_or_redirect');
        mcp_render_oauth_error_page('Authorization failed', 'Missing required client_id or redirect_uri parameter.');
    }

    $pdo = db();
    $stmt = $pdo->prepare('SELECT * FROM oauth_clients WHERE client_id = :cid AND revoked_at IS NULL LIMIT 1');
    $stmt->execute([':cid' => $clientId]);
    $client = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$client) {
        mcp_debug_log($method, '/oauth/authorize', 400, (int)round((microtime(true) - $start) * 1000), null, null, 'unknown_client');
        mcp_render_oauth_error_page('Authorization failed', 'Unknown or revoked OAuth client.');
    }

    $allowedUris = json_decode((string)$client['redirect_uris_json'], true);
    if (!is_array($allowedUris)) {
        $allowedUris = [];
    }
    if (!in_array($redirectUri, $allowedUris, true)) {
        mcp_record_redirect_attempt($clientId, $redirectUri);
        mcp_debug_log($method, '/oauth/authorize', 400, (int)round((microtime(true) - $start) * 1000), null, null, 'redirect_uri_not_allowed');
        mcp_render_oauth_error_page(
            'Unregistered redirect URI',
            'The redirect URI is not registered for this client. If you are connecting Gemini for the first time, enable Redirect URI Learning Mode in Site settings -> AI connection (MCP) and approve the captured URI.'
        );
    }

    $issuer = rtrim(base_url(), '/');
    $errorRedirect = static function (string $errorCode, string $desc) use ($redirectUri, $state, $issuer, $method, $start): never {
        $params = ['error' => $errorCode, 'error_description' => $desc, 'iss' => $issuer];
        if ($state !== '') {
            $params['state'] = $state;
        }
        mcp_debug_log($method, '/oauth/authorize', 302, (int)round((microtime(true) - $start) * 1000), null, null, $errorCode);
        mcp_redirect_with_params($redirectUri, $params);
    };

    if ($responseType !== 'code') {
        $errorRedirect('unsupported_response_type', 'Only response_type=code is supported.');
    }

    $normalizedScope = mcp_normalize_scope($scopeRaw);
    if ($normalizedScope === null) {
        $errorRedirect('invalid_scope', 'Only the notes:read scope is supported.');
    }

    if ($resource !== '' && !mcp_resource_matches($resource)) {
        $errorRedirect('invalid_target', 'Requested resource does not match this MCP server.');
    }

    $requirePkce = (int)$client['require_pkce'] === 1;
    if ($codeChallengeMethod !== '' && $codeChallengeMethod !== 'S256') {
        $errorRedirect('invalid_request', 'Only S256 code_challenge_method is supported.');
    }
    if ($codeChallenge !== '' && $codeChallengeMethod !== 'S256') {
        $errorRedirect('invalid_request', 'code_challenge_method=S256 is required when code_challenge is provided.');
    }
    if ($requirePkce && ($codeChallenge === '' || $codeChallengeMethod !== 'S256')) {
        $errorRedirect('invalid_request', 'PKCE with S256 is required for this client.');
    }
    if ($codeChallenge !== '' && (strlen($codeChallenge) < 43 || strlen($codeChallenge) > 128 || !preg_match('/^[A-Za-z0-9_-]+$/D', $codeChallenge))) {
        $errorRedirect('invalid_request', 'Invalid code_challenge format.');
    }

    $user = current_user();
    if (!$user) {
        if ($method === 'GET') {
            $qs = (string)($_SERVER['QUERY_STRING'] ?? '');
            $returnTo = '/oauth/authorize' . ($qs !== '' ? '?' . $qs : '');
            if (mcp_is_safe_oauth_return_to($returnTo)) {
                $_SESSION['oauth_return_to'] = $returnTo;
            }
        }
        redirect('/login');
    }
    if ((int)$user['must_change_password'] === 1) {
        redirect('/account');
    }

    if ($method === 'POST') {
        check_csrf();
        $decision = (string)($_POST['decision'] ?? 'deny');
        if ($decision !== 'allow') {
            $errorRedirect('access_denied', 'The administrator denied the authorization request.');
        }

        $rawCode = mcp_generate_credential('sn_ac_');
        $codeHash = mcp_hash_secret($rawCode);
        $familyId = bin2hex(random_bytes(16));
        $now = time();

        $insert = $pdo->prepare(
            'INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scope, resource, expires_at, used_at, family_id, created_at)
             VALUES (:code_hash, :client_id, :user_id, :redirect_uri, :code_challenge, :scope, :resource, :expires_at, NULL, :family_id, :created_at)'
        );
        $insert->execute([
            ':code_hash' => $codeHash,
            ':client_id' => $clientId,
            ':user_id' => (int)$user['id'],
            ':redirect_uri' => $redirectUri,
            ':code_challenge' => $codeChallenge !== '' ? $codeChallenge : null,
            ':scope' => $normalizedScope,
            ':resource' => $resource !== '' ? mcp_normalize_resource($resource) : mcp_expected_resource(),
            ':expires_at' => $now + 300,
            ':family_id' => $familyId,
            ':created_at' => now(),
        ]);

        $params = ['code' => $rawCode, 'iss' => $issuer];
        if ($state !== '') {
            $params['state'] = $state;
        }
        mcp_debug_log('POST', '/oauth/authorize', 302, (int)round((microtime(true) - $start) * 1000), null, null, 'code_issued');
        mcp_redirect_with_params($redirectUri, $params);
    }

    // Count currently accessible public shares for the consent screen.
    $countStmt = $pdo->prepare('SELECT COUNT(*) FROM shares WHERE ' . mcp_public_share_where());
    $countStmt->execute([':now' => time(), ':uid' => (int)$user['id']]);
    $publicShareCount = (int)$countStmt->fetchColumn();

    $hiddenFields = [
        'csrf' => csrf_token(),
        'client_id' => $clientId,
        'redirect_uri' => $redirectUri,
        'response_type' => $responseType,
        'scope' => $normalizedScope,
        'state' => $state,
        'code_challenge' => $codeChallenge,
        'code_challenge_method' => $codeChallengeMethod,
        'resource' => $resource,
    ];

    $clientNameHtml = htmlspecialchars((string)$client['name'], ENT_QUOTES, 'UTF-8');
    $redirectHost = htmlspecialchars((string)(parse_url($redirectUri, PHP_URL_HOST) ?? $redirectUri), ENT_QUOTES, 'UTF-8');

    $content = '<div class="auth-card">'
        . '<h1>Authorize AI connection</h1>'
        . '<p class="auth-description"><strong>' . $clientNameHtml . '</strong> is requesting <strong>read-only</strong> access to your <strong>' . $publicShareCount . '</strong> public shared notes.</p>'
        . '<p class="muted">Password-protected, expired, and deleted shares are never exposed. You can revoke access anytime in Site settings.</p>'
        . '<p class="muted">Callback host: <code>' . $redirectHost . '</code> · Scope: <code>notes:read</code></p>'
        . '<form method="post" action="' . base_path() . '/oauth/authorize" class="auth-form">'
        . render_hidden_inputs($hiddenFields)
        . '<button class="button primary w-full" type="submit" name="decision" value="allow">Allow read-only access</button>'
        . '<button class="button ghost w-full" type="submit" name="decision" value="deny">Deny</button>'
        . '</form>'
        . '</div>';

    mcp_debug_log('GET', '/oauth/authorize', 200, (int)round((microtime(true) - $start) * 1000), null, null, 'consent_rendered');
    render_page('Authorize AI connection', $content, null, '', ['layout' => 'auth']);
}

function mcp_authenticate_oauth_client(): ?array {
    $clientId = '';
    $clientSecret = '';

    $auth = (string)($_SERVER['HTTP_AUTHORIZATION'] ?? ($_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? ''));
    if (preg_match('/^\s*Basic\s+(\S+)\s*$/i', $auth, $matches)) {
        $decoded = base64_decode($matches[1], true);
        if ($decoded !== false && str_contains($decoded, ':')) {
            [$rawId, $rawSecret] = explode(':', $decoded, 2);
            // RFC 6749 Section 2.3.1: Basic auth credentials may be application/x-www-form-urlencoded.
            $clientId = urldecode($rawId);
            $clientSecret = urldecode($rawSecret);
        }
    }

    if ($clientId === '' && $clientSecret === '') {
        $clientId = (string)($_POST['client_id'] ?? '');
        $clientSecret = (string)($_POST['client_secret'] ?? '');
    }

    if ($clientId === '' || $clientSecret === '') {
        return null;
    }

    $pdo = db();
    $stmt = $pdo->prepare('SELECT * FROM oauth_clients WHERE client_id = :cid AND revoked_at IS NULL LIMIT 1');
    $stmt->execute([':cid' => $clientId]);
    $client = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$client) {
        return null;
    }

    $providedHash = mcp_hash_secret($clientSecret);
    if (!hash_equals((string)$client['secret_hash'], $providedHash)) {
        return null;
    }
    return $client;
}

function mcp_issue_token_pair(PDO $pdo, string $clientId, int $userId, string $scope, string $resource, string $familyId, int $now): array {
    $accessToken = mcp_generate_credential('sn_at_');
    $refreshToken = mcp_generate_credential('sn_rt_');
    $createdAt = now();

    $insert = $pdo->prepare(
        'INSERT INTO oauth_tokens (token_hash, kind, client_id, user_id, scope, resource, family_id, expires_at, rotated_at, revoked_at, created_at, last_used_at)
         VALUES (:token_hash, :kind, :client_id, :user_id, :scope, :resource, :family_id, :expires_at, NULL, NULL, :created_at, NULL)'
    );
    $insert->execute([
        ':token_hash' => mcp_hash_secret($accessToken),
        ':kind' => 'access',
        ':client_id' => $clientId,
        ':user_id' => $userId,
        ':scope' => $scope,
        ':resource' => $resource,
        ':family_id' => $familyId,
        ':expires_at' => $now + 3600,
        ':created_at' => $createdAt,
    ]);
    $insert->execute([
        ':token_hash' => mcp_hash_secret($refreshToken),
        ':kind' => 'refresh',
        ':client_id' => $clientId,
        ':user_id' => $userId,
        ':scope' => $scope,
        ':resource' => $resource,
        ':family_id' => $familyId,
        ':expires_at' => $now + 2592000,
        ':created_at' => $createdAt,
    ]);

    return [
        'access_token' => $accessToken,
        'token_type' => 'Bearer',
        'expires_in' => 3600,
        'refresh_token' => $refreshToken,
        'scope' => $scope,
    ];
}

function mcp_handle_oauth_token(): void {
    $start = microtime(true);
    if (!mcp_is_enabled()) {
        mcp_json_response(404, ['error' => 'not_found']);
    }
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if ($method !== 'POST') {
        mcp_json_response(405, ['error' => 'method_not_allowed'], ['Allow: POST']);
    }

    $ipBucket = 'oauth_token:ip:' . trusted_client_ip_hash();
    $rl = mcp_rate_limit_check($ipBucket, 60, 60);
    if (!$rl['allowed']) {
        mcp_debug_log('POST', '/oauth/token', 429, (int)round((microtime(true) - $start) * 1000), null, null, 'rate_limited');
        mcp_json_response(429, ['error' => 'temporarily_unavailable', 'error_description' => 'Too many token requests.'], ['Retry-After: ' . $rl['retry_after']]);
    }

    $client = mcp_authenticate_oauth_client();
    if (!$client) {
        mcp_debug_log('POST', '/oauth/token', 401, (int)round((microtime(true) - $start) * 1000), null, null, 'invalid_client');
        mcp_json_response(
            401,
            ['error' => 'invalid_client', 'error_description' => 'Client authentication failed.'],
            ['WWW-Authenticate: Basic realm="oauth"']
        );
    }

    $grantType = trim((string)($_POST['grant_type'] ?? ''));
    $pdo = db();
    $now = time();

    if ($grantType === 'authorization_code') {
        $code = trim((string)($_POST['code'] ?? ''));
        $redirectUri = trim((string)($_POST['redirect_uri'] ?? ''));
        $codeVerifier = trim((string)($_POST['code_verifier'] ?? ''));
        $resource = trim((string)($_POST['resource'] ?? ''));

        if ($code === '' || $redirectUri === '') {
            mcp_debug_log('POST', '/oauth/token', 400, (int)round((microtime(true) - $start) * 1000), null, null, 'missing_code_or_redirect');
            mcp_json_response(400, ['error' => 'invalid_request', 'error_description' => 'Missing code or redirect_uri.']);
        }
        if ($resource !== '' && !mcp_resource_matches($resource)) {
            mcp_debug_log('POST', '/oauth/token', 400, (int)round((microtime(true) - $start) * 1000), null, null, 'invalid_target');
            mcp_json_response(400, ['error' => 'invalid_target', 'error_description' => 'Resource mismatch.']);
        }

        $codeHash = mcp_hash_secret($code);
        $pdo->exec('BEGIN IMMEDIATE');
        $inTx = true;
        try {
            $stmt = $pdo->prepare('SELECT * FROM oauth_codes WHERE code_hash = :hash LIMIT 1');
            $stmt->execute([':hash' => $codeHash]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);

            if (!$row) {
                $pdo->exec('COMMIT');
                $inTx = false;
                mcp_debug_log('POST', '/oauth/token', 400, (int)round((microtime(true) - $start) * 1000), null, null, 'code_not_found');
                mcp_json_response(400, ['error' => 'invalid_grant', 'error_description' => 'Invalid authorization code.']);
            }

            if ($row['used_at'] !== null) {
                // Authorization code replay detected: revoke the entire token family.
                $pdo->prepare('UPDATE oauth_tokens SET revoked_at = :now WHERE family_id = :fid AND revoked_at IS NULL')
                    ->execute([':now' => $now, ':fid' => (string)$row['family_id']]);
                $pdo->exec('COMMIT');
                $inTx = false;
                mcp_debug_log('POST', '/oauth/token', 400, (int)round((microtime(true) - $start) * 1000), null, null, 'code_replay_revoked');
                mcp_json_response(400, ['error' => 'invalid_grant', 'error_description' => 'Authorization code already used.']);
            }

            if (
                (string)$row['client_id'] !== (string)$client['client_id']
                || (string)$row['redirect_uri'] !== $redirectUri
                || (int)$row['expires_at'] <= $now
            ) {
                $pdo->exec('COMMIT');
                $inTx = false;
                mcp_debug_log('POST', '/oauth/token', 400, (int)round((microtime(true) - $start) * 1000), null, null, 'code_mismatch_or_expired');
                mcp_json_response(400, ['error' => 'invalid_grant', 'error_description' => 'Authorization code expired or does not match client/redirect_uri.']);
            }

            if ($row['code_challenge'] !== null && (string)$row['code_challenge'] !== '') {
                if (strlen($codeVerifier) < 43 || strlen($codeVerifier) > 128 || !preg_match('/^[A-Za-z0-9._~-]+$/D', $codeVerifier)) {
                    $pdo->exec('COMMIT');
                    $inTx = false;
                    mcp_debug_log('POST', '/oauth/token', 400, (int)round((microtime(true) - $start) * 1000), null, null, 'invalid_pkce_verifier');
                    mcp_json_response(400, ['error' => 'invalid_grant', 'error_description' => 'Invalid PKCE code_verifier.']);
                }
                $expectedChallenge = mcp_base64url(hash('sha256', $codeVerifier, true));
                if (!hash_equals((string)$row['code_challenge'], $expectedChallenge)) {
                    $pdo->exec('COMMIT');
                    $inTx = false;
                    mcp_debug_log('POST', '/oauth/token', 400, (int)round((microtime(true) - $start) * 1000), null, null, 'pkce_mismatch');
                    mcp_json_response(400, ['error' => 'invalid_grant', 'error_description' => 'PKCE verification failed.']);
                }
            }

            $pdo->prepare('UPDATE oauth_codes SET used_at = :now WHERE code_hash = :hash')
                ->execute([':now' => $now, ':hash' => $codeHash]);

            $boundResource = $row['resource'] !== null && (string)$row['resource'] !== ''
                ? (string)$row['resource']
                : mcp_expected_resource();
            $tokenPayload = mcp_issue_token_pair(
                $pdo,
                (string)$client['client_id'],
                (int)$row['user_id'],
                (string)$row['scope'],
                $boundResource,
                (string)$row['family_id'],
                $now
            );
            $pdo->prepare('UPDATE oauth_clients SET last_used_at = :ts WHERE id = :id')
                ->execute([':ts' => now(), ':id' => (int)$client['id']]);
            $pdo->exec('COMMIT');
            $inTx = false;

            mcp_debug_log('POST', '/oauth/token', 200, (int)round((microtime(true) - $start) * 1000), null, null, 'authorization_code_ok');
            mcp_json_response(200, $tokenPayload);
        } catch (Throwable $error) {
            if ($inTx) {
                try {
                    $pdo->exec('ROLLBACK');
                } catch (Throwable $ignored) {
                }
            }
            throw $error;
        }
    }

    if ($grantType === 'refresh_token') {
        $refreshRaw = trim((string)($_POST['refresh_token'] ?? ''));
        $scopeReq = trim((string)($_POST['scope'] ?? ''));
        $resource = trim((string)($_POST['resource'] ?? ''));

        if ($refreshRaw === '') {
            mcp_json_response(400, ['error' => 'invalid_request', 'error_description' => 'Missing refresh_token.']);
        }
        if ($scopeReq !== '' && mcp_normalize_scope($scopeReq) === null) {
            mcp_json_response(400, ['error' => 'invalid_scope', 'error_description' => 'Invalid scope.']);
        }
        if ($resource !== '' && !mcp_resource_matches($resource)) {
            mcp_json_response(400, ['error' => 'invalid_target', 'error_description' => 'Resource mismatch.']);
        }

        $refreshHash = mcp_hash_secret($refreshRaw);
        $pdo->exec('BEGIN IMMEDIATE');
        $inTx = true;
        try {
            $stmt = $pdo->prepare('SELECT * FROM oauth_tokens WHERE token_hash = :hash AND kind = "refresh" LIMIT 1');
            $stmt->execute([':hash' => $refreshHash]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);

            if (
                !$row
                || (string)$row['client_id'] !== (string)$client['client_id']
                || $row['revoked_at'] !== null
                || (int)$row['expires_at'] <= $now
            ) {
                $pdo->exec('COMMIT');
                $inTx = false;
                mcp_debug_log('POST', '/oauth/token', 400, (int)round((microtime(true) - $start) * 1000), null, null, 'refresh_invalid');
                mcp_json_response(400, ['error' => 'invalid_grant', 'error_description' => 'Invalid or expired refresh token.']);
            }

            if ($row['rotated_at'] !== null) {
                $elapsed = $now - (int)$row['rotated_at'];
                if ($elapsed <= 30) {
                    // 30-second grace window for concurrent cloud refreshes: reject without revoking family.
                    $pdo->exec('COMMIT');
                    $inTx = false;
                    mcp_debug_log('POST', '/oauth/token', 400, (int)round((microtime(true) - $start) * 1000), null, null, 'refresh_grace_reject');
                    mcp_json_response(400, ['error' => 'invalid_grant', 'error_description' => 'Refresh token was already rotated.']);
                }
                // Replay outside grace window: revoke the entire family.
                $pdo->prepare('UPDATE oauth_tokens SET revoked_at = :now WHERE family_id = :fid AND revoked_at IS NULL')
                    ->execute([':now' => $now, ':fid' => (string)$row['family_id']]);
                $pdo->exec('COMMIT');
                $inTx = false;
                mcp_debug_log('POST', '/oauth/token', 400, (int)round((microtime(true) - $start) * 1000), null, null, 'refresh_replay_revoked');
                mcp_json_response(400, ['error' => 'invalid_grant', 'error_description' => 'Refresh token reuse detected.']);
            }

            $pdo->prepare('UPDATE oauth_tokens SET rotated_at = :now, last_used_at = :now2 WHERE id = :id')
                ->execute([':now' => $now, ':now2' => $now, ':id' => (int)$row['id']]);

            $boundResource = $row['resource'] !== null && (string)$row['resource'] !== ''
                ? (string)$row['resource']
                : mcp_expected_resource();
            $tokenPayload = mcp_issue_token_pair(
                $pdo,
                (string)$client['client_id'],
                (int)$row['user_id'],
                (string)$row['scope'],
                $boundResource,
                (string)$row['family_id'],
                $now
            );
            $pdo->prepare('UPDATE oauth_clients SET last_used_at = :ts WHERE id = :id')
                ->execute([':ts' => now(), ':id' => (int)$client['id']]);
            $pdo->exec('COMMIT');
            $inTx = false;

            mcp_debug_log('POST', '/oauth/token', 200, (int)round((microtime(true) - $start) * 1000), null, null, 'refresh_token_ok');
            mcp_json_response(200, $tokenPayload);
        } catch (Throwable $error) {
            if ($inTx) {
                try {
                    $pdo->exec('ROLLBACK');
                } catch (Throwable $ignored) {
                }
            }
            throw $error;
        }
    }

    mcp_debug_log('POST', '/oauth/token', 400, (int)round((microtime(true) - $start) * 1000), null, null, 'unsupported_grant_type');
    mcp_json_response(400, ['error' => 'unsupported_grant_type', 'error_description' => 'Unsupported grant_type.']);
}

function mcp_handle_oauth_revoke(): void {
    $start = microtime(true);
    if (!mcp_is_enabled()) {
        mcp_json_response(404, ['error' => 'not_found']);
    }
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if ($method !== 'POST') {
        mcp_json_response(405, ['error' => 'method_not_allowed'], ['Allow: POST']);
    }

    $client = mcp_authenticate_oauth_client();
    if (!$client) {
        mcp_json_response(
            401,
            ['error' => 'invalid_client', 'error_description' => 'Client authentication failed.'],
            ['WWW-Authenticate: Basic realm="oauth"']
        );
    }

    $rawToken = trim((string)($_POST['token'] ?? ''));
    if ($rawToken !== '') {
        $tokenHash = mcp_hash_secret($rawToken);
        $pdo = db();
        $stmt = $pdo->prepare('SELECT id, kind, family_id FROM oauth_tokens WHERE token_hash = :hash AND client_id = :cid LIMIT 1');
        $stmt->execute([':hash' => $tokenHash, ':cid' => (string)$client['client_id']]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if ($row) {
            $now = time();
            if ((string)$row['kind'] === 'refresh') {
                $pdo->prepare('UPDATE oauth_tokens SET revoked_at = :now WHERE family_id = :fid AND revoked_at IS NULL')
                    ->execute([':now' => $now, ':fid' => (string)$row['family_id']]);
            } else {
                $pdo->prepare('UPDATE oauth_tokens SET revoked_at = :now WHERE id = :id AND revoked_at IS NULL')
                    ->execute([':now' => $now, ':id' => (int)$row['id']]);
            }
        }
    }

    mcp_debug_log('POST', '/oauth/revoke', 200, (int)round((microtime(true) - $start) * 1000));
    mcp_json_response(200, ['revoked' => true]);
}

function mcp_format_compact_number(int $n): string {
    if ($n < 1000) {
        return (string)$n;
    }
    if ($n < 1000000) {
        return rtrim(rtrim(number_format($n / 1000, 1, '.', ''), '0'), '.') . 'k';
    }
    return rtrim(rtrim(number_format($n / 1000000, 2, '.', ''), '0'), '.') . 'M';
}

function mcp_status_code_info(int $status, ?string $note, string $method, int $durationMs = 0): array {
    $noteStr = trim((string)$note);
    $isRpcError = str_starts_with($noteStr, 'rpc_error') || $noteStr === 'tool_error';

    if ($status === 200) {
        if ($isRpcError) {
            return [
                'tone' => 'warn',
                'level' => 'warn',
                'title' => '200 OK · RPC / Tool Error',
                'meaning' => 'HTTP 200 OK (JSON-RPC Error) — The HTTP transport succeeded, but the JSON-RPC call returned an application or tool error (' . $noteStr . ').',
            ];
        }
        if ($durationMs >= 1000) {
            return [
                'tone' => 'warn',
                'level' => 'warn',
                'title' => '200 OK · Slow Request',
                'meaning' => 'HTTP 200 OK — Request succeeded, but execution took ' . $durationMs . ' ms (>= 1000 ms warning threshold).',
            ];
        }
        return [
            'tone' => 'ok',
            'level' => 'info',
            'title' => '200 OK',
            'meaning' => 'HTTP 200 OK — Request succeeded and returned a valid JSON-RPC or OAuth response.',
        ];
    }

    if ($status === 202) {
        return [
            'tone' => 'info',
            'level' => 'info',
            'title' => '202 Accepted',
            'meaning' => 'HTTP 202 Accepted — JSON-RPC notification (such as notifications/initialized) received. Per MCP specification, notifications return 202 with an empty body. This is normal.',
        ];
    }

    if ($status === 302) {
        $isNormalRedirect = ($noteStr === '' || $noteStr === 'code_issued');
        return [
            'tone' => $isNormalRedirect ? 'info' : 'warn',
            'level' => $isNormalRedirect ? 'info' : 'warn',
            'title' => $isNormalRedirect ? '302 Redirect' : '302 OAuth Error Redirect',
            'meaning' => $isNormalRedirect
                ? 'HTTP 302 Found — Normal OAuth 2.1 authorization redirect (to sign-in or back to the client callback URI with an authorization code).'
                : 'HTTP 302 Found (OAuth Error) — Redirected back to the client callback URI with an OAuth error (' . $noteStr . ').',
        ];
    }

    if ($status === 400) {
        return [
            'tone' => 'error',
            'level' => 'error',
            'title' => '400 Bad Request',
            'meaning' => 'HTTP 400 Bad Request — Invalid JSON, missing required OAuth/MCP parameter, PKCE mismatch, expired authorization code, or unregistered redirect URI.',
        ];
    }

    if ($status === 401) {
        return [
            'tone' => 'warn',
            'level' => 'warn',
            'title' => '401 Unauthorized',
            'meaning' => 'HTTP 401 Unauthorized — Missing, expired, or revoked Bearer token (or invalid OAuth client credentials). MCP clients use this 401 challenge to discover OAuth metadata or refresh tokens.',
        ];
    }

    if ($status === 403) {
        return [
            'tone' => 'error',
            'level' => 'error',
            'title' => '403 Forbidden',
            'meaning' => 'HTTP 403 Forbidden — Cross-origin request rejected because the HTTP Origin header did not match this site.',
        ];
    }

    if ($status === 404) {
        return [
            'tone' => 'warn',
            'level' => 'warn',
            'title' => '404 Not Found',
            'meaning' => 'HTTP 404 Not Found — Requested endpoint does not exist or MCP server is disabled.',
        ];
    }

    if ($status === 405) {
        return [
            'tone' => 'warn',
            'level' => 'warn',
            'title' => '405 Method Not Allowed',
            'meaning' => 'HTTP 405 Method Not Allowed — Client sent a ' . $method . ' request to a POST-only endpoint. Note: MCP clients (like Gemini) routinely probe GET /mcp for optional SSE streams; returning 405 is standard per the MCP Streamable HTTP spec and is not a failure.',
        ];
    }

    if ($status === 413) {
        return [
            'tone' => 'error',
            'level' => 'error',
            'title' => '413 Payload Too Large',
            'meaning' => 'HTTP 413 Payload Too Large — Request body exceeded the 1 MiB safety limit.',
        ];
    }

    if ($status === 429) {
        return [
            'tone' => 'error',
            'level' => 'error',
            'title' => '429 Too Many Requests',
            'meaning' => 'HTTP 429 Too Many Requests — Rate limit exceeded (120 req/min per token or 300 req/min per IP). Client must wait for Retry-After.',
        ];
    }

    $isErr = $status >= 400;
    return [
        'tone' => $isErr ? 'error' : 'info',
        'level' => $isErr ? 'error' : 'info',
        'title' => 'HTTP ' . $status,
        'meaning' => 'HTTP ' . $status . ' — Server response status code.',
    ];
}

function mcp_render_rpc_cell(string $rpc): string {
    if ($rpc === '') {
        return '<span class="mcp-cell-empty">—</span>';
    }
    $escapedFull = htmlspecialchars($rpc, ENT_QUOTES, 'UTF-8');
    if (str_contains($rpc, ':')) {
        [$prefix, $name] = explode(':', $rpc, 2);
        return '<code class="mcp-rpc-badge is-tool" title="' . $escapedFull . '">'
            . '<span class="mcp-rpc-prefix">' . htmlspecialchars($prefix, ENT_QUOTES, 'UTF-8') . ':</span>'
            . '<strong>' . htmlspecialchars($name, ENT_QUOTES, 'UTF-8') . '</strong>'
            . '</code>';
    }
    return '<code class="mcp-rpc-badge" title="' . $escapedFull . '">' . $escapedFull . '</code>';
}

function render_mcp_admin_section(): string {
    $pdo = db();
    $base = base_path();
    $mcpEnabled = get_bool_setting('mcp_enabled', false);
    $learningMode = get_bool_setting('mcp_learning_mode', false);
    $debugLogsEnabled = get_bool_setting('mcp_debug_logs_enabled', false);

    $mcpUrl = rtrim(base_url(), '/') . '/mcp';
    $urlParts = parse_url($mcpUrl);
    $scheme = strtolower((string)($urlParts['scheme'] ?? ''));
    $host = strtolower((string)($urlParts['host'] ?? ''));
    $isLocal = in_array($host, ['localhost', '127.0.0.1', '[::1]'], true);

    $plainCred = $_SESSION['mcp_client_secret_plain'] ?? null;
    unset($_SESSION['mcp_client_secret_plain']);

    $openAttr = ($plainCred !== null || $mcpEnabled) ? ' open' : '';
    $html = '<details class="plugin-connection card" id="mcp-connection"' . $openAttr . '><summary>AI connection (MCP)</summary>';
    $html .= '<p class="muted">Expose a read-only Model Context Protocol (MCP) endpoint over OAuth 2.1 for Gemini custom apps. Only public, non-expired, non-password-protected shares are accessible.</p>';

    if ($scheme !== 'https' && !$isLocal) {
        $html .= '<p class="flash error" role="alert">Gemini requires an HTTPS MCP URL. Configure your public HTTPS Website URL in Site settings above.</p>';
    }

    if (is_array($plainCred) && !empty($plainCred['client_id']) && !empty($plainCred['client_secret'])) {
        $html .= '<div class="flash" role="status" data-notice-persistent>';
        $html .= '<div><strong>Client credentials created for ' . htmlspecialchars((string)($plainCred['name'] ?? 'Client'), ENT_QUOTES, 'UTF-8') . '</strong> — copy the Client Secret now; it is shown only once.<br>';
        $html .= 'Client ID: <code class="connection-key">' . htmlspecialchars((string)$plainCred['client_id'], ENT_QUOTES, 'UTF-8') . '</code><br>';
        $html .= 'Client Secret: <code class="connection-key">' . htmlspecialchars((string)$plainCred['client_secret'], ENT_QUOTES, 'UTF-8') . '</code></div>';
        $html .= '</div>';
    }

    $html .= '<label class="field-label" for="mcp-endpoint-url">MCP Server URL</label>';
    $html .= '<div class="mcp-endpoint-row">';
    $html .= '<input class="input" id="mcp-endpoint-url" type="text" readonly value="' . htmlspecialchars($mcpUrl, ENT_QUOTES, 'UTF-8') . '">';
    $html .= '<button class="button" type="button" onclick="navigator.clipboard&&navigator.clipboard.writeText(document.getElementById(\'mcp-endpoint-url\').value)">Copy</button>';
    $html .= '</div>';

    // Settings form
    $html .= '<form class="settings-form" method="post" action="' . $base . '/admin/mcp/settings">'
        . render_hidden_inputs(['csrf' => csrf_token()])
        . '<label class="choice-row"><input type="checkbox" name="mcp_enabled" value="1"' . ($mcpEnabled ? ' checked' : '') . '> Enable read-only MCP server</label>'
        . '<label class="choice-row"><input type="checkbox" name="mcp_learning_mode" value="1"' . ($learningMode ? ' checked' : '') . '> Enable redirect URI learning mode <span class="muted">(enable only during initial Gemini setup, then turn off)</span></label>'
        . '<label class="choice-row"><input type="checkbox" name="mcp_debug_logs_enabled" value="1"' . ($debugLogsEnabled ? ' checked' : '') . '> Enable debug logs <span class="muted">(metadata only; never logs tokens or note content)</span></label>'
        . '<button class="button primary" type="submit">Save MCP settings</button>'
        . '</form>';

    // Create new OAuth client
    $html .= '<section class="settings-group"><h3>OAuth clients</h3>';
    $html .= '<form class="mcp-client-create-form" method="post" action="' . $base . '/admin/mcp/client-create">'
        . render_hidden_inputs(['csrf' => csrf_token()])
        . '<label>Client name<input class="input" name="name" value="Gemini" maxlength="64" required></label>'
        . '<button class="button" type="submit">Create OAuth client</button>'
        . '</form>';

    $clients = $pdo->query('SELECT * FROM oauth_clients WHERE revoked_at IS NULL ORDER BY id DESC')->fetchAll(PDO::FETCH_ASSOC);
    $now = time();
    foreach ($clients as $client) {
        $cid = (string)$client['client_id'];
        $tokStmt = $pdo->prepare('SELECT COUNT(*) FROM oauth_tokens WHERE client_id = :cid AND revoked_at IS NULL AND expires_at > :now');
        $tokStmt->execute([':cid' => $cid, ':now' => $now]);
        $activeTokens = (int)$tokStmt->fetchColumn();

        $uris = json_decode((string)$client['redirect_uris_json'], true);
        if (!is_array($uris)) {
            $uris = [];
        }
        $urisText = implode("\n", $uris);
        $lastUsed = !empty($client['last_used_at']) ? htmlspecialchars((string)$client['last_used_at'], ENT_QUOTES, 'UTF-8') : 'Never';

        $html .= '<div class="card mcp-subcard">';
        $html .= '<div class="mcp-client-header"><strong>' . htmlspecialchars((string)$client['name'], ENT_QUOTES, 'UTF-8') . '</strong> · <code class="mcp-client-id">' . htmlspecialchars($cid, ENT_QUOTES, 'UTF-8') . '</code></div>';
        $html .= '<p class="muted">Active tokens: ' . $activeTokens . ' · Last used: ' . $lastUsed . '</p>';

        $html .= '<form class="settings-form" method="post" action="' . $base . '/admin/mcp/client-update">'
            . render_hidden_inputs(['csrf' => csrf_token(), 'client_id' => $cid])
            . '<label>Allowed Redirect URIs (one per line, https:// or localhost)<textarea class="input code-input" name="redirect_uris" rows="3">' . htmlspecialchars($urisText, ENT_QUOTES, 'UTF-8') . '</textarea></label>'
            . '<label class="choice-row"><input type="checkbox" name="require_pkce" value="1"' . ((int)$client['require_pkce'] === 1 ? ' checked' : '') . '> Require PKCE (S256)</label>'
            . '<button class="button" type="submit">Save client</button>'
            . '</form>';

        $html .= '<div class="table-actions mcp-client-actions">';
        $html .= '<form class="inline-form" method="post" action="' . $base . '/admin/mcp/client-rotate-secret" data-confirm-message="Rotate the Client Secret? Existing credentials will stop authenticating new token requests.">'
            . render_hidden_inputs(['csrf' => csrf_token(), 'client_id' => $cid])
            . '<button class="button" type="submit">Rotate secret</button></form>';
        $html .= '<form class="inline-form" method="post" action="' . $base . '/admin/mcp/client-revoke-tokens" data-confirm-message="Revoke all active tokens for this client?">'
            . render_hidden_inputs(['csrf' => csrf_token(), 'client_id' => $cid])
            . '<button class="button" type="submit">Revoke all tokens</button></form>';
        $html .= '<form class="inline-form" method="post" action="' . $base . '/admin/mcp/client-delete" data-confirm-message="Revoke and delete this OAuth client and all its tokens?">'
            . render_hidden_inputs(['csrf' => csrf_token(), 'client_id' => $cid])
            . '<button class="button danger" type="submit">Revoke client</button></form>';
        $html .= '</div></div>';
    }
    if (empty($clients)) {
        $html .= '<p class="muted">No active OAuth clients yet.</p>';
    }
    $html .= '</section>';

    // Captured Redirect URIs (Learning Mode)
    $attempts = $pdo->query(
        'SELECT a.id, a.client_id, a.redirect_uri, a.seen_at, a.count, c.name AS client_name
         FROM oauth_redirect_attempts a
         INNER JOIN oauth_clients c ON c.client_id = a.client_id AND c.revoked_at IS NULL
         ORDER BY a.seen_at DESC, a.id DESC
         LIMIT 20'
    )->fetchAll(PDO::FETCH_ASSOC);
    if (!empty($attempts)) {
        $html .= '<section class="settings-group"><h3>Captured redirect URIs</h3>';
        $html .= '<p class="muted">Verify the highlighted host carefully before approving.</p>';
        foreach ($attempts as $att) {
            $uri = (string)$att['redirect_uri'];
            $parts = parse_url($uri);
            $hostPart = (string)($parts['host'] ?? '');
            $escapedUri = htmlspecialchars($uri, ENT_QUOTES, 'UTF-8');
            if ($hostPart !== '') {
                $escapedHost = htmlspecialchars($hostPart, ENT_QUOTES, 'UTF-8');
                $pos = strpos($escapedUri, $escapedHost);
                if ($pos !== false) {
                    $escapedUri = substr($escapedUri, 0, $pos)
                        . '<mark><strong>' . $escapedHost . '</strong></mark>'
                        . substr($escapedUri, $pos + strlen($escapedHost));
                }
            }
            $html .= '<div class="card mcp-captured-row">'
                . '<div class="mcp-captured-uri"><code>' . $escapedUri . '</code><br><small class="muted">Client: ' . htmlspecialchars((string)$att['client_name'], ENT_QUOTES, 'UTF-8')
                . ' · Seen ' . (int)$att['count'] . 'x · Last: ' . htmlspecialchars((string)$att['seen_at'], ENT_QUOTES, 'UTF-8') . '</small></div>'
                . '<form class="inline-form" method="post" action="' . $base . '/admin/mcp/redirect-allow">'
                . render_hidden_inputs(['csrf' => csrf_token(), 'attempt_id' => (int)$att['id']])
                . '<button class="button primary" type="submit">Allow for ' . htmlspecialchars((string)$att['client_name'], ENT_QUOTES, 'UTF-8') . '</button>'
                . '</form></div>';
        }
        $html .= '</section>';
    }

    // Usage & Token Statistics section
    $statsRows = $pdo->query('SELECT * FROM mcp_usage_stats ORDER BY call_count DESC, metric_key ASC')->fetchAll(PDO::FETCH_ASSOC);
    if ($mcpEnabled || !empty($statsRows)) {
        $totalCalls = 0;
        $toolCalls = 0;
        $totalErrors = 0;
        $totalDurMs = 0;
        $peakDurMs = 0;
        $totalChars = 0;
        $totalTokens = 0;
        foreach ($statsRows as $sr) {
            $c = (int)$sr['call_count'];
            $e = (int)$sr['error_count'];
            $d = (int)$sr['total_duration_ms'];
            $m = (int)$sr['max_duration_ms'];
            $ch = (int)$sr['total_chars'];
            $tk = (int)$sr['total_tokens'];
            $totalCalls += $c;
            if (str_starts_with((string)$sr['metric_key'], 'tools/call:')) {
                $toolCalls += $c;
            }
            $totalErrors += $e;
            $totalDurMs += $d;
            if ($m > $peakDurMs) {
                $peakDurMs = $m;
            }
            $totalChars += $ch;
            $totalTokens += $tk;
        }
        $avgDurMs = $totalCalls > 0 ? (int)round($totalDurMs / $totalCalls) : 0;
        $successRate = $totalCalls > 0 ? number_format(max(0, ($totalCalls - $totalErrors) / $totalCalls * 100), 1) . '%' : '—';

        $html .= '<section class="settings-group" id="mcp-usage-stats">';
        $html .= '<div class="mcp-section-bar"><div><h3>MCP usage statistics</h3><p class="muted">Cumulative function calls, estimated context tokens and response latency.</p></div>';
        if (!empty($statsRows)) {
            $html .= '<form class="inline-form" method="post" action="' . $base . '/admin/mcp/stats-reset" data-confirm-message="Reset all accumulated MCP usage and token statistics?">'
                . render_hidden_inputs(['csrf' => csrf_token()])
                . '<button class="button" type="submit">Reset stats</button></form>';
        }
        $html .= '</div>';

        $html .= '<dl class="image-compression-stats mcp-stats-cards">'
            . '<div><dt>Total RPC calls</dt><dd>' . number_format($totalCalls) . '</dd><small class="mcp-stat-sub">' . number_format($toolCalls) . ' tool calls</small></div>'
            . '<div><dt>Estimated tokens</dt><dd title="' . number_format($totalTokens) . ' tokens">' . ($totalTokens > 0 ? '~' . mcp_format_compact_number($totalTokens) : '0') . '</dd><small class="mcp-stat-sub">' . mcp_format_compact_number($totalChars) . ' UTF-8 chars</small></div>'
            . '<div><dt>Avg latency</dt><dd>' . $avgDurMs . ' ms</dd><small class="mcp-stat-sub">peak ' . $peakDurMs . ' ms</small></div>'
            . '<div><dt>Success rate</dt><dd>' . $successRate . '</dd><small class="mcp-stat-sub">' . number_format($totalErrors) . ' errors</small></div>'
            . '</dl>';

        if (!empty($statsRows)) {
            $html .= '<div class="table-scroll mcp-table-box"><table class="table mcp-stats-table"><thead><tr>'
                . '<th>Function / Tool</th>'
                . '<th class="num">Calls</th>'
                . '<th class="num">Errors</th>'
                . '<th class="num">Est. Tokens</th>'
                . '<th class="num">Avg / Peak ms</th>'
                . '<th>Last called</th>'
                . '</tr></thead><tbody>';
            foreach ($statsRows as $sr) {
                $key = (string)$sr['metric_key'];
                $calls = (int)$sr['call_count'];
                $errs = (int)$sr['error_count'];
                $durSum = (int)$sr['total_duration_ms'];
                $durMax = (int)$sr['max_duration_ms'];
                $charsSum = (int)$sr['total_chars'];
                $tokSum = (int)$sr['total_tokens'];
                $avgMs = $calls > 0 ? (int)round($durSum / $calls) : 0;
                $avgTok = $calls > 0 && $tokSum > 0 ? (int)round($tokSum / $calls) : 0;
                $sharePct = $totalCalls > 0 ? (int)round($calls / $totalCalls * 100) : 0;

                $tokCell = $tokSum > 0
                    ? '<strong>~' . mcp_format_compact_number($tokSum) . '</strong> <span class="mcp-cell-sub">· ' . mcp_format_compact_number($avgTok) . '/call</span>'
                    : '<span class="mcp-cell-empty">—</span>';
                $errCell = $errs > 0
                    ? '<span class="mcp-err-pill">' . number_format($errs) . '</span>'
                    : '<span class="mcp-cell-empty">0</span>';

                $html .= '<tr>'
                    . '<td>' . mcp_render_rpc_cell($key) . '</td>'
                    . '<td class="num"><strong>' . number_format($calls) . '</strong> <span class="mcp-cell-sub">(' . $sharePct . '%)</span></td>'
                    . '<td class="num">' . $errCell . '</td>'
                    . '<td class="num" title="' . number_format($tokSum) . ' tokens (' . number_format($charsSum) . ' chars)">' . $tokCell . '</td>'
                    . '<td class="num"><strong>' . $avgMs . ' ms</strong> <span class="mcp-cell-sub">/ ' . $durMax . ' ms</span></td>'
                    . '<td class="mcp-col-time">' . htmlspecialchars((string)$sr['last_called_at'], ENT_QUOTES, 'UTF-8') . '</td>'
                    . '</tr>';
            }
            $html .= '</tbody></table></div>';
        } else {
            $html .= '<p class="muted">No MCP calls recorded yet.</p>';
        }
        $html .= '</section>';
    }

    // Debug logs table
    $logs = $pdo->query('SELECT * FROM mcp_debug_logs ORDER BY id DESC LIMIT 200')->fetchAll(PDO::FETCH_ASSOC);
    if ($debugLogsEnabled || !empty($logs)) {
        $totalLogs = count($logs);
        $warnLogs = 0;
        $toolLogs = 0;
        $preparedLogs = [];
        foreach ($logs as $log) {
            $statusCode = (int)$log['status_code'];
            $durMs = (int)$log['duration_ms'];
            $noteRaw = (string)($log['note'] ?? '');
            $methodRaw = (string)$log['method'];
            $rpcRaw = (string)($log['rpc_method'] ?? '');
            $sInfo = mcp_status_code_info($statusCode, $noteRaw, $methodRaw, $durMs);
            $level = $sInfo['level'];
            if ($level !== 'info') {
                $warnLogs++;
            }
            $isTool = str_starts_with($rpcRaw, 'tools/call') || str_starts_with($rpcRaw, 'batch:tools/call');
            if ($isTool) {
                $toolLogs++;
            }
            $preparedLogs[] = [
                'row' => $log,
                'status_info' => $sInfo,
                'level' => $level,
                'is_tool' => $isTool,
            ];
        }

        $html .= '<section class="settings-group mcp-logs-panel" id="mcp-debug-logs" data-mcp-filter="warnings" data-warn-count="' . $warnLogs . '" data-tool-count="' . $toolLogs . '" data-total-count="' . $totalLogs . '">';
        $html .= '<div class="mcp-section-bar"><div><h3>MCP debug logs</h3><p class="muted">Showing latest ' . $totalLogs . ' requests (max 200). Click any row or status badge <strong>!</strong> for details.</p></div>';
        if (!empty($logs)) {
            $html .= '<div class="mcp-log-controls">'
                . '<div class="mcp-filter-group" role="group" aria-label="Filter debug logs">'
                . '<button type="button" class="mcp-filter-pill is-active" data-mcp-filter-btn="warnings" aria-pressed="true">Warnings+ <span class="mcp-filter-count">' . $warnLogs . '</span></button>'
                . '<button type="button" class="mcp-filter-pill" data-mcp-filter-btn="tools" aria-pressed="false">Tool calls <span class="mcp-filter-count">' . $toolLogs . '</span></button>'
                . '<button type="button" class="mcp-filter-pill" data-mcp-filter-btn="all" aria-pressed="false">All <span class="mcp-filter-count">' . $totalLogs . '</span></button>'
                . '</div>'
                . '<form class="inline-form" method="post" action="' . $base . '/admin/mcp/logs-clear">'
                . render_hidden_inputs(['csrf' => csrf_token()])
                . '<button class="button" type="submit">Clear logs</button></form>'
                . '</div>';
        }
        $html .= '</div>';

        if (!empty($preparedLogs)) {
            $html .= '<div class="table-scroll mcp-table-box mcp-log-scroll"><table class="table mcp-log-table"><thead><tr>'
                . '<th>Time</th><th>Req</th><th>RPC</th><th>Proto</th><th>Status</th><th class="num">Tokens</th><th class="num">ms</th><th>Note</th><th>UA</th>'
                . '</tr></thead><tbody>';

            $html .= '<tr class="mcp-log-filter-empty mcp-log-filter-empty--warnings"><td colspan="9">'
                . 'No warnings or errors in the latest ' . $totalLogs . ' logs. '
                . '<button type="button" class="mcp-inline-link" data-mcp-filter-btn="all">Show all ' . $totalLogs . ' logs</button>'
                . '</td></tr>';
            $html .= '<tr class="mcp-log-filter-empty mcp-log-filter-empty--tools"><td colspan="9">'
                . 'No tool calls in the latest ' . $totalLogs . ' logs. '
                . '<button type="button" class="mcp-inline-link" data-mcp-filter-btn="all">Show all ' . $totalLogs . ' logs</button>'
                . '</td></tr>';

            foreach ($preparedLogs as $idx => $item) {
                $log = $item['row'];
                $sInfo = $item['status_info'];
                $level = $item['level'];
                $isTool = $item['is_tool'];
                $detailId = 'mcp-log-detail-' . (int)($log['id'] ?? $idx);

                $createdAt = htmlspecialchars((string)$log['created_at'], ENT_QUOTES, 'UTF-8');
                $methodStr = (string)$log['method'];
                $pathStr = (string)$log['path'];
                $reqFull = htmlspecialchars($methodStr . ' ' . $pathStr, ENT_QUOTES, 'UTF-8');
                $rpcStr = (string)($log['rpc_method'] ?? '');
                $protoStr = (string)($log['protocol_version'] ?? '');
                $statusCode = (int)$log['status_code'];
                $durMs = (int)$log['duration_ms'];
                $noteStr = (string)($log['note'] ?? '');
                $uaStr = (string)($log['user_agent'] ?? '');
                $estTokens = (int)($log['est_tokens'] ?? 0);
                $outChars = (int)($log['output_chars'] ?? 0);

                $tone = $sInfo['tone'];
                $meaningTitle = htmlspecialchars($sInfo['title'], ENT_QUOTES, 'UTF-8');
                $meaningDesc = htmlspecialchars($sInfo['meaning'], ENT_QUOTES, 'UTF-8');

                $protoCell = $protoStr !== ''
                    ? '<span class="mcp-proto-tag">' . htmlspecialchars($protoStr, ENT_QUOTES, 'UTF-8') . '</span>'
                    : '<span class="mcp-cell-empty">—</span>';
                $tokCell = $estTokens > 0
                    ? '~' . mcp_format_compact_number($estTokens)
                    : '<span class="mcp-cell-empty">—</span>';
                $noteCell = $noteStr !== ''
                    ? '<span class="mcp-note-pill is-' . $level . '" title="' . htmlspecialchars($noteStr, ENT_QUOTES, 'UTF-8') . '">' . htmlspecialchars($noteStr, ENT_QUOTES, 'UTF-8') . '</span>'
                    : '<span class="mcp-cell-empty">—</span>';
                $uaCell = $uaStr !== ''
                    ? '<span class="mcp-ellipsis" title="' . htmlspecialchars($uaStr, ENT_QUOTES, 'UTF-8') . '">' . htmlspecialchars($uaStr, ENT_QUOTES, 'UTF-8') . '</span>'
                    : '<span class="mcp-cell-empty">—</span>';

                $html .= '<tr class="mcp-log-row is-level-' . $level . '" data-log-level="' . $level . '" data-log-tool="' . ($isTool ? '1' : '0') . '" data-mcp-log-row="' . $detailId . '" tabindex="0" aria-expanded="false">'
                    . '<td class="mcp-col-time">' . $createdAt . '</td>'
                    . '<td class="mcp-col-req" title="' . $reqFull . '"><span class="mcp-method-tag is-' . strtolower(htmlspecialchars($methodStr, ENT_QUOTES, 'UTF-8')) . '">' . htmlspecialchars($methodStr, ENT_QUOTES, 'UTF-8') . '</span><code class="mcp-path-code">' . htmlspecialchars($pathStr, ENT_QUOTES, 'UTF-8') . '</code></td>'
                    . '<td class="mcp-col-rpc">' . mcp_render_rpc_cell($rpcStr) . '</td>'
                    . '<td class="mcp-col-proto">' . $protoCell . '</td>'
                    . '<td class="mcp-col-status">'
                    . '<span class="mcp-status-wrap">'
                    . '<button type="button" class="mcp-status-badge is-' . $tone . '" data-mcp-status-btn aria-label="Status ' . $statusCode . ': ' . $meaningTitle . '" title="' . $meaningDesc . '">'
                    . '<span class="mcp-status-code">' . $statusCode . '</span>'
                    . '<span class="mcp-status-bang" aria-hidden="true">!</span>'
                    . '</button>'
                    . '<span class="mcp-status-popover" role="tooltip" hidden><strong>' . $meaningTitle . '</strong><span>' . $meaningDesc . '</span></span>'
                    . '</span>'
                    . '</td>'
                    . '<td class="mcp-col-tokens num" title="' . ($estTokens > 0 ? number_format($estTokens) . ' est. tokens (' . number_format($outChars) . ' UTF-8 chars)' : 'No tool content tokens') . '">' . $tokCell . '</td>'
                    . '<td class="mcp-col-ms num">' . $durMs . ' <span class="mcp-unit">ms</span></td>'
                    . '<td class="mcp-col-note">' . $noteCell . '</td>'
                    . '<td class="mcp-col-ua">' . $uaCell . '</td>'
                    . '</tr>';

                $html .= '<tr class="mcp-log-detail-row" id="' . $detailId . '" hidden><td colspan="9"><div class="mcp-log-detail-box">'
                    . '<div class="mcp-detail-status is-' . $tone . '"><span class="mcp-status-bang" aria-hidden="true">!</span><div><strong>' . $meaningTitle . '</strong><p>' . $meaningDesc . '</p></div></div>'
                    . '<div class="mcp-detail-grid">'
                    . '<div><span class="mcp-detail-label">Request</span><code>' . $reqFull . '</code></div>'
                    . '<div><span class="mcp-detail-label">RPC Method</span><code>' . ($rpcStr !== '' ? htmlspecialchars($rpcStr, ENT_QUOTES, 'UTF-8') : '—') . '</code></div>'
                    . '<div><span class="mcp-detail-label">Protocol</span><span>' . ($protoStr !== '' ? htmlspecialchars($protoStr, ENT_QUOTES, 'UTF-8') : '—') . '</span></div>'
                    . '<div><span class="mcp-detail-label">Latency &amp; Tokens</span><span>' . $durMs . ' ms' . ($estTokens > 0 ? ' · ~' . number_format($estTokens) . ' tokens (' . number_format($outChars) . ' chars)' : '') . '</span></div>'
                    . ($noteStr !== '' ? '<div class="mcp-detail-wide"><span class="mcp-detail-label">Note</span><code>' . htmlspecialchars($noteStr, ENT_QUOTES, 'UTF-8') . '</code></div>' : '')
                    . '<div class="mcp-detail-wide"><span class="mcp-detail-label">User-Agent</span><code class="mcp-detail-ua">' . ($uaStr !== '' ? htmlspecialchars($uaStr, ENT_QUOTES, 'UTF-8') : '—') . '</code></div>'
                    . '</div></div></td></tr>';
            }
            $html .= '</tbody></table></div>';
        } else {
            $html .= '<p class="muted">No debug logs recorded yet.</p>';
        }
        $html .= '</section>';
    }

    $html .= '</details>';
    return $html;
}

function handle_mcp_admin_post(string $path, array $user): bool {
    if (!str_starts_with($path, '/admin/mcp/')) {
        return false;
    }
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
        return false;
    }
    check_csrf();
    $pdo = db();

    if ($path === '/admin/mcp/settings') {
        set_setting('mcp_enabled', isset($_POST['mcp_enabled']) ? '1' : '0');
        set_setting('mcp_learning_mode', isset($_POST['mcp_learning_mode']) ? '1' : '0');
        set_setting('mcp_debug_logs_enabled', isset($_POST['mcp_debug_logs_enabled']) ? '1' : '0');
        flash('info', 'MCP settings saved.');
        redirect('/admin#mcp-connection');
    }

    if ($path === '/admin/mcp/client-create') {
        $name = trim((string)($_POST['name'] ?? 'Gemini'));
        if ($name === '' || mb_strlen($name, 'UTF-8') > 64) {
            flash('error', 'Client name must be between 1 and 64 characters.');
            redirect('/admin#mcp-connection');
        }
        $clientId = mcp_generate_credential('sn_cid_', true);
        $clientSecret = mcp_generate_credential('sn_cs_');
        $stmt = $pdo->prepare(
            'INSERT INTO oauth_clients (client_id, secret_hash, name, redirect_uris_json, require_pkce, created_at, last_used_at, revoked_at)
             VALUES (:cid, :sh, :name, "[]", 1, :created_at, NULL, NULL)'
        );
        $stmt->execute([
            ':cid' => $clientId,
            ':sh' => mcp_hash_secret($clientSecret),
            ':name' => $name,
            ':created_at' => now(),
        ]);
        $_SESSION['mcp_client_secret_plain'] = [
            'name' => $name,
            'client_id' => $clientId,
            'client_secret' => $clientSecret,
        ];
        flash('info', 'OAuth client created. Copy the Client Secret now; it is shown only once.');
        redirect('/admin#mcp-connection');
    }

    if ($path === '/admin/mcp/client-update') {
        $clientId = trim((string)($_POST['client_id'] ?? ''));
        $rawUris = str_replace(["\r\n", "\r"], "\n", (string)($_POST['redirect_uris'] ?? ''));
        $lines = array_values(array_filter(array_map('trim', explode("\n", $rawUris)), static fn($v) => $v !== ''));
        $validUris = [];
        foreach ($lines as $uri) {
            if (!mcp_is_valid_redirect_uri($uri)) {
                flash('error', 'Invalid redirect URI: ' . $uri . '. Use https:// (or http://localhost for local testing).');
                redirect('/admin#mcp-connection');
            }
            if (!in_array($uri, $validUris, true)) {
                $validUris[] = $uri;
            }
        }
        $requirePkce = isset($_POST['require_pkce']) ? 1 : 0;
        $pdo->prepare('UPDATE oauth_clients SET redirect_uris_json = :uris, require_pkce = :pkce WHERE client_id = :cid AND revoked_at IS NULL')
            ->execute([
                ':uris' => json_encode($validUris, JSON_UNESCAPED_SLASHES),
                ':pkce' => $requirePkce,
                ':cid' => $clientId,
            ]);
        flash('info', 'OAuth client settings updated.');
        redirect('/admin#mcp-connection');
    }

    if ($path === '/admin/mcp/client-rotate-secret') {
        $clientId = trim((string)($_POST['client_id'] ?? ''));
        $stmt = $pdo->prepare('SELECT id, name FROM oauth_clients WHERE client_id = :cid AND revoked_at IS NULL LIMIT 1');
        $stmt->execute([':cid' => $clientId]);
        $client = $stmt->fetch(PDO::FETCH_ASSOC);
        if ($client) {
            $newSecret = mcp_generate_credential('sn_cs_');
            $pdo->prepare('UPDATE oauth_clients SET secret_hash = :sh WHERE id = :id')
                ->execute([':sh' => mcp_hash_secret($newSecret), ':id' => (int)$client['id']]);
            $_SESSION['mcp_client_secret_plain'] = [
                'name' => (string)$client['name'],
                'client_id' => $clientId,
                'client_secret' => $newSecret,
            ];
            flash('info', 'Client Secret rotated. Copy it now; it is shown only once.');
        }
        redirect('/admin#mcp-connection');
    }

    if ($path === '/admin/mcp/client-revoke-tokens') {
        $clientId = trim((string)($_POST['client_id'] ?? ''));
        $pdo->prepare('UPDATE oauth_tokens SET revoked_at = :now WHERE client_id = :cid AND revoked_at IS NULL')
            ->execute([':now' => time(), ':cid' => $clientId]);
        flash('info', 'All tokens for the client have been revoked.');
        redirect('/admin#mcp-connection');
    }

    if ($path === '/admin/mcp/client-delete') {
        $clientId = trim((string)($_POST['client_id'] ?? ''));
        $nowTs = time();
        $pdo->prepare('UPDATE oauth_clients SET revoked_at = :ts WHERE client_id = :cid AND revoked_at IS NULL')
            ->execute([':ts' => now(), ':cid' => $clientId]);
        $pdo->prepare('UPDATE oauth_tokens SET revoked_at = :now WHERE client_id = :cid AND revoked_at IS NULL')
            ->execute([':now' => $nowTs, ':cid' => $clientId]);
        $pdo->prepare('DELETE FROM oauth_redirect_attempts WHERE client_id = :cid')
            ->execute([':cid' => $clientId]);
        flash('info', 'OAuth client and all associated tokens have been revoked.');
        redirect('/admin#mcp-connection');
    }

    if ($path === '/admin/mcp/redirect-allow') {
        $attemptId = (int)($_POST['attempt_id'] ?? 0);
        $stmt = $pdo->prepare('SELECT * FROM oauth_redirect_attempts WHERE id = :id LIMIT 1');
        $stmt->execute([':id' => $attemptId]);
        $attempt = $stmt->fetch(PDO::FETCH_ASSOC);
        if ($attempt) {
            $uri = (string)$attempt['redirect_uri'];
            $cid = (string)$attempt['client_id'];
            if (mcp_is_valid_redirect_uri($uri)) {
                $cStmt = $pdo->prepare('SELECT id, redirect_uris_json FROM oauth_clients WHERE client_id = :cid AND revoked_at IS NULL LIMIT 1');
                $cStmt->execute([':cid' => $cid]);
                $client = $cStmt->fetch(PDO::FETCH_ASSOC);
                if ($client) {
                    $uris = json_decode((string)$client['redirect_uris_json'], true);
                    if (!is_array($uris)) {
                        $uris = [];
                    }
                    if (!in_array($uri, $uris, true)) {
                        $uris[] = $uri;
                    }
                    $pdo->prepare('UPDATE oauth_clients SET redirect_uris_json = :uris WHERE id = :id')
                        ->execute([':uris' => json_encode($uris, JSON_UNESCAPED_SLASHES), ':id' => (int)$client['id']]);
                    $pdo->prepare('DELETE FROM oauth_redirect_attempts WHERE id = :id')
                        ->execute([':id' => $attemptId]);
                    flash('info', 'Redirect URI added to client allowlist.');
                }
            }
        }
        redirect('/admin#mcp-connection');
    }

    if ($path === '/admin/mcp/logs-clear') {
        $pdo->exec('DELETE FROM mcp_debug_logs');
        flash('info', 'MCP debug logs cleared.');
        redirect('/admin#mcp-connection');
    }

    if ($path === '/admin/mcp/stats-reset') {
        $pdo->exec('DELETE FROM mcp_usage_stats');
        flash('info', 'MCP usage statistics reset.');
        redirect('/admin#mcp-connection');
    }

    return false;
}
