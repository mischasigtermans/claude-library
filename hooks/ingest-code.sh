#!/usr/bin/env bash
# Fold finished Claude Code sessions into the library. Detached and silent: the ingest
# is a watermark sweep, so a missed run is picked up by the next one and nothing blocks
# the session. SessionEnd is the fast path; SessionStart is the net that catches crashes,
# kill -9, closed terminals and restarts, where SessionEnd never fires.
set -euo pipefail
ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
LOG="${HOME}/.claude/library/ingest.log"
mkdir -p "$(dirname "$LOG")"
nohup node "${ROOT}/dist/ingest.js" >>"$LOG" 2>&1 &
exit 0
