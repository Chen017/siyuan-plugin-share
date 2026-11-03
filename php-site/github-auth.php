<?php
declare(strict_types=1);

// Kept outside the repository and image. A missing or malformed file never
// re-enables password login after the database has been switched to GitHub.
function github_oauth_config(): ?array {
    global $config;
    $raw = @file_get_contents((string)$config['github_oauth_config']);
    if ($raw === false || strlen($raw) > 8192) return null;
    $oauth = json_decode($raw, true);
    if (!is_array($oauth)) return null;
    foreach (['client_id', 'client_secret', 'callback_url', 'github_user_id', 'local_user_id'] as $key) {
        if (!isset($oauth[$key]) || !is_scalar($oauth[$key]) || (string)$oauth[$key] === '') return null;
    }
    $url = parse_url((string)$oauth['callback_url']);
    if (!$url || ($url['scheme'] ?? '') !== 'https' || empty($url['host']) || isset($url['user']) || isset($url['pass']) || isset($url['query']) || isset($url['fragment']) || ($url['path'] ?? '') !== '/auth/github/callback') return null;
    if (!preg_match('/^[A-Za-z0-9_]+$/D', (string)$oauth['client_id']) || !preg_match('/^[1-9][0-9]*$/D', (string)$oauth['github_user_id']) || !preg_match('/^[1-9][0-9]*$/D', (string)$oauth['local_user_id'])) return null;
    return $oauth;
}

function github_only(): bool {
    // Unknown non-empty modes fail closed.
    $mode = fetch_setting(db(), 'admin_auth_mode');
    return $mode !== null && $mode !== '' && $mode !== 'password';
}

function github_session_digest(array $oauth, array $user): string {
    $payload = implode(':', [(string)$oauth['client_id'], (string)$oauth['github_user_id'], (string)$oauth['local_user_id'], (string)$user['password_hash']]);
    return hash_hmac('sha256', $payload, (string)$oauth['client_secret']);
}

function github_session_valid(array $user): bool {
    $oauth = github_oauth_config();
    return $oauth !== null && (string)$user['id'] === (string)$oauth['local_user_id']
        && isset($_SESSION['github_session']) && is_string($_SESSION['github_session'])
        && hash_equals(github_session_digest($oauth, $user), $_SESSION['github_session']);
}

function github_http_json(string $url, array $headers, ?array $post = null): ?array {
    $options = ['method' => $post === null ? 'GET' : 'POST', 'header' => implode("\r\n", $headers),
        'timeout' => 10, 'follow_location' => 0, 'ignore_errors' => true];
    if ($post !== null) $options['content'] = http_build_query($post, '', '&', PHP_QUERY_RFC3986);
    $context = stream_context_create(['http' => $options, 'ssl' => ['verify_peer' => true, 'verify_peer_name' => true]]);
    $body = @file_get_contents($url, false, $context, 0, 65537);
    $status = $http_response_header[0] ?? '';
    if ($body === false || strlen($body) > 65536 || !preg_match('#^HTTP/\S+ 200(?:\s|$)#', $status)) return null;
    $value = json_decode($body, true);
    return is_array($value) ? $value : null;
}

function github_fail(): void {
    unset($_SESSION['github_oauth']);
    flash('error', 'GitHub sign-in failed. Please try again.');
    redirect('/login');
}

function handle_github_auth(string $path): void {
    header('Cache-Control: no-store');
    header('Referrer-Policy: no-referrer');
    if ($_SERVER['REQUEST_METHOD'] !== 'GET') { http_response_code(405); exit; }
    $oauth = github_oauth_config();
    if (!$oauth) github_fail();
    if ($path === '/auth/github') {
        $state = bin2hex(random_bytes(32));
        $verifier = rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
        $_SESSION['github_oauth'] = ['state' => $state, 'verifier' => $verifier, 'created' => time()];
        $params = ['client_id' => (string)$oauth['client_id'], 'redirect_uri' => (string)$oauth['callback_url'],
            'state' => $state, 'code_challenge' => rtrim(strtr(base64_encode(hash('sha256', $verifier, true)), '+/', '-_'), '='),
            'code_challenge_method' => 'S256', 'allow_signup' => 'false'];
        header('Location: https://github.com/login/oauth/authorize?' . http_build_query($params, '', '&', PHP_QUERY_RFC3986));
        exit;
    }
    $attempt = $_SESSION['github_oauth'] ?? null;
    unset($_SESSION['github_oauth']); // single use, including failed callbacks
    $state = $_GET['state'] ?? null;
    $code = $_GET['code'] ?? null;
    if (!is_array($attempt) || !is_string($state) || !is_string($code) || $code === '' || strlen($code) > 2048 || !isset($attempt['state'], $attempt['verifier'], $attempt['created']) || !is_string($attempt['state']) || !is_string($attempt['verifier']) || time() - (int)$attempt['created'] > 600 || !hash_equals($attempt['state'], $state)) github_fail();
    $token = github_http_json('https://github.com/login/oauth/access_token', ['Accept: application/json', 'Content-Type: application/x-www-form-urlencoded', 'User-Agent: SiYuan-Share'], [
        'client_id' => (string)$oauth['client_id'], 'client_secret' => (string)$oauth['client_secret'], 'code' => $code,
        'redirect_uri' => (string)$oauth['callback_url'], 'code_verifier' => $attempt['verifier'],
    ]);
    if (!is_array($token) || !isset($token['access_token']) || !is_string($token['access_token']) || !preg_match('/^[A-Za-z0-9_]+$/D', $token['access_token'])) github_fail();
    $identity = github_http_json('https://api.github.com/user', ['Accept: application/vnd.github+json', 'User-Agent: SiYuan-Share', 'Authorization: Bearer ' . $token['access_token'], 'X-GitHub-Api-Version: 2022-11-28']);
    unset($token);
    if (!is_array($identity) || !isset($identity['id']) || (string)$identity['id'] !== (string)$oauth['github_user_id']) github_fail();
    $stmt = db()->prepare('SELECT * FROM users WHERE id = ? AND role = "admin" AND disabled = 0 LIMIT 1');
    $stmt->execute([(int)$oauth['local_user_id']]);
    $user = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$user) github_fail();
    if ((int)$user['must_change_password'] === 1) {
        db()->prepare('UPDATE users SET must_change_password = 0, updated_at = ? WHERE id = ?')->execute([now(), $user['id']]);
    }
    session_regenerate_id(true);
    $_SESSION = ['user_id' => $user['id'], 'auth_method' => 'github', 'github_session' => github_session_digest($oauth, $user)];
    redirect('/dashboard');
}
