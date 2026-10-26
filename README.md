# 🔗 Siyuan Share

[English](README.md) · [简体中文](README_zh_CN.md)

Share a SiYuan document, a document tree or a notebook through a web link, with passwords, expiration dates, visitor limits and incremental sync.

This is **[Chen017](https://github.com/Chen017)'s personal fork** of [b8l8u8e8/siyuan-plugin-share](https://github.com/b8l8u8e8/siyuan-plugin-share). The original sharing features come from upstream; this fork focuses on reading, rendering fixes and self-hosting.

## ✨ What changed here

| Area | Personal changes |
| --- | --- |
| Runtime | PHP **8.3.36**, graceful Nginx/PHP-FPM shutdown, runtime and API regression checks. |
| Fonts | Local **MiSans** for Latin letters, digits and common punctuation; system fonts for Chinese. The Latin WOFF2 is **34 KB**, down from the original 8.1 MB TTF. |
| Reading | Neutral surfaces, clear blue links, rounded press feedback and short motion with reduced-motion support. Notebook landing pages offer Browse documents and local Continue reading, without duplicating the document tree. Reader controls use English. Footer links lead with this fork and credit upstream. |
| Home navigation | Configurable reader home URL. Other shares show Home / Return to home; documents, query strings and anchors within the same home share do not. |
| Administrator-only backend | Notes, Site settings and Password navigation; administrator sign-in/out, password changes, API keys, share management and storage quotas remain. Public registration and multi-user management are removed. |
| Removed services | Access analytics and logs, admin KPI/charts, instance statistics/heartbeats, SMTP/email flows, comments, reports, announcements, moderation/scanning, ordinary CAPTCHA, ICP/contact settings, manual chunk cleanup and the global data-reset endpoint. PDF CAPTCHA and automatic upload cleanup remain. |
| Configuration | Website/share URL prefix, HTML Head insertion and custom CSS/JS switches, editors, help and injection remain available. Upstream release checks and update prompts are removed; attribution remains. |
| Data migration | Retired module data is removed once. Notes, share URLs, ownership, API keys and referenced attachments are preserved; historical visitor limits carry forward and storage usage is recalculated. [Scope and migration](docs/FOCUS_SIMPLIFICATION.md). |
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

Only administrator password sign-in is available. Public registration, email authentication and ordinary CAPTCHA have been removed; PDF CAPTCHA remains independent. Set up the administrator, create an API key, then enter your server URL and key in the SiYuan plugin.

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
