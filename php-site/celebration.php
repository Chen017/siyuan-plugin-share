<?php
declare(strict_types=1);

// 14-day website update celebration Easter egg configuration, eligibility, and Markdown payload.
const CELEBRATION_CAMPAIGN_ID = '2026-11-update';
const CELEBRATION_STORAGE_KEY = 'sps:celebration:2026-11-update';
const CELEBRATION_COOKIE_NAME = 'sps_celebration_202611';
const CELEBRATION_COOKIE_MAX_AGE = 1209600; // 14 days
const CELEBRATION_START_AT = '2026-11-26 00:00:00';
const CELEBRATION_END_AT = '2026-12-10 23:59:59';

function celebration_window_bounds(): array {
    static $bounds = null;
    if ($bounds !== null) {
        return $bounds;
    }
    $tz = new DateTimeZone('Asia/Shanghai');
    $start = new DateTimeImmutable(CELEBRATION_START_AT, $tz);
    $end = new DateTimeImmutable(CELEBRATION_END_AT, $tz);
    $bounds = [
        'start' => $start->getTimestamp(),
        'end' => $end->getTimestamp(),
    ];
    return $bounds;
}

function celebration_is_preview_request(?array $query = null): bool {
    $source = $query ?? $_GET;
    return trim((string)($source['celebration'] ?? '')) === 'preview';
}

function celebration_is_active(?int $timestamp = null): bool {
    $ts = $timestamp ?? time();
    $bounds = celebration_window_bounds();
    return $ts >= $bounds['start'] && $ts <= $bounds['end'];
}

function celebration_has_seen_cookie(?array $cookies = null): bool {
    $source = $cookies ?? $_COOKIE;
    return (string)($source[CELEBRATION_COOKIE_NAME] ?? '') === '1';
}

function celebration_should_render(
    string $layout,
    array $options = [],
    ?int $timestamp = null,
    ?array $cookies = null,
    ?array $query = null
): bool {
    if (empty($options['celebration'])) {
        return false;
    }
    if (!in_array($layout, ['share', 'public'], true)) {
        return false;
    }
    if (!empty($options['pdf_export']) || !empty($options['pdf_embedded'])) {
        return false;
    }
    if (celebration_is_preview_request($query)) {
        return true;
    }
    return celebration_is_active($timestamp) && !celebration_has_seen_cookie($cookies);
}

function celebration_changelog_zh_markdown(): string {
    return <<<'MD'
**更新概览（2026-10-22 – 2026-11-26）**

* **更新时长**：35 天
* **Commit 数**：128 个
* **代码改动**：+37,423 / -30,139 行（累计 67,562 行）
* **GitHub Actions**：130+ 次运行，自动完成测试、部署与 11 个版本发布

---

### 1. 阅读与界面体验

* **清爽阅读视图**：精简统计、评论与文末脚注，统一中性色与蓝灰深色主题。
* **脚注悬停预览**：悬停弹出气泡预览，支持点击固定卡片细读。
* **悬浮快捷卡片**：右下角合并「回到顶部」与移动端「目录」按钮，滚动后自动浮现。

### 2. 导航、目录与搜索

* **笔记本首页与续读**：新增笔记本引导页，自动记录阅读进度并支持一键「继续阅读」。
* **侧栏与目录树升级**：桌面侧栏支持拖拽调宽并记忆状态；一级分组吸顶，新增目录与列表层级引导线；空父级文档直接作为文件夹展开。
* **文内跳转修复**：修复同文档块引用及列表、引用、公式等容器块的定位跳转。

### 3. 排版渲染与便捷复制

* **划选复制 Markdown**：划选正文（含公式、代码、表格、提示块、图表）复制即得标准 Markdown 源码；源码模式支持一键复制全文。
* **公式与图表优化**：修复公式异常；深色模式透明 SVG 自动补底；图表按需加载以加速首屏。
* **图片自适应与压缩**：保留笔记自定义图片尺寸，修复行内图片并排，服务端自动压缩图片以加快加载。

### 4. 访客 PDF 批量导出

* **多范围自动下载**：支持单篇、子目录、多选或整份分享导出，独立生成 PDF 并顺序自动下载（支持后台标签页运行）。
* **288 DPI 高清与可选文字**：渲染提升至 288 DPI，内置文字层支持正文选中、搜索与复制。

### 5. 省略更多细节优化...
MD;
}

