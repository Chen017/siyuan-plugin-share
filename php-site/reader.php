<?php
declare(strict_types=1);

// Document trees, reader home navigation and full or partial reader responses.
function build_doc_tree(array $docs, ?string $activeId = null): array {
    $useParent = false;
    foreach ($docs as $doc) {
        if (isset($doc['parent_id']) && trim((string)$doc['parent_id']) !== '') {
            $useParent = true;
            break;
        }
    }
    if ($useParent) {
        $nodes = [];
        foreach ($docs as $docIndex => $doc) {
            $docId = trim((string)($doc['doc_id'] ?? ''));
            if ($docId === '') {
                continue;
            }
            $nodes[$docId] = [
                'title' => (string)($doc['title'] ?? $docId),
                'children' => [],
                'doc' => $doc,
                'contains_active' => false,
                'order' => is_numeric($doc['sort_index'] ?? null) ? (float)$doc['sort_index'] : $docIndex,
                'order_index' => $docIndex,
            ];
        }
        $tree = [];
        foreach ($nodes as $docId => &$node) {
            $parentId = trim((string)($node['doc']['parent_id'] ?? ''));
            if ($parentId !== '' && isset($nodes[$parentId]) && $parentId !== $docId) {
                $nodes[$parentId]['children'][$docId] =& $node;
            } else {
                $tree[$docId] =& $node;
            }
        }
        unset($node);
        mark_doc_tree_active($tree, $activeId);
        sort_doc_tree($tree);
        return $tree;
    }
    $root = ['children' => []];
    foreach ($docs as $docIndex => $doc) {
        $hpath = trim((string)($doc['hpath'] ?? ''), '/');
        $parts = $hpath !== '' ? array_values(array_filter(explode('/', $hpath))) : [];
        if (empty($parts)) {
            $parts = [trim((string)($doc['title'] ?? '')) ?: trim((string)($doc['doc_id'] ?? ''))];
        }
        $docOrder = isset($doc['sort_order']) ? (int)$doc['sort_order'] : $docIndex;
        $docOrderIndex = $docIndex;
        $node =& $root['children'];
        foreach ($parts as $idx => $part) {
            $isLast = $idx === count($parts) - 1;
            $key = $part;
            if (!isset($node[$key])) {
                $node[$key] = [
                    'title' => $part,
                    'children' => [],
                    'doc' => null,
                    'contains_active' => false,
                    'order' => $docOrder,
                    'order_index' => $docOrderIndex,
                ];
            } else {
                $existingOrder = $node[$key]['order'] ?? $docOrder;
                $existingIndex = $node[$key]['order_index'] ?? $docOrderIndex;
                if ($docOrder < $existingOrder || ($docOrder === $existingOrder && $docOrderIndex < $existingIndex)) {
                    $node[$key]['order'] = $docOrder;
                    $node[$key]['order_index'] = $docOrderIndex;
                }
            }
            if ($isLast) {
                $node[$key]['doc'] = $doc;
                $node[$key]['order'] = min($node[$key]['order'] ?? $docOrder, $docOrder);
                $node[$key]['order_index'] = min($node[$key]['order_index'] ?? $docOrderIndex, $docOrderIndex);
            }
            $node =& $node[$key]['children'];
        }
    }
    $tree = $root['children'];
    mark_doc_tree_active($tree, $activeId);
    sort_doc_tree($tree);
    return $tree;
}

function mark_doc_tree_active(array &$nodes, ?string $activeId = null): bool {
    $hasActive = false;
    foreach ($nodes as &$node) {
        $nodeHas = false;
        $doc = $node['doc'] ?? null;
        if ($activeId && $doc && (string)$doc['doc_id'] === (string)$activeId) {
            $nodeHas = true;
        }
        if (!empty($node['children'])) {
            $childHas = mark_doc_tree_active($node['children'], $activeId);
            $nodeHas = $nodeHas || $childHas;
        }
        $node['contains_active'] = $nodeHas;
        if ($nodeHas) {
            $hasActive = true;
        }
    }
    unset($node);
    return $hasActive;
}

