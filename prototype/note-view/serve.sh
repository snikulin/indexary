#!/usr/bin/env bash
# THROWAWAY PROTOTYPE: serve the note-view variants locally.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
knowledge_base="${INDEXARY_KNOWLEDGE_BASE:-${HOME}/vault}"
python3 "$script_dir/server.py" --vault "$knowledge_base" "$@"
