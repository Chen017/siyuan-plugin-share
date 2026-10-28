<?php
declare(strict_types=1);

// Loaded by index.php after public reader and sync routes have been handled.
if (!function_exists('db')) { http_response_code(404); exit; }

if ($path === '/logout' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    check_csrf();
    $_SESSION = [];
    session_destroy();
    redirect('/login');
}

if ($path === '/login') {
    if ($_SERVER['REQUEST_METHOD'] === 'POST') check_csrf();
    if (current_user()) redirect('/dashboard');
    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        $stmt = db()->prepare('SELECT * FROM users WHERE username = ? AND role = "admin" AND disabled = 0 LIMIT 1');
        $stmt->execute([trim((string)($_POST['username'] ?? ''))]);
        $user = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$user || !password_verify((string)($_POST['password'] ?? ''), (string)$user['password_hash'])) {
            flash('error', 'Invalid username or password.');
            redirect('/login');
        }
        session_regenerate_id(true);
        $_SESSION['user_id'] = $user['id'];
        $_SESSION['password_hash'] = $user['password_hash'];
        redirect((int)$user['must_change_password'] === 1 ? '/account' : '/dashboard');
    }
    $content = '<div class="auth-card"><h1>Sign in</h1><p class="auth-description">Manage your shared notes.</p>';
    if ($error = flash('error')) $content .= '<p class="flash error" role="alert">' . htmlspecialchars($error) . '</p>';
    if ($info = flash('info')) $content .= '<p class="flash" role="status">' . htmlspecialchars($info) . '</p>';
    $content .= '<form method="post" class="auth-form">' . render_hidden_inputs(['csrf' => csrf_token()]);
    $content .= '<label>Username<input class="auth-input" name="username" autocomplete="username" required></label>';
    $content .= '<label>Password<input class="auth-input" type="password" name="password" autocomplete="current-password" required></label>';
    $content .= '<button class="button primary w-full" type="submit">Sign in</button></form></div>';
    render_page('Sign in', $content, null, '', ['layout' => 'auth']);
}

if ($path === '/account') {
    $user = require_admin();
    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        check_csrf();
        $new = (string)($_POST['new_password'] ?? '');
        if (strlen($new) < 6 || $new !== (string)($_POST['confirm_password'] ?? '')) {
            flash('error', 'Use matching passwords with at least 6 characters.');
            redirect('/account');
        }
        if (!password_verify((string)($_POST['current_password'] ?? ''), (string)$user['password_hash'])) {
            flash('error', 'Incorrect current password.');
            redirect('/account');
        }
        db()->prepare('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?')
            ->execute([password_hash($new, PASSWORD_DEFAULT), now(), $user['id']]);
        unset($_SESSION['user_id'], $_SESSION['password_hash']);
        session_regenerate_id(true);
        flash('info', 'Password updated. Sign in again.');
        redirect('/login');
    }
    $content = '<div class="card"><h1>Password</h1>';
    foreach (['error', 'info'] as $kind) if ($message = flash($kind)) $content .= '<p class="flash">' . htmlspecialchars($message) . '</p>';
    if ((int)$user['must_change_password'] === 1) $content .= '<p class="notice">Change the initial password before using this site.</p>';
    $content .= '<form class="settings-form" method="post">' . render_hidden_inputs(['csrf' => csrf_token()]);
    foreach (['current_password' => 'Current password', 'new_password' => 'New password', 'confirm_password' => 'Confirm new password'] as $name => $label) {
        $auto = $name === 'current_password' ? 'current-password' : 'new-password';
        $content .= '<label>' . $label . '<input class="input" type="password" name="' . $name . '" autocomplete="' . $auto . '" required></label>';
    }
    $content .= '<button class="button primary" type="submit">Update password</button></form></div>';
    render_page('Password', $content, $user, '', ['nav' => 'account']);
}

if ($path === '/api-key/rotate' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    $user = require_admin();
    check_csrf();
    $key = generate_api_key();
    db()->prepare('UPDATE users SET api_key_hash = ?, api_key_prefix = ?, api_key_last4 = ?, updated_at = ? WHERE id = ?')
        ->execute([$key[1], $key[2], $key[3], now(), $user['id']]);
    $_SESSION['api_key_plain'] = $key[0];
    flash('info', 'Connection key created. Copy it into the plugin now; it is shown only once.');
    redirect('/admin#plugin-connection');
}

if ($path === '/admin/share') {
    $user = require_admin();
    require_once __DIR__ . '/admin-share.php';
    render_admin_share_editor((int)($_GET['share_id'] ?? 0), $user);
}