function sort_doc_tree(array &$nodes): void {
    foreach ($nodes as &$node) {
        if (!empty($node['children'])) {
            sort_doc_tree($node['children']);
        }
    }
    unset($node);
    uasort($nodes, function ($a, $b) {
        $orderA = $a['order'] ?? PHP_INT_MAX;
        $orderB = $b['order'] ?? PHP_INT_MAX;
        if ($orderA === $orderB) {
            $idxA = $a['order_index'] ?? PHP_INT_MAX;
            $idxB = $b['order_index'] ?? PHP_INT_MAX;
            if ($idxA === $idxB) {
                return strcmp((string)($a['title'] ?? ''), (string)($b['title'] ?? ''));
            }
            return $idxA <=> $idxB;
        }
        return $orderA <=> $orderB;
    });
}

function decode_hex_emoji_string(string $value): string {
    $raw = trim($value);
    if ($raw === '') {
        return $raw;
    }
    $raw = preg_replace('/^u\+/i', '', $raw);
    $raw = str_replace(' ', '', $raw);
    if (!preg_match('/^(?:0x)?[0-9a-f]{4,6}(?:-(?:0x)?[0-9a-f]{4,6})*$/i', $raw)) {
        return $value;
    }
    $parts = explode('-', strtolower($raw));
    $out = '';
    foreach ($parts as $part) {
        $part = preg_replace('/^0x/', '', $part);
        if ($part === '') {
            continue;
        }
        $out .= html_entity_decode('&#x' . $part . ';', ENT_NOQUOTES, 'UTF-8');
    }
    return $out !== '' ? $out : $value;
}

function normalize_doc_icon_value($value): string {
    if ($value === null) {
        return '';
    }
    if (is_string($value)) {
        $trimmed = trim($value);
        if ($trimmed === '') {
            return '';
        }
        if ((str_starts_with($trimmed, '{') && str_ends_with($trimmed, '}')) ||
            (str_starts_with($trimmed, '[') && str_ends_with($trimmed, ']'))
        ) {
            $decoded = json_decode($trimmed, true);
            if (json_last_error() === JSON_ERROR_NONE && $decoded !== null) {
                return normalize_doc_icon_value($decoded);
            }
        }
        return decode_hex_emoji_string($trimmed);
    }
    if (is_numeric($value)) {
        return decode_hex_emoji_string((string)$value);
    }
    if (is_object($value)) {
        $value = (array)$value;
    }
    if (is_array($value)) {
        $keys = ['icon', 'value', 'emoji', 'iconEmoji', 'iconValue', 'path', 'file', 'asset', 'assetPath', 'src', 'url'];
        foreach ($keys as $key) {
            if (array_key_exists($key, $value)) {
                $candidate = normalize_doc_icon_value($value[$key]);
                if ($candidate !== '') {
                    return $candidate;
                }
            }
        }
        foreach ($value as $item) {
            $candidate = normalize_doc_icon_value($item);
            if ($candidate !== '') {
                return $candidate;
            }
        }
    }
    return '';
}

function is_doc_icon_image_value(string $icon): bool {
    if ($icon === '') {
        return false;
    }
    if (preg_match('/^data:image\//i', $icon)) {
        return true;
    }
    if (preg_match('/^https?:\/\//i', $icon)) {
        return true;
    }
    if (strpos($icon, '/') !== false || preg_match('/\.(svg|png|jpe?g|gif|webp|bmp)$/i', $icon)) {
        return true;
    }
    return false;
}

function build_doc_icon_src(string $icon, string $assetBasePath): string {
    if ($icon === '') {
        return '';
    }
    if (preg_match('/^data:image\//i', $icon) || preg_match('/^https?:\/\//i', $icon)) {
        return $icon;
    }
    $path = sanitize_asset_path($icon);
    if ($path === '') {
        return '';
    }
    $prefix = $assetBasePath;
    if ($prefix !== '' && substr($prefix, -1) !== '/') {
        $prefix .= '/';
    }
    return $prefix . encode_path_segments($path);
}

function render_doc_tree_icon(?array $doc, string $assetBasePath): string {
    $icon = $doc ? normalize_doc_icon_value($doc['icon'] ?? '') : '';
    if ($icon !== '' && is_doc_icon_image_value($icon)) {
        $src = build_doc_icon_src($icon, $assetBasePath);
        if ($src !== '') {
            return '<img class="kb-tree-icon kb-tree-icon--image" src="' . htmlspecialchars($src) . '" alt="">';
        }
    }
    if ($icon !== '' && !is_doc_icon_image_value($icon)) {
        return '<span class="kb-tree-icon kb-tree-icon--emoji">' . htmlspecialchars($icon) . '</span>';
    }
    return '';
}

