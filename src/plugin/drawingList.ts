import {confirm, Dialog} from 'siyuan';
import {escapeText} from './text';
import type {DrawingArchive, DrawingCandidate} from './api';
export interface DrawingRow extends DrawingArchive {title: string; path: string; accessible: boolean; pending: boolean; error?: string; verified: boolean; metadataAt: number; metadataEpoch: number}
export class DrawingListCache {
    rows = new Map<string, DrawingRow>();
    candidates = new Map<string, DrawingCandidate>();
    dirty = new Set<string>();
    revisions = new Map<string, number>();
    checkedAt = 0;
    full = true;
    epoch = 0;
    metadataEpoch = 0;
    notify: (() => void) | null = null;
    invalidate(id?: string, metadata = false) {
        if (id) { this.dirty.add(id); this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1); }
        else { this.full = true; this.epoch++; }
        if (metadata) this.metadataEpoch++;
        this.notify?.();
    }
}
const CACHE_MS = 30000;
interface ListOptions {
    t: (key: string, vars?: Record<string, string>) => string;
    cache: DrawingListCache;
    candidates: (signal: AbortSignal) => Promise<DrawingCandidate[]>;
    inspect: (candidate: DrawingCandidate, signal: AbortSignal, previous: DrawingRow | undefined, forceMetadata: boolean) => Promise<DrawingRow>;
    open: (id: string, exportDocument: boolean, signal: AbortSignal) => Promise<void>;
    remove: (row: DrawingRow) => Promise<void>;
    canDelete: () => boolean;
    onClose: () => void;
}

