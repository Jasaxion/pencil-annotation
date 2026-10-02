import {showMessage, type Plugin} from "siyuan";
import type {PencilPayload} from "../engine/types";
import {fingerprint, makeBase, safeId, validateBase, validateLegacy, validateSnapshot,
    MAX_FILE_BYTES, MAX_DOCUMENT_BYTES, MAX_FILES, MAX_WRITERS, MAX_BASES, snapshotCovers, SyncCapacityError, SyncIntegrityError, SyncTransientError,
    type Publication, type SyncBase, type SyncPayload, type WriterSnapshot} from "../engine/sync";

export const authHeaders = (): Record<string, string> => {
    const token = window.siyuan?.config?.api?.token;
    return token ? {Authorization: `Token ${token}`} : {};
};
export const storageName = (docId: string) => `${docId}.json`;
export const syncDirectory = (plugin: Plugin, docId: string, generation = 0) => {
    if (!safeId(plugin.name) || !safeId(docId) || !Number.isSafeInteger(generation) || generation < 0) throw new Error("Invalid storage identifier");
    return `/data/storage/petal/${plugin.name}/sync-v2/${docId}${generation ? `/g${generation}` : ""}`;
};

export async function boundedJSON(response: Response, maxBytes = MAX_FILE_BYTES): Promise<any> {
    if (!response.ok) {
        if (response.status >= 500) throw new SyncTransientError(`HTTP ${response.status}`);
        throw new SyncIntegrityError(`HTTP ${response.status}`);
    }
    if (!response.body) throw new Error("Empty response");
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let bytes = 0, text = "";
    try {
        while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > maxBytes) { await reader.cancel(); throw new SyncCapacityError("Handwriting response exceeds the safety limit"); }
            text += decoder.decode(chunk.value, {stream: true});
        }
        text += decoder.decode();
        return JSON.parse(text);
    } finally { reader.releaseLock(); }
}
export async function kernelJSON(path: string, data: unknown, signal?: AbortSignal): Promise<any> {
    const response = await fetch(path, {method: "POST", headers: {"Content-Type": "application/json", ...authHeaders()}, body: JSON.stringify(data), signal});
    const result = await boundedJSON(response);
    if (result.code !== 0) throw new Error(result.msg || `Kernel error ${result.code}`);
    return result.data;
}
async function readFile(path: string): Promise<any | null> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
    try {
        const response = await fetch("/api/file/getFile", {method: "POST", headers: {"Content-Type": "application/json", ...authHeaders()},
            body: JSON.stringify({path}), signal: controller.signal});
        if (response.status === 404) return null;
        const value = await boundedJSON(response);
        if (value?.code === 404) return null;
        if (typeof value?.code === "number") throw new Error(value.msg || `Read failed: ${value.code}`);
        return value;
    } finally { clearTimeout(timer); }
}
interface FileEntry {name: string; isDir: boolean; isSymlink?: boolean}
const MAX_REGISTRY_ENTRIES = 50000; // metadata-only registries, not per-document ink snapshots
async function readDir(path: string, maxEntries = MAX_FILES): Promise<FileEntry[]> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
    try {
        const response = await fetch("/api/file/readDir", {method: "POST", headers: {"Content-Type": "application/json", ...authHeaders()},
            body: JSON.stringify({path}), signal: controller.signal});
        const result = await boundedJSON(response);
        if (result.code === 404) return [];
        if (result.code !== 0 || !Array.isArray(result.data)) throw new Error(result.msg || "Cannot enumerate ink snapshots");
        if (result.data.length > maxEntries) throw new SyncCapacityError("Ink snapshot directory needs maintenance; no files were discarded");
        return result.data;
    } finally { clearTimeout(timer); }
}
async function putFile(path: string, data: unknown) {
    const host = window.siyuan;
    if (host?.config?.readonly || host?.isPublish) throw new Error("Readonly or published document");
    const bytes = JSON.stringify(data);
    const blob = new Blob([bytes], {type: "application/json"});
    if (blob.size > MAX_FILE_BYTES) throw new SyncCapacityError("Ink snapshot is too large; keep the page open and export a backup");
    const form = new FormData(); form.append("path", path); form.append("isDir", "false"); form.append("file", blob, path.split("/").pop()!);
    const result = await boundedJSON(await fetch("/api/file/putFile", {method: "POST", headers: authHeaders(), body: form}));
    if (result.code !== 0) {
        if ([400, 401, 403].includes(result.code)) throw new SyncIntegrityError(result.msg || "Ink write was refused");
        throw new SyncTransientError(result.msg || "Ink write failed");
    }
}
export const validDocumentId = (id: unknown): id is string => typeof id === "string" && /^\d{14}-[a-z0-9]{7}$/.test(id);
export class DocumentRetiredError extends SyncIntegrityError {
    constructor(readonly generation: number) { super("This document's old handwriting was retired; reopen the document for a fresh handwriting session"); }
}
const lifetimes = new WeakMap<Plugin, {epochs: Map<string, number>; fenced: Set<string>; generations: Map<string, number>; writes: Map<string, Set<Promise<unknown>>>}>();
function lifetimeState(plugin: Plugin) {
    let state = lifetimes.get(plugin);
    if (!state) { state = {epochs: new Map(), fenced: new Set(), generations: new Map(), writes: new Map()}; lifetimes.set(plugin, state); }
    return state;
}
function operationEpoch(plugin: Plugin, docId: string) {
    const epoch = lifetimeState(plugin).epochs.get(docId) ?? 0;
    assertOperation(plugin, docId, epoch); return epoch;
}
function assertOperation(plugin: Plugin, docId: string, epoch: number) {
    const state = lifetimeState(plugin);
    if (state.fenced.has(docId) || (state.epochs.get(docId) ?? 0) !== epoch) throw new SyncTransientError("Document deletion interrupted this operation; its old data was not republished");
}
export function fenceDocument(plugin: Plugin, docId: string): () => void {
    const state = lifetimeState(plugin);
    state.epochs.set(docId, (state.epochs.get(docId) ?? 0) + 1); state.fenced.add(docId);
    return () => state.fenced.delete(docId);
}
function trackWrite<T>(plugin: Plugin, docId: string, run: () => Promise<T>): Promise<T> {
    const writes = lifetimeState(plugin).writes;
    let pending = writes.get(docId); if (!pending) { pending = new Set(); writes.set(docId, pending); }
    const operation = run().finally(() => { pending!.delete(operation); if (!pending!.size) writes.delete(docId); });
    pending.add(operation); return operation;
}
export async function settleDocumentWrites(plugin: Plugin, docId: string) {
    const pending = lifetimeState(plugin).writes.get(docId);
    if (pending) await Promise.allSettled([...pending]);
}
const lifecycleRoot = (plugin: Plugin) => {
    if (!safeId(plugin.name)) throw new SyncIntegrityError("Invalid plugin storage name");
    return `/data/storage/petal/${plugin.name}/document-lifecycle`;
};
const lifecycleDirectory = (plugin: Plugin, docId: string) => {
    syncDirectory(plugin, docId); return `${lifecycleRoot(plugin)}/${docId}`;
};
const lifecycleFile = /^(deleted|active)-([1-9]\d{0,8})\.json$/;
async function readLifecycle(plugin: Plugin, docId: string): Promise<{generation: number; active: boolean}> {
    const directory = lifecycleDirectory(plugin, docId), files = await readDir(directory);
    let generation = 0, activeGeneration = 0;
    for (const file of files) {
        const match = lifecycleFile.exec(file.name);
        if (!match || file.isDir || file.isSymlink) throw new SyncIntegrityError("Unknown document lifecycle metadata; files were preserved");
        if (match[1] === "deleted") generation = Math.max(generation, Number(match[2]));
        else activeGeneration = Math.max(activeGeneration, Number(match[2]));
    }
    const known = lifetimeState(plugin).generations.get(docId) ?? 0;
    if (activeGeneration > generation) {
        const active = await readFile(`${directory}/active-${activeGeneration}.json`);
        if (!active || active.version !== 1 || active.docId !== docId || active.kind !== "active" || active.generation !== activeGeneration) throw new SyncIntegrityError("Invalid document lifetime record");
        lifetimeState(plugin).generations.set(docId, Math.max(known, activeGeneration));
        throw new SyncTransientError("Document lifecycle synchronization is incomplete; older ink was not loaded");
    }
    if (generation < known) throw new SyncTransientError("Document deletion metadata is temporarily incomplete");
    let active = false;
    for (const kind of ["deleted", "active"] as const) {
        if (!generation || (kind === "active" && !files.some(f => f.name === `active-${generation}.json`))) continue;
        const value = await readFile(`${directory}/${kind}-${generation}.json`);
        if (!value || value.version !== 1 || value.docId !== docId || value.kind !== kind || value.generation !== generation) throw new SyncIntegrityError("Invalid document lifecycle record; files were preserved");
        if (kind === "active") active = true;
    }
    if (generation) lifetimeState(plugin).generations.set(docId, generation);
    return {generation, active};
}
async function writeLifecycle(plugin: Plugin, docId: string, kind: "deleted" | "active", generation: number) {
    const value = {version: 1, docId, kind, generation}, path = `${lifecycleDirectory(plugin, docId)}/${kind}-${generation}.json`;
    const matches = (record: any) => record?.version === 1 && record.docId === docId && record.kind === kind && record.generation === generation;
    const existing = await readFile(path);
    if (existing && !matches(existing)) throw new SyncIntegrityError("Conflicting document lifecycle record");
    if (!existing) {
        const entry = (await readDir(lifecycleRoot(plugin), MAX_REGISTRY_ENTRIES)).find(file => file.name === docId);
        if (entry && (!entry.isDir || entry.isSymlink)) throw new SyncIntegrityError("Unexpected document lifecycle directory");
        await putFile(path, value);
    }
    if (!matches(await readFile(path))) throw new SyncIntegrityError("Document lifecycle write could not be verified");
}
async function documentExists(docId: string): Promise<boolean> {
    const result = await boundedJSON(await fetch("/api/block/getDocInfo", {method: "POST", headers: {"Content-Type": "application/json", ...authHeaders()}, body: JSON.stringify({id: docId})}));
    if (result.code === 0 && result.data?.id === docId && result.data?.rootID === docId) return true;
    if (result.code === -1 && result.msg === "block not found" && result.data == null) return false;
    throw new SyncTransientError("Document availability could not be checked; handwriting was preserved");
}
async function assertDocumentGeneration(plugin: Plugin, docId: string, generation: number) {
    const current = await readLifecycle(plugin, docId);
    if (generation < current.generation) throw new DocumentRetiredError(current.generation);
    if (generation !== current.generation) throw new SyncTransientError("Document lifecycle synchronization is incomplete");
    if (!await documentExists(docId)) throw new SyncTransientError("Document is unavailable; this is not evidence to erase its handwriting");
}

