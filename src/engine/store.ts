import {newId, strokeBBox, translateStroke} from "./geometry";
import {deserializeStroke, serializeStroke, type Point, type Stroke, type StrokeAnchor, type StrokeTool} from "./types";
import {baseValues, fingerprint, makeBase, randomWriter, snapshotCovers, type InkPayload, type InkValue, type Publication, type SyncBase, type SyncPayload, type WriterSnapshot} from "./sync";

interface Op { before: InkValue[]; after: InkValue[] }
const copyValue = (v: InkValue): InkValue => JSON.parse(JSON.stringify(v));
const copyStroke = (s: Stroke): Stroke => ({...s, points: s.points.map(p => ({...p})),
    ...(s.anchor ? {anchor: {...s.anchor}} : {}), ...(s.fallback ? {fallback: [...s.fallback] as [number, number]} : {})});

/** Observed-remove ink values. A move replaces only the selected revision;
 * concurrent replacements remain independent, selectable copies. */
export class DocStore {
    strokes: Stroke[] = [];
    readonly docId: string;
    dirty = false;
    lastSavedAt = 0;
    saving: Promise<unknown> | null = null;
    loaded = false;
    generation = 0;
    retiredDocument = false;
    loading: Promise<void> | null = null;
    blocked: {kind: "integrity" | "capacity"; message: string} | null = null;

    private values = new Map<string, InkValue>();
    private views = new Map<string, Stroke>();
    private retired = new Set<string>();
    private deleted = new Map<string, InkValue>();
    private authoredDeleted = new Map<string, InkValue>();
    private signatures = new Map<string, string>();
    private bases = new Map<string, SyncBase>();
    private seen = new Map<string, WriterSnapshot>();
    private authored = new Map<string, InkValue>();
    private writer: string | null = null;
    private counter = 0;
    private acknowledged = 0;
    private pending: Publication | null = null;
    private undoStack: Op[] = [];
    private redoStack: Op[] = [];
    private inputActive = false;
    private deferred: SyncPayload | null = null;

    constructor(docId: string) {
        this.docId = docId;
        const empty = makeBase(docId, null);
        this.bases.set(empty.hash, empty);
    }
    get canEdit() { return this.loaded && !this.blocked; }
    get canUndo() { return this.blocked?.kind !== "integrity" && this.undoStack.length > 0; }
    get canRedo() { return this.blocked?.kind !== "integrity" && this.redoStack.length > 0; }
    block(kind: "integrity" | "capacity", message: string) { this.blocked = {kind, message}; }
    unblock() { if (!this.retiredDocument) this.blocked = null; }
    retireDocument() {
        const generation = this.generation;
        this.inputActive = false; this.deferred = null;
        this.adoptPayload(null);
        this.generation = generation; this.retiredDocument = true;
        this.block("integrity", "This document's handwriting generation was permanently retired");
    }
    rejectUnsentPublication() {
        // A save in preflight can still publish its frozen object. Only its
        // settled owner may release it, even before the first network write.
        if (this.saving) return;
        if (this.pending && !this.pending.attempted) {
            for (const value of this.pending.snapshot.values) {
                if (value.revision.startsWith(`${this.writer}.`) && Number(value.revision.split(".")[1]) > this.acknowledged && this.retired.has(value.revision)) {
                    this.deleted.delete(value.revision); this.authoredDeleted.delete(value.revision); // explicitly rejected bytes cannot be published
                }
            }
            this.pending = null;
        }
    }
    get conflictCount() {
        const counts = new Map<string, number>();
        for (const s of this.strokes) counts.set(s.logicalId!, (counts.get(s.logicalId!) ?? 0) + 1);
        return [...counts.values()].filter(n => n > 1).length;
    }
    beginInput() { this.inputActive = true; }
    endInput(): boolean {
        this.inputActive = false;
        const queued = this.deferred; this.deferred = null;
        return queued ? this.mergeRemote(queued) : false;
    }
    snapshotStrokes(strokes: Stroke[]) { return strokes.map(copyStroke); }

