/**
 * Scratchy bridge — lets a parent page (the CCIC Scratchy app) drive this
 * sandbox over postMessage: place scripts, read the workspace, add library
 * or AI-drawn custom sprites, snapshot the stage, run the project.
 * Placement is animated block-by-block with a fake cursor so kids can
 * watch "Scratchy dragging blocks."
 *
 * Protocol (parent -> sandbox):
 *   {scratchy: true, id, action: 'hello'}
 *   {scratchy: true, id, action: 'add_script', xml}
 *   {scratchy: true, id, action: 'delete_script', blockId}
 *   {scratchy: true, id, action: 'set_field', blockId, field, value}
 *   {scratchy: true, id, action: 'read_workspace'}
 *   {scratchy: true, id, action: 'select_sprite', name}
 *   {scratchy: true, id, action: 'add_sprite', name}            // Scratch library
 *   {scratchy: true, id, action: 'add_custom_sprite', name, svg, x?, y?, size?}
 *   {scratchy: true, id, action: 'add_custom_backdrop', svg, name?}
 *   {scratchy: true, id, action: 'see_stage'}                   // -> {image: dataURI}
 *   {scratchy: true, id, action: 'run_project'} | 'stop_project'
 *   {scratchy: true, id, action: 'export_project'}              // -> {sb3: base64, size}
 *   {scratchy: true, id, action: 'load_project', sb3?|json?}    // replaces the whole project
 * Replies (sandbox -> parent): {scratchy: true, id, ok, data?, error?}
 * Plus one unsolicited event on boot: {scratchy: true, event: 'ready'}
 */

import {sanitizeSvg} from 'scratch-svg-renderer';
import storage from '../lib/storage';

const ALLOWED_PARENTS = [
    'http://localhost:3000',
    'http://localhost:8601',
    'https://ccic-scratchy.vercel.app',
    'https://ccic-coding-camp.vercel.app'
];

const REVEAL_MS = 550; // per-block reveal pace (kid-watchable)
const ACTION_TIMEOUT_MS = 30000; // watchdog: a stuck action must never jam the bridge

let refs = null; // {workspace, ScratchBlocks, vm}
let busy = false;
let cursorEl = null;

const isAllowed = origin =>
    origin === window.location.origin || ALLOWED_PARENTS.indexOf(origin) !== -1;

const post = (msg, origin) => {
    const target = window.parent === window ? window : window.parent;
    target.postMessage(Object.assign({scratchy: true}, msg), origin || '*');
};

/* ---------------------------------------------------------------- cursor */

const ensureCursor = () => {
    if (cursorEl) return cursorEl;
    cursorEl = document.createElement('div');
    cursorEl.setAttribute('aria-hidden', 'true');
    cursorEl.style.cssText = [
        'position:fixed', 'left:0', 'top:0', 'z-index:99999',
        'pointer-events:none', 'display:none',
        'transition:transform 0.45s cubic-bezier(.22,.9,.35,1.2)',
        'filter:drop-shadow(0 2px 4px rgba(0,0,0,.35))'
    ].join(';');
    cursorEl.innerHTML =
        '<svg width="26" height="30" viewBox="0 0 26 30">' +
        '<path d="M2 2 L2 24 L8.5 18.5 L12.5 27 L16.5 25 L12.5 17 L21 16 Z"' +
        ' fill="#FF5A1F" stroke="#19193A" stroke-width="2"/></svg>' +
        '<div style="position:absolute;left:18px;top:20px;background:#19193A;' +
        'color:#FFD93D;font:bold 11px sans-serif;padding:2px 7px;' +
        'border-radius:10px;white-space:nowrap">Scratchy 🤖</div>';
    document.body.appendChild(cursorEl);
    return cursorEl;
};

const moveCursor = (x, y) => {
    ensureCursor().style.transform = `translate(${x}px, ${y}px)`;
};

