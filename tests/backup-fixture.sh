#!/usr/bin/env bash
set -euo pipefail
image=${1:?Test image required}
container="siyuan-backup-fixture-$RANDOM"
backup_root=$(mktemp -d)
config_file="$backup_root/config.php"
printf '<?php return ["fixture" => "private-config"];\n' > "$config_file"
chmod 600 "$config_file"
bash scripts/prepare-config.sh "$image" "$config_file"
test "$(stat -c %a "$config_file")" = 640
cleanup() {
    docker rm -fv "$container" >/dev/null 2>&1 || true
    rm -rf "$backup_root"
}
trap cleanup EXIT
docker run -d --name "$container" --volume /var/www/html/storage --volume /var/www/html/uploads \
    --mount "type=bind,source=$config_file,target=/var/www/html/config.php,readonly" "$image" >/dev/null
docker exec "$container" curl --retry 15 --retry-connrefused --retry-delay 1 --fail --silent --output /dev/null http://127.0.0.1/login
docker exec --user www-data "$container" php -r '$c = require "/var/www/html/config.php"; if (($c["fixture"] ?? "") !== "private-config") exit(1);'
docker exec "$container" sh -ec 'mkdir -p /var/www/html/uploads/fixture; printf "backup fixture attachment\n" > /var/www/html/uploads/fixture/note.txt; chown -R www-data:www-data /var/www/html/uploads/fixture'
bash scripts/backup-data.sh "$container" "$backup_root" | tee "$backup_root/run.log"
backup_dir=$(sed -n 's/^BACKUP_DIR=//p' "$backup_root/run.log")
test -f "$backup_dir/VERIFIED"
grep -q 'uploads/fixture/note.txt' "$backup_dir/files.sha256"
grep -q 'config.php' "$backup_dir/files.sha256"
grep -q '"integrity": "ok"' "$backup_dir/snapshot.json"
test "$(docker inspect --format '{{.State.Running}}' "$container")" = true
docker exec "$container" grep -q 'backup fixture attachment' /var/www/html/uploads/fixture/note.txt
echo 'Consistent backup, full file restore checks, SQLite restore integrity and service resume passed.'
