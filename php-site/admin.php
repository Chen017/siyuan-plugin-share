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
    if ($_SERVER['REQUEST_METHOD'] === 'POST' && !github_only()) {
        $stmt = db()->prepare('SELECT * FROM users WHERE username = ? AND role = "admin" AND disabled = 0 LIMIT 1');
        $stmt->execute([trim((string)($_POST['username'] ?? ''))]);
        $user = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$user || !password_verify((string)($_POST['password'] ?? ''), (string)$user['password_hash'])) {
            flash('error', 'Invalid username or password.');
            redirect('/login');
        }
        $returnTo = is_string($_SESSION['oauth_return_to'] ?? null) ? $_SESSION['oauth_return_to'] : null;
        unset($_SESSION['oauth_return_to']);
        session_regenerate_id(true);
        unset($_SESSION['auth_method'], $_SESSION['github_session']);
        $_SESSION['user_id'] = $user['id'];
        $_SESSION['password_hash'] = $user['password_hash'];
        if ((int)$user['must_change_password'] === 1) {
            redirect('/account');
        }
        if (mcp_is_safe_oauth_return_to($returnTo)) {
            redirect($returnTo);
        }
        redirect('/dashboard');
    }
    $content = '<div class="auth-card"><h1>Sign in</h1><p class="auth-description">Manage your shared notes.</p>';
    if ($error = flash('error')) $content .= '<p class="flash error" role="alert">' . htmlspecialchars($error) . '</p>';
    if ($info = flash('info')) $content .= '<p class="flash" role="status">' . htmlspecialchars($info) . '</p>';
    if (github_oauth_config()) $content .= '<a class="button primary w-full" href="' . base_path() . '/auth/github">Sign in with GitHub</a>';
    if (!github_only()) {
        $content .= '<form method="post" class="auth-form">' . render_hidden_inputs(['csrf' => csrf_token()]);
        $content .= '<label>Username<input class="auth-input" name="username" autocomplete="username" required></label>';
        $content .= '<label>Password<input class="auth-input" type="password" name="password" autocomplete="current-password" required></label>';
        $content .= '<button class="button primary w-full" type="submit">Sign in</button></form>';
    } elseif (!github_oauth_config()) {
        $content .= '<p class="flash error">GitHub sign-in is unavailable. Contact the site administrator.</p>';
    }
    $content .= '</div>';
    render_page('Sign in', $content, null, '', ['layout' => 'auth']);
}

if ($path === '/auth/github' || $path === '/auth/github/callback') {
    handle_github_auth($path);
}