/** Session-cached archive directory. Never counts or retains stroke geometry. */
export function drawingListDialog(options: ListOptions): Dialog {
    const {t, cache} = options;
    let disposed = false, controller: AbortController | null = null, scanning = false, busy = false, limit = 50;
    let renderFrame: number | null = null, updateTimer: number | null = null;
    let actionController: AbortController | null = null;
    let checked = 0, total = 0, message = '';
    const rows = cache.rows;
    const changed = () => {
        if (disposed || busy || scanning || updateTimer !== null) return;
        updateTimer = window.setTimeout(() => { updateTimer = null; if (!disposed && !busy && !scanning) void scan(); }, 250);
    };
    const dialog = new Dialog({title: t('drawingList'), width: 'min(780px, calc(100vw - 24px))',
        content: '<div class="pa-drawings"></div>', destroyCallback: () => {
            disposed = true; controller?.abort(); actionController?.abort();
            if (renderFrame !== null) cancelAnimationFrame(renderFrame);
            if (updateTimer !== null) clearTimeout(updateTimer);
            if (cache.notify === changed) cache.notify = null;
            options.onClose();
        }});
    const root = dialog.element.querySelector<HTMLElement>('.pa-drawings')!;
    const tools = document.createElement('div'); tools.className = 'pa-drawings__tools';
    const search = document.createElement('input'); search.type = 'search'; search.className = 'b3-text-field';
    search.placeholder = t('drawingSearch'); search.setAttribute('aria-label', t('drawingSearch'));
    const button = (text: string, action: () => void, danger = false) => {
        const el = document.createElement('button'); el.type = 'button'; el.className = 'b3-button b3-button--outline';
        if (danger) el.classList.add('pa-drawings__danger'); el.textContent = text; el.addEventListener('click', action); return el;
    };
    const refresh = button(t('drawingRefresh'), () => void scan(true));
    const stop = button(t('exportCancel'), () => { controller?.abort(); message = t('drawingScanStopped'); render(); });
    tools.append(search, refresh, stop);
    const status = document.createElement('p'); status.className = 'pa-drawings__status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const note = document.createElement('p'); note.className = 'pa-drawings__hint'; note.textContent = t('drawingListHint');
    const list = document.createElement('div'); list.className = 'pa-drawings__rows';
    const more = button(t('drawingShowMore'), () => { limit += 50; render(); }); more.classList.add('pa-drawings__more');
    root.append(tools, status, note, list, more);
    cache.notify = changed;
    function render() {
        if (disposed) return;
        if (renderFrame !== null) { cancelAnimationFrame(renderFrame); renderFrame = null; }
        refresh.disabled = busy; stop.hidden = !scanning; stop.disabled = busy;
        const query = search.value.trim().toLocaleLowerCase();
        const filtered = [...rows.values()].filter(row => row.archived || row.pending || !row.verified).filter(row => [row.title, row.path, row.id].some(s => s.toLocaleLowerCase().includes(query)))
            .sort((a, b) => Number(b.accessible) - Number(a.accessible) || Number(b.verified) - Number(a.verified) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
        status.textContent = message || (scanning ? t('drawingScanning', {done: String(checked), total: String(total)}) : t('drawingFound', {count: String(filtered.length)}));
        const focused = list.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
        const focusId = focused?.closest<HTMLElement>('[data-doc-id]')?.dataset.docId, focusAction = focused?.dataset.action;
        list.replaceChildren();
        if (!filtered.length) { const empty = document.createElement('p'); empty.className = 'pa-drawings__empty'; empty.textContent = scanning ? t('drawingScanningHint') : message ? t('drawingReadFailed') : t('drawingEmpty'); list.append(empty); }
        for (const row of filtered.slice(0, limit)) {
            const item = document.createElement('article'); item.className = 'pa-drawings__row'; item.dataset.docId = row.id;
            const main = document.createElement('div'); main.className = 'pa-drawings__main';
            const title = button(row.title, () => void run(signal => options.open(row.id, false, signal), true));
            title.className = 'pa-drawings__title'; title.dataset.action = 'title'; title.disabled = busy || !row.accessible;
            const path = document.createElement('div'); path.className = 'pa-drawings__path'; path.textContent = row.path || row.id; path.title = row.path || row.id;
            const detail = document.createElement('div'); detail.className = 'pa-drawings__detail';
            detail.textContent = row.error || t(row.pending ? 'drawingPending' : 'drawingArchive');
            if (row.error) detail.classList.add('pa-drawings__error');
            main.append(title, path, detail);
            const actions = document.createElement('div'); actions.className = 'pa-drawings__actions';
            const open = button(t('drawingOpen'), () => void run(signal => options.open(row.id, false, signal), true));
            const exportButton = button(t('drawingExport'), () => void run(signal => options.open(row.id, true, signal), true));
            open.dataset.action = 'open'; exportButton.dataset.action = 'export';
            open.disabled = exportButton.disabled = busy || !row.accessible;
            const remove = button(t('drawingDelete'), () => {
                if (busy || !row.verified || !options.canDelete()) return;
                busy = true; controller?.abort(); render();
                confirm(t('drawingDeleteTitle'), t('drawingDeleteConfirm', {name: escapeText(row.title), id: row.id}), () => {
                    if (disposed) return;
                    busy = false;
                    void run(async () => { await options.remove(row); cache.invalidate(row.id); await scan(); });
                }, () => { busy = false; render(); });
            }, true);
            remove.dataset.action = 'delete';
            remove.disabled = busy || !row.verified || !options.canDelete();
            if (!options.canDelete()) remove.title = t('drawingReadOnly');
            actions.append(open, exportButton, remove); item.append(main, actions); list.append(item);
        }
        if (focusId && focusAction) list.querySelector<HTMLElement>(`[data-doc-id="${CSS.escape(focusId)}"] [data-action="${CSS.escape(focusAction)}"]`)?.focus({preventScroll: true});
        more.hidden = filtered.length <= limit; more.disabled = busy;
    }
    async function run(action: (signal: AbortSignal) => Promise<void>, close = false) {
        if (disposed || busy) return;
        actionController = new AbortController();
        busy = true; controller?.abort(); message = t('drawingWorking'); render();
        try { await action(actionController.signal); if (close && !disposed) dialog.destroy(); else message = ''; }
        catch (error) { message = t('drawingActionFailed', {msg: String((error as Error)?.message || error)}); }
        finally { busy = false; render(); }
    }
    function requestRender() {
        if (disposed || renderFrame !== null) return;
        renderFrame = requestAnimationFrame(() => { renderFrame = null; render(); });
    }
    // Cache is only a UI hint. Actions recheck generations and data independently.
    // A small worker pool overlaps metadata latency without loading stroke files.
    async function scan(force = false, followup = false) {
        if (disposed) return;
        if (updateTimer !== null) { clearTimeout(updateTimer); updateTimer = null; }
        if (!force && !cache.full && cache.checkedAt && Date.now() - cache.checkedAt < CACHE_MS && !cache.dirty.size) { render(); return; }
        if (force) { cache.full = true; cache.epoch++; cache.metadataEpoch++; }
        controller?.abort(); const current = new AbortController(); controller = current;
        const full = cache.full || !cache.checkedAt || Date.now() - cache.checkedAt >= CACHE_MS;
        const epoch = cache.epoch, metadataEpoch = cache.metadataEpoch;
        const pending = new Set(cache.dirty); pending.forEach(id => cache.dirty.delete(id));
        scanning = true; checked = 0; total = 0; message = ''; render();
        let complete = false;
        try {
            let candidates: DrawingCandidate[];
            if (full) {
                candidates = await options.candidates(current.signal);
                if (current.signal.aborted || disposed) return;
                cache.candidates = new Map(candidates.map(item => [item.id, item]));
            } else candidates = [...pending].map(id => cache.candidates.get(id) ?? {id, legacy: false});
            const seen = new Set(candidates.map(item => item.id));
            total = candidates.length; requestRender();
            let cursor = 0;
            const work = async () => {
                while (!current.signal.aborted && !disposed && cursor < candidates.length) {
                    const candidate = candidates[cursor++], id = candidate.id;
                    const revision = cache.revisions.get(id) ?? 0, previous = rows.get(id);
                    let row: DrawingRow;
                    try { row = await options.inspect(candidate, current.signal, previous, force || previous?.metadataEpoch !== metadataEpoch); }
                    catch {
                        row = {id, title: previous?.title ?? id, path: previous?.path ?? '', generation: previous?.generation ?? 0,
                            archived: previous?.archived ?? false, pending: false, accessible: false, verified: false, metadataAt: 0, metadataEpoch,
                            error: t('drawingReadFailed')};
                    }
                    if (current.signal.aborted || disposed) return;
                    if ((cache.revisions.get(id) ?? 0) === revision) rows.set(id, row);
                    checked++; requestRender();
                }
            };
            await Promise.all(Array.from({length: Math.min(4, candidates.length)}, () => work()));
            if (current.signal.aborted || disposed) return;
            if (full && cache.epoch === epoch) {
                for (const id of rows.keys()) if (!seen.has(id) && !cache.dirty.has(id)) rows.delete(id);
                cache.checkedAt = Date.now(); cache.full = false;
            }
            complete = true;
        } catch (error) { if (!current.signal.aborted) message = t('drawingActionFailed', {msg: String((error as Error)?.message || error)}); }
        finally {
            if (!complete) { if (full) cache.full = true; pending.forEach(id => cache.dirty.add(id)); }
            if (controller === current) {
                scanning = false; render();
                if (complete && !followup && (cache.dirty.size || cache.full)) void scan(false, true);
            }
        }
    }
    search.addEventListener('input', () => { limit = 50; requestRender(); });
    void scan(); queueMicrotask(() => { if (!disposed) search.focus(); });
    return dialog;
}