const showCursor = show => {
    ensureCursor().style.display = show ? 'block' : 'none';
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/* ------------------------------------------------------------ placement */

// Bottom edge (workspace coords) of the lowest existing script, so new
// scripts land below instead of on top of old ones.
const nextFreeY = workspace => {
    let maxBottom = 20;
    workspace.getTopBlocks(false).forEach(block => {
        const xy = block.getRelativeToSurfaceXY();
        const hw = block.getHeightWidth();
        maxBottom = Math.max(maxBottom, xy.y + hw.height + 40);
    });
    return maxBottom;
};

const VAR_TYPE_BY_FIELD = {
    VARIABLE: '',
    LIST: 'list',
    BROADCAST_OPTION: 'broadcast_msg'
};

// Variable fields arrive by name only; make sure the variable exists and
// stamp its id into the DOM so domToWorkspace links it correctly.
const ensureVariables = (dom, workspace) => {
    const fields = dom.querySelectorAll(
        'field[name="VARIABLE"], field[name="LIST"], field[name="BROADCAST_OPTION"]'
    );
    for (let i = 0; i < fields.length; i++) {
        const field = fields[i];
        const varName = field.textContent;
        const type = VAR_TYPE_BY_FIELD[field.getAttribute('name')] || '';
        let variable = workspace.getVariable(varName, type);
        if (!variable) variable = workspace.createVariable(varName, type);
        field.setAttribute('id', variable.getId());
        if (type) field.setAttribute('variabletype', type);
    }
};

const revealOrder = topBlock => {
    // Pre-order walk: statement substacks and next-chain get their own
    // reveal steps; value inputs (shadows, reporters) ride with the parent.
    const order = [];
    const walk = block => {
        if (!block) return;
        order.push(block);
        block.inputList.forEach(input => {
            if (input.type === 3 /* NEXT_STATEMENT */ &&
                input.connection && input.connection.targetBlock()) {
                walk(input.connection.targetBlock());
            }
        });
        walk(block.getNextBlock());
    };
    walk(topBlock);
    return order;
};

const animateReveal = async topBlock => {
    const steps = revealOrder(topBlock);
    steps.forEach(block => {
        const root = block.getSvgRoot();
        if (root) root.style.visibility = 'hidden';
    });
    showCursor(true);
    // Start from the palette for the "dragged out of the toolbox" feel.
    moveCursor(60, window.innerHeight / 2);
    await sleep(300);
    for (let i = 0; i < steps.length; i++) {
        const block = steps[i];
        const root = block.getSvgRoot();
        if (!root) continue;
        const rect = root.getBoundingClientRect();
        moveCursor(rect.left + Math.min(rect.width, 120) / 2, rect.top + 14);
        await sleep(i === 0 ? 450 : REVEAL_MS);
        root.style.visibility = 'visible';
    }
    await sleep(250);
    showCursor(false);
};

const addScript = async xmlText => {
    const {workspace, ScratchBlocks} = refs;
    const dom = ScratchBlocks.Xml.textToDom(xmlText);
    ensureVariables(dom, workspace);
    const beforeIds = {};
    workspace.getTopBlocks(false).forEach(b => {
        beforeIds[b.id] = true;
    });
    // Compute the landing spot BEFORE inserting, from existing scripts only.
    const freeY = nextFreeY(workspace);
    ScratchBlocks.Events.setGroup(true);
    let newTops;
    try {
        ScratchBlocks.Xml.domToWorkspace(dom, workspace);
        newTops = workspace.getTopBlocks(false).filter(b => !beforeIds[b.id]);
        // Always place below existing scripts — domToWorkspace's default
        // spot overlaps whatever is already there.
        newTops.forEach((top, i) => {
            const xy = top.getRelativeToSurfaceXY();
            top.moveBy(60 - xy.x, (freeY + i * 60) - xy.y);
        });
    } finally {
        ScratchBlocks.Events.setGroup(false);
    }
    for (let i = 0; i < newTops.length; i++) {
        const top = newTops[i];
        if (typeof workspace.centerOnBlock === 'function') {
            try {
                workspace.centerOnBlock(top.id);
            } catch (e) { /* non-fatal */ }
        }
        await animateReveal(top);
    }
    // Echo what actually landed so the model can verify itself.
    const target = refs.vm.editingTarget;
    const placed = target ?
        newTops.map(top => vmSerializeScript(target.blocks._blocks, top.id, '').join('\n')) :
        [];
    return {blockIds: newTops.map(b => b.id), placed};
};

/* ------------------------------------------------------------ reading */

// Serialize scripts from VM block data (works for ALL sprites, not just
// the one open in the Blockly workspace). Ids match Blockly's.
const vmBlockLine = (blocks, id) => {
    const b = blocks[id];
    if (!b) return '?';
    const kv = [];
    Object.keys(b.fields || {}).forEach(name => {
        kv.push(`${name}=${b.fields[name].value}`);
    });
    Object.keys(b.inputs || {}).forEach(name => {
        if (name.indexOf('SUBSTACK') === 0) return;
        const inp = b.inputs[name];
        if (!inp.block) return;
        const child = blocks[inp.block];
        if (!child) return;
        if (inp.block === inp.shadow) {
            const firstField = Object.keys(child.fields || {})[0];
            kv.push(`${name}=(${firstField ? child.fields[firstField].value : ''})`);
        } else {
            kv.push(`${name}=(${vmBlockLine(blocks, inp.block)})`);
        }
    });
    return b.opcode + (kv.length ? ` [${kv.join(', ')}]` : '');
};

const vmSerializeScript = (blocks, topId, indent) => {
    const lines = [];
    let cur = topId;
    while (cur) {
        const b = blocks[cur];
        if (!b) break;
        lines.push(`${indent}{${cur}} ${vmBlockLine(blocks, cur)}`);
        ['SUBSTACK', 'SUBSTACK2'].forEach(name => {
            const inp = (b.inputs || {})[name];
            if (inp && inp.block) {
                lines.push(...vmSerializeScript(blocks, inp.block, `${indent}  `));
            }
        });
        cur = b.next;
    }
    return lines;
};

const readWorkspace = () => {
    const {vm} = refs;
    const sprites = vm.runtime.targets
        .filter(t => t.isOriginal)
        .map(t => {
            const blocks = t.blocks._blocks;
            const scripts = t.blocks._scripts.map(topId =>
                vmSerializeScript(blocks, topId, '').join('\n'));
            const variables = {};
            Object.keys(t.variables || {}).forEach(vid => {
                const v = t.variables[vid];
                if (v.type === '') variables[v.name] = v.value;
            });
            return {
                name: t.getName(),
                isStage: t.isStage,
                editing: vm.editingTarget && vm.editingTarget.id === t.id,
                x: Math.round(t.x || 0),
                y: Math.round(t.y || 0),
                size: t.size,
                direction: t.direction,
                visible: t.visible,
                currentCostume: t.getCostumes()[t.currentCostume] ?
                    t.getCostumes()[t.currentCostume].name : null,
                costumes: t.getCostumes().map(c => c.name),
                sounds: t.getSounds().map(s => s.name),
                variables,
                scripts
            };
        });
    return {
        stage: {width: 480, height: 360, note: 'x -240..240, y -180..180'},
        editingSprite: vm.editingTarget ? vm.editingTarget.getName() : null,
        sprites
    };
};

/* ------------------------------------------------------------ sprites */

const findTarget = (name, {allowStage = true} = {}) => {
    const {vm} = refs;
    const target = vm.runtime.targets.find(
        t => t.isOriginal && t.getName().toLowerCase() === String(name).toLowerCase()
    );
    if (!target) throw new Error(`No sprite named "${name}"`);
    if (!allowStage && target.isStage) throw new Error('That is the Stage, not a sprite');
    return target;
};

const selectSprite = async name => {
    const {vm} = refs;
    const target = findTarget(name);
    vm.setEditingTarget(target.id);
    await sleep(300); // let the Blockly workspace swap before the next action
    return {selected: target.getName()};
};

const deleteSprite = name => {
    const {vm} = refs;
    const target = findTarget(name, {allowStage: false});
    const deletedName = target.getName();
    vm.deleteSprite(target.id);
    return {deleted: deletedName};
};

const renameSprite = (name, to) => {
    const {vm} = refs;
    const target = findTarget(name, {allowStage: false});
    vm.renameSprite(target.id, String(to));
    return {renamed: target.getName()};
};

const duplicateSprite = async (name, as) => {
    const {vm} = refs;
    const target = findTarget(name, {allowStage: false});
    const before = {};
    vm.runtime.targets.forEach(t => {
        before[t.id] = true;
    });
    await vm.duplicateSprite(target.id);
    const fresh = vm.runtime.targets.find(t => !before[t.id] && t.isOriginal);
    if (as && fresh) vm.renameSprite(fresh.id, String(as));
    return {duplicated: target.getName(), as: fresh ? fresh.getName() : null};
};

const setSprite = msg => {
    const target = findTarget(msg.name, {allowStage: false});
    if (typeof msg.x === 'number' || typeof msg.y === 'number') {
        target.setXY(
            typeof msg.x === 'number' ? msg.x : target.x,
            typeof msg.y === 'number' ? msg.y : target.y
        );
    }
    if (typeof msg.size === 'number') target.setSize(msg.size);
    if (typeof msg.direction === 'number') target.setDirection(msg.direction);
    if (typeof msg.visible === 'boolean') target.setVisible(msg.visible);
    if (msg.layer === 'front') target.goToFront();
    if (msg.layer === 'back') target.goToBack();
    return {
        set: target.getName(),
        x: Math.round(target.x),
        y: Math.round(target.y),
        size: target.size,
        direction: target.direction,
        visible: target.visible
    };
};

const deleteCostume = async (spriteName, costumeName) => {
    const {vm} = refs;
    const target = findTarget(spriteName);
    const costumes = target.getCostumes();
    if (costumes.length <= 1) throw new Error('A sprite needs at least one costume — redraw it instead');
    const index = costumes.findIndex(c => c.name.toLowerCase() === String(costumeName).toLowerCase());
    if (index === -1) {
        throw new Error(`No costume "${costumeName}" on ${target.getName()} (has: ${costumes.map(c => c.name).join(', ')})`);
    }
    vm.setEditingTarget(target.id);
    await sleep(150);
    vm.deleteCostume(index);
    return {deleted: costumeName, remaining: target.getCostumes().map(c => c.name)};
};

const addSprite = async name => {
    const {vm} = refs;
    const {default: spriteLibrary} = await import('../lib/libraries/sprites.json');
    const wanted = String(name).toLowerCase();
    const entry = spriteLibrary.find(s => s.name.toLowerCase() === wanted) ||
        spriteLibrary.find(s => s.name.toLowerCase().indexOf(wanted) === 0);
    if (!entry) throw new Error(`No library sprite named "${name}"`);
    await vm.addSprite(JSON.stringify(entry.json ? entry.json : entry));
    return {added: entry.name};
};

/* ------------------------------------------- AI-drawn sprites/backdrops */

const svgToAsset = svgText => {
    const text = String(svgText || '').trim();
    if (!text.toLowerCase().includes('<svg')) throw new Error('svg must be a complete <svg>…</svg> document');
    if (text.length > 60000) throw new Error('svg too big — keep it under 60KB');
    // Scratch's own sanitizer (same one used for kid file uploads).
    const clean = sanitizeSvg.sanitizeByteStream(new TextEncoder().encode(text));
    const asset = storage.createAsset(
        storage.AssetType.ImageVector,
        storage.DataFormat.SVG,
        clean,
        null,
        true // generate md5
    );
    // createAsset does NOT register the asset anywhere storage.load() can
    // find it — loadCostume would fall through to the CDN and 404. Cache it
    // like the default project's assets are cached.
    storage.builtinHelper._store(
        storage.AssetType.ImageVector,
        storage.DataFormat.SVG,
        clean,
        asset.assetId
    );
    // Rotation center = middle of the viewBox (fallback 50,50).
    let cx = 50;
    let cy = 50;
    const vb = (text.match(/viewBox\s*=\s*"([^"]+)"/i) || [])[1];
    if (vb) {
        const p = vb.trim().split(/[\s,]+/).map(Number);
        if (p.length === 4 && p.every(n => !isNaN(n))) {
            cx = p[0] + (p[2] / 2);
            cy = p[1] + (p[3] / 2);
        }
    }
    return {asset, cx, cy};
};

const addCustomSprite = async msg => {
    const {vm} = refs;
    const {asset, cx, cy} = svgToAsset(msg.svg);
    const name = String(msg.name || 'My Sprite').slice(0, 30);
    // Redraw semantics: drawing a name that already exists REPLACES that
    // sprite's look (new costume, switched to) instead of spawning
    // "Dragon2" — the #1 mess reported from real use.
    const existing = vm.runtime.targets.find(
        t => t.isOriginal && !t.isStage && t.getName().toLowerCase() === name.toLowerCase()
    );
    if (existing) {
        const md5ext = `${asset.assetId}.svg`;
        await vm.addCostume(md5ext, {
            name: `look ${existing.getCostumes().length + 1}`,
            dataFormat: 'svg',
            asset,
            md5: md5ext,
            assetId: asset.assetId,
            rotationCenterX: cx,
            rotationCenterY: cy
        }, existing.id);
        existing.setCostume(existing.getCostumes().length - 1);
        if (typeof msg.x === 'number' || typeof msg.y === 'number') {
            existing.setXY(
                typeof msg.x === 'number' ? msg.x : existing.x,
                typeof msg.y === 'number' ? msg.y : existing.y
            );
        }
        if (typeof msg.size === 'number') existing.setSize(msg.size);
        return {added: existing.getName(), replacedLook: true, costumes: existing.getCostumes().map(c => c.name)};
    }
    const sprite = {
        name,
        isStage: false,
        x: typeof msg.x === 'number' ? msg.x : 0,
        y: typeof msg.y === 'number' ? msg.y : 0,
        visible: true,
        size: typeof msg.size === 'number' ? msg.size : 100,
        direction: 90,
        draggable: false,
        rotationStyle: 'all around',
        variables: {},
        lists: {},
        broadcasts: {},
        blocks: {},
        currentCostume: 0,
        costumes: [{
            name: 'costume1',
            assetId: asset.assetId,
            md5ext: `${asset.assetId}.svg`,
            dataFormat: 'svg',
            rotationCenterX: cx,
            rotationCenterY: cy
        }],
        sounds: []
    };
    await vm.addSprite(JSON.stringify(sprite));
    return {added: name};
};

const addCustomBackdrop = async msg => {
    const {vm} = refs;
    const {asset, cx, cy} = svgToAsset(msg.svg);
    const name = String(msg.name || 'my backdrop').slice(0, 30);
    await vm.addBackdrop(`${asset.assetId}.svg`, {
        name,
        dataFormat: 'svg',
        asset,
        md5: `${asset.assetId}.svg`,
        assetId: asset.assetId,
        rotationCenterX: cx,
        rotationCenterY: cy
    });
    return {added: name};
};

/* ------------------------------------------------------------ stage eye */

const seeStage = async () => {
    const renderer = refs.vm.renderer;
    if (!renderer) throw new Error('stage snapshots not supported here');
    let uri = null;
    if (typeof renderer.requestSnapshot === 'function') {
        // Waits for the next draw — which never comes when Chrome throttles
        // rAF for this (cross-origin iframe) context, yielding "data:,".
        uri = await Promise.race([
            new Promise(resolve => renderer.requestSnapshot(resolve)),
            sleep(3000).then(() => null)
        ]);
    }
    if (!uri || uri.length < 1000) {
        // Throttled: force a draw and read the buffer in the same task
        // (valid even with preserveDrawingBuffer: false).
        renderer.draw();
        uri = renderer.canvas.toDataURL('image/png');
    }
    if (!uri || uri.length < 1000) throw new Error('stage camera unavailable right now');
    return {image: uri};
};

/* ------------------------------------------------------------ dispatch */

const ACTIONS = {
    hello: () => ({ready: true}),
    add_script: msg => addScript(msg.xml),
    delete_script: msg => {
        const block = refs.workspace.getBlockById(msg.blockId);
        if (!block) throw new Error(`No block ${msg.blockId} on the selected sprite — select_sprite first?`);
        block.dispose(true);
        return {deleted: msg.blockId};
    },
    set_field: msg => {
        const block = refs.workspace.getBlockById(msg.blockId);
        if (!block) throw new Error(`No block ${msg.blockId} on the selected sprite — select_sprite first?`);
        let done = false;
        const trySet = candidate => {
            if (done || !candidate) return;
            const field = candidate.getField && candidate.getField(msg.field);
            if (field) {
                field.setValue(String(msg.value));
                done = true;
            }
        };
        trySet(block);
        block.inputList.forEach(input => {
            if (input.connection) trySet(input.connection.targetBlock());
        });
        if (!done) throw new Error(`No field ${msg.field} on ${msg.blockId}`);
        return {set: msg.field};
    },
    read_workspace: () => readWorkspace(),
    select_sprite: msg => selectSprite(msg.name),
    add_sprite: msg => addSprite(msg.name),
    add_custom_sprite: msg => addCustomSprite(msg),
    add_custom_backdrop: msg => addCustomBackdrop(msg),
    delete_sprite: msg => deleteSprite(msg.name),
    rename_sprite: msg => renameSprite(msg.name, msg.to),
    duplicate_sprite: msg => duplicateSprite(msg.name, msg.as),
    set_sprite: msg => setSprite(msg),
    delete_costume: msg => deleteCostume(msg.sprite, msg.costume),
    see_stage: () => seeStage(),
    run_project: () => {
        refs.vm.greenFlag();
        return {running: true};
    },
    stop_project: () => {
        refs.vm.stopAll();
        return {running: false};
    },
    export_project: async () => {
        const blob = await refs.vm.saveProjectSb3();
        if (blob.size > 20 * 1024 * 1024) {
            throw new Error('Project is over 20MB — too big to export here');
        }
        return {sb3: await blobToBase64(blob), size: blob.size};
    },
    load_project: async msg => {
        if (msg.sb3) {
            await refs.vm.loadProject(base64ToBuffer(msg.sb3));
        } else if (msg.json) {
            await refs.vm.loadProject(
                typeof msg.json === 'string' ? msg.json : JSON.stringify(msg.json)
            );
        } else {
            throw new Error('load_project needs sb3 (base64) or json');
        }
        return {
            loaded: true,
            sprites: refs.vm.runtime.targets.filter(t => t.isOriginal && !t.isStage).length
        };
    }
};

// postMessage carries strings, so project bytes travel as base64.
const blobToBase64 = async blob => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
};
const base64ToBuffer = b64 => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
};

