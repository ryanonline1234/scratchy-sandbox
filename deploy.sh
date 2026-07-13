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

vercel link --yes --project scratchy-sandbox
vercel deploy --prod --yes
