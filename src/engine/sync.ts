import {sha256} from "@noble/hashes/sha2.js";
import {bytesToHex} from "@noble/hashes/utils.js";
import {deserializeStroke, serializeStroke, type PencilPayload, type SerializedStroke} from "./types";

// Pure JS hashing also works on HTTP LAN origins where crypto.subtle is unavailable.
export const fingerprint = (value: unknown) => bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(value))));
export const randomWriter = () => `w${bytesToHex(crypto.getRandomValues(new Uint8Array(16)))}`;
export const safeId = (s: unknown): s is string => typeof s === "string" && /^[\w-]{1,160}$/.test(s);
export const validRevision = (s: unknown): s is string => typeof s === "string" && /^(legacy\.[a-f0-9]{64}|w[a-f0-9]{32}\.[1-9]\d{0,14})$/.test(s);
export const MAX_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_DOCUMENT_BYTES = 96 * 1024 * 1024;
export const MAX_WRITERS = 256;
export const MAX_BASES = 256;
export const MAX_FILES = 2048;
export class SyncIntegrityError extends Error { name = "SyncIntegrityError"; }
export class SyncCapacityError extends Error { name = "SyncCapacityError"; }
export class SyncTransientError extends Error { name = "SyncTransientError"; }

export interface InkValue {
    revision: string;
    stroke: SerializedStroke;
    replaces?: string[];
}
export interface SyncBase {
    version: 2;
    docId: string;
    hash: string;
    legacy: PencilPayload | null;
}
export interface WriterSnapshot {
    version: 2;
    docId: string;
    writer: string;
    sequence: number;
    bases: string[];
    values: InkValue[];
    retired: string[];
    deleted: InkValue[];
}
export interface SyncPayload {
    version: 2;
    docId: string;
    bases: SyncBase[];
    snapshots: WriterSnapshot[];
    /** Transport namespace; omitted for the original, pre-deletion generation. */
    generation?: number;
}
export interface Publication {
    generation?: number;
    bases: SyncBase[];
    snapshot: WriterSnapshot;
    /** Runtime only; not part of the frozen file bytes. */
    attempted?: boolean;
}
export type InkPayload = PencilPayload | SyncPayload;

