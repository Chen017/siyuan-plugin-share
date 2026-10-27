<?php
declare(strict_types=1);

// Share passwords, expiration and persistent visitor limits.
// Both plugin and website edits use the same optimistic update. An upload that
// started earlier must never undo a later access change.
function save_share_access(array $share, string $slug, ?string $passwordHash, ?int $expiresAt, int $visitorLimit, ?string $title = null): bool {
    $stmt = db()->prepare('UPDATE shares SET revision = revision + 1, title = :title, slug = :slug, password_hash = :password_hash, expires_at = :expires_at, visitor_limit = :visitor_limit, updated_at = :updated_at WHERE id = :id AND user_id = :uid AND revision = :revision AND deleted_at IS NULL');
    $stmt->execute([
        ':title' => $title ?? $share['title'], ':slug' => $slug, ':password_hash' => $passwordHash,
        ':expires_at' => $expiresAt, ':visitor_limit' => $visitorLimit, ':updated_at' => now(),
        ':id' => (int)$share['id'], ':uid' => (int)$share['user_id'], ':revision' => (int)$share['revision'],
    ]);
    return $stmt->rowCount() === 1;
}

function share_requires_password(array $share): bool {
    return !empty($share['password_hash']);
}

function share_is_expired(array $share): bool {
    if (empty($share['expires_at'])) {
        return false;
    }
    return time() > (int)$share['expires_at'];
}

function share_password_hash_by_id(int $shareId): string {
    static $cache = [];
    if ($shareId <= 0) {
        return '';
    }
    if (array_key_exists($shareId, $cache)) {
        return (string)$cache[$shareId];
    }
    $pdo = db();
    $stmt = $pdo->prepare('SELECT password_hash FROM shares WHERE id = :id AND deleted_at IS NULL LIMIT 1');
    $stmt->execute([':id' => $shareId]);
    $value = $stmt->fetchColumn();
    $hash = is_string($value) ? trim($value) : '';
    $cache[$shareId] = $hash;
    return $hash;
}

function share_access_signature(string $passwordHash): string {
    $raw = trim($passwordHash);
    if ($raw === '') {
        return '';
    }
    return hash('sha256', $raw);
}

function share_access_granted(int $shareId): bool {
    if ($shareId <= 0) {
        return false;
    }
    $entry = $_SESSION['share_access'][$shareId] ?? null;
    if (empty($entry)) {
        return false;
    }
    $passwordHash = share_password_hash_by_id($shareId);
    if ($passwordHash === '') {
        // No password now: old session entries are irrelevant.
        return true;
    }
    $expected = share_access_signature($passwordHash);
    if ($expected === '') {
        return false;
    }
    if ($entry === true) {
        // Legacy boolean session format; force one re-verification for protected shares.
        return false;
    }
    if (is_string($entry) && $entry !== '') {
        return hash_equals($expected, $entry);
    }
    if (is_array($entry)) {
        $token = trim((string)($entry['token'] ?? ''));
        if ($token !== '') {
            return hash_equals($expected, $token);
        }
    }
    return false;
}

function grant_share_access(int $shareId): void {
    if ($shareId <= 0) {
        return;
    }
    if (!isset($_SESSION['share_access']) || !is_array($_SESSION['share_access'])) {
        $_SESSION['share_access'] = [];
    }
    $passwordHash = share_password_hash_by_id($shareId);
    if ($passwordHash === '') {
        $_SESSION['share_access'][$shareId] = true;
        return;
    }
    $_SESSION['share_access'][$shareId] = share_access_signature($passwordHash);
}

function share_visitor_limit(array $share): int {
    return max(0, (int)($share['visitor_limit'] ?? 0));
}

function share_visitor_count(int $shareId): int {
    if ($shareId <= 0) {
        return 0;
    }
    $pdo = db();
    $stmt = $pdo->prepare('SELECT COUNT(*) FROM share_visitors WHERE share_id = :sid');
    $stmt->execute([':sid' => $shareId]);
    return (int)$stmt->fetchColumn();
}

function share_visitor_limit_reached(array $share): bool {
    $limit = share_visitor_limit($share);
    if ($limit <= 0) {
        return false;
    }
    $shareId = (int)($share['id'] ?? 0);
    if ($shareId <= 0) {
        return false;
    }
    $visitorId = get_visitor_id();
    $pdo = db();
    if ($visitorId !== '') {
        $stmt = $pdo->prepare('SELECT 1 FROM share_visitors WHERE share_id = :sid AND visitor_id = :vid LIMIT 1');
        $stmt->execute([
            ':sid' => $shareId,
            ':vid' => $visitorId,
        ]);
        if ($stmt->fetchColumn()) {
            return false;
        }
    }
    return share_visitor_count($shareId) >= $limit;
}

function register_share_visitor(int $shareId, string $visitorId): void {
    if ($shareId <= 0 || $visitorId === '') {
        return;
    }
    $pdo = db();
    $pdo->prepare('INSERT OR IGNORE INTO share_visitors (share_id, visitor_id, created_at)
        VALUES (:sid, :vid, :created_at)')->execute([
        ':sid' => $shareId,
        ':vid' => $visitorId,
        ':created_at' => now(),
    ]);
}

/** Reserve a reader slot under the same write lock that checks the current limit. */
function share_has_current_read_access(array $share): bool {
    if (share_is_expired($share)) return false;
    if (!share_requires_password($share)) return true;
    $entry = $_SESSION['share_access'][(int)$share['id']] ?? '';
    $token = is_array($entry) ? ($entry['token'] ?? '') : $entry;
    return is_string($token) && hash_equals(share_access_signature((string)$share['password_hash']), $token);
}

function admit_share_visitor(int $shareId): bool {
    $pdo = db();
    $share = find_share_by_id($shareId);
    if (!$share || !share_has_current_read_access($share)) return false;
    // Unlimited shares remain read-only. Limited shares re-read after taking the write lock.
    if (share_visitor_limit($share) === 0) return true;
    $visitorId = get_visitor_id();
    $pdo->exec('BEGIN IMMEDIATE');
    try {
        $share = find_share_by_id($shareId);
        $allowed = $share && share_has_current_read_access($share);
        if ($allowed && share_visitor_limit($share) > 0) {
            $allowed = !share_visitor_limit_reached($share);
            if ($allowed) register_share_visitor($shareId, $visitorId);
        }
        $pdo->exec('COMMIT');
        return (bool)$allowed;
    } catch (Throwable $error) {
        $pdo->exec('ROLLBACK');
        throw $error;
    }
}