if ($path === '/dashboard') {
    $user = require_admin();
    $used = recalculate_user_storage((int)$user['id']);
    $limit = get_user_limit_bytes($user);
    $allStored = (int)db()->query('SELECT COALESCE(SUM(size_bytes), 0) FROM shares')->fetchColumn();
    $content = '<div class="admin-page-heading"><div><p class="admin-eyebrow">Your library</p><h1>Shared notes</h1><p class="muted">Manage links, passwords and access in one place.</p></div><div class="storage-summary"><span>Storage used</span><strong>' . format_bytes($used) . '</strong><small>of ' . ($limit > 0 ? format_bytes($limit) : 'unlimited storage') . '</small></div></div>';
    if ($allStored !== $used) $content .= '<p class="muted">All retained notes and attachments: ' . format_bytes($allStored) . '</p>';
    foreach (['error', 'info'] as $kind) if ($message = flash($kind)) $content .= '<p class="flash' . ($kind === 'error' ? ' error' : '') . '" role="status">' . htmlspecialchars($message) . '</p>';
    $search = trim((string)($_GET['share_search'] ?? ''));
    $status = (string)($_GET['status'] ?? 'active');
    if (!in_array($status, ['active', 'deleted', 'all'], true)) $status = 'active';
    $where = $status === 'active' ? 'deleted_at IS NULL' : ($status === 'deleted' ? 'deleted_at IS NOT NULL' : '1=1');
    $params = [];
    if ($search !== '') { $where .= ' AND (title LIKE ? OR slug LIKE ?)'; $params = ['%' . $search . '%', '%' . $search . '%']; }
    $stmt = db()->prepare('SELECT * FROM shares WHERE ' . $where . ' ORDER BY updated_at DESC, id DESC');
    $stmt->execute($params);
    $content .= '<div class="card" id="shares"><h2>Shares</h2><form class="share-filter-form" method="get"><label>Search<input class="input" name="share_search" value="' . htmlspecialchars($search) . '"></label><label>Status<select class="input" name="status">';
    foreach (['active' => 'Active', 'deleted' => 'Deleted', 'all' => 'All'] as $value => $label) $content .= '<option value="' . $value . '"' . ($status === $value ? ' selected' : '') . '>' . $label . '</option>';
    $content .= '</select></label><button class="button" type="submit">Search</button></form><div class="share-grid" role="list" aria-label="Shared notes">';
    $listedShares = $stmt->fetchAll(PDO::FETCH_ASSOC);
    foreach ($listedShares as $share) {
        $deleted = !empty($share['deleted_at']);
        $title = htmlspecialchars($share['title']);
        $manage = $base . '/admin/share?share_id=' . (int)$share['id'];
        $content .= '<article class="share-card" role="listitem"><div class="share-card-heading"><div class="share-title-cell">' . ($deleted ? '<strong>' . $title . '</strong>' : '<a class="share-title-link" href="' . $manage . '">' . $title . '</a>') . '<small>' . ($share['type'] === 'notebook' ? 'Notebook' : 'Document') . ' · /s/' . htmlspecialchars($share['slug']) . '</small></div><span class="share-card-size">' . format_bytes((int)$share['size_bytes']) . '</span></div>';
        $statusLabel = $deleted ? 'Deleted' : (share_is_expired($share) ? 'Expired' : (share_requires_password($share) ? 'Password protected' : 'Anyone with the link'));
        $content .= '<div class="share-card-bottom"><div class="share-card-meta"><span class="share-access-status">' . $statusLabel . '</span><small>' . (!empty($share['expires_at']) ? 'Expires ' . date('Y-m-d H:i', (int)$share['expires_at']) . ' (UTC+8)' : 'No expiry') . '</small></div><div class="table-actions">';
        if (!$deleted) $content .= '<a class="button" href="' . $manage . '">Manage</a>';
        $actions = $deleted ? ['restore' => 'Restore', 'hard-delete' => 'Delete permanently'] : ['delete' => 'Delete'];
        foreach ($actions as $action => $label) {
            $confirm = $action === 'hard-delete' ? ' data-confirm-message="Permanently delete this share and its files?"' : '';
            $content .= '<form class="inline-form" method="post" action="' . $base . '/admin/share-' . $action . '"' . $confirm . '>' . render_hidden_inputs(['csrf' => csrf_token(), 'share_id' => $share['id']]) . '<button class="button' . ($action === 'restore' ? '' : ' danger') . '" type="submit">' . $label . '</button></form>';
        }
        $content .= '</div></div></article>';
    }
    if (!$listedShares) $content .= '<p class="admin-empty">' . ($search !== '' ? 'No shares match your search.' : ($status === 'deleted' ? 'No deleted shares.' : 'No shared notes yet. Share a notebook from the SiYuan plugin to begin.')) . '</p>';
    $content .= '</div></div>';
    render_page('Shares', $content, $user, '', ['nav' => 'dashboard']);
}