    private project() {
        const live = [...this.values.values()].filter(v => !this.retired.has(v.revision));
        const counts = new Map<string, number>();
        for (const v of live) counts.set(v.stroke.i, (counts.get(v.stroke.i) ?? 0) + 1);
        live.sort((a, b) => a.stroke.a - b.stroke.a || (a.revision < b.revision ? -1 : a.revision > b.revision ? 1 : 0));
        const views = new Map<string, Stroke>();
        this.strokes = live.map(v => {
            const stroke = this.views.get(v.revision) ?? {...deserializeStroke(v.stroke), logicalId: v.stroke.i, revision: v.revision};
            stroke.id = counts.get(v.stroke.i)! > 1 ? `${v.stroke.i}~${v.revision}` : v.stroke.i;
            views.set(v.revision, stroke);
            return stroke;
        });
        this.views = views; // unchanged revision point arrays are reused, not recopied on every pen-up
    }
    private current(strokes: Stroke[]): InkValue[] {
        return strokes.map(s => {
            const value = s.revision && this.values.get(s.revision);
            if (!value || this.retired.has(value.revision)) throw new Error("Ink changed remotely; select it again");
            return copyValue(value);
        });
    }
    private replace(before: InkValue[], geometry: ReturnType<typeof serializeStroke>[], keepDeleted: boolean): InkValue[] {
        if (!before.length && !geometry.length) return [];
        this.writer ??= randomWriter();
        // Even a deletion-only action advances the immutable publication filename.
        this.counter++;
        for (const v of before) {
            this.retired.add(v.revision);
            this.values.delete(v.revision);
            this.authored.delete(v.revision);
            const ownSequence = this.writer && v.revision.startsWith(`${this.writer}.`) ? Number(v.revision.split(".")[1]) : null;
            const unsentOwn = ownSequence !== null && ownSequence > this.acknowledged &&
                !(this.pending && ownSequence <= this.pending.snapshot.sequence);
            if (keepDeleted && !unsentOwn) {
                this.deleted.set(v.revision, copyValue(v));
                this.authoredDeleted.set(v.revision, copyValue(v));
            }
        }
        const added = geometry.map((stroke, index) => {
            const parent = before[index];
            const value: InkValue = {revision: `${this.writer}.${++this.counter}`, stroke,
                ...(parent && parent.stroke.i === stroke.i ? {replaces: [parent.revision]} : {})};
            this.values.set(value.revision, value);
            this.authored.set(value.revision, value);
            this.signatures.set(value.revision, fingerprint(value));
            return value;
        });
        this.dirty = true;
        this.project();
        return added;
    }
    private action(before: InkValue[], geometry: ReturnType<typeof serializeStroke>[], keepDeleted = false): InkValue[] {
        const after = this.replace(before, geometry, keepDeleted);
        this.undoStack.push({before: before.map(copyValue), after: after.map(copyValue)});
        if (this.undoStack.length > 100) this.undoStack.shift();
        this.redoStack = [];
        return after;
    }
    addStroke(tool: StrokeTool, config: {color: string; width: number; opacity: number; simulate: boolean}, points: Point[],
        anchor?: StrokeAnchor, fallback?: [number, number]): Stroke {
        if (this.retiredDocument || (this.blocked && !this.inputActive)) throw new Error(this.blocked?.message ?? "Document retired");
        const stroke: Stroke = {id: newId(), tool, ...config, points: points.map(p => ({...p})), createdAt: Date.now(), anchor, fallback};
        const [value] = this.action([], [serializeStroke(stroke)]);
        return this.strokes.find(s => s.revision === value.revision)!;
    }
    eraseWhere(predicate: (s: Stroke) => boolean): Stroke[] {
        if (this.blocked && !this.inputActive) return [];
        const removed = this.strokes.filter(predicate);
        if (removed.length) this.action(this.current(removed), [], true);
        return removed;
    }
    clearAll(): Stroke[] { return this.eraseWhere(() => true); }
    moveStrokesTransient(strokes: Stroke[], dx: number, dy: number) {
        for (const stroke of strokes) translateStroke(stroke, dx, dy);
    }
    commitMove(strokes: Stroke[], dx: number, dy: number, before?: Stroke[]): Stroke[] {
        if (before && (before.length !== strokes.length || before.some((s, i) => s.revision !== strokes[i]?.revision))) {
            throw new Error("A move must preserve the selected value identities");
        }
        if ((this.blocked && !this.inputActive) || (dx === 0 && dy === 0)) return strokes;
        const original = before ?? strokes.map(s => {
            const old = copyStroke(s); translateStroke(old, -dx, -dy); return old;
        });
        const oldValues = this.current(original);
        const geometry = strokes.map(serializeStroke);
        if (oldValues.every((v, i) => fingerprint(v.stroke) === fingerprint(geometry[i]))) return strokes;
        const after = this.action(oldValues, geometry);
        return after.map(v => this.strokes.find(s => s.revision === v.revision)!);
    }
    moveStrokes(strokes: Stroke[], dx: number, dy: number) {
        const before = this.snapshotStrokes(strokes);
        this.moveStrokesTransient(strokes, dx, dy);
        return this.commitMove(strokes, dx, dy, before);
    }
    duplicateStroke(stroke: Stroke): Stroke | null {
        if (this.blocked) return null;
        const copy = copyStroke(stroke);
        copy.id = newId(); delete copy.logicalId; delete copy.revision;
        translateStroke(copy, 12, 12);
        const [value] = this.action([], [serializeStroke(copy)]);
        return this.strokes.find(s => s.revision === value.revision)!;
    }
    private retarget(old: InkValue[], fresh: InkValue[], current: Op) {
        const replacements = new Map(old.map((v, i) => [v.revision, fresh[i]]));
        for (const op of [...this.undoStack, ...this.redoStack, current]) {
            op.before = op.before.map(v => copyValue(replacements.get(v.revision) ?? v));
            op.after = op.after.map(v => copyValue(replacements.get(v.revision) ?? v));
        }
    }
    undo(): boolean {
        if (!this.canUndo) return false;
        if (this.blocked?.kind === "capacity") { this.rejectUnsentPublication(); this.unblock(); }
        const op = this.undoStack.pop();
        if (!op) return false;
        const previous = op.before.map(copyValue);
        const restored = this.replace(op.after, previous.map(v => v.stroke), true);
        this.retarget(previous, restored, op);
        this.redoStack.push(op);
        return true;
    }
    redo(): boolean {
        if (!this.canRedo) return false;
        if (this.blocked?.kind === "capacity") { this.rejectUnsentPublication(); this.unblock(); }
        const op = this.redoStack.pop();
        if (!op) return false;
        const next = op.after.map(copyValue);
        const restored = this.replace(op.before, next.map(v => v.stroke), true);
        this.retarget(next, restored, op);
        this.undoStack.push(op);
        return true;
    }
    contentBBox(offsets?: (s: Stroke) => {dx: number; dy: number} | null) {
        if (!this.strokes.length) return null;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const s of this.strokes) {
            const b = strokeBBox(s), o = offsets ? offsets(s) : {dx: 0, dy: 0};
            if (!o) continue;
            minX = Math.min(minX, b.minX + o.dx); minY = Math.min(minY, b.minY + o.dy);
            maxX = Math.max(maxX, b.maxX + o.dx); maxY = Math.max(maxY, b.maxY + o.dy);
        }
        return Number.isFinite(minX) ? {minX, minY, maxX, maxY} : null;
    }

    private currentSnapshot(): WriterSnapshot {
        if (!this.writer || !this.counter) throw new Error("No local ink changes to publish");
        return {version: 2, docId: this.docId, writer: this.writer, sequence: this.counter,
            bases: [...this.bases.keys()].sort(), values: [...this.authored.values()].filter(v => !this.retired.has(v.revision)),
            retired: [...this.retired].sort(), deleted: [...this.authoredDeleted.values()]};
    }
    backup(): {format: string; payload: SyncPayload} {
        const snapshots = new Map(this.seen);
        if (this.writer && this.counter) snapshots.set(this.writer, this.currentSnapshot());
        return {format: "pencil-sync-backup", payload: {version: 2, docId: this.docId, generation: this.generation, bases: [...this.bases.values()], snapshots: [...snapshots.values()]}};
    }
    serialize(): Publication {
        if (this.retiredDocument) throw new Error("Document retired");
        if (this.pending) return this.pending;
        // Frozen retry bytes: remote reads cannot change an already allocated filename.
        this.pending = JSON.parse(JSON.stringify({generation: this.generation, bases: [...this.bases.values()], snapshot: this.currentSnapshot()}));
        return this.pending!;
    }
    acknowledge(sequence: number) {
        if (this.retiredDocument) return;
        if (this.pending?.snapshot.sequence === sequence) this.pending = null;
        this.acknowledged = Math.max(this.acknowledged, sequence);
        this.dirty = this.counter > this.acknowledged;
        this.lastSavedAt = Date.now();
    }
    adoptPayload(payload: InkPayload | null) {
        if (this.retiredDocument) return;
        this.inputActive = false; this.deferred = null;
        this.generation = payload?.version === 2 ? payload.generation ?? 0 : 0;
        if (!Number.isSafeInteger(this.generation) || this.generation < 0) throw new Error("Invalid document generation");
        this.values.clear(); this.views.clear(); this.retired.clear(); this.deleted.clear(); this.authoredDeleted.clear(); this.signatures.clear(); this.bases.clear(); this.seen.clear();
        this.authored.clear(); this.writer = null; this.counter = this.acknowledged = 0; this.pending = null;
        this.undoStack = []; this.redoStack = [];
        if (payload) this.mergeRemote(payload);
        else { const base = makeBase(this.docId, null); this.bases.set(base.hash, base); }
        this.dirty = false;
        this.loaded = true;
        this.project();
    }
    mergeRemote(payload: InkPayload): boolean {
        if (this.retiredDocument) return false;
        if ((payload.version === 2 ? payload.generation ?? 0 : 0) !== this.generation) throw new Error("Document lifetime changed; download a backup of unsaved ink and reload the page");
        if (payload.docId !== this.docId) throw new Error("Wrong document payload");
        if (this.inputActive) {
            const bases = new Map(this.deferred?.bases.map(b => [b.hash, b]) ?? []);
            const snapshots = new Map(this.deferred?.snapshots.map(s => [s.writer, s]) ?? []);
            const incoming = payload.version === 1 ? {bases: [makeBase(this.docId, payload)], snapshots: []} : payload;
            for (const base of incoming.bases) bases.set(base.hash, base);
            for (const snapshot of incoming.snapshots) {
                const old = snapshots.get(snapshot.writer);
                if (!old || snapshot.sequence > old.sequence) {
                    if (old && !snapshotCovers(snapshot, old)) throw new Error("Deferred writer snapshot is not cumulative");
                    snapshots.set(snapshot.writer, snapshot);
                } else if (old.sequence === snapshot.sequence && fingerprint(old) !== fingerprint(snapshot)) throw new Error("An immutable snapshot changed");
            }
            this.deferred = {version: 2, docId: this.docId, generation: this.generation, bases: [...bases.values()], snapshots: [...snapshots.values()]};
            return false;
        }
        const bases = payload.version === 1 ? [makeBase(this.docId, payload)] : payload.bases;
        const snapshots = payload.version === 1 ? [] : payload.snapshots;
        const before = new Map(this.strokes.map(s => [s.revision!, s.logicalId!]));
        const values = new Map(this.values), retired = new Set(this.retired), deleted = new Map(this.deleted);
        const signatures = new Map(this.signatures), seen = new Map(this.seen), nextBases = new Map(this.bases);
        const accept = (value: InkValue) => {
            const hash = fingerprint(value), previous = signatures.get(value.revision);
            if (previous && previous !== hash) throw new Error("Conflicting contents for one ink revision");
            signatures.set(value.revision, hash); values.set(value.revision, value);
        };
        for (const base of bases) {
            // An empty in-memory base is not a migration source once a real source is available.
            nextBases.set(base.hash, base);
            baseValues(base).forEach(accept);
        }
        for (const snapshot of snapshots) {
            const old = seen.get(snapshot.writer);
            if (old && old.sequence > snapshot.sequence) continue;
            if (old && old.sequence === snapshot.sequence) {
                if (fingerprint(old) !== fingerprint(snapshot)) throw new Error("An immutable writer snapshot changed");
                continue;
            }
            if (old && !snapshotCovers(snapshot, old)) throw new Error("Writer snapshot is not cumulative");
            snapshot.values.forEach(accept);
            for (const id of snapshot.retired) retired.add(id);
            for (const value of snapshot.deleted) { accept(value); deleted.set(value.revision, value); }
            seen.set(snapshot.writer, snapshot);
        }
        for (const id of retired) values.delete(id);
        this.values = values; this.retired = retired; this.deleted = deleted; this.signatures = signatures; this.seen = seen; this.bases = nextBases;
        this.project();
        const after = new Map(this.strokes.map(s => [s.revision!, s.logicalId!]));
        const affected = new Set<string>();
        for (const [id, logical] of before) if (!after.has(id)) affected.add(logical);
        for (const [id, logical] of after) if (!before.has(id)) affected.add(logical);
        if (affected.size) {
            // Never apply pre-remote undo geometry over another device's edits.
            const unaffected = (op: Op) => ![...op.before, ...op.after].some(v => affected.has(v.stroke.i));
            this.undoStack = this.undoStack.filter(unaffected);
            this.redoStack = this.redoStack.filter(unaffected);
        }
        return affected.size > 0;
    }
}
