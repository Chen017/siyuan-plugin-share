#!/usr/bin/env bash
set -euo pipefail
umask 077

expected_sha=${1:?A tested main commit SHA is required}
[[ "$expected_sha" =~ ^[0-9a-f]{40}$ ]] || exit 1
ops_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cd /root/siyuan-plugin-share
exec 9>/root/.siyuan-share-deploy.lock
flock -n 9 || { echo 'Another VPS maintenance operation is running' >&2; exit 1; }
[[ "$(git branch --show-current)" = main ]]
git diff --quiet
git diff --cached --quiet
git fetch origin main
[[ "$(git rev-parse origin/main)" = "$expected_sha" ]] || { echo 'Main changed after testing; refusing deployment' >&2; exit 1; }
git merge-base --is-ancestor HEAD "$expected_sha"

backup_log=$(mktemp)
bash "$ops_dir/backup-data.sh" siyuan-share-web /root/siyuan-share-backups | tee "$backup_log"
backup_dir=$(sed -n 's/^BACKUP_DIR=//p' "$backup_log")
rm -f "$backup_log"
[[ "$backup_dir" = /root/siyuan-share-backups/* && -f "$backup_dir/VERIFIED" ]]
git archive HEAD > "$backup_dir/source-before.tar"
rollback_tag=$(cat "$backup_dir/rollback-image.txt")
printf 'services:\n  web:\n    image: "%s"\n' "$rollback_tag" > "$backup_dir/rollback.override.yml"
cutover_started=0
deployment_complete=0
rollback() {
    local status=$?
    if (( status != 0 && cutover_started && !deployment_complete )); then
        echo 'Verification failed; restoring the preserved application image' >&2
        docker compose -f docker-compose.yml -f "$backup_dir/rollback.override.yml" up -d --no-build --pull never web || true
    fi
    return "$status"
}
trap rollback EXIT

# This source update and image build happen only after the data backup is verified.
git merge --ff-only "$expected_sha"
docker compose build --pull --no-cache web
# Resolve the configured build tag rather than the still-running old container.
new_image=$(docker image inspect siyuan-share-web:latest --format '{{.Id}}')
bash "$ops_dir/prepare-config.sh" "$new_image"
docker run --rm --network none --entrypoint php "$new_image" -r 'if (PHP_MAJOR_VERSION !== 8 || PHP_MINOR_VERSION !== 3 || PHP_VERSION_ID < 80336) exit(1); echo "Built PHP ", PHP_VERSION, "\n";'
printf '%s\n' "$expected_sha" > "$backup_dir/source-after.txt"
printf '%s\n' "$new_image" > "$backup_dir/image-after.txt"

# Take a fresh comparison immediately before cutover, including writes since the backup.
cutover_started=1
docker stop --signal SIGTERM --time 30 siyuan-share-web >/dev/null
docker run --rm --network none --read-only --volumes-from siyuan-share-web:ro \
    --mount "type=bind,source=$ops_dir,target=/ops,readonly" \
    --entrypoint php "$new_image" /ops/data-snapshot.php /var/www/html/storage/app.db --core-only > "$backup_dir/pre-install-snapshot.json"
docker compose up -d --no-build --pull never web
docker exec siyuan-share-web curl --retry 30 --retry-connrefused --retry-delay 1 --fail --silent --output /dev/null http://127.0.0.1/login
docker cp "$ops_dir/data-snapshot.php" siyuan-share-web:/tmp/deploy-data-snapshot.php
docker exec siyuan-share-web php /tmp/deploy-data-snapshot.php /var/www/html/storage/app.db --core-only > "$backup_dir/after-snapshot.json"
cmp "$backup_dir/pre-install-snapshot.json" "$backup_dir/after-snapshot.json"
for attempt in $(seq 1 45); do
    health=$(docker inspect --format '{{.State.Health.Status}}' siyuan-share-web)
    [[ "$health" = healthy ]] && break
    sleep 2
done
[[ "$health" = healthy ]]
for path in /login /assets/app.js /assets/style.css; do
    [[ "$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:8081$path")" = 200 ]]
done
curl --max-time 15 -fsS http://127.0.0.1:8081/login | grep -F '<h1>Sign in</h1>' >/dev/null
for path in /config.php /storage/app.db /vendor/Parsedown.php; do
    code=$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:8081$path")
    [[ "$code" = 403 || "$code" = 404 ]]
done
[[ "$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8081/api/v1/auth/verify)" = 401 ]]
docker exec siyuan-share-web php -r 'if (PHP_VERSION_ID < 80336) exit(1); echo "Installed PHP ", PHP_VERSION, "\n";'
docker exec siyuan-share-web nginx -t
docker exec siyuan-share-web php-fpm -t
deployment_complete=1
printf 'DEPLOYED_COMMIT=%s\nBACKUP_DIR=%s\nINSTALLED_IMAGE=%s\n' "$expected_sha" "$backup_dir" "$new_image"
echo 'Production data fingerprints match; detailed snapshots retained privately on the VPS.'
echo 'Deployment verified; no backup, rollback image, or production data was deleted.'