function celebration_changelog_en_markdown(): string {
    return <<<'MD'
**Update Overview (2026-10-22 – 2026-11-26)**

* **Duration**: 35 days
* **Commits**: 128
* **Code changes**: +37,423 / -30,139 lines (67,562 total)
* **GitHub Actions**: 130+ runs covering automated testing, deployment, and 11 releases

---

### 1. Reading & Interface Experience

* **Cleaner reading view**: Streamlined statistics, comments, and end-of-page footnotes, with unified neutral tones and a slate-blue dark theme.
* **Footnote hover previews**: Hover to preview footnotes in a floating bubble, or click to pin the card for closer reading.
* **Floating quick-action card**: Combined "Back to top" and mobile "Navigation" buttons in the bottom-right corner, automatically appearing on scroll.

### 2. Navigation, Outline & Search

* **Notebook home & resume reading**: Added a notebook welcome page that automatically saves reading progress with one-click "Continue reading".
* **Upgraded sidebar & document tree**: Resizable desktop sidebar with persisted width and collapsed state; sticky top-level groups, tree and list hierarchy guides, and empty parent documents acting directly as expandable folders.
* **In-document jump fixes**: Fixed same-document block references and target positioning inside lists, blockquotes, math formulas, and other container blocks.

### 3. Typography, Rendering & Quick Copy

* **Select-to-copy Markdown**: Selecting rendered content (including formulas, code, tables, callouts, and diagrams) copies clean standard Markdown source; one-click full-document copy in Source view.
* **Formula & diagram improvements**: Fixed math rendering issues; added automatic light backing for transparent SVGs in dark mode; lazy-loaded diagram engines for faster initial paint.
* **Adaptive images & compression**: Preserved custom image sizes from SiYuan, fixed side-by-side inline images, and added automatic server-side image compression for faster loading.

### 4. Guest Batch PDF Export

* **Multi-scope auto-download**: Export a single document, subtree, custom selection, or entire share as individual PDFs with sequential auto-download (supports background tabs).
* **288 DPI crisp rendering & selectable text**: Upgraded rendering to 288 DPI with an embedded text layer supporting selection, search, and copy.

### 5. And many more subtle refinements...
MD;
}

function celebration_payload(bool $preview = false): array {
    return [
        'campaignId' => CELEBRATION_CAMPAIGN_ID,
        'storageKey' => CELEBRATION_STORAGE_KEY,
        'cookieName' => CELEBRATION_COOKIE_NAME,
        'cookieMaxAge' => CELEBRATION_COOKIE_MAX_AGE,
        'preview' => $preview,
        'range' => '2026-10-22 – 2026-11-26',
        'changelogZhHtml' => render_markdown(celebration_changelog_zh_markdown()),
        'changelogEnHtml' => render_markdown(celebration_changelog_en_markdown()),
    ];
}

function render_celebration_head(): string {
    return "<link rel='stylesheet' href='" . htmlspecialchars(site_asset_url('celebration.css'), ENT_QUOTES, 'UTF-8') . "'>";
}

function render_celebration_footer(bool $preview = false): string {
    $json = json_encode(
        celebration_payload($preview),
        JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_HEX_TAG | JSON_HEX_AMP
    );
    if (!is_string($json)) {
        $json = '{}';
    }
    $scriptUrl = htmlspecialchars(site_asset_url('celebration.js'), ENT_QUOTES, 'UTF-8');
    return "<script type='application/json' id='sps-celebration-data'>{$json}</script>"
        . "<script defer src='{$scriptUrl}'></script>";
}