if ($path === '/admin') {
    $user = require_admin();
    $content = '<div class="admin-page-heading"><div><p class="admin-eyebrow">Preferences</p><h1>Site settings</h1><p class="muted">Reading, storage and appearance.</p></div></div><div class="card settings-section" id="settings"><h2>Storage</h2>';
    foreach (['error', 'info'] as $kind) if ($message = flash($kind)) $content .= '<p class="flash">' . htmlspecialchars($message) . '</p>';
    $content .= '<form class="settings-form" method="post" action="' . $base . '/admin/settings">' . render_hidden_inputs(['csrf' => csrf_token()]);
    $content .= '<label for="storage-limit">Storage limit <span class="field-unit">(MB)</span></label><input id="storage-limit" aria-describedby="storage-limit-hint" class="input" type="number" min="0" name="default_storage_limit_mb" value="' . mb_from_bytes(default_storage_limit_bytes()) . '"><p class="field-hint" id="storage-limit-hint">0 means unlimited. Stored notes and attachments count toward the limit.</p><section class="settings-group"><h2>Reading & links</h2>';
    $content .= '<label for="site-base-url">Website URL / share link prefix</label><input class="input" id="site-base-url" name="site_base_url" type="url" value="' . htmlspecialchars((string)get_setting('site_base_url', ''), ENT_QUOTES) . '"><details><summary>About the share link prefix</summary><p>Use the public website address, including any subdirectory. This is useful when HTTPS terminates at a reverse proxy. Leave empty to use the request address.</p></details>';
    $content .= '<label for="reader-home-url">Reader home URL</label><input class="input" id="reader-home-url" type="url" name="reader_home_url" value="' . htmlspecialchars((string)get_setting('reader_home_url', ''), ENT_QUOTES) . '"><p class="muted">Other shares show Home. Documents and anchors within the home share do not. Leave empty to disable.</p>';
    $content .= '</section><section class="settings-group"><h2>Appearance & customization</h2><label for="site-head-html">HTML Head insertion</label><textarea class="input code-input" id="site-head-html" name="site_head_html" rows="4">' . htmlspecialchars((string)get_setting('site_head_html', '')) . '</textarea><p class="muted">Inserted into the document head. Use only code you trust.</p>';
    foreach (['css' => true, 'js' => false] as $kind => $default) {
        $upper = strtoupper($kind);
        $enabled = get_bool_setting('site_custom_' . $kind . '_enabled', $default);
        $content .= '<label class="choice-row"><input type="checkbox" name="site_custom_' . $kind . '_enabled" value="1"' . ($enabled ? ' checked' : '') . '> Enable custom ' . $upper . '</label>';
        $content .= '<label for="custom-' . $kind . '">Custom ' . $upper . '</label><textarea class="input code-input" id="custom-' . $kind . '" name="site_custom_' . $kind . '" rows="8">' . htmlspecialchars((string)get_setting('site_custom_' . $kind, '')) . '</textarea>';
        $example = $kind === 'css' ? 'body.layout-share .markdown-body { max-width: 980px; }' : 'document.querySelectorAll(".markdown-body a").forEach((link) => { link.rel = "noopener"; });';
        $content .= '<details><summary>Custom ' . $upper . ' help and example</summary><p>' . ($kind === 'css' ? 'Scope selectors to body.layout-share or body.layout-app. Rules load after the site stylesheet.' : 'JavaScript runs after DOMContentLoaded. It is disabled by default. Use only trusted scripts.') . '</p><pre class="help-code">' . htmlspecialchars($example) . '</pre></details>';
    }
    $content .= '</section><button class="button primary" type="submit">Save settings</button></form></div>';
    $content .= render_pdf_export_settings();
    $key = (string)($_SESSION['api_key_plain'] ?? '');
    unset($_SESSION['api_key_plain']);
    $content .= '<details class="plugin-connection card" id="plugin-connection"' . ($key !== '' ? ' open' : '') . '><summary>Plugin connection</summary><p class="muted">The SiYuan plugin uses a connection key to authenticate synchronization. Existing connections keep working. Generating a new key disconnects the old one.</p>';
    if ($key !== '') $content .= '<label class="field-label">New connection key<code class="connection-key">' . htmlspecialchars($key) . '</code></label><p class="field-hint">Copy this into the plugin now. It is shown only once.</p>';
    else $content .= '<p class="muted">' . (!empty($user['api_key_last4']) ? 'Connected · key ending ' . htmlspecialchars((string)$user['api_key_last4']) : 'No plugin connection yet') . '</p>';
    $confirm = !empty($user['api_key_last4']) ? ' data-confirm-message="Replace the connection key? Update it in your SiYuan plugin to reconnect."' : '';
    $content .= '<form method="post" action="' . $base . '/api-key/rotate"' . $confirm . '>' . render_hidden_inputs(['csrf' => csrf_token()]) . '<button class="button" type="submit">' . (!empty($user['api_key_last4']) ? 'Replace connection key' : 'Connect plugin') . '</button></form></details>';

    render_page('Site settings', $content, $user, '', ['nav' => 'admin-settings']);
}

