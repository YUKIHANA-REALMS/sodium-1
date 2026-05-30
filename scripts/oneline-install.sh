#!/bin/bash
# One-line install for Sodium Panel
# bash <(curl -s https://raw.githubusercontent.com/sodium/panel/main/scripts/oneline-install.sh)

set -e

if [[ $EUID -ne 0 ]]; then
    echo "Run as root or with sudo."
    exit 1
fi

bash <(curl -s https://raw.githubusercontent.com/sodium/panel/main/install.sh) "$@"