/** Called ONLY for a successful removeDoc event, never from a missing-document scan.
 * Reused IDs have no event occurrence token in SiYuan: require confirmation rather
 * than guessing whether a notification belongs to the restored lifetime. */
export async function planDocumentDeletion(plugin: Plugin, docId: string, capturedGeneration?: number) {
    if (!validDocumentId(docId)) throw new SyncIntegrityError("Invalid deleted document ID");
    const life = await readLifecycle(plugin, docId);
    if (life.generation && !life.active && capturedGeneration !== life.generation && !(await readDir(syncDirectory(plugin, docId, life.generation))).length) {
        return {generation: life.generation - 1, confirm: false}; // same retirement, not a new generation
    }
    if (capturedGeneration !== undefined && capturedGeneration < life.generation && await documentExists(docId)) return {generation: capturedGeneration, confirm: false};
    const exists = await documentExists(docId);
    const listing = await kernelJSON("/api/notebook/lsNotebooks", {});
    const fullyAvailable = Array.isArray(listing?.notebooks) && listing.notebooks.length > 0 && listing.notebooks.every((box: any) =>
        box.closed === false && (box.encrypted === false || (box.encrypted === true && box.unlocked === true)));
    return {generation: life.generation, confirm: exists || life.generation > 0 || !fullyAvailable};
}
export async function retireDocumentGeneration(plugin: Plugin, docId: string, generation: number, confirmed = false) {
    if (!validDocumentId(docId) || !Number.isSafeInteger(generation) || generation < 0) throw new SyncIntegrityError("Invalid document retirement");
    const current = await readLifecycle(plugin, docId);
    if (generation > current.generation) throw new SyncIntegrityError("Unverified document generation");
    if (generation === current.generation) {
        if (!confirmed && await documentExists(docId)) throw new SyncTransientError("Document was restored during cleanup; confirmation is required");
        await writeLifecycle(plugin, docId, "deleted", generation + 1);
    }
    // Old v2 clients must fail closed too; this guard contains no ink.
    const entry = (await readDir(`/data/storage/petal/${plugin.name}/sync-v2`, MAX_REGISTRY_ENTRIES)).find(file => file.name === docId);
    if (entry && (!entry.isDir || entry.isSymlink)) throw new SyncIntegrityError("Unexpected document storage directory");
    const path = `${syncDirectory(plugin, docId)}/retired-v1.json`, guard = {version: 1, docId, kind: "retired-original"};
    const existing = await readFile(path);
    if (existing && fingerprint(existing) !== fingerprint(guard)) throw new SyncIntegrityError("Unknown document retirement guard");
    if (!existing) await putFile(path, guard);
    if (fingerprint(await readFile(path)) !== fingerprint(guard)) throw new SyncIntegrityError("Document retirement guard was not verified");
    if ((await readLifecycle(plugin, docId)).generation <= generation) throw new SyncIntegrityError("Document retirement was not persisted");
    releasePayloadCache(plugin, docId, generation + 1);
}
export async function retiredDocumentIds(plugin: Plugin): Promise<string[]> {
    // ponytail: bounded registry scans; use a targeted stat/index if very large
    // retired-document registries make background cleanup noticeably expensive.
    return (await readDir(lifecycleRoot(plugin), MAX_REGISTRY_ENTRIES)).filter(f => f.isDir && !f.isSymlink && validDocumentId(f.name)).map(f => f.name);
}
export async function cleanupRetiredDocument(plugin: Plugin, docId: string) {
    if (window.siyuan?.config?.readonly || window.siyuan?.isPublish) return;
    if (!validDocumentId(docId)) throw new SyncIntegrityError("Invalid cleanup document ID");
    const {generation} = await readLifecycle(plugin, docId);
    if (!generation) return;
    const parent = `/data/storage/petal/${plugin.name}`, root = syncDirectory(plugin, docId);
    const docEntry = (await readDir(`${parent}/sync-v2`, MAX_REGISTRY_ENTRIES)).find(f => f.name === docId);
    if (docEntry && (!docEntry.isDir || docEntry.isSymlink)) throw new SyncIntegrityError("Unexpected document storage path; cleanup refused");
    const files = await readDir(root), paths: string[] = [];
    for (const file of files) {
        if (file.isSymlink) throw new SyncIntegrityError("Cleanup refused a symlink");
        if (file.name === "retired-v1.json" && !file.isDir) continue;
        if (file.isDir && /^g[1-9]\d{0,8}$/.test(file.name)) {
            if (Number(file.name.slice(1)) < generation) paths.push(`${root}/${file.name}`);
        } else if (!file.isDir && (snapshotName.test(file.name) || baseName.test(file.name))) paths.push(`${root}/${file.name}`);
        else throw new SyncIntegrityError("Unknown ink files were preserved during document cleanup");
    }
    const legacy = (await readDir(parent, MAX_REGISTRY_ENTRIES)).find(f => f.name === storageName(docId));
    if (legacy) {
        if (legacy.isDir || legacy.isSymlink) throw new SyncIntegrityError("Unexpected legacy storage path; cleanup refused");
        paths.push(`${parent}/${storageName(docId)}`);
    }
    for (const path of paths) await kernelJSON("/api/file/removeFile", {path});
    // Never remove the parent directory: a restored document may be publishing
    // a new-generation child concurrently. History/cloud backups are not erased.
    releasePayloadCache(plugin, docId, generation);
}