if ($path === '/admin/settings' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    require_admin();
    check_csrf();
    $home = trim((string)($_POST['reader_home_url'] ?? get_setting('reader_home_url', '')));
    if ($home !== '' && (strlen($home) > 2048 || !filter_var($home, FILTER_VALIDATE_URL) || reader_home_url_key($home) === '')) {
        flash('error', 'Enter a valid HTTP or HTTPS home URL without credentials.');
        redirect('/admin#settings');
    }
    $css = str_replace(["\r\n", "\r"], "\n", (string)($_POST['site_custom_css'] ?? ''));
    $js = str_replace(["\r\n", "\r"], "\n", (string)($_POST['site_custom_js'] ?? ''));
    if (strlen($css) > 200000 || strlen($js) > 200000) {
        flash('error', 'Custom CSS and JavaScript must each be at most 200 KB.');
        redirect('/admin#settings');
    }
    foreach (['reader_home_url' => $home, 'default_storage_limit_bytes' => (string)bytes_from_mb(max(0, (int)($_POST['default_storage_limit_mb'] ?? 0))),
        'site_base_url' => trim((string)($_POST['site_base_url'] ?? '')), 'site_head_html' => trim((string)($_POST['site_head_html'] ?? '')),
        'site_custom_css' => $css, 'site_custom_js' => $js, 'site_custom_css_enabled' => isset($_POST['site_custom_css_enabled']) ? '1' : '0',
        'site_custom_js_enabled' => isset($_POST['site_custom_js_enabled']) ? '1' : '0'] as $key => $value) set_setting($key, $value);
    flash('info', 'Site settings saved.');
    redirect('/admin#settings');
}

if ($path === '/admin/pdf-export-settings' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    require_admin();
    pdf_export_csrf();
    try { save_pdf_export_settings($_POST); flash('info', 'PDF export settings saved.'); }
    catch (InvalidArgumentException $error) { flash('error', $error->getMessage()); }
    redirect('/admin#settings');
}

if (in_array($path, ['/admin/share-delete', '/admin/share-restore', '/admin/share-hard-delete'], true) && $_SERVER['REQUEST_METHOD'] === 'POST') {
    require_admin();
    check_csrf();
    $id = (int)($_POST['share_id'] ?? 0);
    $lookup = db()->prepare('SELECT * FROM shares WHERE id = ?');
    $lookup->execute([$id]);
    $share = $lookup->fetch(PDO::FETCH_ASSOC);
    if ($share) {
        if ($path === '/admin/share-hard-delete') hard_delete_share($id);
        else {
            db()->prepare('UPDATE shares SET revision = revision + 1, deleted_at = ?, updated_at = ? WHERE id = ?')->execute([$path === '/admin/share-delete' ? now() : null, now(), $id]);
            recalculate_user_storage((int)$share['user_id']);
        }
        flash('info', 'Share updated.');
    }
    redirect('/dashboard#shares');
}

if ($path === '/') {
    if ($user = current_user()) redirect('/dashboard');
    $content = '<section class="home-hero"><div class="home-hero__main"><div class="notebook-emblem" aria-hidden="true">' . render_reader_icon('book') . '</div><h1 class="home-title">' . htmlspecialchars($config['app_name']) . '</h1><p class="home-lead">Explore shared notes, one idea at a time.</p><div class="home-actions">';
    $home = trim((string)get_setting('reader_home_url', ''));
    $hasHome = reader_home_url_key($home) !== '';
    if ($hasHome) $content .= '<a class="button primary" href="' . htmlspecialchars($home, ENT_QUOTES) . '">Open notebook' . render_reader_icon('arrow') . '</a>';
    $content .= '<a class="button' . ($hasHome ? '' : ' primary') . '" href="' . $base . '/login">Sign in</a></div></div></section>';
    render_page('Home', $content, null);
}
