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
        check_csrf();
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
    $content = '<div class="auth-card">' . render_auth_mascot() . '<h1>Sign in</h1>';
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
    flash('info', 'API key created. Copy it now; it will be shown only once.');
    redirect('/dashboard');
}

if ($path === '/dashboard') {
    $user = require_admin();
    $used = recalculate_user_storage((int)$user['id']);
    $limit = get_user_limit_bytes($user);
    $allStored = (int)db()->query('SELECT COALESCE(SUM(size_bytes), 0) FROM shares')->fetchColumn();
    $content = '<div class="card"><h1>Notes</h1><p>Storage for this API key: ' . format_bytes($used) . ' / ' . ($limit > 0 ? format_bytes($limit) : 'Unlimited') . '</p><p>All stored notes and attachments: ' . format_bytes($allStored) . '</p>';
    foreach (['error', 'info'] as $kind) if ($message = flash($kind)) $content .= '<p class="flash">' . htmlspecialchars($message) . '</p>';
    $key = (string)($_SESSION['api_key_plain'] ?? '');
    unset($_SESSION['api_key_plain']);
    if ($key !== '') $content .= '<p>API key: <code>' . htmlspecialchars($key) . '</code></p>';
    else $content .= '<p>API key: ' . (!empty($user['api_key_last4']) ? '••••' . htmlspecialchars((string)$user['api_key_last4']) : 'Not created') . '</p>';
    $content .= '<form method="post" action="' . $base . '/api-key/rotate">' . render_hidden_inputs(['csrf' => csrf_token()]) . '<button class="button" type="submit">Generate API key</button></form></div>';
    $search = trim((string)($_GET['share_search'] ?? ''));
    $status = (string)($_GET['status'] ?? 'active');
    if (!in_array($status, ['active', 'deleted', 'all'], true)) $status = 'active';
    $where = $status === 'active' ? 'deleted_at IS NULL' : ($status === 'deleted' ? 'deleted_at IS NOT NULL' : '1=1');
    $params = [];
    if ($search !== '') { $where .= ' AND (title LIKE ? OR slug LIKE ?)'; $params = ['%' . $search . '%', '%' . $search . '%']; }
    $stmt = db()->prepare('SELECT COUNT(*) FROM shares WHERE ' . $where);
    $stmt->execute($params);
    [$page, $size, $pages, $offset] = paginate((int)$stmt->fetchColumn(), max(1, (int)($_GET['share_page'] ?? 1)), normalize_page_size($_GET['share_size'] ?? 10));
    $stmt = db()->prepare('SELECT * FROM shares WHERE ' . $where . ' ORDER BY updated_at DESC LIMIT ? OFFSET ?');
    foreach ($params as $i => $value) $stmt->bindValue($i + 1, $value);
    $stmt->bindValue(count($params) + 1, $size, PDO::PARAM_INT);
    $stmt->bindValue(count($params) + 2, $offset, PDO::PARAM_INT);
    $stmt->execute();
    $content .= '<div class="card" id="shares"><h2>Shares</h2><form class="share-filter-form" method="get"><label>Search<input class="input" name="share_search" value="' . htmlspecialchars($search) . '"></label><label>Status<select class="input" name="status">';
    foreach (['active' => 'Active', 'deleted' => 'Deleted', 'all' => 'All'] as $value => $label) $content .= '<option value="' . $value . '"' . ($status === $value ? ' selected' : '') . '>' . $label . '</option>';
    $content .= '</select></label><button class="button" type="submit">Search</button></form><div class="table-scroll table-scroll-has-actions"><table class="table table-has-actions"><thead><tr><th>Title</th><th>Size</th><th>Visitor limit</th><th class="actions">Actions</th></tr></thead><tbody>';
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $share) {
        $content .= '<tr><td><a href="' . htmlspecialchars($base . '/s/' . $share['slug'], ENT_QUOTES) . '">' . htmlspecialchars($share['title']) . '</a></td><td>' . format_bytes((int)$share['size_bytes']) . '</td><td>' . ((int)$share['visitor_limit'] ?: 'Unlimited') . '</td><td class="actions">';
        $actions = $share['deleted_at'] ? ['restore' => 'Restore', 'hard-delete' => 'Delete permanently'] : ['delete' => 'Move to deleted'];
        foreach ($actions as $action => $label) {
            $confirm = $action === 'hard-delete' ? ' data-confirm-message="Permanently delete this share and its files?"' : '';
            $content .= '<form class="inline-form" method="post" action="' . $base . '/admin/share-' . $action . '"' . $confirm . '>' . render_hidden_inputs(['csrf' => csrf_token(), 'share_id' => $share['id']]) . '<button class="button" type="submit">' . $label . '</button></form>';
        }
        $content .= '</td></tr>';
    }
    $content .= '</tbody></table></div><p>Page ' . $page . ' / ' . $pages . '</p>';
    if ($page > 1) $content .= '<a class="button" href="' . htmlspecialchars(build_dashboard_query_url(['share_page' => $page - 1]), ENT_QUOTES) . '">Previous</a> ';
    if ($page < $pages) $content .= '<a class="button" href="' . htmlspecialchars(build_dashboard_query_url(['share_page' => $page + 1]), ENT_QUOTES) . '">Next</a>';
    $content .= '</div>';
    render_page('Notes', $content, $user, '', ['nav' => 'dashboard']);
}

