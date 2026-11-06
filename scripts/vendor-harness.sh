#!/usr/bin/env bash
# Copy glen-harness modules, unmodified, into app/vendor/glen-harness/.
#
#   scripts/vendor-harness.sh            re-fetch the ref named in REF
#   scripts/vendor-harness.sh v0.2.0     move to another tag or commit
#
# The copy is never edited by hand. CI re-runs this script and fails if the
# result differs from what is committed; see app/vendor/glen-harness/README.md.
set -euo pipefail

DEST=app/vendor/glen-harness
REPO=SchmidtDSE/glen-harness
FILES=(
  src/core.js
  src/agent.js
  src/tool-registry.js
  ui/chat-ui.js
  ui/markdown.js
  ui/export-config.js
  ui/export-report.js
  ui/icons.js
  ui/voice-input.js
  ui/transcriber.js
)

cd "$(dirname "$0")/.."
REF=${1:-$(cat "$DEST/REF")}

for f in "${FILES[@]}"; do
  mkdir -p "$DEST/$(dirname "$f")"
  curl -fsSL "https://raw.githubusercontent.com/$REPO/$REF/$f" -o "$DEST/$f"
done
printf '%s\n' "$REF" > "$DEST/REF"
echo "Vendored $REPO@$REF into $DEST (${#FILES[@]} files)"
