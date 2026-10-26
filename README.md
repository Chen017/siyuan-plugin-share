# 🔗 Siyuan Share

[English](README.md) · [简体中文](README_zh_CN.md)

Share a SiYuan document, a document tree or a notebook through a web link, with passwords, expiration dates, visitor limits and incremental sync.

This is **[Chen017](https://github.com/Chen017)'s personal fork** of [b8l8u8e8/siyuan-plugin-share](https://github.com/b8l8u8e8/siyuan-plugin-share). The original sharing features come from upstream; this fork focuses on reading, rendering fixes and self-hosting.

## ✨ What changed here

| Area | Personal changes |
| --- | --- |
| Runtime | PHP **8.3.36**, graceful Nginx/PHP-FPM shutdown, runtime and API regression checks. |
| Fonts | Local **MiSans** for Latin letters, digits and common punctuation; system fonts for Chinese. The Latin WOFF2 is **34 KB**, down from the original 8.1 MB TTF. |
| Reading | Neutral dark surfaces and clear blue links; reading statistics and comments hidden on share pages. Footer links lead with this fork and credit upstream. |
| Rendering | SiYuan table-cell alignment fixes, on-demand diagram engines and one Markdown render per document. Math, footnotes and diagrams remain available. |
| PDF export | Single/batch downloads in a dialog, selectable text, hidden attribution and visitor quota indicators. [Details](docs/GUEST_PDF_EXPORT.md). |
| Accessibility & SEO | Clearer links, correct button states and TOC focus, main landmarks, working image-download controls, page descriptions, robots.txt and real 404 responses. |
| Deployment | Local-only `127.0.0.1:8081`, versioned static assets, GitHub Actions deployment and isolated regression tests. Backup and restore-verification scripts are included. |

Earlier changes and commit references: [Fork changes](CUSTOM_FEATURES.md) · [PHP upgrade record](docs/PHP83_BETA.md).

## 🚀 Self-host

With Docker and Docker Compose installed:

```sh
git clone https://github.com/Chen017/siyuan-plugin-share.git
cd siyuan-plugin-share
# Review php-site/config.php for your installation.
docker compose build --pull
docker compose up -d
```

The service listens on **`127.0.0.1:8081`**. Point your HTTPS reverse proxy at that address. SQLite data, uploads and configuration persist outside the container.

Registration and captcha are disabled in this fork's default configuration. Set up the administrator first, create an API key, then enter your own server URL and key in the SiYuan plugin.

## Using the plugin

1. Install **Siyuan Share** in SiYuan and configure your server URL and API key.
2. Right-click a document or notebook, then create a share.
3. Set its password, expiration or visitor limit as needed; copy the link to share it.

Update an existing share to keep its URL. Automatic and incremental sync are inherited from upstream. See the [upstream guide](https://github.com/b8l8u8e8/siyuan-plugin-share#readme) for the full plugin workflow.

## Contributions merged upstream

Chen017 also contributed [dark-mode code highlighting #38](https://github.com/b8l8u8e8/siyuan-plugin-share/pull/38), [dark mode for login/admin/public pages #39](https://github.com/b8l8u8e8/siyuan-plugin-share/pull/39), [custom HTML head insertion #45](https://github.com/b8l8u8e8/siyuan-plugin-share/pull/45), and [nested-dollar KaTeX parsing #69](https://github.com/b8l8u8e8/siyuan-plugin-share/pull/69). These are already part of upstream.

## Maintenance

- **`main`**: this fork's deployable code. **`upstream`**: the retained upstream reference branch.
- [PHP/Docker regression](.github/workflows/php83-regression.yml) and [reader regression](.github/workflows/frontend-regression.yml) use disposable test data.
- [Backup and rollback records](docs/VPS_UPGRADE_20261022.md) · [Upstream changelog](CHANGELOG.md).
- The deployment workflow targets the maintainer's VPS; configure your own Actions secrets before using it.

Original project by **b8l8u8e8 and contributors**. Personal fork maintained by **Chen017**. [MIT License](LICENSE).
