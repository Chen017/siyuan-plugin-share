<?php
declare(strict_types=1);

function pdf_visitor_migrate(PDO $pdo): void {
    ensure_column($pdo, 'pdf_export_events', 'visitor_hash', 'TEXT NOT NULL DEFAULT ""');
    ensure_column($pdo, 'pdf_export_leases', 'visitor_hash', 'TEXT NOT NULL DEFAULT ""');
    ensure_column($pdo, 'pdf_export_events', 'doc_count', 'INTEGER NOT NULL DEFAULT 1');
    ensure_column($pdo, 'pdf_export_events', 'job_token', 'TEXT NOT NULL DEFAULT ""');
    ensure_column($pdo, 'pdf_export_events', 'doc_index', 'INTEGER NOT NULL DEFAULT -1');
    ensure_column($pdo, 'pdf_export_leases', 'document_count', 'INTEGER NOT NULL DEFAULT 1');
    ensure_column($pdo, 'pdf_export_leases', 'created_at', 'INTEGER NOT NULL DEFAULT 0');
    $pdo->exec('CREATE TABLE IF NOT EXISTS pdf_export_visitors (visitor_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)');
    $pdo->exec('CREATE TABLE IF NOT EXISTS pdf_export_claims (
        job_token TEXT NOT NULL, doc_index INTEGER NOT NULL, PRIMARY KEY(job_token, doc_index),
        FOREIGN KEY(job_token) REFERENCES pdf_export_leases(token) ON DELETE CASCADE)');
    $pdo->exec('CREATE INDEX IF NOT EXISTS pdf_export_events_visitor ON pdf_export_events(visitor_hash, created_at)');
    $pdo->exec('CREATE TABLE IF NOT EXISTS pdf_export_fingerprints (
        fingerprint_hash TEXT NOT NULL, visitor_hash TEXT NOT NULL, seen_at INTEGER NOT NULL, needs_captcha INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(fingerprint_hash, visitor_hash))');
    $pdo->exec('CREATE INDEX IF NOT EXISTS pdf_export_fingerprints_seen ON pdf_export_fingerprints(seen_at)');
    $pdo->exec('CREATE TABLE IF NOT EXISTS pdf_export_clearance (visitor_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)');
    $pdo->exec('CREATE TABLE IF NOT EXISTS pdf_export_challenges (
        token TEXT PRIMARY KEY, visitor_hash TEXT NOT NULL, fingerprint_hash TEXT NOT NULL,
        session_hash TEXT NOT NULL, answer_hash TEXT NOT NULL, expires_at INTEGER NOT NULL)');
    $pdo->exec('CREATE TABLE IF NOT EXISTS pdf_export_captcha_limits (
        visitor_hash TEXT PRIMARY KEY, started_at INTEGER NOT NULL, images INTEGER NOT NULL DEFAULT 0,
        failures INTEGER NOT NULL DEFAULT 0)');
}

function pdf_visitor_secret(): string {
    $secret = (string)get_setting('pdf_export_cookie_key', '');
    if (!preg_match('/^[a-f0-9]{64}$/D', $secret)) throw new RuntimeException('访客标识暂不可用，请稍后重试。', 503);
    return $secret;
}

function pdf_visitor_cookie_valid(string $cookie): bool {
    if (!preg_match('/^([a-f0-9]{48})\.([a-f0-9]{64})$/D', $cookie, $parts)) return false;
    if (!hash_equals(hash_hmac('sha256', $parts[1], pdf_visitor_secret()), $parts[2])) return false;
    $stmt = db()->prepare('SELECT 1 FROM pdf_export_visitors WHERE visitor_hash = ? AND expires_at > ?');
    $stmt->execute([hash('sha256', $parts[1]), time()]);
    return (bool)$stmt->fetchColumn();
}

