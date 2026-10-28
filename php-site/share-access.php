<?php
declare(strict_types=1);

// Share passwords and expiration.
// Both plugin and website edits use the same optimistic update. An upload that
// started earlier must never undo a later access change.
function save_share_access(array $share, string $slug, ?string $passwordHash, ?int $expiresAt, ?string $title = null): bool {
    $stmt = db()->prepare('UPDATE shares SET revision = revision + 1, title = :title, slug = :slug, password_hash = :password_hash, expires_at = :expires_at, updated_at = :updated_at WHERE id = :id AND user_id = :uid AND revision = :revision AND deleted_at IS NULL');
    $stmt->execute([
        ':title' => $title ?? $share['title'], ':slug' => $slug, ':password_hash' => $passwordHash,
        ':expires_at' => $expiresAt, ':updated_at' => now(),
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

function share_has_current_read_access(array $share): bool {
    if (share_is_expired($share)) return false;
    if (!share_requires_password($share)) return true;
    $entry = $_SESSION['share_access'][(int)$share['id']] ?? '';
    $token = is_array($entry) ? ($entry['token'] ?? '') : $entry;
    return is_string($token) && hash_equals(share_access_signature((string)$share['password_hash']), $token);
}

function share_read_access_allowed(int $shareId): bool {
    $share = find_share_by_id($shareId);
    return $share && empty($share['deleted_at']) && share_has_current_read_access($share);
}
