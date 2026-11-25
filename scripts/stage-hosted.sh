#!/bin/sh
# Lay out the hosted app (hosted/README.md) for a static server:
#
#   <dest>/core/ <dest>/app/ <dest>/hosted/   glen and the builder
#   <dest>/index.html                         sends visitors to the builder
#   <dest>/a/<slug>/index.html                one page per app in hosted/apps/
#
# Each /a/<slug>/ page is hosted/map/index.html with a <base> back to
# hosted/map/, so it loads the same files and reads its slug from the path.
# POSIX sh only: the GitHub Pages workflow runs it, and so does the NRP
# deployment's alpine/git initContainer.
#
#   scripts/stage-hosted.sh <glen checkout> <dest> [registry dir]
set -eu
src=${1:?glen checkout}
dest=${2:?destination}
registry=${3:-$src/hosted/apps}

mkdir -p "$dest/a"
for d in core app hosted; do
    rm -rf "${dest:?}/$d"
    cp -R "$src/$d" "$dest/$d"
done
rm -f "$dest/app/index.html" "$dest/app/config.json" "$dest/core/config.json"
# A deployment's own registry replaces the one in the checkout.
if [ "$registry" != "$src/hosted/apps" ]; then
    rm -rf "$dest/hosted/apps"
    cp -R "$registry" "$dest/hosted/apps"
fi

cat > "$dest/index.html" <<'HTML'
<!doctype html><meta charset=utf-8><title>GLEN map builder</title>
<meta http-equiv="refresh" content="0; url=hosted/">
<a href="hosted/">GLEN map builder</a>
HTML

n=0
for f in "$dest"/hosted/apps/*.json; do
    [ -e "$f" ] || continue
    slug=$(basename "$f" .json)
    case $slug in
        *[!a-z0-9-]*|-*|*-) echo "skipping $f: not a slug" >&2; continue ;;
    esac
    mkdir -p "$dest/a/$slug"
    sed 's#<!--BASE-->#<base href="../../hosted/map/">#' "$dest/hosted/map/index.html" > "$dest/a/$slug/index.html"
    n=$((n + 1))
done
echo "Staged the hosted app at $dest with $n apps."
