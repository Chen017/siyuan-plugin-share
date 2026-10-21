#!/usr/bin/env bash
set -euo pipefail
umask 077

container=${1:-siyuan-share-web}
backup_root=${2:-/root/siyuan-share-backups}
ops_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
[[ "$backup_root" = /* && "$backup_root" != / ]] || { echo 'An absolute backup directory is required' >&2; exit 1; }
[[ "$(docker inspect --format '{{.State.Running}}' "$container")" = true ]]
# Refuse a misleading backup when data is stored outside the known persisted directories.
for target in /var/www/html/storage /var/www/html/uploads; do
    docker inspect --format '{{range .Mounts}}{{println .Destination}}{{end}}' "$container" | grep -Fxq "$target"
done
docker exec "$container" php -r '$c = is_file("/var/www/html/config.php") ? require "/var/www/html/config.php" : []; if (($c["db_path"] ?? "/var/www/html/storage/app.db") !== "/var/www/html/storage/app.db" || ($c["uploads_dir"] ?? "/var/www/html/uploads") !== "/var/www/html/uploads") {fwrite(STDERR, "Nonstandard data directories require a matching backup\n"); exit(1);} if (!is_file("/var/www/html/storage/app.db")) exit(1);'
mkdir -p -- "$backup_root"
chmod 700 "$backup_root"
size_kb=$(docker exec "$container" du -sk /var/www/html/storage /var/www/html/uploads | awk '{total += $1} END {print total}')
free_kb=$(df -Pk "$backup_root" | awk 'END {print $4}')
(( free_kb > size_kb * 3 + 524288 )) || { echo 'Insufficient space for backup and restore verification' >&2; exit 1; }
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_dir=$(mktemp -d "$backup_root/$stamp-XXXXXX")
old_image=$(docker inspect --format '{{.Image}}' "$container")
rollback_tag="siyuan-share-web:rollback-$stamp"
docker tag "$old_image" "$rollback_tag"
docker inspect "$container" > "$backup_dir/container-before.json"
printf '%s\n' "$old_image" > "$backup_dir/image-before.txt"
printf '%s\n' "$rollback_tag" > "$backup_dir/rollback-image.txt"
if [[ -f docker-compose.yml ]]; then cp -p docker-compose.yml "$backup_dir/compose-before.yml"; fi
git rev-parse HEAD > "$backup_dir/source-before.txt" 2>/dev/null || true
restart_needed=0
resume() {
    local status=$?
    if (( restart_needed )); then docker start "$container" >/dev/null || true; fi
    return "$status"
}
trap resume EXIT
restart_needed=1
# The previous FPM-based image inherited SIGQUIT but its supervisor only traps SIGTERM.
docker stop --signal SIGTERM --time 30 "$container" >/dev/null
docker run --rm --network none --read-only --volumes-from "$container:ro" \
    --env "BACKUP_OWNER=$(id -u):$(id -g)" \
    --mount "type=bind,source=$backup_dir,target=/backup" \
    --mount "type=bind,source=$ops_dir,target=/ops,readonly" \
    --entrypoint /bin/sh "$old_image" -ec '
        cd /var/www/html
        if [ -f config.php ]; then set -- storage uploads config.php; else set -- storage uploads; fi
        find "$@" -type f -exec sha256sum {} + > /backup/files.sha256
        tar -czf /backup/share-data.tar.gz "$@"
        gzip -t /backup/share-data.tar.gz
        tar -tzf /backup/share-data.tar.gz > /backup/archive-list.txt
        mkdir /backup/verify
        tar -xzf /backup/share-data.tar.gz -C /backup/verify
        cd /backup/verify
        sha256sum -c /backup/files.sha256 > /backup/restore-check.log
        php /ops/data-snapshot.php /backup/verify/storage/app.db > /backup/snapshot.json
        cd /backup
        sha256sum share-data.tar.gz files.sha256 snapshot.json > SHA256SUMS
        rm -rf /backup/verify
        touch /backup/VERIFIED
        chmod 600 /backup/*
        chown -R "$BACKUP_OWNER" /backup
    '
docker start "$container" >/dev/null
restart_needed=0
docker exec "$container" curl --retry 20 --retry-connrefused --retry-delay 1 --fail --silent --output /dev/null http://127.0.0.1/login
echo 'Backup restoration and SQLite integrity verified; detailed snapshot retained privately.'
printf 'BACKUP_DIR=%s\n' "$backup_dir"
