# Docker source deployment

This guide builds the current Chen017 fork. Existing Docker Hub tags and the upstream changelog may contain different features; use this source checkout for the administrator-only reader.

## Start

Install Docker with the Compose plugin, then run:

```sh
git clone https://github.com/Chen017/siyuan-plugin-share.git
cd siyuan-plugin-share
# php-site/config.php is included. Review it before starting.
docker compose build --pull
docker compose up -d
docker compose ps
docker compose logs --tail=100 web
```

Open `http://127.0.0.1:8081/login` on the host. The initial administrator is `admin` / `123456`; the site requires a password change before use. Generate an API key under **Notes**, then configure the SiYuan plugin with the public website URL and key. Registration and email recovery are unavailable in this fork.

The default Compose file binds only `127.0.0.1:8081`. For a NAS named-volume installation, see [the NAS guide](README_NAS.md). Keep the database, uploads and configuration mounted when replacing a container:

| Host path | Container path | Purpose |
| --- | --- | --- |
| `php-site/storage` | `/var/www/html/storage` | SQLite database and upload staging |
| `php-site/uploads` | `/var/www/html/uploads` | Shared attachments |
| `php-site/config.php` | `/var/www/html/config.php` (read only) | Installation configuration |

Configure **Site settings** for the public website URL, reader home URL, storage quota, HTML Head, CSS/JS and visitor PDF limits. Saved settings take precedence over initial PDF defaults in `config.php`.

## Reverse proxy

Point your HTTPS reverse proxy at the local listener. For example, the location within an existing HTTPS server can use:

```nginx
location / {
    proxy_pass http://127.0.0.1:8081;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Set the public HTTPS address in **Site settings** so generated share links use the correct scheme and prefix. The PDF proxy setting trusts only explicitly listed proxy peers; the proxy must overwrite its configured client-IP header.

## Backup and update

Run from the checkout, with permission to manage Docker and the backup directory:

```sh
bash backup-volumes.sh siyuan-share-web "$PWD/backups"
```

The wrapper uses the same verified backup for bind mounts and named volumes. It briefly stops writes, archives storage/uploads/config, checks a complete extraction against SHA-256, checks the restored SQLite database and resumes the container. Look for `BACKUP_DIR=...` and the `VERIFIED` file. Keep that private directory and its rollback image; the script does not delete older backups.

After confirming the backup:

```sh
git pull --ff-only
docker compose build --pull
bash scripts/prepare-config.sh siyuan-share-web:latest
docker compose up -d --no-build --pull never
docker compose ps
curl -fsS http://127.0.0.1:8081/login | grep -F '<h1>Sign in</h1>'
```

`prepare-config.sh` grants the PHP worker group read access to a private configuration file (mode 640). Run it with ownership/group privileges when required. Do not overwrite an installation's configuration just to resolve a Git conflict.

Backups contain `share-data.tar.gz`, file checksums, restored database fingerprints, container/Compose metadata and a rollback image reference. Restore into an empty, separate directory first and verify the checksums. Stop the application before restoring data to its mounted paths. Restore the matching application image too when reverting a schema migration; switching images alone does not restore database changes. Keep the original data and backup until the restored reader and synchronization have been checked.

## Verification and troubleshooting

- `docker compose logs --tail=100 web` shows Nginx and PHP errors.
- The health check verifies the rendered sign-in page, so a PHP error returning HTTP 200 is unhealthy.
- Ensure `storage` and `uploads` are writable by the container's `www-data` user and the configuration is readable. `prepare-config.sh` determines the group from the actual image.
- Change the host side of `127.0.0.1:8081:80` if that local port is occupied, then update the reverse proxy target.
- Keep the mount directories and backup files when stopping/replacing containers. `docker compose down -v` removes named volumes.

The maintainer's Actions workflow targets a specific VPS and uses repository secrets. Configure a separate destination before reusing it. See [maintenance and regression instructions](docs/MAINTENANCE.md).
