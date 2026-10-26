<?php
declare(strict_types=1);

// Markdown normalization, custom emoji handling and HTML sanitization.
function rewrite_asset_links(string $markdown, string $assetBase = ''): string {
    $prefix = $assetBase;
    if ($prefix !== '' && substr($prefix, -1) !== '/') {
        $prefix .= '/';
    }
    $markdown = str_replace('](/assets/', '](' . $prefix . 'assets/', $markdown);
    $markdown = str_replace('](./assets/', '](' . $prefix . 'assets/', $markdown);
    $markdown = str_replace('](assets/', '](' . $prefix . 'assets/', $markdown);
    $markdown = str_replace('](<assets/', '](<' . $prefix . 'assets/', $markdown);
    $markdown = str_replace('](</assets/', '](<' . $prefix . 'assets/', $markdown);
    $markdown = str_replace('src="/assets/', 'src="' . $prefix . 'assets/', $markdown);
    $markdown = str_replace('src="./assets/', 'src="' . $prefix . 'assets/', $markdown);
    $markdown = str_replace('src="assets/', 'src="' . $prefix . 'assets/', $markdown);
    $markdown = str_replace('href="/assets/', 'href="' . $prefix . 'assets/', $markdown);
    $markdown = str_replace('href="./assets/', 'href="' . $prefix . 'assets/', $markdown);
    $markdown = str_replace('href="assets/', 'href="' . $prefix . 'assets/', $markdown);
    $markdown = str_replace('](/emojis/', '](' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('](./emojis/', '](' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('](emojis/', '](' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('](<emojis/', '](<' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('](</emojis/', '](<' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('src="/emojis/', 'src="' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('src="./emojis/', 'src="' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('src="emojis/', 'src="' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('href="/emojis/', 'href="' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('href="./emojis/', 'href="' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('href="emojis/', 'href="' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('](/emojis/', '](' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('](./emojis/', '](' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('](emojis/', '](' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('src="/emojis/', 'src="' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('src="./emojis/', 'src="' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('src="emojis/', 'src="' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('href="/emojis/', 'href="' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('href="./emojis/', 'href="' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('href="emojis/', 'href="' . $prefix . 'emojis/', $markdown);
    return $markdown;
}

function encode_path_segments(string $path): string {
    $parts = explode('/', $path);
    $encoded = array_map(static fn($part) => rawurlencode($part), $parts);
    return implode('/', $encoded);
}

function sanitize_emoji_token_name(string $token): string {
    $token = trim($token);
    if ($token === '' || $token[0] !== ':' || substr($token, -1) !== ':') {
        return '';
    }
    $name = trim(substr($token, 1, -1));
    if ($name === '' || strpos($name, "\n") !== false || strpos($name, "\r") !== false) {
        return '';
    }
    if (strpos($name, ':') !== false) {
        return '';
    }
    return $name;
}

function normalize_emoji_key(string $name): string {
    $value = strtolower(trim($name));
    if ($value === '') {
        return '';
    }
    $normalized = preg_replace('/[\s_-]+/', '', $value);
    return $normalized ?? '';
}

function resolve_custom_emoji_src(string $name, int $shareId, string $assetBasePath): string {
    global $config;
    static $cache = [];
    $key = $shareId . '|' . $name;
    if (isset($cache[$key])) {
        return $cache[$key];
    }
    $clean = str_replace('\\', '/', $name);
    $clean = ltrim($clean, '/');
    if ($clean === '' || strpos($clean, '..') !== false) {
        $cache[$key] = '';
        return '';
    }
    $decoded = rawurldecode($clean);
    $candidates = [$clean];
    if ($decoded !== '' && $decoded !== $clean) {
        $candidates[] = $decoded;
    }
    $compact = preg_replace('/\s+/', '', $clean);
    if ($compact !== $clean && $compact !== '') {
        $candidates[] = $compact;
    }
    $extensions = ['svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];
    $uploadsDir = (string)($config['uploads_dir'] ?? (__DIR__ . '/uploads'));
    $uploadsDir = rtrim($uploadsDir, '/\\');
    $fsBase = $uploadsDir . '/shares/' . $shareId . '/emojis/';
    foreach ($candidates as $candidate) {
        $hasExt = (bool)preg_match('/\.(svg|png|jpe?g|gif|webp|bmp)$/i', $candidate);
        $names = $hasExt ? [$candidate] : array_merge([$candidate], array_map(
            static fn($ext) => $candidate . '.' . $ext,
            $extensions
        ));
        foreach ($names as $file) {
            $fsPath = $fsBase . $file;
            if (is_file($fsPath)) {
                $rel = 'emojis/' . $file;
                $cache[$key] = $assetBasePath . encode_path_segments($rel);
                return $cache[$key];
            }
        }
    }
    $index = build_share_emoji_index($shareId, $uploadsDir);
    if (!empty($index)) {
        $normalizedIndex = [];
        foreach ($index as $nameKey => $rel) {
            $norm = normalize_emoji_key($nameKey);
            if ($norm !== '' && !isset($normalizedIndex[$norm])) {
                $normalizedIndex[$norm] = $rel;
            }
        }
        foreach ($candidates as $candidate) {
            if (isset($index[$candidate])) {
                $cache[$key] = $assetBasePath . encode_path_segments($index[$candidate]);
                return $cache[$key];
            }
            $lower = strtolower($candidate);
            foreach ($index as $nameKey => $rel) {
                if (strtolower($nameKey) === $lower) {
                    $cache[$key] = $assetBasePath . encode_path_segments($rel);
                    return $cache[$key];
                }
            }
            foreach ($index as $nameKey => $rel) {
                if (str_starts_with($nameKey, $candidate . '-')) {
                    $cache[$key] = $assetBasePath . encode_path_segments($rel);
                    return $cache[$key];
                }
            }
            if (!empty($normalizedIndex)) {
                $normalized = normalize_emoji_key($candidate);
                if ($normalized !== '' && isset($normalizedIndex[$normalized])) {
                    $cache[$key] = $assetBasePath . encode_path_segments($normalizedIndex[$normalized]);
                    return $cache[$key];
                }
            }
        }
    }
    $cache[$key] = '';
    return '';
}

function build_share_emoji_index(int $shareId, string $uploadsDir): array {
    static $cache = [];
    $key = $uploadsDir . '|' . $shareId;
    if (isset($cache[$key])) {
        return $cache[$key];
    }
    $map = [];
    if ($shareId <= 0 || $uploadsDir === '') {
        $cache[$key] = $map;
        return $map;
    }
    $root = rtrim($uploadsDir, '/\\') . '/shares/' . $shareId . '/emojis';
    if (!is_dir($root)) {
        $cache[$key] = $map;
        return $map;
    }
    try {
        $iterator = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS)
        );
        foreach ($iterator as $file) {
            if (!$file->isFile()) {
                continue;
            }
            $fullPath = str_replace('\\', '/', $file->getPathname());
            if (!preg_match('/\.(svg|png|jpe?g|gif|webp|bmp)$/i', $fullPath)) {
                continue;
            }
            $relative = substr($fullPath, strlen(rtrim($root, '/\\')) + 1);
            if ($relative === false || $relative === '') {
                continue;
            }
            $relative = ltrim(str_replace('\\', '/', $relative), '/');
            $name = preg_replace('/\.(svg|png|jpe?g|gif|webp|bmp)$/i', '', $relative);
            if ($name === '') {
                continue;
            }
            $map[$name] = 'emojis/' . $relative;
            $baseName = basename($name);
            if ($baseName !== '' && !isset($map[$baseName])) {
                $map[$baseName] = 'emojis/' . $relative;
            }
        }
    } catch (Throwable $err) {
        // ignore
    }
    try {
        $pdo = db();
        $stmt = $pdo->prepare('SELECT asset_path FROM share_assets WHERE share_id = :sid AND asset_path LIKE :prefix');
        $stmt->execute([
            ':sid' => $shareId,
            ':prefix' => 'emojis/%',
        ]);
        $rows = $stmt->fetchAll(PDO::FETCH_COLUMN);
        foreach ($rows as $path) {
            $path = sanitize_asset_path((string)$path);
            if ($path === '' || !str_starts_with($path, 'emojis/')) {
                continue;
            }
            $relative = substr($path, strlen('emojis/'));
            if ($relative === '' || substr($relative, -1) === '/') {
                continue;
            }
            $name = preg_replace('/\.(svg|png|jpe?g|gif|webp|bmp)$/i', '', $relative);
            if ($name === '' || isset($map[$name])) {
                continue;
            }
            $map[$name] = $path;
            $baseName = basename($name);
            if ($baseName !== '' && !isset($map[$baseName])) {
                $map[$baseName] = $path;
            }
        }
    } catch (Throwable $err) {
        // ignore
    }
    $cache[$key] = $map;
    return $map;
}

function get_fence_marker(string $text, int $index): string {
    $ch = $text[$index] ?? '';
    if ($ch !== '`' && $ch !== '~') {
        return '';
    }
    $marker = substr($text, $index, 3);
    if ($marker !== '```' && $marker !== '~~~') {
        return '';
    }
    $i = $index - 1;
    while ($i >= 0 && $text[$i] === ' ') {
        $i--;
    }
    if ($i >= 0 && $text[$i] !== "\n") {
        return '';
    }
    return $marker;
}

function get_emoji_token_name_at(string $text, int $index): string {
    $len = strlen($text);
    if ($index < 0 || $index >= $len) {
        return '';
    }
    if ($text[$index] !== ':') {
        return '';
    }
    $end = strpos($text, ':', $index + 1);
    if ($end === false || $end <= $index + 1) {
        return '';
    }
    return sanitize_emoji_token_name(substr($text, $index, $end - $index + 1));
}

function replace_custom_emoji_tokens(string $markdown, int $shareId, string $assetBasePath): string {
    $source = (string)$markdown;
    if ($source === '') {
        return $source;
    }
    $len = strlen($source);
    $out = '';
    $inFence = false;
    $fenceMarker = '';
    $inInline = false;
    $inTag = false;
    $i = 0;
    while ($i < $len) {
        $fence = $inTag ? '' : get_fence_marker($source, $i);
        if (!$inFence && $fence !== '') {
            $inFence = true;
            $fenceMarker = $fence;
            $out .= $fence;
            $i += 3;
            continue;
        }
        if ($inFence && $fence !== '' && $fence === $fenceMarker) {
            $inFence = false;
            $fenceMarker = '';
            $out .= $fence;
            $i += 3;
            continue;
        }
        $ch = $source[$i];
        if (!$inFence) {
            if ($ch === '<') {
                $next = $source[$i + 1] ?? '';
                if ($next === '!' || $next === '/' || ctype_alpha($next)) {
                    $inTag = true;
                    $out .= $ch;
                    $i++;
                    continue;
                }
            }
            if ($inTag) {
                $out .= $ch;
                if ($ch === '>') {
                    $inTag = false;
                }
                $i++;
                continue;
            }
            if ($ch === '`') {
                $inInline = !$inInline;
                $out .= $ch;
                $i++;
                continue;
            }
            if ($ch === "\n") {
                $inInline = false;
            }
            if (!$inInline && $ch === ':') {
                $end = strpos($source, ':', $i + 1);
                if ($end !== false && $end > $i + 1) {
                    $token = substr($source, $i, $end - $i + 1);
                    $name = sanitize_emoji_token_name($token);
                    if ($name !== '') {
                        $src = resolve_custom_emoji_src($name, $shareId, $assetBasePath);
                        if ($src !== '') {
                            $out .= '![](<';
                            $out .= $src;
                            $out .= '>)';
                            $nextName = get_emoji_token_name_at($source, $end + 1);
                            if ($nextName !== '') {
                                $nextSrc = resolve_custom_emoji_src($nextName, $shareId, $assetBasePath);
                                if ($nextSrc !== '') {
                                    $out .= ' ';
                                }
                            }
                            $i = $end + 1;
                            continue;
                        }
                    }
                    $out .= $token;
                    $i = $end + 1;
                    continue;
                }
            }
        }
        $out .= $ch;
        $i++;
    }
    return $out;
}

function insert_adjacent_emoji_image_spacing(string $markdown): string {
    $source = (string)$markdown;
    if ($source === '') {
        return $source;
    }
    return preg_replace(
        '/(!\[[^\]]*]\((?:<)?[^)\s]*emojis\/[^)\s>]+(?:>)?\))(?=!\[[^\]]*]\((?:<)?[^)\s]*emojis\/)/',
        '$1 ',
        $source,
    ) ?? $source;
}

function strip_duplicate_title_heading(string $markdown, string $title): string {
    $title = trim($title);
    if ($title === '') {
        return $markdown;
    }
    $lines = preg_split("/\r\n|\r|\n/", $markdown);
    if (!is_array($lines)) {
        return $markdown;
    }
    $count = count($lines);
    $idx = 0;
    while ($idx < $count && trim($lines[$idx]) === '') {
        $idx++;
    }
    if ($idx >= $count) {
        return $markdown;
    }
    $line = trim($lines[$idx]);
    $next = $idx + 1 < $count ? trim($lines[$idx + 1]) : '';
    $headingText = '';
    $removeLines = 0;
    if (preg_match('/^#{1,6}\s+(.*)$/', $line, $match)) {
        $headingText = trim($match[1]);
        $removeLines = 1;
    } elseif ($line === $title && $next !== '' && preg_match('/^=+$/', $next)) {
        $headingText = $line;
        $removeLines = 2;
    }
    if ($headingText === '' || $headingText !== $title) {
        return $markdown;
    }
    $start = $idx;
    $end = $idx + $removeLines;
    while ($end < $count && trim($lines[$end]) === '') {
        $end++;
    }
    array_splice($lines, $start, $end - $start);
    return implode("\n", $lines);
}

function share_style_is_dangerous(string $style): bool {
    $value = strtolower((string)$style);
    $compact = preg_replace('/[\x00-\x1f\x7f]+/u', '', $value);
    if (!is_string($compact)) {
        $compact = $value;
    }
    return (bool)preg_match('/expression\s*\(|javascript\s*:|vbscript\s*:|url\s*\(\s*[\'"]?\s*data\s*:\s*text\/html/i', $compact);
}

function is_safe_share_url(string $value, string $tag = '', string $attr = ''): bool {
    $raw = trim((string)$value);
    if ($raw === '') {
        return true;
    }
    $compact = preg_replace('/[\x00-\x20\x7f\s]+/u', '', $raw);
    if (!is_string($compact) || $compact === '') {
        $compact = $raw;
    }
    $tag = strtolower($tag);
    $attr = strtolower($attr);

    if (preg_match('/^(?:javascript|vbscript)\s*:/i', $compact)) {
        return false;
    }
    if (preg_match('/^data\s*:/i', $compact)) {
        if ($tag === 'img' && $attr === 'src') {
            return (bool)preg_match('/^data:image\/(?:png|gif|jpe?g|webp|bmp|avif);base64,[a-z0-9+\/=\r\n]+$/i', $compact);
        }
        return false;
    }
    if ($tag === 'iframe' && $attr === 'src') {
        if ($compact === '') {
            return true;
        }
        if (preg_match('/^(?:https?:)?\/\//i', $compact)) {
            return true;
        }
        if (str_starts_with($compact, '/') || str_starts_with($compact, './') || str_starts_with($compact, '../')) {
            return true;
        }
        if (preg_match('/^about:blank(?:[?#].*)?$/i', $compact)) {
            return true;
        }
        return false;
    }
    if ($compact[0] === '#') {
        return true;
    }
    if (str_starts_with($compact, '/') && !str_starts_with($compact, '//')) {
        return true;
    }
    if (str_starts_with($compact, './') || str_starts_with($compact, '../')) {
        return true;
    }
    if (str_starts_with($compact, '//')) {
        return true;
    }
    if (preg_match('/^[a-zA-Z][a-zA-Z0-9+.\-]*:/', $compact)) {
        return (bool)preg_match('/^(?:https?|mailto|tel):/i', $compact);
    }
    return true;
}

function sanitize_share_html(string $html): string {
    $source = (string)$html;
    if ($source === '') {
        return '';
    }
    if (!class_exists('DOMDocument')) {
        return htmlspecialchars($source, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    }

    $libxmlBackup = libxml_use_internal_errors(true);
    $dom = new DOMDocument('1.0', 'UTF-8');
    $wrapperId = '__sps_share_html_root__';
    $loaded = $dom->loadHTML(
        '<?xml encoding="UTF-8"><!doctype html><html><body><div id="' . $wrapperId . '">' . $source . '</div></body></html>',
        LIBXML_HTML_NOIMPLIED | LIBXML_HTML_NODEFDTD | LIBXML_NOERROR | LIBXML_NOWARNING,
    );
    libxml_clear_errors();
    libxml_use_internal_errors($libxmlBackup);
    if (!$loaded) {
        return htmlspecialchars($source, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    }

    $root = null;
    $xpath = new DOMXPath($dom);
    $rootNodes = $xpath->query('//*[@id="' . $wrapperId . '"]');
    if ($rootNodes && $rootNodes->length > 0 && $rootNodes->item(0) instanceof DOMElement) {
        $root = $rootNodes->item(0);
    }
    if (!$root) {
        return htmlspecialchars($source, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    }

    $blockedTags = ['script', 'object', 'embed', 'svg', 'math', 'base', 'meta', 'link'];
    $katexSvgAllowedTags = ['svg', 'path', 'line', 'g'];
    $katexSvgAllowedAttrs = [
        'svg' => ['class', 'style', 'xmlns', 'xmlns:xlink', 'width', 'height', 'viewbox', 'preserveaspectratio', 'role', 'aria-hidden', 'focusable'],
        'path' => ['class', 'style', 'd', 'fill', 'fill-rule', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity', 'transform', 'opacity'],
        'line' => ['class', 'style', 'x1', 'y1', 'x2', 'y2', 'fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity', 'transform', 'opacity'],
        'g' => ['class', 'style', 'transform', 'fill', 'fill-rule', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity', 'opacity'],
    ];
    $urlAttrs = ['href', 'src', 'xlink:href', 'formaction', 'action', 'poster'];
    $iframeAllowedAttrs = [
        'src',
        'width',
        'height',
        'title',
        'allow',
        'allowfullscreen',
        'loading',
        'referrerpolicy',
        'sandbox',
        'frameborder',
    ];

    $elements = [];
    foreach ($root->getElementsByTagName('*') as $node) {
        $elements[] = $node;
    }

    foreach ($elements as $element) {
        if (!($element instanceof DOMElement)) {
            continue;
        }

        $tag = strtolower($element->tagName);
        // Parsedown renders SiYuan's table-cell IAL as literal text.
        // Apply the alignment to the actual cell before HTML sanitization.
        if (($tag === 'th' || $tag === 'td') && $element->firstChild instanceof DOMText) {
            $firstText = $element->firstChild;
            $match = [];
            if (preg_match('/^[ \t]*\{:\s*style\s*=\s*"\s*text-align\s*:\s*(left|center|right)\s*;?\s*"\s*\}[ \t]*/i', $firstText->data, $match)) {
                $firstText->data = substr($firstText->data, strlen($match[0]));
                $element->setAttribute('style', 'text-align: ' . strtolower($match[1]) . ';');
            }
        }

        $insideSvg = false;
        $insideKatex = false;
        $cursor = $element;
        while ($cursor instanceof DOMElement) {
            if (strtolower($cursor->tagName) === 'svg') {
                $insideSvg = true;
            }
            if (preg_match('/(?:^|\s)katex(?:\s|$)/i', (string)$cursor->getAttribute('class'))) {
                $insideKatex = true;
            }
            $parent = $cursor->parentNode;
            $cursor = $parent instanceof DOMElement ? $parent : null;
        }
        $isKatexSvgNode = $insideSvg && $insideKatex && in_array($tag, $katexSvgAllowedTags, true);
        if (in_array($tag, $blockedTags, true)) {
            if (!($tag === 'svg' && $isKatexSvgNode)) {
                if ($element->parentNode) {
                    $element->parentNode->removeChild($element);
                }
                continue;
            }
        } elseif ($insideSvg && !$isKatexSvgNode) {
            if ($element->parentNode) {
                $element->parentNode->removeChild($element);
            }
            continue;
        }

        $attrNames = [];
        if ($element->hasAttributes()) {
            foreach ($element->attributes as $attribute) {
                $attrNames[] = $attribute->name;
            }
        }
        $allowedSvgAttrs = $isKatexSvgNode ? ($katexSvgAllowedAttrs[$tag] ?? []) : [];

        foreach ($attrNames as $attrNameRaw) {
            $attrName = strtolower($attrNameRaw);
            $attrValue = (string)$element->getAttribute($attrNameRaw);

            if (str_starts_with($attrName, 'on')) {
                $element->removeAttribute($attrNameRaw);
                continue;
            }
            if ($attrName === 'srcdoc') {
                $element->removeAttribute($attrNameRaw);
                continue;
            }
            if ($isKatexSvgNode && !in_array($attrName, $allowedSvgAttrs, true)) {
                $element->removeAttribute($attrNameRaw);
                continue;
            }
            if ($attrName === 'style' && share_style_is_dangerous($attrValue)) {
                $element->removeAttribute($attrNameRaw);
                continue;
            }
            if ($isKatexSvgNode) {
                continue;
            }
            if ($tag === 'iframe' && !in_array($attrName, $iframeAllowedAttrs, true)) {
                $element->removeAttribute($attrNameRaw);
                continue;
            }
            if (in_array($attrName, $urlAttrs, true) && !is_safe_share_url($attrValue, $tag, $attrName)) {
                $element->removeAttribute($attrNameRaw);
            }
        }

        if ($tag === 'iframe') {
            $iframeSrc = trim((string)$element->getAttribute('src'));
            if ($iframeSrc !== '' && !is_safe_share_url($iframeSrc, 'iframe', 'src')) {
                if ($element->parentNode) {
                    $element->parentNode->removeChild($element);
                }
            }
        }
    }

    $output = '';
    foreach ($root->childNodes as $child) {
        $rendered = $dom->saveHTML($child);
        if (is_string($rendered)) {
            $output .= $rendered;
        }
    }

    return $output;
}

function render_markdown(string $markdown): string {
    static $parser = null;
    if (!$parser) {
        $parser = new Parsedown();
        if (method_exists($parser, 'setSafeMode')) {
            $parser->setSafeMode(false);
        }
    }
    return sanitize_share_html($parser->text($markdown));
}