interface ReadCache {generation: number; files: Map<string, any>; latest: Map<string, WriterSnapshot>; bases: Map<string, SyncBase>; legacyChecked: boolean;
    activeReads: number; releaseWhenIdle: boolean; hardError: {kind: "capacity" | "integrity"; message: string} | null}
const measured = new WeakMap<object, number>();
const measure = (value: object): number => {
    let bytes = measured.get(value);
    if (bytes === undefined) { bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength; measured.set(value, bytes); }
    return bytes;
};
const caches = new WeakMap<Plugin, Map<string, ReadCache>>();
function cacheFor(plugin: Plugin, docId: string, generation = 0): ReadCache {
    const key = `${docId}/${generation}`;
    let docs = caches.get(plugin); if (!docs) { docs = new Map(); caches.set(plugin, docs); }
    let cache = docs.get(key); if (!cache) { cache = {generation, files: new Map(), latest: new Map(), bases: new Map(), legacyChecked: false, activeReads: 0, releaseWhenIdle: false, hardError: null}; docs.set(key, cache); }
    cache.releaseWhenIdle = false;
    return cache;
}
export function releasePayloadCache(plugin: Plugin, docId: string, beforeGeneration = Infinity) {
    const docs = caches.get(plugin);
    for (const [key, cache] of docs ?? []) if (key.startsWith(`${docId}/`) && cache.generation < beforeGeneration) {
        if (cache.activeReads) cache.releaseWhenIdle = true;
        else docs!.delete(key);
    }
}
const snapshotName = /^(w[a-f0-9]{32})-([1-9]\d{0,14})\.json$/;
const baseName = /^base-([a-f0-9]{64})\.json$/;

