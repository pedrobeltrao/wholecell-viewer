#!/usr/bin/env bash
# Build the app and publish app/dist to the gh-pages branch (GitHub Pages serves it at
# https://<owner>.github.io/wholecell-viewer/). Usage: tools/deploy_pages.sh [remote]   (default remote: origin)
set -euo pipefail
cd "$(dirname "$0")/../app"
remote="${1:-origin}"
npm ci
rm -rf public/molstar && cp -r node_modules/molstar/build/viewer public/molstar   # local Mol* copy (CDN is the fallback)
npm run build
rm -f dist/cells.local.json   # local registry, never published
touch dist/.nojekyll
tmp="$(mktemp -d)"
cp -r dist/. "$tmp/"
cd "$tmp"
git init -q -b gh-pages
git add -A
git -c user.name="${GIT_AUTHOR_NAME:-wholecell}" -c user.email="${GIT_AUTHOR_EMAIL:-wholecell@localhost}" commit -q -m "Deploy viewer $(git -C "$OLDPWD" rev-parse --short HEAD 2>/dev/null || echo build)"
git push -f "$(git -C "$OLDPWD" remote get-url "$remote")" gh-pages
