#!/usr/bin/env bash
# A private Git checkout may create config.php as 0600. Give only the FPM group read access.
set -euo pipefail
image=${1:?Application image required}
config_file=${2:-php-site/config.php}
if [[ ! -e "$config_file" ]]; then exit 0; fi
[[ -f "$config_file" ]] || { echo 'Configuration must be a regular file' >&2; exit 1; }
config_gid=$(docker run --rm --network none --entrypoint id "$image" -g www-data)
[[ "$config_gid" =~ ^[0-9]+$ ]] || { echo 'Cannot determine the PHP worker group' >&2; exit 1; }
chgrp "$config_gid" "$config_file"
chmod 640 "$config_file"