/** Read the legacy backup plus the greatest known immutable snapshot of each writer.
 * Missing/failed listings never mean deletion; deletions are explicit retired value IDs. */
export async function loadPayload(plugin: Plugin, docId: string, checkLegacy = true): Promise<SyncPayload> {
    const epoch = operationEpoch(plugin, docId), generation = (await readLifecycle(plugin, docId)).generation;
    assertOperation(plugin, docId, epoch);
    if (generation) {
        if (!await documentExists(docId)) throw new DocumentRetiredError(generation);
        await writeLifecycle(plugin, docId, "active", generation);
    }
    const cache = cacheFor(plugin, docId, generation); cache.activeReads++;
    try {
        if (!checkLegacy && cache.hardError) throw cache.hardError.kind === "capacity"
            ? new SyncCapacityError(cache.hardError.message) : new SyncIntegrityError(cache.hardError.message);
        const result = await loadPayloadData(plugin, docId, cache, checkLegacy);
        assertOperation(plugin, docId, epoch);
        if ((await readLifecycle(plugin, docId)).generation !== generation) throw new SyncTransientError("Document lifetime changed during load; retry");
        if (generation && !await documentExists(docId)) throw new DocumentRetiredError(generation);
        assertOperation(plugin, docId, epoch);
        if (checkLegacy) cache.hardError = null;
        return result;
    } catch (error) {
        if (error instanceof DocumentRetiredError) throw error;
        if ((error as Error)?.name === "AbortError" || error instanceof TypeError || error instanceof SyncTransientError) throw error;
        const kind = error instanceof SyncCapacityError ? "capacity" : "integrity";
        const message = String((error as Error)?.message || error);
        cache.hardError = {kind, message};
        throw kind === "capacity" ? new SyncCapacityError(message) : new SyncIntegrityError(message);
    } finally {
        cache.activeReads--;
        if (!cache.activeReads && cache.releaseWhenIdle && caches.get(plugin)?.get(`${docId}/${cache.generation}`) === cache) caches.get(plugin)!.delete(`${docId}/${cache.generation}`);
    }
}
async function loadPayloadData(plugin: Plugin, docId: string, cache: ReadCache, checkLegacy: boolean, skipLegacyGuard = false): Promise<SyncPayload> {
    const directory = syncDirectory(plugin, docId, cache.generation);
    for (let attempt = 0; attempt < 2; attempt++) {
        const files = await readDir(directory);
        const candidates = new Map<string, {name: string; seq: number}>();
        const baseFiles: Array<{name: string; hash: string}> = [];
        for (const file of files) {
            if (file.isDir || file.isSymlink) throw new Error("Unexpected directory or symlink in ink storage");
            const snapshot = snapshotName.exec(file.name), base = baseName.exec(file.name);
            if (snapshot) {
                const seq = Number(snapshot[2]);
                if (!Number.isSafeInteger(seq)) throw new Error("Invalid snapshot sequence");
                if (seq > (candidates.get(snapshot[1])?.seq ?? 0)) candidates.set(snapshot[1], {name: file.name, seq});
            } else if (base) baseFiles.push({name: file.name, hash: base[1]});
            else if (file.name.endsWith(".json")) throw new Error("Unknown ink format; upgrade the plugin before editing");
        }
        if (candidates.size > MAX_WRITERS || baseFiles.length > MAX_BASES) throw new SyncCapacityError("Too many ink writer/import sessions; maintenance is required");
        const bases = new Map(cache.bases), latest = new Map(cache.latest), loadedFiles = new Map(cache.files);
        let bytes = [...bases.values(), ...latest.values()].reduce((sum, value) => sum + measure(value), 0);
        const withinBudget = () => { if (bytes > MAX_DOCUMENT_BYTES) throw new SyncCapacityError("Ink document exceeds the synchronization memory budget"); };
        withinBudget();
        let raced = false;
        for (const file of baseFiles) {
            if (bases.has(file.hash)) continue;
            const path = `${directory}/${file.name}`;
            const base = loadedFiles.get(path) ?? await readFile(path);
            if (!base) { raced = true; break; }
            validateBase(base, docId, file.hash);
            bytes += measure(base); withinBudget();
            bases.set(file.hash, base); loadedFiles.set(path, base);
        }
        for (const [writer, file] of candidates) {
            if (raced) break;
            if ((latest.get(writer)?.sequence ?? 0) >= file.seq) continue;
            const path = `${directory}/${file.name}`;
            const snapshot = loadedFiles.get(path) ?? await readFile(path);
            if (!snapshot) { raced = true; break; }
            validateSnapshot(snapshot, docId, writer, file.seq);
            if (snapshot.bases.some((hash: string) => !bases.has(hash))) { raced = true; break; }
            bytes += measure(snapshot) - (latest.has(writer) ? measure(latest.get(writer)!) : 0); withinBudget();
            latest.set(writer, snapshot);
            if (latest.size > MAX_WRITERS) throw new SyncCapacityError("Too many ink writer sessions; maintenance is required");
            loadedFiles.set(path, snapshot);
        }
        if (raced) { if (!attempt) continue; throw new SyncTransientError("Ink sync is incomplete; retry after synchronization finishes"); }
        if (!skipLegacyGuard && (checkLegacy || !cache.legacyChecked)) {
            const legacy = cache.generation ? null : await readFile(`/data/storage/petal/${plugin.name}/${storageName(docId)}`);
            if (legacy) validateLegacy(legacy, docId);
            const currentBase = makeBase(docId, legacy as PencilPayload | null);
            if (!bases.size && !latest.size) { bases.set(currentBase.hash, currentBase); bytes += measure(currentBase); withinBudget(); }
            else if (!bases.has(currentBase.hash)) throw new Error("An old plugin changed the legacy ink file. Refresh all old pages; the original file and new snapshots have been preserved");
            cache.legacyChecked = true;
        }
        const payload: SyncPayload = {version: 2, docId, generation: cache.generation, bases: [...bases.values()], snapshots: [...latest.values()]};
        cache.bases = bases; cache.latest = latest; cache.files = loadedFiles;
        const retainedPaths = new Set([...baseFiles.map(f => `${directory}/${f.name}`),
            ...[...latest.values()].map(s => `${directory}/${s.writer}-${s.sequence}.json`)]);
        for (const path of cache.files.keys()) if (!retainedPaths.has(path)) cache.files.delete(path);
        return payload;
    }
    throw new Error("Ink synchronization failed");
}

