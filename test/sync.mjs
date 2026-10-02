import assert from "node:assert/strict";
import {build} from "esbuild";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
const directory = await mkdtemp(join(tmpdir(), "pencil-sync-test-"));
try {
    const outfile = join(directory, "engine.mjs");
    await build({stdin: {contents: 'export * from "./src/engine/store"; export * from "./src/engine/sync"; export * from "./src/engine/types"; export {checkPublicationBudget} from "./src/plugin/api";', resolveDir: process.cwd()},
        plugins: [{name: "host-stub", setup(builder) {
            builder.onResolve({filter: /^siyuan$/}, () => ({path: "siyuan", namespace: "host-stub"}));
            builder.onLoad({filter: /.*/, namespace: "host-stub"}, () => ({contents: "export function showMessage() {}"}));
        }}], outfile, bundle: true, platform: "node", format: "esm", logLevel: "silent"});
    const {DocStore, baseValues, makeBase, validateBase, validateSnapshot, validateLegacy, checkPublicationBudget, MAX_FILE_BYTES} = await import(pathToFileURL(outfile));
    const docId = "20261002120000-testdoc";
    const legacy = {version: 1, docId, updatedAt: 10, strokes: [
        {i: "original", t: 0, c: "#000000", w: 4, o: 1, s: 0, a: 1, p: [110, 220, .5, 120, 230, .8], b: ["block-0", 100, 200]},
    ]};
    const client = () => { const s = new DocStore(docId); s.adoptPayload(legacy); return s; };
    const publish = store => { const p = JSON.parse(JSON.stringify(store.serialize())); store.acknowledge(p.snapshot.sequence); return p; };
    const payload = (...publications) => ({version: 2, docId, bases: [...new Map(publications.flatMap(p => p.bases).map(b => [b.hash, b])).values()], snapshots: publications.map(p => p.snapshot)});
    const incoming = (...publications) => { const s = new DocStore(docId); s.adoptPayload(payload(...publications)); return s; };
    const geometry = {color: "#123456", width: 4, opacity: 1, simulate: false};
    const add = (s, x) => s.addStroke("pen", geometry, [{x, y: 40, p: .6}, {x: x + 20, y: 45, p: .7}]);
    const canonical = s => JSON.stringify(s.strokes.map(v => ({id: v.id, revision: v.revision, points: v.points, anchor: v.anchor})));

    const base = client();
    assert.deepEqual(base.strokes[0].points[0], {x: 10, y: 20, p: .5});
    assert.deepEqual(base.strokes[0].fallback, [100, 200]);
    assert.deepEqual(base.strokes[0].anchor, {blockId: "block-0", ox: 0, oy: 0});
    assert.equal(baseValues(makeBase(docId, legacy))[0].revision, "legacy.6c8733b52c969363748d5684f4fba65bbc4a35a74128f731f07c5a1210d35ff5");
    assert.equal(baseValues(makeBase(docId, legacy))[0].revision,
        baseValues(makeBase(docId, {...legacy, updatedAt: 999}))[0].revision);
    assert.equal(base.dirty, false);
    assert.throws(() => base.serialize(), /No local/);

    const cached = client(), unchanged = cached.strokes[0], unchangedPoints = unchanged.points;
    add(cached, 40);
    assert.equal(cached.strokes.find(s => s.revision === unchanged.revision), unchanged);
    assert.equal(unchanged.points, unchangedPoints, "new ink should not copy every existing point array");
    const a = client(), b = client(); add(a, 50); add(b, 70);
    const pa = publish(a), pb = publish(b);
    const ab = incoming(pa, pb), ba = incoming(pb, pa);
    assert.equal(ab.strokes.length, 3); assert.equal(canonical(ab), canonical(ba));
    ab.mergeRemote(payload(pa, pb)); assert.equal(ab.strokes.length, 3); assert.equal(ab.dirty, false);

    const ma = client(), mb = client();
    ma.moveStrokes([ma.strokes[0]], 10, 0); mb.moveStrokes([mb.strokes[0]], 0, 30);
    const pma = publish(ma), pmb = publish(mb);
    const conflicts = incoming(pma, pmb);
    assert.equal(conflicts.strokes.length, 2); assert.equal(conflicts.conflictCount, 1);
    const removeID = conflicts.strokes[0].id;
    conflicts.eraseWhere(s => s.id === removeID);
    const resolved = publish(conflicts);
    assert.equal(incoming(pma, pmb, resolved).strokes.length, 1);

    const deleted = client(); deleted.clearAll(); const pd = publish(deleted);
    assert.equal(incoming(pd).strokes.length, 0);
    const stale = incoming(pd, pma); assert.equal(stale.strokes.length, 1); // concurrent edit survives deletion
    stale.mergeRemote(legacy); assert.equal(stale.strokes.length, 1); // unchanged old ink does not resurrect
    assert(pd.snapshot.deleted.length > 0);
    assert.equal(incoming(pd, pa).strokes.length, 1); // clear cannot delete an unseen addition

    const history = new DocStore(docId); history.adoptPayload(null); add(history, 10);
    history.moveStrokes([history.strokes[0]], 20, 30);
    assert(history.undo()); assert.equal(history.strokes[0].points[0].x, 10);
    assert(history.undo()); assert.equal(history.strokes.length, 0);
    assert(history.redo()); assert.equal(history.strokes[0].points[0].x, 10);
    assert(history.redo()); assert.equal(history.strokes[0].points[0].x, 30);
    const ph = publish(history); assert.equal(incoming(ph).strokes[0].points[0].x, 30);

    const reanchor = client(); const before = reanchor.snapshotStrokes(reanchor.strokes);
    reanchor.strokes[0].points = [{x: 3, y: 4, p: .5}];
    reanchor.strokes[0].anchor = {blockId: "block-1", ox: 0, oy: 0}; reanchor.strokes[0].fallback = [500, 600];
    reanchor.commitMove(reanchor.strokes, 10, 20, before);
    reanchor.undo(); assert.deepEqual(reanchor.strokes[0].anchor, before[0].anchor); assert.deepEqual(reanchor.strokes[0].points, before[0].points);
    reanchor.redo(); assert.equal(reanchor.strokes[0].anchor.blockId, "block-1");

    const defer = client(); defer.beginInput();
    assert.equal(defer.mergeRemote(payload(pmb)), false);
    defer.moveStrokes([defer.strokes[0]], 5, 0);
    assert(defer.endInput()); assert.equal(defer.strokes.length, 2); assert.equal(defer.canUndo, false);
    assert.equal(defer.dirty, true);
    const unrelated = client(); add(unrelated, 99); unrelated.mergeRemote(payload(pma));
    assert(unrelated.canUndo); unrelated.undo(); assert.equal(unrelated.strokes.length, 1);

    const queued = client(); add(queued, 10); const first = queued.serialize(); const frozen = JSON.stringify(first);
    add(queued, 30); queued.mergeRemote(payload(pmb));
    assert.equal(JSON.stringify(queued.serialize()), frozen);
    queued.acknowledge(first.snapshot.sequence); assert.equal(queued.dirty, true);
    const second = publish(queued); assert(second.snapshot.sequence > first.snapshot.sequence);
    const order = incoming(second, first, pmb), ordered = incoming(first, second, pmb);
    assert.equal(canonical(order), canonical(ordered));
    validateSnapshot(second.snapshot, docId, second.snapshot.writer, second.snapshot.sequence);

    const invalid = structuredClone(second.snapshot); invalid.values[0].stroke.p[2] = 8;
    assert.throws(() => validateSnapshot(invalid, docId, invalid.writer, invalid.sequence));
    const badLegacy = structuredClone(legacy); badLegacy.strokes[0].b[0] = '"] script';
    assert.throws(() => validateLegacy(badLegacy, docId));
    const badOrigin = structuredClone(legacy); badOrigin.strokes[0].b[1] = 1e12;
    assert.throws(() => validateLegacy(badOrigin, docId));
    const missingBase = makeBase(docId, null); delete missingBase.legacy;
    assert.throws(() => validateBase(missingBase, docId, missingBase.hash));
    const collision = structuredClone(pa); collision.snapshot.values[0].stroke.w += 1;
    const stable = incoming(pa); const state = canonical(stable);
    assert.throws(() => stable.mergeRemote(payload(collision)), /immutable|Conflicting/);
    assert.equal(canonical(stable), state);
    const zero = new DocStore(docId);
    zero.adoptPayload({...legacy, strokes: [{...legacy.strokes[0], b: ["block-0", 0, 0]}]});
    assert.deepEqual(zero.strokes[0].fallback, [0, 0]);
    const size = value => Buffer.byteLength(JSON.stringify(value));
    const active = payload(pa, pb);
    const activeBytes = [...active.bases, ...active.snapshots].reduce((sum, value) => sum + size(value), 0);
    checkPublicationBudget(pa, active, 100000, activeBytes);
    assert.throws(() => checkPublicationBudget(pma, active, 100000, activeBytes), /read budget/);
    assert.throws(() => checkPublicationBudget(pma, active, 1, 100000), /file budget/);
    const rejected = client(); add(rejected, 200);
    const oversized = rejected.serialize();
    rejected.rejectUnsentPublication(); rejected.block("capacity", "test capacity");
    assert.equal(rejected.canEdit, false);
    rejected.undo();
    const reduced = rejected.serialize();
    assert(reduced.snapshot.sequence > oversized.snapshot.sequence);
    assert.equal(reduced.snapshot.values.length, 0);
    assert.equal(reduced.snapshot.deleted.length, 0); // never-published ink need not bloat durable recovery
    assert.equal(rejected.canEdit, true);
    const uncertain = client(); add(uncertain, 250);
    const sending = uncertain.serialize(); sending.attempted = true;
    uncertain.rejectUnsentPublication(); assert.equal(uncertain.serialize(), sending);
    assert(uncertain.backup().payload.snapshots.length > 0);
    const inFlight = client(); add(inFlight, 270);
    const owned = inFlight.serialize(), ownedRevision = owned.snapshot.values[0].revision;
    let finishPreflight;
    inFlight.saving = new Promise(resolve => { finishPreflight = resolve; });
    inFlight.block("capacity", "concurrent refresh capacity barrier");
    inFlight.undo();
    assert.equal(inFlight.serialize(), owned, "capacity undo cannot discard another active save's publication");
    owned.attempted = true; finishPreflight(); await inFlight.saving; inFlight.saving = null;
    inFlight.acknowledge(owned.snapshot.sequence);
    const afterFlight = publish(inFlight);
    assert(afterFlight.snapshot.deleted.some(v => v.revision === ownedRevision));
    const awaiting = client(); add(awaiting, 280);
    const allocated = awaiting.serialize();
    const revision = allocated.snapshot.values[0].revision;
    awaiting.undo(); // preflight still pending: these allocated bytes can still be published
    allocated.attempted = true; awaiting.acknowledge(allocated.snapshot.sequence);
    const retirement = publish(awaiting);
    assert(retirement.snapshot.deleted.some(v => v.revision === revision));
    assert.equal(incoming(allocated, retirement).strokes.length, 1); // only legacy base ink remains
    const rejectedDuringUndo = client(); add(rejectedDuringUndo, 300);
    const rejectedBytes = rejectedDuringUndo.serialize(); rejectedDuringUndo.undo();
    rejectedDuringUndo.rejectUnsentPublication();
    assert(rejectedDuringUndo.serialize().snapshot.sequence > rejectedBytes.snapshot.sequence);
    assert.equal(rejectedDuringUndo.serialize().snapshot.deleted.length, 0);
    const guardedMove = client(), savedRevision = guardedMove.strokes[0].revision;
    assert.throws(() => guardedMove.commitMove([], 10, 10, guardedMove.snapshotStrokes(guardedMove.strokes)), /preserve/);
    assert.equal(guardedMove.strokes[0].revision, savedRevision); assert.equal(guardedMove.dirty, false);
    const many = structuredClone(pa.snapshot); many.sequence = 50001;
    many.values = Array.from({length: 50001}, (_, i) => ({revision: `${many.writer}.${i+1}`, stroke: {...pa.snapshot.values[0].stroke, i: `tiny-${i}`, p: [1,2,.5]}}));
    assert(Buffer.byteLength(JSON.stringify(many)) < MAX_FILE_BYTES);
    assert.throws(() => checkPublicationBudget({bases: pa.bases, snapshot: many}, {version: 2, docId, bases: pa.bases, snapshots: []}), e => e.name === "SyncCapacityError");
    many.values.pop(); checkPublicationBudget({bases: pa.bases, snapshot: many}, {version: 2, docId, bases: pa.bases, snapshots: []});
    const longStroke = structuredClone(pa.snapshot); longStroke.values[0].stroke.p = Array(1500003).fill(.5);
    assert.throws(() => validateSnapshot(longStroke, docId, longStroke.writer, longStroke.sequence), e => e.name === "SyncCapacityError");
    console.log("sync: deterministic import, concurrent edits/deletes, selective conflict copies, undo/redo, reanchor, deferral, immutable retries, admission and validation passed");
} finally { await rm(directory, {recursive: true, force: true}); }
