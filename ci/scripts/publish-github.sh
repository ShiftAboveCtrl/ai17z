#!/usr/bin/env bash
# Publish the complete ASSETS list; every downloaded byte is compared first.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
python3 -I "$HERE/release_publish.py" "$@"