/** Explicit, additive reconciliation only. An unchanged old value keeps its
 * deterministic ID, so retired ink cannot be resurrected by reimporting it. */
export function reconcileLegacy(plugin: Plugin, docId: string): Promise<SyncPayload> {
    return trackWrite(plugin, docId, () => reconcileLegacyData(plugin, docId));
}
async function reconcileLegacyData(plugin: Plugin, docId: string): Promise<SyncPayload> {
    const epoch = operationEpoch(plugin, docId);
    if ((await readLifecycle(plugin, docId)).generation) throw new SyncIntegrityError("Legacy ink from a deleted document cannot be reimported");
    const directory = syncDirectory(plugin, docId), cache = cacheFor(plugin, docId);
    const guard = async () => { assertOperation(plugin, docId, epoch); await assertDocumentGeneration(plugin, docId, 0); assertOperation(plugin, docId, epoch); };
    cache.activeReads++;
    try {
        const current = await loadPayloadData(plugin, docId, cache, false, true);
        const legacy = await readFile(`/data/storage/petal/${plugin.name}/${storageName(docId)}`);
        if (legacy) validateLegacy(legacy, docId);
        const base = makeBase(docId, legacy as PencilPayload | null);
        const allBases = new Map(current.bases.map(b => [b.hash, b])); allBases.set(base.hash, base);
        if (allBases.size > MAX_BASES || measure(base) > MAX_FILE_BYTES || [...allBases.values(), ...current.snapshots].reduce((sum, value) => sum + measure(value), 0) > MAX_DOCUMENT_BYTES) {
            throw new SyncCapacityError("Legacy import exceeds the document budget; original files were preserved");
        }
        const files = await readDir(directory);
        if (files.length >= MAX_FILES && !files.some(file => file.name === `base-${base.hash}.json`)) throw new SyncCapacityError("Ink storage needs maintenance before import");
        const path = `${directory}/base-${base.hash}.json`;
        const existing = await readFile(path);
        if (existing && fingerprint(existing) !== fingerprint(base)) throw new SyncIntegrityError("Migration backup conflict");
        await guard();
        if (!existing) await putFile(path, base);
        await guard();
        if (fingerprint(await readFile(path)) !== fingerprint(base)) throw new SyncIntegrityError("Migration backup verification failed");
        return await loadPayload(plugin, docId, true);
    } finally {
        cache.activeReads--;
        if (!cache.activeReads && cache.releaseWhenIdle && caches.get(plugin)?.get(`${docId}/${cache.generation}`) === cache) caches.get(plugin)!.delete(`${docId}/${cache.generation}`);
    }
}

