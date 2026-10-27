# Siyuan Share

[English](README.md) · [简体中文](README_zh_CN.md)

Share SiYuan documents and notebooks through a web reader with passwords, expiration dates, visitor limits, incremental sync and downloadable PDFs.

Maintained by [Chen017](https://github.com/Chen017/siyuan-plugin-share), based on [b8l8u8e8/siyuan-plugin-share](https://github.com/b8l8u8e8/siyuan-plugin-share). Original copyright and the [MIT license](LICENSE) are retained.

## What's changed

- **Reader:** Source / Preview switching keeps the page in place. Footnotes open after a short hover, with controls to pin or dismiss the preview. Motion is brief and respects reduced-motion settings.
- **Share administration:** Manage each share from the website, including its title, link, expiration, visitor limit and password. The list shows useful access and size details, and deleted shares can be restored or permanently removed.
- **Settings:** The admin navigation and controls are streamlined; plugin connection details are tucked into Site settings, while storage limits remain available.

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