function render_reader_icon(string $name): string {
    $paths = [
        'book' => '<path d="M12 6.5C9.5 4.5 6 4.5 3 5.5v14c3-1 6.5-1 9 1 2.5-2 6-2 9-1v-14c-3-1-6.5-1-9 1Zm0 0v14"/>',
        'home' => '<path d="m3 10 9-7 9 7M5 9v11h5v-6h4v6h5V9"/>',
        'code' => '<path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-14-2 18"/>',
        'download' => '<path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5"/>',
        'arrow' => '<path d="M4 12h16m-6-6 6 6-6 6"/>',
    ];
    return '<svg class="reader-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' . ($paths[$name] ?? '') . '</svg>';
}

function render_reader_library(string $title, string $slug): string {
    return '<a class="reader-library" href="' . base_path() . '/s/' . rawurlencode($slug) . '" data-share-nav="doc" data-doc-id="">'
        . render_reader_icon('book') . '<span>' . htmlspecialchars($title) . '</span></a>';
}

function render_share_search_box(): string {
    $html  = '<div class="kb-search" data-share-search>';
    $html .= '<div class="kb-search-input-wrap">';
    $html .= '<svg class="kb-search-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35"/></svg>';
    $html .= '<input class="kb-search-input" type="search" placeholder="Search notes" aria-label="Search notes" data-share-search-input autocomplete="off" spellcheck="false">';
    $html .= '<kbd class="kb-search-shortcut" aria-hidden="true">Ctrl K</kbd>';
    $html .= '<button class="kb-search-clear" type="button" data-share-search-clear hidden aria-label="Clear search">&times;</button>';
    $html .= '</div>';
    $html .= '<div class="kb-search-results" data-share-search-results hidden></div>';
    $html .= '</div>';
    return $html;
}

function render_doc_tree(array $nodes, string $slug, ?string $activeId = null, int $level = 0, string $path = '', string $assetBasePath = ''): string {
    if (empty($nodes)) {
        return '';
    }
    $html = '<ul class="kb-tree kb-tree-children" data-level="' . $level . '">';
    foreach ($nodes as $node) {
        $doc = $node['doc'] ?? null;
        $hasChildren = !empty($node['children']);
        $isActive = $doc && $activeId && (string)$doc['doc_id'] === (string)$activeId;
        $shouldOpen = false;
        $nodeLabel = $doc ? (string)($doc['doc_id'] ?? '') : (string)($node['title'] ?? '');
        $pathKey = trim($path . '/' . $nodeLabel, '/');
        $nodeKey = $doc ? ('doc:' . $nodeLabel) : ('folder:' . $pathKey);
        $nodeClass = 'kb-tree-node';
        if ($hasChildren) {
            $nodeClass .= $shouldOpen ? ' is-open' : ' is-collapsed';
        }
        $html .= '<li class="' . $nodeClass . '" data-tree-key="' . htmlspecialchars($nodeKey) . '">';
        $html .= '<div class="kb-tree-row">';
        if ($hasChildren) {
            $html .= '<button class="kb-tree-toggle" type="button" aria-label="Expand or collapse ' . htmlspecialchars((string)$node['title'], ENT_QUOTES, 'UTF-8') . '" aria-expanded="' . ($shouldOpen ? 'true' : 'false') . '">';
            $html .= '<svg class="kb-tree-toggle-icon kb-tree-toggle-icon--collapsed" viewBox="0 0 24 24" aria-hidden="true"><use href="#sps-tree-arrow-collapsed"></use></svg>';
            $html .= '<svg class="kb-tree-toggle-icon kb-tree-toggle-icon--open" viewBox="0 0 24 24" aria-hidden="true"><use href="#sps-tree-arrow-expanded"></use></svg>';
            $html .= '</button>';
        } else {
            $html .= '<span class="kb-tree-spacer"></span>';
        }
        if ($doc) {
            $docId = (string)$doc['doc_id'];
            $docTitle = htmlspecialchars($doc['title'] ?? $docId);
            $docPath = base_path() . '/s/' . $slug . '/' . rawurlencode($docId);
            $activeClass = $isActive ? ' is-active' : '';
            $docAttrs = ($isActive ? ' aria-current="page"' : '') . ' href="' . $docPath . '" title="' . htmlspecialchars((string)($doc['title'] ?? $docId), ENT_QUOTES, 'UTF-8') . '" data-doc-id="' . htmlspecialchars($docId) . '" data-share-nav="doc"';
            $html .= '<a class="kb-tree-item' . $activeClass . '"' . $docAttrs . '>';
            $html .= render_doc_tree_icon($doc, $assetBasePath);
            $html .= '<span class="kb-tree-label">' . $docTitle . '</span></a>';
        } else {
            $html .= '<div class="kb-tree-folder">';
            $html .= render_doc_tree_icon(null, $assetBasePath);
            $html .= '<span class="kb-tree-label">' . htmlspecialchars((string)$node['title']) . '</span></div>';
        }
        $html .= '</div>';
        if ($hasChildren) {
            $html .= render_doc_tree($node['children'], $slug, $activeId, $level + 1, $pathKey, $assetBasePath);
        }
        $html .= '</li>';
    }
    $html .= '</ul>';
    return $html;
}