export function checkPublicationBudget(publication: Publication, current: SyncPayload, fileLimit = MAX_FILE_BYTES, totalLimit = MAX_DOCUMENT_BYTES) {
    validateSnapshot(publication.snapshot, publication.snapshot.docId, publication.snapshot.writer, publication.snapshot.sequence);
    const bases = new Map(current.bases.map(b => [b.hash, b])), snapshots = new Map(current.snapshots.map(s => [s.writer, s]));
    for (const base of publication.bases) {
        validateBase(base, publication.snapshot.docId, base.hash);
        if (measure(base) > fileLimit) throw new SyncCapacityError("Migration backup exceeds the file budget");
        bases.set(base.hash, base);
    }
    if (measure(publication.snapshot) > fileLimit) throw new SyncCapacityError("Ink snapshot exceeds the file budget. Undo unsaved ink or download a backup");
    snapshots.set(publication.snapshot.writer, publication.snapshot);
    if (bases.size > MAX_BASES || snapshots.size > MAX_WRITERS) throw new SyncCapacityError("Too many ink writer/import sessions; maintenance is required");
    if ([...bases.values(), ...snapshots.values()].reduce((sum, value) => sum + measure(value), 0) > totalLimit) {
        throw new SyncCapacityError("This write would exceed the document read budget. Undo unsaved ink or download a backup; existing files were preserved");
    }
}
const cleanupWarnings = new WeakSet<Plugin>();
export function savePayload(plugin: Plugin, publication: Publication): Promise<boolean> {
    return trackWrite(plugin, publication.snapshot.docId, () => savePayloadData(plugin, publication));
}
async function savePayloadData(plugin: Plugin, publication: Publication): Promise<boolean> {
    try {
        const {snapshot, bases} = publication, generation = publication.generation ?? 0;
        const epoch = operationEpoch(plugin, snapshot.docId);
        const guard = async () => { assertOperation(plugin, snapshot.docId, epoch); await assertDocumentGeneration(plugin, snapshot.docId, generation); assertOperation(plugin, snapshot.docId, epoch); };
        const directory = syncDirectory(plugin, snapshot.docId, generation), cache = cacheFor(plugin, snapshot.docId, generation);
        validateSnapshot(snapshot, snapshot.docId, snapshot.writer, snapshot.sequence);
        if (window.siyuan?.config?.readonly || window.siyuan?.isPublish) throw new SyncIntegrityError("Readonly or published document");
        await guard();
        const current = await loadPayload(plugin, snapshot.docId, !cache.legacyChecked);
        if ((current.generation ?? 0) !== generation) throw new DocumentRetiredError(current.generation ?? 0);
        checkPublicationBudget(publication, current);
        const files = await readDir(directory);
        const writers = new Set(files.map(f => snapshotName.exec(f.name)?.[1]).filter(Boolean));
        if (files.length >= MAX_FILES || (!writers.has(snapshot.writer) && writers.size >= MAX_WRITERS)) throw new SyncCapacityError("Ink storage needs maintenance before more writes");
        for (const base of bases) {
            validateBase(base, snapshot.docId, base.hash);
            const path = `${directory}/base-${base.hash}.json`;
            const existing = cache.files.get(path) ?? await readFile(path);
            if (existing && fingerprint(existing) !== fingerprint(base)) throw new SyncIntegrityError("Migration backup conflict");
            if (!existing) {
                await guard();
                await putFile(path, base);
                await guard();
                if (fingerprint(await readFile(path)) !== fingerprint(base)) throw new SyncIntegrityError("Migration backup verification failed");
            }
            cache.files.set(path, base); cache.bases.set(base.hash, base);
        }
        const path = `${directory}/${snapshot.writer}-${snapshot.sequence}.json`;
        const existing = await readFile(path);
        if (existing && fingerprint(existing) !== fingerprint(snapshot)) throw new SyncIntegrityError("Immutable snapshot collision");
        await guard();
        publication.attempted = true;
        if (!existing) await putFile(path, snapshot);
        await guard();
        const verified = await readFile(path);
        if (fingerprint(verified) !== fingerprint(snapshot)) throw new SyncIntegrityError("Ink snapshot verification failed");
        await guard();
        cache.files.set(path, snapshot);
        cache.latest.set(snapshot.writer, snapshot);
        // Only prune this writer's old files, after read-back verification. Keep two
        // cumulative successors; never expire tombstones or delete another writer.
        try {
            const own = files.map(f => ({file: f, match: snapshotName.exec(f.name)}))
                .filter(x => x.match?.[1] === snapshot.writer && Number(x.match[2]) < snapshot.sequence)
                .sort((a, b) => Number(b.match![2]) - Number(a.match![2]));
            if (own.length > 1) {
                const previousPath = `${directory}/${own[0].file.name}`;
                const previous = await readFile(previousPath);
                validateSnapshot(previous, snapshot.docId, snapshot.writer, Number(own[0].match![2]));
                if (!snapshotCovers(snapshot, previous)) throw new Error("Snapshot does not cover its predecessor");
                for (const old of own.slice(1)) {
                    const oldPath = `${directory}/${old.file.name}`;
                    const value = await readFile(oldPath);
                    if (!value) continue;
                    validateSnapshot(value, snapshot.docId, snapshot.writer, Number(old.match![2]));
                    if (!snapshotCovers(previous, value) || !snapshotCovers(snapshot, value)) throw new Error("Refusing unsafe snapshot cleanup");
                    await guard();
                    await kernelJSON("/api/file/removeFile", {path: oldPath}); cache.files.delete(oldPath);
                }
            }
        } catch (e) {
            console.warn("[pencil-annotation] ink saved; snapshot cleanup deferred", e);
            if (!cleanupWarnings.has(plugin)) {
                cleanupWarnings.add(plugin);
                showMessage(String(plugin.i18n?.syncCleanupFailed ?? "Ink saved; old snapshot cleanup failed. Files were retained."), 6000, "error");
            }
        }
        return true;
    } catch (e) {
        console.error("[pencil-annotation] savePayload failed", e);
        if (e instanceof SyncCapacityError || e instanceof SyncIntegrityError) throw e;
        if (!publication.attempted && !(e instanceof TypeError) && !(e instanceof SyncTransientError) && (e as Error)?.name !== "AbortError") {
            throw new SyncIntegrityError(String((e as Error)?.message || e));
        }
        return false;
    }
}

/** Upload a PNG to workspace assets; PDF uses the browser download path instead. */
export async function uploadAssetPng(fileName: string, blob: Blob, signal?: AbortSignal): Promise<string> {
    const form = new FormData(); form.append("assetsPath", "/assets/"); form.append("file[]", blob, fileName);
    const result = await boundedJSON(await fetch("/api/asset/upload", {method: "POST", headers: authHeaders(), body: form, signal}));
    if (result.code !== 0 || !result.data?.succMap?.[fileName]) throw new Error(result.msg || "upload failed");
    return result.data.succMap[fileName];
}
export async function appendBlockMarkdown(parentId: string, markdown: string, signal?: AbortSignal): Promise<void> {
    await kernelJSON("/api/block/appendBlock", {dataType: "markdown", data: markdown, parentID: parentId}, signal);
}
