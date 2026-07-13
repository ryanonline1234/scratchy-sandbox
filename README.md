# Scratchy Sandbox

A lightly modified fork of [scratch-gui](https://github.com/scratchfoundation/scratch-gui)
(the real Scratch 3 editor) that the **CCIC Cupertino Summer Coding Camp**
app embeds as "Scratchy codes for you" mode — the camp's AI tutor places
blocks in this sandbox over a postMessage bridge, with a visible cursor,
so students can watch it build and redirect it from chat.

Forked from `scratchfoundation/scratch-gui` @ `dae2a97a` (May 2026).
License: **AGPL-3.0**, unchanged — see [LICENSE](LICENSE).

## Changes from upstream

- `src/playground/scratchy-bridge.js` (new): postMessage API — place
  scripts from scratch-blocks XML with an animated block-by-block reveal,
  read the workspace as compact text, switch/add sprites, green-flag/stop.
  Only whitelisted parent origins (localhost + the camp's Vercel domains)
  may drive it. No data leaves the page.
- `src/containers/blocks.jsx`: two lines to hand the bridge the workspace,
  ScratchBlocks, and VM once mounted.
- `src/playground/render-gui.jsx`: skip the "leave site?" prompt when
  running inside the parent app's iframe.
- `webpack.config.js`: page title.

## Dev / deploy

```bash
npm ci
npm start              # dev server on :8601
NODE_ENV=production npm run build   # static site in build/
cd build && vercel deploy --prod    # deployed as the scratchy-sandbox Vercel project
```

The parent app is [CCIC-Cupertino-Summer-Coding-Camp](https://github.com/ryanonline1234/CCIC-Cupertino-Summer-Coding-Camp).