function build_breadcrumbs(string $hpath): array {
    $trimmed = trim($hpath, '/');
    if ($trimmed === '') {
        return [];
    }
    return array_values(array_filter(explode('/', $trimmed)));
}

function is_share_partial_request(): bool {
    if (!empty($_GET['partial']) && (string)$_GET['partial'] === '1') {
        return true;
    }
    if (!empty($_SERVER['HTTP_X_SPS_PARTIAL']) && (string)$_SERVER['HTTP_X_SPS_PARTIAL'] === '1') {
        return true;
    }
    return false;
}

// Compare share roots rather than individual documents, query strings or fragments.
function reader_home_url_key(string $url): string {
    $parts = parse_url($url);
    if (!is_array($parts) || empty($parts['host'])) return '';
    $scheme = strtolower((string)($parts['scheme'] ?? ''));
    if (!in_array($scheme, ['http', 'https'], true) || isset($parts['user']) || isset($parts['pass'])) return '';
    $port = (int)($parts['port'] ?? 0);
    if (($scheme === 'https' && $port === 443) || ($scheme === 'http' && $port === 80)) $port = 0;
    $path = (string)($parts['path'] ?? '/');
    if (preg_match('#^(.*?/s/[a-zA-Z0-9_-]+)(?:/|$)#', $path, $matches)) $path = $matches[1];
    // TLS may terminate at a reverse proxy while PHP sees HTTP. Share identity is unchanged.
    return strtolower((string)$parts['host']) . ($port ? ':' . $port : '') . rtrim($path, '/');
}

function render_reader_home_link(string $slug): string {
    $home = trim((string)get_setting('reader_home_url', ''));
    $homeKey = reader_home_url_key($home);
    if ($homeKey === '' || $homeKey === reader_home_url_key(base_url() . '/s/' . rawurlencode($slug))) return '';
    return '<a class="button ghost reader-home-link" data-reader-home href="' . htmlspecialchars($home, ENT_QUOTES, 'UTF-8') . '" aria-label="Return to home">' . render_reader_icon('home') . 'Home</a>';
}

function render_share_document_actions(string $slug, string $docId): string {
    return '<div class="share-document-actions">' . render_reader_home_link($slug)
        . '<button class="button ghost share-view-toggle" type="button" data-share-toggle aria-pressed="false">' . render_reader_icon('code') . '<span data-share-toggle-label>Source</span></button>'
        . render_pdf_export_link(['slug' => $slug, 'doc_id' => $docId]) . '</div>';
}

function render_notebook_welcome(string $title, string $slug): string {
    $html = '<div class="kb-main" role="main"><section class="notebook-welcome" data-notebook-welcome>';
    $html .= '<div class="notebook-emblem" aria-hidden="true">' . render_reader_icon('book') . '</div>';
    $html .= '<p class="notebook-eyebrow">Shared notebook</p><h1 class="kb-title">' . htmlspecialchars($title) . '</h1>';
    $html .= '<p class="notebook-intro">A little space for ideas.<br>Explore the notes, or pick up where you left off.</p>';
    $html .= '<div class="notebook-actions"><button class="button primary" type="button" data-reader-show-tree>Browse documents' . render_reader_icon('arrow') . '</button>' . render_reader_home_link($slug);
    $html .= '<a class="button" data-reader-resume hidden>Continue reading: <span></span></a></div>';
    $html .= '<p class="notebook-reading-hint">Make yourself at home.<br>Your reading position is saved in this browser.</p>';
    return $html . '</section></div>';
}

