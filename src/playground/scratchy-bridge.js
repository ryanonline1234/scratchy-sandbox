/**
 * Scratchy bridge — lets a parent page (the CCIC Scratchy app) drive this
 * sandbox over postMessage: place scripts, read the workspace, switch
 * sprites, run the project. Placement is animated block-by-block with a
 * fake cursor so kids can watch "Scratchy dragging blocks."
 *
 * Protocol (parent -> sandbox):
 *   {scratchy: true, id, action: 'hello'}
 *   {scratchy: true, id, action: 'add_script', xml, note?}
 *   {scratchy: true, id, action: 'delete_script', blockId}
 *   {scratchy: true, id, action: 'set_field', blockId, field, value}
 *   {scratchy: true, id, action: 'read_workspace'}
 *   {scratchy: true, id, action: 'select_sprite', name}
 *   {scratchy: true, id, action: 'add_sprite', name}
 *   {scratchy: true, id, action: 'run_project'} | 'stop_project'
 * Replies (sandbox -> parent): {scratchy: true, id, ok, data?, error?}
 * Plus one unsolicited event on boot: {scratchy: true, event: 'ready'}
 */

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

// Variable fields arrive by name only; make sure the variable exists and
// stamp its id into the DOM so domToWorkspace links it correctly.
const VAR_TYPE_BY_FIELD = {
    VARIABLE: '',
    LIST: 'list',
    BROADCAST_OPTION: 'broadcast_msg'
};

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
    // Pre-order walk: block, its value inputs' shadows ride along with it,
    // statement substacks and next-chain get their own reveal steps.
    const order = [];
    const walk = block => {
        if (!block) return;
        order.push(block);
        block.inputList.forEach(input => {
            if (input.connection && input.connection.targetBlock()) {
                const child = input.connection.targetBlock();
                // Statement inputs (substacks) reveal step-by-step; value
                // inputs (numbers, dropdowns, reporters) ride with parent.
                if (input.type === 3 /* NEXT_STATEMENT */) {
                    walk(child);
                }
            }
        });
        walk(block.getNextBlock());
    };
    walk(topBlock);
    return order;
};

const setScriptVisible = (topBlock, visible) => {
    const all = topBlock.getDescendants ? topBlock.getDescendants() : [topBlock];
    all.forEach(block => {
        const root = block.getSvgRoot && block.getSvgRoot();
        if (root) root.style.visibility = visible ? 'visible' : 'hidden';
    });
};

const animateReveal = async topBlock => {
    const steps = revealOrder(topBlock);
    // Hide only the stepped blocks; value shadows inherit parent visibility.
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
    return {blockIds: newTops.map(b => b.id)};
};

/* ------------------------------------------------------------ reading */

const blockLine = block => {
    // Humanized single line: field values inline, value inputs stringified.
    const parts = [block.type];
    const fields = {};
    block.inputList.forEach(input => {
        input.fieldRow.forEach(field => {
            if (field.name) fields[field.name] = field.getText();
        });
        if (input.type !== 3 && input.connection && input.connection.targetBlock()) {
            fields[input.name] = `(${input.connection.targetBlock().toString()})`;
        }
    });
    const kv = Object.keys(fields).map(k => `${k}=${fields[k]}`);
    if (kv.length) parts.push(`[${kv.join(', ')}]`);
    return parts.join(' ');
};

const serializeScript = (block, indent) => {
    const lines = [];
    let current = block;
    while (current) {
        lines.push(`${indent}${current.isShadow() ? '' : `{${current.id}} `}${blockLine(current)}`);
        current.inputList.forEach(input => {
            if (input.type === 3 && input.connection && input.connection.targetBlock()) {
                lines.push(...serializeScript(input.connection.targetBlock(), `${indent}  `));
            }
        });
        current = current.getNextBlock();
    }
    return lines;
};

const readWorkspace = () => {
    const {workspace, vm} = refs;
    const sprites = vm.runtime.targets
        .filter(t => t.isOriginal)
        .map(t => ({
            name: t.getName(),
            isStage: t.isStage,
            x: Math.round(t.x || 0),
            y: Math.round(t.y || 0),
            costumes: t.getCostumes().length,
            editing: vm.editingTarget && vm.editingTarget.id === t.id
        }));
    const scripts = workspace.getTopBlocks(true).map(top => serializeScript(top, '').join('\n'));
    return {
        sprites,
        editingSprite: vm.editingTarget ? vm.editingTarget.getName() : null,
        scripts
    };
};

/* ------------------------------------------------------------ sprites */

const selectSprite = name => {
    const {vm} = refs;
    const target = vm.runtime.targets.find(
        t => t.isOriginal && t.getName().toLowerCase() === String(name).toLowerCase()
    );
    if (!target) throw new Error(`No sprite named "${name}"`);
    vm.setEditingTarget(target.id);
    return {selected: target.getName()};
};

const addSprite = async name => {
    const {vm} = refs;
    // Lazy-load the standard sprite library and match by name.
    const {default: spriteLibrary} = await import('../lib/libraries/sprites.json');
    const wanted = String(name).toLowerCase();
    const entry = spriteLibrary.find(s => s.name.toLowerCase() === wanted) ||
        spriteLibrary.find(s => s.name.toLowerCase().indexOf(wanted) === 0);
    if (!entry) throw new Error(`No library sprite named "${name}"`);
    await vm.addSprite(JSON.stringify(entry.json ? entry.json : entry));
    return {added: entry.name};
};

/* ------------------------------------------------------------ dispatch */

const ACTIONS = {
    hello: () => ({ready: true}),
    add_script: msg => addScript(msg.xml),
    delete_script: msg => {
        const block = refs.workspace.getBlockById(msg.blockId);
        if (!block) throw new Error(`No block ${msg.blockId}`);
        block.dispose(true);
        return {deleted: msg.blockId};
    },
    set_field: msg => {
        const block = refs.workspace.getBlockById(msg.blockId);
        if (!block) throw new Error(`No block ${msg.blockId}`);
        // The field usually lives on a shadow input of the named block.
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
    run_project: () => {
        refs.vm.greenFlag();
        return {running: true};
    },
    stop_project: () => {
        refs.vm.stopAll();
        return {running: false};
    }
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
    if (!window.__scratchyBridgeListening) {
        window.__scratchyBridgeListening = true;
        window.addEventListener('message', onMessage);
    }
    // Handy for manual poking from devtools while developing.
    window.__scratchy = refs;
    post({event: 'ready'});
}