if ($path === '/account') {
    if (github_only()) redirect('/dashboard');
    $user = require_admin(true);
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
        if ((int)$user['must_change_password'] === 1 && password_verify($new, (string)$user['password_hash'])) {
            flash('error', 'Choose a different password from the initial password.');
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
    $undo = $_SESSION['share_undo'] ?? null;
    unset($_SESSION['share_undo']);
    if (is_array($undo)) {
        $content .= '<div class="flash" role="status" data-notice-persistent><span>Deleted &ldquo;' . htmlspecialchars((string)$undo['title'], ENT_QUOTES, 'UTF-8') . '&rdquo;. The share link is inactive.</span><form class="inline-form" method="post" action="' . $base . '/admin/share-restore">' . render_hidden_inputs(['csrf' => csrf_token(), 'share_id' => (int)$undo['id']]) . '<button class="button" type="submit">Undo</button></form><button class="button ghost" type="button" data-notice-dismiss aria-label="Dismiss notification">×</button></div>';
    }
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
            $confirm = $action === 'hard-delete' ? ' data-confirm-message="' . htmlspecialchars('Permanently delete “' . $share['title'] . '” and its files? This cannot be undone.', ENT_QUOTES, 'UTF-8') . '"' : '';
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
    $headHtml = (string)get_setting('site_head_html', '');
    $headNormalized = str_replace(["\r\n", "\r"], "\n", trim($headHtml));
    $headLines = $headNormalized !== '' ? substr_count($headNormalized, "\n") + 1 : 0;
    $headStatus = $headLines > 0
        ? 'Configured · ' . $headLines . ' ' . ($headLines === 1 ? 'line' : 'lines')
        : 'Not configured';
    $content = '<div class="admin-page-heading"><div><p class="admin-eyebrow">Preferences</p><h1>Site settings</h1><p class="muted">Storage, public links and head markup.</p></div></div><div class="card settings-section" id="settings"><h2>General</h2>';
    foreach (['error', 'info'] as $kind) if ($message = flash($kind)) $content .= '<p class="flash' . ($kind === 'error' ? ' error' : '') . '" role="status">' . htmlspecialchars($message) . '</p>';
    $content .= '<form class="settings-form" method="post" action="' . $base . '/admin/settings">' . render_hidden_inputs(['csrf' => csrf_token()]);
    $content .= '<div class="setting-field"><label for="storage-limit">Storage limit <span class="field-unit">(MB)</span></label><input id="storage-limit" aria-describedby="storage-limit-hint" class="input input--short" type="number" min="0" name="default_storage_limit_mb" value="' . mb_from_bytes(default_storage_limit_bytes()) . '"><p class="field-hint" id="storage-limit-hint">0 means unlimited. Notes and attachments count toward this limit.</p></div>';
    $content .= '<div class="setting-field"><label for="site-base-url">Website URL</label><input class="input" id="site-base-url" name="site_base_url" type="url" placeholder="https://example.com" value="' . htmlspecialchars((string)get_setting('site_base_url', ''), ENT_QUOTES) . '"><p class="field-hint">Public link prefix used for shares. Leave empty to use the request address.</p></div>';
    $content .= '<div class="setting-field"><label for="reader-home-url">Reader home URL</label><input class="input" id="reader-home-url" name="reader_home_url" type="url" placeholder="https://example.com/s/home" value="' . htmlspecialchars((string)get_setting('reader_home_url', ''), ENT_QUOTES) . '"><p class="field-hint">Optional Home button target shown on other shares. Leave empty to disable.</p></div>';
    $content .= '<section class="settings-group"><h2>HTML Head</h2>';
    $content .= '<details class="code-setting-row"><summary class="code-setting-summary"><span class="code-setting-meta"><span class="code-setting-title">Head HTML insertion</span><span class="field-hint">Inserted into &lt;head&gt; on site pages. Use only trusted markup.</span></span><span class="code-setting-actions"><span class="code-setting-status' . ($headLines > 0 ? ' is-configured' : '') . '">' . $headStatus . '</span><span class="button code-setting-toggle"><span class="code-setting-toggle__open">Edit</span><span class="code-setting-toggle__close">Close</span></span></span></summary>';
    $content .= '<div class="code-setting-editor"><label class="sr-only" for="site-head-html">Head HTML insertion</label><textarea class="input code-input" id="site-head-html" name="site_head_html" rows="5" placeholder="&lt;meta ...&gt; or &lt;link ...&gt;">' . htmlspecialchars($headHtml, ENT_QUOTES, 'UTF-8') . '</textarea></div></details>';
    $content .= '</section><div class="settings-actions"><button class="button primary" type="submit">Save settings</button></div></form></div>';
    $content .= render_image_compression_admin_section();
    $content .= render_pdf_export_settings();
    $key = (string)($_SESSION['api_key_plain'] ?? '');
    unset($_SESSION['api_key_plain']);
    $content .= '<details class="plugin-connection card" id="plugin-connection"' . ($key !== '' ? ' open' : '') . '><summary>Plugin connection</summary><p class="muted">The SiYuan plugin uses a connection key to authenticate synchronization. Generating a new key disconnects the old one.</p>';
    if ($key !== '') $content .= '<label class="field-label">New connection key<code class="connection-key">' . htmlspecialchars($key) . '</code></label><p class="field-hint">Copy this into the plugin now. It is shown only once.</p>';
    else $content .= '<p class="muted">' . (!empty($user['api_key_last4']) ? 'Connected · key ending ' . htmlspecialchars((string)$user['api_key_last4']) : 'No plugin connection yet') . '</p>';
    $confirm = !empty($user['api_key_last4']) ? ' data-confirm-message="Replace the connection key? Update it in your SiYuan plugin to reconnect."' : '';
    $content .= '<form method="post" action="' . $base . '/api-key/rotate"' . $confirm . '>' . render_hidden_inputs(['csrf' => csrf_token()]) . '<button class="button" type="submit">' . (!empty($user['api_key_last4']) ? 'Replace connection key' : 'Connect plugin') . '</button></form></details>';
    $content .= render_mcp_admin_section();

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
    $headHtml = trim((string)($_POST['site_head_html'] ?? ''));
    if (strlen($headHtml) > 200000) {
        flash('error', 'Head HTML insertion must be at most 200 KB.');
        redirect('/admin#settings');
    }
    foreach ([
        'reader_home_url' => $home,
        'default_storage_limit_bytes' => (string)bytes_from_mb(max(0, (int)($_POST['default_storage_limit_mb'] ?? 0))),
        'site_base_url' => trim((string)($_POST['site_base_url'] ?? '')),
        'site_head_html' => $headHtml,
    ] as $key => $value) {
        set_setting($key, $value);
    }
    flash('info', 'Site settings saved.');
    redirect('/admin#settings');
}

if (str_starts_with($path, '/admin/mcp/') && $_SERVER['REQUEST_METHOD'] === 'POST') {
    $user = require_admin();
    if (handle_mcp_admin_post($path, $user)) {
        exit;
    }
}

if ($path === '/admin/pdf-export-settings' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    require_admin();
    pdf_export_csrf();
    try { save_pdf_export_settings($_POST); flash('info', 'PDF export settings saved.'); }
    catch (InvalidArgumentException $error) { flash('error', $error->getMessage()); }
    redirect('/admin#settings');
}

if ($path === '/admin/images/compress' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    require_admin();
    check_csrf();
    $res = start_background_compression_job();
    flash($res['success'] ? 'info' : 'error', $res['message']);
    if (str_contains($_SERVER['HTTP_ACCEPT'] ?? '', 'application/json')) {
        api_response($res['success'] ? 200 : 400, $res);
    }
    redirect('/admin#image-compression');
}

if ($path === '/admin/images/compress-stop' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    require_admin();
    check_csrf();
    $res = request_stop_background_compression();
    flash($res['success'] ? 'info' : 'error', $res['message']);
    if (str_contains($_SERVER['HTTP_ACCEPT'] ?? '', 'application/json')) {
        api_response($res['success'] ? 200 : 400, $res);
    }
    redirect('/admin#image-compression');
}

if ($path === '/admin/images/status' && $_SERVER['REQUEST_METHOD'] === 'GET') {
    require_admin();
    header('Cache-Control: no-store');
    $stats = get_image_compression_stats(db());
    $task = get_background_compression_status();
    api_response(200, array_merge($stats, ['background_task' => $task]));
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
        if ($path === '/admin/share-delete') $_SESSION['share_undo'] = ['id' => $id, 'title' => $share['title']];
        else flash('info', $path === '/admin/share-restore' ? 'Share restored. Its link is available again.' : 'Share permanently deleted.');
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
    render_page('Home', $content, null, '', ['celebration' => true]);
}