function pdf_visitor_id(bool $requireExisting = false): string {
    $cookie = $_COOKIE['sps_pdf_visitor'] ?? '';
    if (!is_string($cookie) || !pdf_visitor_cookie_valid($cookie)) {
        if ($requireExisting) throw new RuntimeException('请允许 Cookie，并重新打开导出页面。', 409);
        $payload = bin2hex(random_bytes(24));
        $cookie = $payload . '.' . hash_hmac('sha256', $payload, pdf_visitor_secret());
        $pdo = db();
        $pdo->prepare('DELETE FROM pdf_export_visitors WHERE expires_at <= ?')->execute([time()]);
        $pdo->prepare('INSERT INTO pdf_export_visitors VALUES (?, ?)')->execute([hash('sha256', $payload), time() + 604800]);
        setcookie('sps_pdf_visitor', $cookie, [
            'expires' => time() + 604800, 'path' => base_path() . '/',
            'secure' => !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off',
            'httponly' => true, 'samesite' => 'Lax',
        ]);
        $_COOKIE['sps_pdf_visitor'] = $cookie;
    }
    return hash('sha256', explode('.', $cookie)[0]);
}

function pdf_visitor_fingerprint($raw): string {
    if (!is_string($raw) || !preg_match('/^[a-f0-9]{64}$/D', $raw)) throw new RuntimeException('无效的浏览器指纹，请刷新后重试。', 400);
    // Exact hash equality only. Similar devices are not grouped into a quota.
    return hash('sha256', $raw);
}