export function validateStroke(s: any): asserts s is SerializedStroke {
    if (Array.isArray(s?.p) && s.p.length > 1500000) throw new SyncCapacityError("Stroke point count exceeds the safety budget");
    if (!s || !safeId(s.i) || (s.t !== 0 && s.t !== 1) || typeof s.c !== "string" || s.c.length > 80 ||
        !Number.isFinite(s.w) || s.w <= 0 || s.w > 1000 || !Number.isFinite(s.o) || s.o < 0 || s.o > 1 ||
        !Number.isFinite(s.a) || (s.s !== 0 && s.s !== 1) || !Array.isArray(s.p) || s.p.length < 3 ||
        s.p.length % 3 || !s.p.every((n: unknown) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 1e8) ||
        (s.b !== undefined && (!Array.isArray(s.b) || s.b.length !== 3 || !safeId(s.b[0]) ||
            !Number.isFinite(s.b[1]) || !Number.isFinite(s.b[2]) || Math.abs(s.b[1]) > 1e8 || Math.abs(s.b[2]) > 1e8)) ||
        (s.f !== undefined && (!Array.isArray(s.f) || s.f.length !== 2 || !s.f.every((n: unknown) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 1e8)))) {
        throw new Error("Invalid handwriting geometry; refusing to discard or overwrite it");
    }
    for (let i = 2; i < s.p.length; i += 3) if (s.p[i] < 0 || s.p[i] > 1) throw new Error("Invalid pressure");
}
export function validateLegacy(data: any, docId: string): asserts data is PencilPayload {
    if (Array.isArray(data?.strokes) && data.strokes.length > 50000) throw new SyncCapacityError("Legacy stroke count exceeds the safety budget");
    if (!data || data.version !== 1 || data.docId !== docId || !Number.isFinite(data.updatedAt) ||
        !Array.isArray(data.strokes)) throw new Error("Invalid legacy handwriting file");
    data.strokes.forEach(validateStroke);
    if (new Set(data.strokes.map((s: SerializedStroke) => s.i)).size !== data.strokes.length) throw new Error("Duplicate legacy stroke IDs");
}
export function makeBase(docId: string, legacy: PencilPayload | null): SyncBase {
    if (!safeId(docId)) throw new Error("Invalid document ID");
    if (legacy) validateLegacy(legacy, docId);
    // Canonical field order makes simultaneous import byte-identical.
    const canonical = legacy ? {version: 1 as const, docId, updatedAt: legacy.updatedAt,
        strokes: legacy.strokes.map(s => ({i: s.i, t: s.t, c: s.c, w: s.w, o: s.o, s: s.s,
            p: [...s.p], a: s.a, ...(s.b ? {b: [...s.b] as [string, number, number]} : {}),
            ...(s.f ? {f: [...s.f] as [number, number]} : {})}))} : null;
    return {version: 2, docId, hash: fingerprint(canonical), legacy: canonical};
}
export function baseValues(base: SyncBase): InkValue[] {
    return (base.legacy?.strokes ?? []).map(s => {
        const stroke = serializeStroke(deserializeStroke(s));
        validateStroke(stroke);
        // Per-value identity, not per-document hash: unrelated legacy changes do not duplicate ink.
        return {revision: `legacy.${fingerprint([base.docId, s.i, s.t, s.c, s.w, s.o, s.s, s.a, s.p, s.b ?? null, s.f ?? null])}`, stroke};
    });
}
export function validateBase(base: any, docId: string, hash: string): asserts base is SyncBase {
    if (base?.version !== 2 || base.docId !== docId || base.hash !== hash ||
        (base.legacy !== null && (typeof base.legacy !== "object" || !base.legacy)) || makeBase(docId, base.legacy).hash !== hash) {
        throw new Error("Invalid or conflicting migration backup");
    }
}
export function validateValue(value: any): asserts value is InkValue {
    if (Array.isArray(value?.replaces) && value.replaces.length > 50000) throw new SyncCapacityError("Revision ancestry count exceeds the safety budget");
    if (!value || !validRevision(value.revision) || (value.replaces !== undefined &&
        (!Array.isArray(value.replaces) || !value.replaces.every(validRevision)))) throw new Error("Invalid ink revision");
    validateStroke(value.stroke);
    if (value.stroke.b && (value.stroke.b[1] !== 0 || value.stroke.b[2] !== 0)) throw new Error("Sync ink must be block-relative");
}
export function snapshotCovers(current: WriterSnapshot, previous: WriterSnapshot): boolean {
    const values = new Map(current.values.map(v => [v.revision, fingerprint(v)])), retired = new Set(current.retired);
    const deleted = new Map(current.deleted.map(v => [v.revision, fingerprint(v)]));
    return previous.values.every(v => values.get(v.revision) === fingerprint(v) || retired.has(v.revision)) &&
        previous.retired.every(id => retired.has(id)) && previous.deleted.every(v => deleted.get(v.revision) === fingerprint(v)) &&
        previous.bases.every(hash => current.bases.includes(hash));
}

export function validateSnapshot(s: any, docId: string, writer: string, sequence: number): asserts s is WriterSnapshot {
    for (const [field, limit] of [["bases", MAX_BASES], ["values", 50000], ["retired", 200000], ["deleted", 50000]] as const) {
        if (Array.isArray(s?.[field]) && s[field].length > limit) throw new SyncCapacityError(`Snapshot ${field} count exceeds the safety budget`);
    }
    if (s?.version !== 2 || s.docId !== docId || s.writer !== writer || !/^w[a-f0-9]{32}$/.test(writer) ||
        s.sequence !== sequence || !Number.isSafeInteger(sequence) || sequence < 1 ||
        !Array.isArray(s.bases) || !s.bases.length || !s.bases.every((b: unknown) => typeof b === "string" && /^[a-f0-9]{64}$/.test(b)) ||
        !Array.isArray(s.values) || !Array.isArray(s.retired) ||
        !s.retired.every(validRevision) || !Array.isArray(s.deleted)) throw new Error("Invalid sync snapshot");
    for (const value of s.values) {
        validateValue(value);
        if (!value.revision.startsWith(`${writer}.`) || Number(value.revision.split(".")[1]) > sequence) throw new Error("Writer revision mismatch");
    }
    s.deleted.forEach(validateValue);
    const retired = new Set(s.retired);
    if (s.deleted.some((v: InkValue) => !retired.has(v.revision))) throw new Error("Recovery ink must remain retired");
    if (new Set(s.values.map((v: InkValue) => v.revision)).size !== s.values.length) throw new Error("Duplicate revision in snapshot");
}