const onMessage = async event => {
    const msg = event.data;
    if (!msg || msg.scratchy !== true || !msg.action) return;
    if (!isAllowed(event.origin)) return;
    const reply = payload =>
        post(Object.assign({id: msg.id}, payload), event.origin);
    if (!refs) {
        reply({ok: false, error: 'sandbox not ready yet'});
        return;
    }
    if (busy && msg.action !== 'hello') {
        reply({ok: false, error: 'busy'});
        return;
    }
    busy = true;
    try {
        const handler = ACTIONS[msg.action];
        if (!handler) throw new Error(`Unknown action ${msg.action}`);
        // Watchdog: a hung action (e.g. an asset download that never
        // settles) must not jam the bridge forever.
        const data = await Promise.race([
            Promise.resolve(handler(msg)),
            new Promise((_, rejectRace) => setTimeout(
                () => rejectRace(new Error(`${msg.action} took too long (30s) — the sandbox gave up on it`)),
                ACTION_TIMEOUT_MS
            ))
        ]);
        reply({ok: true, data});
    } catch (err) {
        reply({ok: false, error: (err && err.message) || String(err)});
    } finally {
        busy = false;
        showCursor(false);
    }
};

/**
 * Called from the Blocks container once the workspace exists.
 */
export default function initScratchyBridge (newRefs) {
    refs = newRefs;
    // The playground never configures storage hosts, so library sprites,
    // backdrops, and sounds cannot download their assets (vm.addSprite
    // hangs). Point storage at Scratch's public CDN, like scratch-www does.
    if (!storage.assetHost) {
        storage.setAssetHost('https://assets.scratch.mit.edu');
    }
    if (!storage.projectHost) {
        storage.setProjectHost('https://projects.scratch.mit.edu');
    }
    // The playground's fetch-worker never completes its jobs in this build,
    // and storage's ProxyTool awaits the first tool with no fallback — so
    // every library-asset download hangs forever. Drop the worker tool and
    // let the plain in-page FetchTool (which works) handle assets.
    // Identified structurally ('inner'/'worker' props) because class names
    // are minified in production.
    try {
        const assetTool = storage.webHelper && storage.webHelper.assetTool;
        if (assetTool && Array.isArray(assetTool.tools)) {
            const plain = assetTool.tools.filter(t => t && !('inner' in t) && !('worker' in t));
            if (plain.length > 0 && plain.length < assetTool.tools.length) {
                assetTool.tools = plain;
            }
        }
    } catch (e) { /* non-fatal — worst case the sprite library stays broken */ }
    // Pen blocks are an extension — load it so Scratchy (and kids, via the
    // toolbox) can use stamp/pen-down drawing.
    try {
        if (!newRefs.vm.extensionManager.isExtensionLoaded('pen')) {
            newRefs.vm.extensionManager.loadExtensionIdSync('pen');
        }
    } catch (e) { /* non-fatal — pen category just won't appear */ }
    if (!window.__scratchyBridgeListening) {
        window.__scratchyBridgeListening = true;
        window.addEventListener('message', onMessage);
    }
    // Handy for manual poking from devtools while developing.
    window.__scratchy = refs;
    post({event: 'ready'});
}