function pdf_visitor_quota(string $visitor, array $limits, int $documents = 1): void {
    if ($documents > $limits['requests']) throw new RuntimeException('本次篇数超过当前访客的个人额度上限，请减少本次篇数。', 429);
    $stmt = db()->prepare('SELECT SUM(CASE WHEN visitor_hash = ? THEN doc_count ELSE 0 END) AS own, COUNT(*) AS total
        FROM pdf_export_events WHERE created_at > ?');
    $stmt->execute([$visitor, time() - $limits['window_seconds']]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if ((int)$row['own'] + $documents > $limits['requests']) {
        $needed = (int)$row['own'] + $documents - $limits['requests'];
        $stmt = db()->prepare('SELECT created_at, doc_count FROM pdf_export_events WHERE visitor_hash = ? AND doc_count > 0 AND created_at > ? ORDER BY created_at');
        $stmt->execute([$visitor, time() - $limits['window_seconds']]);
        $resume = time() + $limits['window_seconds'];
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $event) {
            $needed -= (int)$event['doc_count'];
            if ($needed <= 0) { $resume = (int)$event['created_at'] + $limits['window_seconds']; break; }
        }
        throw new RuntimeException('导出太频繁，请稍后再试。当前 Cookie 的剩余额度不足，预计 ' . date('Y-m-d H:i:s', $resume) . ' 可继续；也可以减少本次篇数。', 429);
    }
    if ((int)$row['total'] >= $limits['max_window_events']) throw new RuntimeException('导出服务繁忙，请稍后再试。', 429);
}

function pdf_visitor_needs_captcha(string $visitor, string $fingerprint): bool {
    $pdo = db();
    $now = time();
    $window = pdf_export_limits()['window_seconds'];
    $pdo->exec('PRAGMA busy_timeout = 3000');
    $pdo->exec('BEGIN IMMEDIATE');
    try {
        $pdo->prepare('DELETE FROM pdf_export_fingerprints WHERE seen_at <= ?')->execute([$now - $window]);
        $pdo->prepare('DELETE FROM pdf_export_clearance WHERE expires_at <= ?')->execute([$now]);
        $pdo->prepare('DELETE FROM pdf_export_challenges WHERE expires_at <= ?')->execute([$now]);
        $pdo->prepare('DELETE FROM pdf_export_captcha_limits WHERE started_at <= ?')->execute([$now - 300]);
        $stmt = $pdo->prepare('SELECT 1 FROM pdf_export_clearance WHERE visitor_hash = ? AND expires_at > ?');
        $stmt->execute([$visitor, $now]);
        $cleared = (bool)$stmt->fetchColumn();
        $stmt = $pdo->prepare('SELECT 1 FROM pdf_export_fingerprints WHERE fingerprint_hash = ? AND visitor_hash != ? LIMIT 1');
        $stmt->execute([$fingerprint, $visitor]);
        $otherCookie = (bool)$stmt->fetchColumn();
        $stmt = $pdo->prepare('SELECT needs_captcha FROM pdf_export_fingerprints WHERE fingerprint_hash = ? AND visitor_hash = ?');
        $stmt->execute([$fingerprint, $visitor]);
        $entry = $stmt->fetch(PDO::FETCH_ASSOC);
        $known = is_array($entry);
        if (!$known && (int)$pdo->query('SELECT COUNT(*) FROM pdf_export_fingerprints')->fetchColumn() >= 20000) {
            throw new RuntimeException('导出服务繁忙，请稍后再试。', 429);
        }
        $risk = $known ? (int)$entry['needs_captcha'] === 1 : $otherCookie;
        $pdo->prepare('INSERT INTO pdf_export_fingerprints VALUES (?, ?, ?, ?) ON CONFLICT(fingerprint_hash, visitor_hash) DO UPDATE SET seen_at = excluded.seen_at')
            ->execute([$fingerprint, $visitor, $now, $risk ? 1 : 0]);
        $pdo->exec('COMMIT');
        return !$cleared && $risk;
    } catch (Throwable $error) {
        $pdo->exec('ROLLBACK');
        throw $error;
    }
}

function pdf_visitor_captcha_budget(string $visitor, string $kind): void {
    $pdo = db();
    $now = time();
    $pdo->exec('BEGIN IMMEDIATE');
    try {
        $pdo->prepare('DELETE FROM pdf_export_captcha_limits WHERE started_at <= ?')->execute([$now - 300]);
        $pdo->prepare('INSERT OR IGNORE INTO pdf_export_captcha_limits(visitor_hash, started_at) VALUES (?, ?)')->execute([$visitor, $now]);
        $stmt = $pdo->prepare('SELECT images, failures FROM pdf_export_captcha_limits WHERE visitor_hash = ?');
        $stmt->execute([$visitor]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if ((int)$row['failures'] >= 10 || ($kind === 'images' && (int)$row['images'] >= 6)) {
            throw new RuntimeException('验证码尝试过于频繁，请稍后再试。', 429);
        }
        $column = $kind === 'images' ? 'images' : 'failures';
        $pdo->prepare('UPDATE pdf_export_captcha_limits SET ' . $column . ' = ' . $column . ' + 1 WHERE visitor_hash = ?')->execute([$visitor]);
        $pdo->exec('COMMIT');
    } catch (Throwable $error) {
        $pdo->exec('ROLLBACK');
        throw $error;
    }
}

function pdf_visitor_challenge(string $visitor, string $fingerprint): array {
    pdf_visitor_captcha_budget($visitor, 'images');
    $pdo = db();
    if ((int)$pdo->query('SELECT COUNT(*) FROM pdf_export_challenges')->fetchColumn() >= 1000) throw new RuntimeException('验证码服务繁忙，请稍后再试。', 429);
    $code = '';
    $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for ($i = 0; $i < 5; $i++) $code .= $alphabet[random_int(0, strlen($alphabet) - 1)];
    $token = bin2hex(random_bytes(24));
    $hash = hash_hmac('sha256', $token . ':' . $code, pdf_visitor_secret());
    $pdo->prepare('DELETE FROM pdf_export_challenges WHERE visitor_hash = ?')->execute([$visitor]);
    $pdo->prepare('INSERT INTO pdf_export_challenges VALUES (?, ?, ?, ?, ?, ?)')
        ->execute([$token, $visitor, $fingerprint, hash('sha256', session_id()), $hash, time() + 300]);
    $image = imagecreatetruecolor(150, 50);
    $bg = imagecolorallocate($image, 246, 248, 255);
    $ink = imagecolorallocate($image, 35, 65, 120);
    $noise = imagecolorallocate($image, 180, 194, 215);
    imagefill($image, 0, 0, $bg);
    for ($i = 0; $i < 8; $i++) imageline($image, random_int(0, 149), random_int(0, 49), random_int(0, 149), random_int(0, 49), $noise);
    foreach (str_split($code) as $i => $letter) imagestring($image, 5, 18 + $i * 24, random_int(13, 20), $letter, $ink);
    ob_start();
    imagepng($image);
    $png = ob_get_clean();
    imagedestroy($image);
    return ['token' => $token, 'image' => 'data:image/png;base64,' . base64_encode($png), 'expires_in' => 300];
}

function pdf_visitor_verify_captcha(string $visitor, string $fingerprint, $token, $answer): void {
    pdf_visitor_captcha_budget($visitor, 'failures');
    if (!is_string($token) || !is_string($answer) || strlen($answer) > 16) throw new RuntimeException('验证码无效，请重试。', 400);
    $pdo = db();
    $pdo->exec('BEGIN IMMEDIATE');
    try {
        $stmt = $pdo->prepare('SELECT answer_hash FROM pdf_export_challenges WHERE token = ? AND visitor_hash = ? AND fingerprint_hash = ? AND session_hash = ? AND expires_at > ?');
        $stmt->execute([$token, $visitor, $fingerprint, hash('sha256', session_id()), time()]);
        $expected = $stmt->fetchColumn();
        $actual = hash_hmac('sha256', $token . ':' . strtoupper(trim($answer)), pdf_visitor_secret());
        if (!is_string($expected) || !hash_equals($expected, $actual)) throw new RuntimeException('验证码错误或已过期，请重试。', 400);
        $stmt = $pdo->prepare('SELECT expires_at FROM pdf_export_visitors WHERE visitor_hash = ?');
        $stmt->execute([$visitor]);
        $expires = (int)$stmt->fetchColumn();
        $pdo->prepare('INSERT INTO pdf_export_clearance VALUES (?, ?) ON CONFLICT(visitor_hash) DO UPDATE SET expires_at = excluded.expires_at')
            ->execute([$visitor, $expires]);
        $pdo->prepare('DELETE FROM pdf_export_challenges WHERE visitor_hash = ?')->execute([$visitor]);
        $pdo->exec('COMMIT');
    } catch (Throwable $error) {
        $pdo->exec('ROLLBACK');
        throw $error;
    }
}

function pdf_visitor_claim(int $shareId, string $token, int $index): void {
    $pdo = db();
    $visitor = pdf_visitor_id(true);
    $limits = pdf_export_limits();
    $now = time();
    $pdo->exec('BEGIN IMMEDIATE');
    try {
        $stmt = $pdo->prepare('SELECT * FROM pdf_export_leases WHERE token = ? AND share_id = ? AND visitor_hash = ? AND session_hash = ? AND expires_at > ?');
        $stmt->execute([$token, $shareId, $visitor, hash('sha256', session_id()), $now]);
        $lease = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$lease || $index < 0 || $index >= (int)$lease['document_count']) throw new RuntimeException('导出任务已失效，请重新打开预览。', 410);
        $stmt = $pdo->prepare('SELECT 1 FROM pdf_export_claims WHERE job_token = ? AND doc_index = ?');
        $stmt->execute([$token, $index]);
        if (!$stmt->fetchColumn()) {
            pdf_visitor_quota($visitor, $limits);
            $pdo->prepare('INSERT INTO pdf_export_events(ip_hash, fingerprint_hash, created_at, visitor_hash, doc_count, job_token, doc_index) VALUES (?, ?, ?, ?, 1, ?, ?)')
                ->execute([$lease['ip_hash'], $lease['fingerprint_hash'], $now, $visitor, $token, $index]);
            $pdo->prepare('INSERT INTO pdf_export_claims VALUES (?, ?)')->execute([$token, $index]);
        }
        $pdo->exec('COMMIT');
    } catch (Throwable $error) {
        $pdo->exec('ROLLBACK');
        throw $error;
    }
}
