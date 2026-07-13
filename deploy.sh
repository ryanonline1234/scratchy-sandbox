#!/bin/bash
# Build + deploy the Scratchy sandbox to the scratchy-sandbox Vercel project.
#
# NOTE: `npm run build` runs `npm run clean`, which deletes build/ INCLUDING
# the .vercel link file — so we must relink before every deploy, or the CLI
# auto-creates a new project named "build" from the folder name.
set -euo pipefail
cd "$(dirname "$0")"

NODE_ENV=production npm run build

cd build
# Trim what we never serve: source maps + the three demo entry points.
rm -f -- *.js.map chunks/*.js.map
rm -f -- blocksonly.js blocksonly.js.LICENSE.txt blocks-only.html
rm -f -- compatibilitytesting.js compatibilitytesting.js.LICENSE.txt compatibility-testing.html
rm -f -- player.js player.js.LICENSE.txt player.html
# Maps are gone — drop the dangling sourceMappingURL pointers too (devtools
# 404 noise otherwise).
for f in *.js; do
  sed -i '' -e 's|^//# sourceMappingURL=.*$||' "$f"
done
# scratch-storage ships prebuilt with a nested webpack runtime that loads
# chunks/fetch-worker.<hash>.js at runtime — scratch-gui's build never
# copies it, so the worker 404s (this was the root cause of the original
# library-asset hang). Ship the real file AND its source map (the worker
# carries a sourceMappingURL pointer; without the map, devtools log a 404).
cp ../node_modules/scratch-storage/dist/web/chunks/fetch-worker.*.js chunks/ 2>/dev/null || true
cp ../node_modules/scratch-storage/dist/web/chunks/fetch-worker.*.js.map chunks/ 2>/dev/null || true

vercel link --yes --project scratchy-sandbox
vercel deploy --prod --yes
