#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
case "${1:-start}" in
    prepare|watch|test|integration|host-smoke|package)
        exec node "$root/scripts/extension.cjs" "$@"
        ;;
esac
exec python3 "$root/scripts/lab.py" "$@"
