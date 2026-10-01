'use strict';
// Contracts for the three additions the bounty-hunt mod relies on: the native
// target picker (api.targeting.pick), the @command channel (api.server.command)
// and the item:use event -- all in patches/client/ExtensionRuntime.mjs, wired to
// roBrowser by ExtensionBridge.mjs. Kept beside client-extensions.test.cjs; a
// separate file only so the diff stays clean.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const runtimeModule = import('../patches/client/ExtensionRuntime.mjs');

test('a pick resolves frozen, a completed pick does not cancel, and disposal cancels a pending one', async () => {
    const { createRuntime } = await runtimeModule;
    const runtime = createRuntime();
    let pendingResolve = null, cancelled = 0;
    runtime.configure({
        beginTargeting: () => new Promise(resolve => { pendingResolve = resolve; }),
        // Mirror the real bridge: cancelling does something only while a pick is
        // outstanding, so the release a completed pick runs is a no-op.
        cancelTargeting: () => { const resolve = pendingResolve; if (!resolve) return; pendingResolve = null; cancelled++; resolve(null); },
    });
    const scope = runtime.scope('bounty');

    const pick = scope.api.targeting.pick({ label: 'click a monster' });
    const resolve = pendingResolve; pendingResolve = null;
    resolve({ classId: 1002, gid: 42, name: 'Poring' });
    const monster = await pick;
    assert.equal(monster.classId, 1002);
    assert.equal(monster.name, 'Poring');
    assert.equal(Object.isFrozen(monster), true);
    assert.equal(cancelled, 0, 'a completed pick must not cancel');

    const pending = scope.api.targeting.pick({});
    assert.ok(pendingResolve, 'the second pick is outstanding');
    scope.dispose();
    assert.equal(cancelled, 1, 'disposing the plugin cancels its pending pick');
    assert.equal(await pending, null);
});

test('targeting.pick resolves null when the client is too old to offer a picker', async () => {
    const { createRuntime } = await runtimeModule;
    const runtime = createRuntime();          // no beginTargeting configured
    const scope = runtime.scope('bounty');
    assert.equal(await scope.api.targeting.pick({}), null);
});

test('item:use fans out the item id, ignores non-integers, and stops at disposal', async () => {
    const { createRuntime } = await runtimeModule;
    const runtime = createRuntime();
    const scope = runtime.scope('bounty');
    const used = [];
    scope.api.on('item:use', event => used.push(event.itemId));
    runtime.useItem(30050);
    runtime.useItem(undefined);
    runtime.useItem('30050');
    assert.deepEqual(used, [30050]);
    scope.dispose();
    runtime.useItem(30050);
    assert.deepEqual(used, [30050], 'a disposed scope hears nothing more');
});

test('server.command only forwards strings and reflects the bridge verdict', async () => {
    const { createRuntime } = await runtimeModule;
    const runtime = createRuntime();
    const sent = [];
    runtime.configure({ serverCommand: text => { sent.push(text); return text.startsWith('@'); } });
    const scope = runtime.scope('bounty');
    assert.equal(scope.api.server.command('@bounty 1002'), true);
    assert.equal(scope.api.server.command(1002), false, 'non-strings never reach the bridge');
    assert.deepEqual(sent, ['@bounty 1002']);
});

test('pick forwards its options (type/label) to the bridge and returns a frozen entity', async () => {
    const { createRuntime } = await runtimeModule;
    const runtime = createRuntime();
    let seen;
    runtime.configure({ beginTargeting: opts => { seen = opts; return Promise.resolve({ classId: 4001, gid: 9, name: 'Alice', kind: 'player' }); } });
    const scope = runtime.scope('bounty');
    const picked = await scope.api.targeting.pick({ type: 'player', label: 'Pick a player' });
    assert.deepEqual(seen, { type: 'player', label: 'Pick a player' });
    assert.equal(picked.kind, 'player');
    assert.equal(picked.classId, 4001);
    assert.equal(Object.isFrozen(picked), true);
});
