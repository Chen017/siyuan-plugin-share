# 🔗 Siyuan Share

[English](README.md) · [简体中文](README_zh_CN.md)

Share a SiYuan document, a document tree or a notebook through a web link, with passwords, expiration dates, visitor limits and incremental sync.

This is **[Chen017](https://github.com/Chen017)'s personal fork** of [b8l8u8e8/siyuan-plugin-share](https://github.com/b8l8u8e8/siyuan-plugin-share). The original sharing features come from upstream; this fork focuses on reading, rendering fixes and self-hosting. Original copyright and the [MIT license](LICENSE) are retained.

## ✨ What changed here

| Area | Personal changes |
| --- | --- |
| Runtime | PHP **8.3.36**, graceful Nginx/PHP-FPM shutdown, runtime and API regression checks. |
| Fonts | Local **MiSans** for Latin letters, digits and common punctuation; system fonts for Chinese. The Latin WOFF2 is **34 KB**, down from the original 8.1 MB TTF. |
| Reading | Neutral surfaces, clear blue links, rounded press feedback and short motion with reduced-motion support. Notebook landing pages offer Browse documents and local Continue reading, without duplicating the document tree. Reader controls use English. Footer links lead with this fork and credit upstream. |
| UI & motion | Source / Preview switching keeps its position. Footnotes open after a short hover and can be pinned; transitions stay brief and respect reduced-motion settings. The admin share manager edits share details and access rules in one place. |
| Home navigation | Configurable reader home URL. Other shares show Home / Return to home; documents, query strings and anchors within the same home share do not. |
| Administrator-only backend | Streamlined admin navigation and settings; manage share titles, links, expiration, visitor limits and passwords. Deleted shares can be restored or permanently removed. Plugin connection details live in Site settings, and storage quotas remain available. Public registration and multi-user management are removed. |
| Removed services | Access analytics and logs, admin KPI/charts, instance statistics/heartbeats, SMTP/email flows, comments, reports, announcements, moderation/scanning, ordinary CAPTCHA, ICP/contact settings, manual chunk cleanup and the global data-reset endpoint. PDF CAPTCHA and automatic upload cleanup remain. |
| Configuration | Website/share URL prefix, HTML Head insertion and custom CSS/JS switches, editors, help and injection remain available. Upstream release checks and update prompts are removed; attribution remains. |
| Data migration | Retired module data is removed once. Notes, share URLs, ownership, API keys and referenced attachments are preserved; historical visitor limits carry forward and storage usage is recalculated. [Scope and migration](docs/FOCUS_SIMPLIFICATION.md). |
| Rendering | SiYuan table-cell alignment fixes, on-demand diagram engines and one Markdown render per document. Math, footnotes and diagrams remain available. |
| PDF export | Single/batch downloads in a dialog, selectable text, hidden attribution and visitor quota indicators. [Details](docs/GUEST_PDF_EXPORT.md). |
| Accessibility & SEO | Clearer links, correct button states and TOC focus, main landmarks, working image-download controls, page descriptions, robots.txt and real 404 responses. |
| Deployment | Local-only `127.0.0.1:8081`, versioned static assets, GitHub Actions deployment and isolated regression tests. Backup and restore-verification scripts are included. |
| Maintenance | PHP modules with unchanged routes/API contracts, obsolete style/helper cleanup, one verified backup entry point, consistent rendered-page health checks, private configuration permissions and CI before deployment. [Maintenance guide](docs/MAINTENANCE.md). |

Earlier changes and commit references: [Fork changes](CUSTOM_FEATURES.md) · [PHP upgrade record](docs/PHP83_BETA.md).

## Docker Compose

Docker Engine and Docker Compose are required. Run from the repository root:

```sh
git clone https://github.com/Chen017/siyuan-plugin-share.git
cd siyuan-plugin-share
# Review php-site/config.php before starting.
docker compose build --pull
bash scripts/prepare-config.sh siyuan-share-web:latest
docker compose up -d --no-build --pull never
docker compose ps
```

The supplied Compose file builds this fork from source and listens on **127.0.0.1:8081**. Point your HTTPS reverse proxy at that address and preserve the Host header. Set the public HTTPS URL in **Site settings**.

On a fresh installation, sign in with **admin / 123456** and change the password immediately. The backend is administrator-only; registration and email authentication are unavailable.

| Persistent host path | Contents |
| --- | --- |
| `php-site/storage/` | SQLite database and upload staging |
| `php-site/uploads/` | Attachments |
| `php-site/config.php` | Read-only mounted installation configuration |

Keep these paths when updating. Do not replace an existing configuration with the example. After initialization, saved PDF settings take precedence over config defaults.

## Connect SiYuan

1. Install the Siyuan Share plugin, then enter your server URL and an API key generated in the administrator backend.
2. Right-click a document or notebook to create a share.
3. Set its password, expiration date or visitor limit, then copy the link.

Updating an existing share preserves its URL. Automatic updates, incremental sync, document trees, search, math, footnotes and diagrams remain supported.

## Reader and PDF

**Site settings** controls the reader home URL, public URL prefix, storage quotas, HTML Head insertion and custom CSS/JavaScript. Scope custom CSS to `body.layout-share` or `body.layout-app`; only insert trusted code.

Open a document and choose **Export PDF**. Select a single document, its subpages, the whole share or specific documents. Each document downloads as a separate PDF with selectable text. The default visitor allowance is 120 documents per rolling hour; the administrator can change it. Browser permissions may be needed for multiple downloads. [PDF usage and limits](docs/GUEST_PDF_EXPORT.md).

## Backup and update

Create and verify a backup before updating:

```sh
bash backup-volumes.sh siyuan-share-web "$PWD/backups"
```

The script briefly stops writes, saves configuration/data and the rollback image, verifies extracted file hashes and SQLite integrity, then resumes the service. Keep the directory reported by `BACKUP_DIR` and its `VERIFIED` marker privately.

Backup retention: keep only the latest verified backup. After a new backup is created and verified successfully, manually remove older backups; retain the existing backup if verification fails. The current script does not remove older backups automatically.

```sh
git pull --ff-only
docker compose build --pull
bash scripts/prepare-config.sh siyuan-share-web:latest
docker compose up -d --no-build --pull never
docker compose logs --tail=100 web
```

For a rollback, restore the matching verified data/configuration and image together. Database migrations may make an image-only rollback insufficient.

## Development

```sh
python tests/run.py --php /path/to/php-8.3
NODE_PATH=/path/to/isolated/node_modules node tests/plugin.cjs
NODE_PATH=/path/to/isolated/node_modules node tests/frontend.cjs
NODE_PATH=/path/to/isolated/node_modules node tests/reader-ui.cjs
python tests/package.py
```

DOM tests use `jsdom@26.1.0`. PDF text-layer tests additionally use `jspdf@4.0.0` and `pypdfium2==5.14.0`. Add `--browser` to the PHP runner for real PDF downloads; an existing Playwright/browser installation can be selected with `SIYUAN_PLAYWRIGHT_MODULE` and `SIYUAN_BROWSER_EXECUTABLE`. Docker regression uses `--docker <built-image>` and disposable data. Runtime data, backups and local test output are excluded from release packages.

`main` deploys to the maintainer's VPS only after PHP/Docker and reader regression pass. Configure your own repository secrets before reusing this workflow. The plugin remains a no-build single-file entry point; source fonts live in `resources/fonts/` and are excluded from public assets.
