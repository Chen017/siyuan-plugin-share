#!/usr/bin/env bash
# Compatibility entry point for bind mounts and named volumes alike.
set -euo pipefail
ops_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
container=${1:-siyuan-share-web}
backup_root=${2:-"$PWD/backups"}
mkdir -p -- "$backup_root"
backup_root=$(cd -- "$backup_root" && pwd -P)
exec bash "$ops_dir/scripts/backup-data.sh" "$container" "$backup_root"