if ($path === '/admin') {
    $user = require_admin();
    $content = '<div class="card" id="settings"><h1>Site settings</h1>';
    foreach (['error', 'info'] as $kind) if ($message = flash($kind)) $content .= '<p class="flash">' . htmlspecialchars($message) . '</p>';
    $content .= '<form class="settings-form" method="post" action="' . $base . '/admin/settings">' . render_hidden_inputs(['csrf' => csrf_token()]);
    $content .= '<label>Storage limit (MB)<input class="input" type="number" min="0" name="default_storage_limit_mb" value="' . mb_from_bytes(default_storage_limit_bytes()) . '"></label><p class="muted">0 means unlimited. Stored notes and attachments count toward the limit.</p>';
    $content .= '<label for="site-base-url">Website URL / share link prefix</label><input class="input" id="site-base-url" name="site_base_url" type="url" value="' . htmlspecialchars((string)get_setting('site_base_url', ''), ENT_QUOTES) . '"><details><summary>About the share link prefix</summary><p>Use the public website address, including any subdirectory. This is useful when HTTPS terminates at a reverse proxy. Leave empty to use the request address.</p></details>';
    $content .= '<label for="reader-home-url">Reader home URL</label><input class="input" id="reader-home-url" type="url" name="reader_home_url" value="' . htmlspecialchars((string)get_setting('reader_home_url', ''), ENT_QUOTES) . '"><p class="muted">Other shares show Home. Documents and anchors within the home share do not. Leave empty to disable.</p>';
    $content .= '<label for="site-head-html">HTML Head insertion</label><textarea class="input code-input" id="site-head-html" name="site_head_html" rows="4">' . htmlspecialchars((string)get_setting('site_head_html', '')) . '</textarea><p class="muted">Inserted into the document head. Use only code you trust.</p>';
    foreach (['css' => true, 'js' => false] as $kind => $default) {
        $upper = strtoupper($kind);
        $enabled = get_bool_setting('site_custom_' . $kind . '_enabled', $default);
        $content .= '<label><input type="checkbox" name="site_custom_' . $kind . '_enabled" value="1"' . ($enabled ? ' checked' : '') . '> Enable custom ' . $upper . '</label>';
        $content .= '<label for="custom-' . $kind . '">Custom ' . $upper . '</label><textarea class="input code-input" id="custom-' . $kind . '" name="site_custom_' . $kind . '" rows="8">' . htmlspecialchars((string)get_setting('site_custom_' . $kind, '')) . '</textarea>';
        $example = $kind === 'css' ? 'body.layout-share .markdown-body { max-width: 980px; }' : 'document.querySelectorAll(".markdown-body a").forEach((link) => { link.rel = "noopener"; });';
        $content .= '<details><summary>Custom ' . $upper . ' help and example</summary><p>' . ($kind === 'css' ? 'Scope selectors to body.layout-share or body.layout-app. Rules load after the site stylesheet.' : 'JavaScript runs after DOMContentLoaded. It is disabled by default. Use only trusted scripts.') . '</p><pre class="help-code">' . htmlspecialchars($example) . '</pre></details>';
    }
    $content .= '<button class="button primary" type="submit">Save settings</button></form></div>';
    $content .= render_pdf_export_settings();
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
            db()->prepare('UPDATE shares SET deleted_at = ?, updated_at = ? WHERE id = ?')->execute([$path === '/admin/share-delete' ? now() : null, now(), $id]);
            recalculate_user_storage((int)$share['user_id']);
        }
        flash('info', 'Share updated.');
    }
    redirect('/dashboard#shares');
}

if ($path === '/') {
    if ($user = current_user()) redirect('/dashboard');
    $content = '<section class="home-hero"><div class="home-hero__main"><h1 class="home-title">' . htmlspecialchars($config['app_name']) . '</h1><p class="home-lead">Read and share notes.</p><div class="home-actions">';
    $home = trim((string)get_setting('reader_home_url', ''));
    if (reader_home_url_key($home) !== '') $content .= '<a class="button primary" href="' . htmlspecialchars($home, ENT_QUOTES) . '">Home</a>';
    $content .= '<a class="button" href="' . $base . '/login">Sign in</a></div></div></section>';
    render_page('Home', $content, null);
}