function route_share(string $slug, ?string $docId = null): void {
    $share = find_share_by_slug($slug);
    if (!$share) {
        render_share_not_found_page();
        return;
    }
    $shareId = (int)$share['id'];
    $shareTitleRaw = (string)$share['title'];
    $shareTitle = htmlspecialchars($shareTitleRaw);
    $redirectPath = '/s/' . $slug . ($docId ? '/' . rawurlencode($docId) : '');
    $resumeAssetPath = resolve_asset_resume_redirect_path($share);
    $isPartial = is_share_partial_request();

    if (share_is_expired($share)) {
        $content = '<div class="share-shell share-shell--single">';
        $content .= '<div class="share-content" role="main">';
        $content .= '<div class="share-header"><h1>' . $shareTitle . '</h1></div>';
        $content .= '<div class="share-empty">This share has expired.</div>';
        $content .= '</div></div>';
        render_page($shareTitleRaw, $content, null, '', ['layout' => 'share']);
        return;
    }

    if (share_visitor_limit_reached($share)) {
        $content = '<div class="share-shell share-shell--single">';
        $content .= '<div class="share-content" role="main">';
        $content .= '<div class="share-header"><h1>' . $shareTitle . '</h1></div>';
        $content .= '<div class="share-empty">This share has reached its visitor limit.</div>';
        $content .= '</div></div>';
        render_page($shareTitleRaw, $content, null, '', ['layout' => 'share']);
        return;
    }

    if (share_requires_password($share) && !share_access_granted($shareId)) {
        $error = '';
        if ($_SERVER['REQUEST_METHOD'] === 'POST') {
            $input = trim((string)($_POST['share_password'] ?? ''));
            if ($input !== '' && password_verify($input, (string)$share['password_hash'])) {
                grant_share_access($shareId);
                if ($resumeAssetPath !== '') {
                    redirect($resumeAssetPath);
                }
                redirect($redirectPath);
            }
            $error = 'Incorrect share password.';
        }
        $content = '<div class="share-shell share-shell--single">';
        $content .= '<div class="share-content" role="main">';
        $content .= '<div class="share-header"><h1>' . $shareTitle . '</h1></div>';
        $content .= '<div class="share-gate">';
        $content .= '<div class="share-gate-note">This share is password protected.</div>';
        if ($error) {
            $content .= '<div class="alert error">' . htmlspecialchars($error) . '</div>';
        }
        $content .= '<form method="post" class="share-gate-form">';
        $content .= '<input class="input" type="password" name="share_password" placeholder="Enter the share password" required>';
        $content .= '<button class="button primary" type="submit">Unlock</button>';
        $content .= '</form></div></div></div>';
        render_page($shareTitleRaw, $content, null, '', ['layout' => 'share']);
        return;
    }

    $pdo = db();
    $stmt = $pdo->prepare('SELECT id, doc_id, title, icon, hpath, parent_id, sort_index, sort_order, updated_at FROM share_docs WHERE share_id = :sid ORDER BY sort_order ASC, id ASC');
    $stmt->execute([':sid' => $shareId]);
    $docs = $stmt->fetchAll(PDO::FETCH_ASSOC);
    $docMarkdownStmt = $pdo->prepare('SELECT markdown FROM share_docs WHERE share_id = :sid AND id = :id LIMIT 1');
    $loadDocMarkdown = function (array $doc) use ($docMarkdownStmt, $shareId): string {
        $rowId = (int)($doc['id'] ?? 0);
        if ($rowId <= 0) {
            return '';
        }
        $docMarkdownStmt->execute([
            ':sid' => $shareId,
            ':id' => $rowId,
        ]);
        $markdown = $docMarkdownStmt->fetchColumn();
        return is_string($markdown) ? $markdown : '';
    };
    if (empty($docs)) {
        render_share_not_found_page();
        return;
    }
    $visitorRegistered = false;
    $registerShareVisitor = function () use (&$visitorRegistered, $share, $shareId): void {
        if ($visitorRegistered) {
            return;
        }
        if (!admit_share_visitor($shareId)) {
            if (is_share_partial_request()) api_response(403, null, 'Share access changed or the visitor limit was reached');
            http_response_code(403);
            render_page('Share unavailable', '<p>This share is no longer available or has reached its visitor limit.</p>', null, '', ['layout' => 'share']);
            exit;
        }
        $visitorRegistered = true;
    };

    $assetBasePath = base_path() . '/uploads/shares/' . $shareId . '/';

    if ($share['type'] === 'doc') {
        if ($docId !== null && !in_array($docId, array_column($docs, 'doc_id'), true)) {
            render_share_not_found_page();
            return;
        }
        $hasMultipleDocs = count($docs) > 1;
        $activeDocId = $docId ?: (string)($share['doc_id'] ?? ($docs[0]['doc_id'] ?? ''));
        if ($hasMultipleDocs) {
            $doc = null;
            foreach ($docs as $item) {
                if ((string)($item['doc_id'] ?? '') === (string)$activeDocId) {
                    $doc = $item;
                    break;
                }
            }
            if (!$doc && !$docId && !empty($docs)) {
                $doc = $docs[0];
                $activeDocId = (string)($doc['doc_id'] ?? '');
            }
            if (!$doc) {
                render_share_not_found_page();
                return;
            }
            $docTitleRaw = trim((string)($doc['title'] ?? '')) ?: $shareTitleRaw;
            $docTitle = htmlspecialchars($docTitleRaw);
            $front = extract_front_matter($loadDocMarkdown($doc));
            $markdown = rewrite_asset_links((string)$front['body'], $assetBasePath);
            $markdown = strip_duplicate_title_heading($markdown, $docTitleRaw);
            $markdown = replace_custom_emoji_tokens($markdown, (int)$shareId, $assetBasePath);
            $markdown = insert_adjacent_emoji_image_spacing($markdown);
            $registerShareVisitor();
            $documentTree = build_doc_tree($docs, $activeDocId);
            $treeHtml = render_doc_tree($documentTree, $slug, $activeDocId, 0, '', $assetBasePath);
            $sidebar = '<aside class="kb-sidebar" data-share-sidebar data-share-slug="' . htmlspecialchars($slug) . '">';
            $sidebar .= render_reader_library($shareTitleRaw, $slug);
            $sidebar .= render_share_search_box();
            $sidebar .= '<div class="kb-side-tabs" data-share-tabs data-share-default="tree">';
            $sidebar .= '<button class="kb-side-tab is-active" type="button" data-share-tab="tree">Documents</button>';
            $sidebar .= '<button class="kb-side-tab" type="button" data-share-tab="toc">Contents</button>';
            $sidebar .= '<div class="kb-side-actions" data-share-tree-actions>';
            $sidebar .= '<button class="kb-side-action" type="button" data-tree-collapse title="Collapse all" aria-label="Collapse all"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#sps-tree-collapse-all"></use></svg></button>';
            $sidebar .= '<button class="kb-side-action" type="button" data-tree-expand title="Expand all" aria-label="Expand all"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#sps-tree-expand-all"></use></svg></button>';
            $sidebar .= '</div>';
            $sidebar .= '</div>';
            $sidebar .= '<div class="kb-side-panel" data-share-panel="tree">';
            $sidebar .= '<div class="kb-side-body">' . $treeHtml . '</div>';
            $sidebar .= '</div>';
            $sidebar .= '<div class="kb-side-panel" data-share-panel="toc" data-share-toc="doc" hidden>';
            $sidebar .= '<div class="kb-side-body share-toc-body"></div>';
            $sidebar .= '</div>';
            $sidebar .= '</aside>';
            $base = base_path();
            $crumbs = build_breadcrumbs((string)($doc['hpath'] ?? ''));
            if (!empty($crumbs)) {
                array_pop($crumbs);
            }
            if ($shareTitleRaw !== '' && !empty($crumbs)) {
                while (!empty($crumbs) && $crumbs[0] === $shareTitleRaw) {
                    array_shift($crumbs);
                }
            }
            $filteredCrumbs = [];
            $prevCrumb = null;
            foreach ($crumbs as $crumb) {
                if ($crumb === $prevCrumb) {
                    continue;
                }
                $filteredCrumbs[] = $crumb;
                $prevCrumb = $crumb;
            }
            $crumbs = $filteredCrumbs;
            $breadcrumbsHtml = '<div class="kb-breadcrumbs"><a class="kb-back" href="' . $base . '/s/' . $slug . '" data-doc-id="" data-share-nav="doc">' . htmlspecialchars($shareTitleRaw) . '</a>';
            foreach ($crumbs as $crumb) {
                $breadcrumbsHtml .= '<span>' . htmlspecialchars($crumb) . '</span>';
            }
            $breadcrumbsHtml .= '</div>';
            $mainHtml = '<div class="kb-main" role="main">';
            $mainHtml .= '<div class="share-article" data-share-view="preview">';
            $mainHtml .= '<div class="kb-header">' . $breadcrumbsHtml;
            $mainHtml .= '<div class="kb-title-row">';
            $mainHtml .= '<h1 class="kb-title">' . $docTitle . '</h1>';
            $mainHtml .= render_share_document_actions($slug, $activeDocId);
            $mainHtml .= '</div>';
            $mainHtml .= '</div>';
            $mainHtml .= '<div class="markdown-body" data-md-id="doc">' . render_markdown($markdown) . '</div>';
            $mainHtml .= '<textarea class="markdown-source" data-md-id="doc" readonly spellcheck="false" aria-label="Markdown source">' . htmlspecialchars($markdown) . '</textarea>';
            $mainHtml .= '</div></div>';
            if ($isPartial) {
                api_response(200, [
                    'title' => $docTitleRaw,
                    'docId' => $activeDocId,
                    'html' => $mainHtml,
                ]);
            }
            $content = '<div class="share-shell share-shell--notebook" data-share-doc-id="' . htmlspecialchars($activeDocId) . '">';
            $content .= $sidebar;
            $content .= $mainHtml;
            $content .= '</div>';
            render_page($docTitleRaw, $content, null, '', ['layout' => 'share', 'markdown' => true]);
            return;
        }

        $doc = $docs[0];
        $docTitleRaw = trim((string)($doc['title'] ?? '')) ?: $shareTitleRaw;
        $docTitle = htmlspecialchars($docTitleRaw);
        $front = extract_front_matter($loadDocMarkdown($doc));
        $markdown = rewrite_asset_links((string)$front['body'], $assetBasePath);
        $markdown = strip_duplicate_title_heading($markdown, $docTitleRaw);
        $markdown = replace_custom_emoji_tokens($markdown, (int)$shareId, $assetBasePath);
        $markdown = insert_adjacent_emoji_image_spacing($markdown);
        $registerShareVisitor();
        $sidebar = '<aside class="kb-sidebar" data-share-sidebar data-share-slug="' . htmlspecialchars($slug) . '">';
        $sidebar .= render_reader_library($shareTitleRaw, $slug);
        $sidebar .= render_share_search_box();
        $sidebar .= '<div class="kb-side-tabs" data-share-tabs data-share-default="toc">';
        $sidebar .= '<button class="kb-side-tab is-active" type="button" data-share-tab="toc">Contents</button>';
        $sidebar .= '</div>';
        $sidebar .= '<div class="kb-side-panel" data-share-panel="toc" data-share-toc="doc">';
        $sidebar .= '<div class="kb-side-body share-toc-body"></div>';
        $sidebar .= '</div>';
        $sidebar .= '</aside>';
        $content = '<div class="share-shell share-shell--notebook">';
        $content .= $sidebar;
        $content .= '<div class="kb-main" role="main">';
        $content .= '<div class="share-article" data-share-view="preview">';
        $content .= '<div class="kb-header">';
        $content .= '<div class="kb-title-row">';
        $content .= '<h1 class="kb-title">' . $docTitle . '</h1>';
        $content .= render_share_document_actions($slug, (string)$doc['doc_id']);
        $content .= '</div>';
        $content .= '</div>';
        $content .= '<div class="markdown-body" data-md-id="doc">' . render_markdown($markdown) . '</div>';
        $content .= '<textarea class="markdown-source" data-md-id="doc" readonly spellcheck="false" aria-label="Markdown source">' . htmlspecialchars($markdown) . '</textarea>';
        $content .= '</div></div></div>';
        render_page($docTitleRaw, $content, null, '', ['layout' => 'share', 'markdown' => true]);
    }

    if ($share['type'] === 'notebook') {
        $notebookTree = build_doc_tree($docs, $docId);
        $treeHtml = render_doc_tree($notebookTree, $slug, $docId, 0, '', $assetBasePath);
        $sidebar = '<aside class="kb-sidebar" data-share-sidebar data-share-slug="' . htmlspecialchars($slug) . '">';
        $sidebar .= render_reader_library($shareTitleRaw, $slug);
        $sidebar .= render_share_search_box();
        $sidebar .= '<div class="kb-side-tabs" data-share-tabs data-share-default="tree">';
        $sidebar .= '<button class="kb-side-tab is-active" type="button" data-share-tab="tree">Documents</button>';
        $sidebar .= '<button class="kb-side-tab" type="button" data-share-tab="toc">Contents</button>';
        $sidebar .= '<div class="kb-side-actions" data-share-tree-actions>';
        $sidebar .= '<button class="kb-side-action" type="button" data-tree-collapse title="Collapse all" aria-label="Collapse all"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#sps-tree-collapse-all"></use></svg></button>';
        $sidebar .= '<button class="kb-side-action" type="button" data-tree-expand title="Expand all" aria-label="Expand all"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#sps-tree-expand-all"></use></svg></button>';
        $sidebar .= '</div>';
        $sidebar .= '</div>';
        $sidebar .= '<div class="kb-side-panel" data-share-panel="tree">';
        $sidebar .= '<div class="kb-side-body">' . $treeHtml . '</div>';
        $sidebar .= '</div>';
        $sidebar .= '<div class="kb-side-panel" data-share-panel="toc" data-share-toc="doc" hidden>';
        $sidebar .= '<div class="kb-side-body share-toc-body"></div>';
        $sidebar .= '</div>';
        $sidebar .= '</aside>';
        $base = base_path();

        if ($docId) {
            $doc = null;
            foreach ($docs as $item) {
                if ((string)$item['doc_id'] === (string)$docId) {
                    $doc = $item;
                    break;
                }
            }
            if (!$doc) {
                render_share_not_found_page();
                return;
            }
            $docTitleRaw = trim((string)($doc['title'] ?? '')) ?: $shareTitleRaw;
            $docTitle = htmlspecialchars($docTitleRaw);
            $front = extract_front_matter($loadDocMarkdown($doc));
            $markdown = rewrite_asset_links((string)$front['body'], $assetBasePath);
            $markdown = strip_duplicate_title_heading($markdown, $docTitleRaw);
            $markdown = replace_custom_emoji_tokens($markdown, (int)$shareId, $assetBasePath);
            $markdown = insert_adjacent_emoji_image_spacing($markdown);
            $registerShareVisitor();
            $crumbs = build_breadcrumbs((string)($doc['hpath'] ?? ''));
            if (!empty($crumbs)) {
                array_pop($crumbs);
            }
            $breadcrumbsHtml = '<div class="kb-breadcrumbs"><a class="kb-back" href="' . $base . '/s/' . $slug . '" data-doc-id="" data-share-nav="doc">Contents</a>';
            foreach ($crumbs as $crumb) {
                $breadcrumbsHtml .= '<span>' . htmlspecialchars($crumb) . '</span>';
            }
            $breadcrumbsHtml .= '</div>';
            $mainHtml = '<div class="kb-main" role="main">';
            $mainHtml .= '<div class="share-article" data-share-view="preview">';
            $mainHtml .= '<div class="kb-header">' . $breadcrumbsHtml;
            $mainHtml .= '<div class="kb-title-row">';
            $mainHtml .= '<h1 class="kb-title">' . $docTitle . '</h1>';
            $mainHtml .= render_share_document_actions($slug, (string)$docId);
            $mainHtml .= '</div>';
            $mainHtml .= '</div>';
            $mainHtml .= '<div class="markdown-body" data-md-id="doc">' . render_markdown($markdown) . '</div>';
            $mainHtml .= '<textarea class="markdown-source" data-md-id="doc" readonly spellcheck="false" aria-label="Markdown source">' . htmlspecialchars($markdown) . '</textarea>';
            $mainHtml .= '</div></div>';
            if ($isPartial) {
                api_response(200, [
                    'title' => $docTitleRaw,
                    'docId' => $docId,
                    'html' => $mainHtml,
                ]);
            }
            $content = '<div class="share-shell share-shell--notebook" data-share-doc-id="' . htmlspecialchars((string)$docId) . '">';
            $content .= $sidebar;
            $content .= $mainHtml;
            $content .= '</div>';
            render_page($docTitleRaw, $content, null, '', ['layout' => 'share', 'markdown' => true]);
        }

        if (!$docId) {
            $registerShareVisitor();
            $mainHtml = render_notebook_welcome($shareTitleRaw, $slug);
            if ($isPartial) {
                api_response(200, [
                    'title' => $shareTitleRaw,
                    'docId' => '',
                    'html' => $mainHtml,
                ]);
            }
            $content = '<div class="share-shell share-shell--notebook" data-share-doc-id="">';
            $content .= $sidebar;
            $content .= $mainHtml;
            $content .= '</div>';
            render_page($shareTitleRaw, $content, null, '', ['layout' => 'share', 'markdown' => true]);
        }

    }

    render_share_not_found_page();
}
