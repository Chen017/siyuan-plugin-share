<?php
declare(strict_types=1);

// Administrator share editor. Reader admission and plugin synchronization keep
// using the same password hashes, visitor records and revision counter.
function render_admin_share_editor(int $id, array $user): void {
    $share = find_share_by_id($id);
    if (!$share || !empty($share['deleted_at'])) {
        http_response_code(404);
        render_page('Share unavailable', '<div class="card"><h1>Share unavailable</h1><p>This share was deleted or does not exist.</p><a class="button" href="' . base_path() . '/dashboard">Back to shares</a></div>', $user, '', ['nav' => 'dashboard']);
        return;
    }
    $values = ['title' => $share['title'], 'slug' => $share['slug'], 'expires_at' => !empty($share['expires_at']) ? date('Y-m-d\TH:i', (int)$share['expires_at']) : '', 'visitor_limit' => (string)(int)$share['visitor_limit'], 'password_mode' => 'keep'];
    $error = '';
    $postedRevision = is_string($_POST['revision'] ?? null) ? $_POST['revision'] : '';
    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        check_csrf();
        foreach ($values as $key => $_) $values[$key] = is_string($_POST[$key] ?? null) ? trim($_POST[$key]) : '';
        $values['slug'] = sanitize_slug($values['slug']);
        $password = is_string($_POST['password'] ?? null) ? trim($_POST['password']) : '';
        $expires = null;
        if ($values['expires_at'] !== '') {
            $date = DateTimeImmutable::createFromFormat('!Y-m-d\TH:i', $values['expires_at']);
            if (!$date || $date->format('Y-m-d\TH:i') !== $values['expires_at']) $error = 'Enter a valid expiry date and time.';
            else $expires = $date->getTimestamp();
        }
        if ($values['title'] === '' || mb_strlen($values['title']) > 500) $error = 'Enter a title of 1–500 characters.';
        elseif ($values['slug'] === '' || share_slug_validation_key($values['slug']) !== '') $error = 'The link suffix must contain 6–32 letters or numbers.';
        elseif (share_slug_exists(db(), $values['slug'], $id)) $error = 'This link suffix is already in use. Choose another.';
        elseif (!preg_match('/^[0-9]{1,9}$/D', $values['visitor_limit'])) $error = 'Enter a visitor limit from 0 to 999999999. Use 0 for unlimited.';
        elseif (!in_array($values['password_mode'], ['keep', 'set', 'remove'], true)) $error = 'Choose how to update the password.';
        elseif ($values['password_mode'] === 'set' && ($password === '' || strlen($password) > 72 || str_contains($password, "\0"))) $error = 'Enter a new password. If it is long, shorten it and try again.';
        elseif ($postedRevision !== (string)$share['revision']) {
            $error = 'This share changed in another window or in the plugin. Reload before saving.';
            http_response_code(409);
        }
        if ($error === '') {
            $hash = $share['password_hash'] ?: null;
            if ($values['password_mode'] === 'set') $hash = password_hash($password, PASSWORD_DEFAULT);
            elseif ($values['password_mode'] === 'remove') $hash = null;
            try {
                $saved = save_share_access($share, $values['slug'], $hash, $expires, (int)$values['visitor_limit'], $values['title']);
            } catch (PDOException $exception) {
                // A concurrent editor can claim a slug after the availability check.
                if ((string)$exception->getCode() !== '23000') throw $exception;
                $saved = false;
            }
            if ($saved) {
                flash('info', 'Share settings saved.');
                redirect('/admin/share?share_id=' . $id);
            }
            http_response_code(409);
            $error = 'This share or its link changed while saving. Reload and try again.';
        } elseif (http_response_code() !== 409) http_response_code(400);
    }
    $escape = static fn($value): string => htmlspecialchars((string)$value, ENT_QUOTES, 'UTF-8');
    $content = '<div class="admin-page-heading"><div><a class="admin-back" href="' . base_path() . '/dashboard">← Shares</a><h1>Share settings</h1><p class="muted">' . $escape($share['title']) . '</p></div><a class="button" href="' . $escape(share_url($share['slug'])) . '" target="_blank" rel="noopener">Open share</a></div>';
    if ($message = flash('info')) $content .= '<p class="flash" role="status">' . $escape($message) . '</p>';
    if ($error !== '') $content .= '<p class="flash error" role="alert">' . $escape($error) . '</p>';
    $content .= '<form class="share-editor settings-form" method="post">' . render_hidden_inputs(['csrf' => csrf_token(), 'revision' => $_SERVER['REQUEST_METHOD'] === 'POST' ? $postedRevision : $share['revision']]);
    $content .= '<section class="card settings-section"><h2>Share link</h2><label>Title<input class="input" name="title" maxlength="500" required value="' . $escape($values['title']) . '"></label><label>Link suffix<input class="input" name="slug" pattern="[a-zA-Z0-9]{6,32}" minlength="6" maxlength="32" required value="' . $escape($values['slug']) . '"><span class="field-hint">Changing this invalidates the old link.</span></label><label>Current share URL<input class="input" readonly value="' . $escape(share_url($share['slug'])) . '"></label></section>';
    $content .= '<section class="card settings-section"><h2>Access</h2><label>Expires at (UTC+8)<input class="input" type="datetime-local" name="expires_at" value="' . $escape($values['expires_at']) . '"><span class="field-hint">Leave empty for no expiry.</span></label><label>Visitor limit<input class="input" type="number" min="0" max="999999999" name="visitor_limit" required value="' . $escape($values['visitor_limit']) . '"><span class="field-hint">0 means unlimited. ' . share_visitor_count($id) . ' visitors recorded; changing the limit keeps the existing visitor records.</span></label></section>';
    $content .= '<section class="card settings-section"><h2>Password</h2><p class="muted">' . (share_requires_password($share) ? 'Password protected. The existing password cannot be retrieved. You can replace or remove it below.' : 'Anyone with the link can read this share.') . '</p><fieldset class="password-options"><legend class="sr-only">Password action</legend>';
    foreach (['keep' => 'Keep current protection', 'set' => 'Set a new password', 'remove' => 'Remove password protection'] as $value => $label) {
        $content .= '<label class="choice-row"><input type="radio" name="password_mode" value="' . $value . '"' . ($values['password_mode'] === $value ? ' checked' : '') . '>' . $label . '</label>';
    }
    $content .= '</fieldset><div class="form-field"><label for="share-new-password">New password</label><div class="password-field"><input class="input" id="share-new-password" type="password" name="password" autocomplete="new-password" aria-describedby="new-password-hint" data-share-new-password><button class="button ghost" type="button" data-password-visibility="share-new-password" aria-controls="share-new-password" aria-pressed="false">Show</button></div><p id="new-password-hint" class="field-hint">Changing the password makes visitors sign in again with the new password.</p></div></section><div class="form-actions"><button class="button primary" type="submit">Save changes</button><a class="button ghost" href="' . base_path() . '/dashboard">Cancel</a></div></form>';
    render_page('Share settings', $content, $user, '', ['nav' => 'dashboard']);
}
