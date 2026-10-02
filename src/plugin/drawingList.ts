import {confirm, Dialog} from 'siyuan';
import {escapeText} from './text';
import type {DrawingSummary} from './api';
export interface DrawingRow extends DrawingSummary {title: string; path: string; accessible: boolean; error?: string; verified: boolean}
interface ListOptions {
    t: (key: string, vars?: Record<string, string>) => string;
    candidates: (signal: AbortSignal) => Promise<string[]>;
    inspect: (id: string, signal: AbortSignal) => Promise<DrawingRow>;
    open: (id: string, exportDocument: boolean, signal: AbortSignal) => Promise<void>;
    remove: (row: DrawingRow) => Promise<void>;
    canDelete: () => boolean;
    onClose: () => void;
}

/** Native dialog + progressive read-only discovery. No durable catalogue/index. */
export function drawingListDialog(options: ListOptions): Dialog {
    const {t} = options;
    let disposed = false, controller: AbortController | null = null, scanning = false, busy = false, limit = 50;
    let actionController: AbortController | null = null;
    let checked = 0, total = 0, message = '';
    const rows = new Map<string, DrawingRow>();
    const dialog = new Dialog({title: t('drawingList'), width: 'min(780px, calc(100vw - 24px))',
        content: '<div class="pa-drawings"></div>', destroyCallback: () => { disposed = true; controller?.abort(); actionController?.abort(); options.onClose(); }});
    const root = dialog.element.querySelector<HTMLElement>('.pa-drawings')!;
    const tools = document.createElement('div'); tools.className = 'pa-drawings__tools';
    const search = document.createElement('input'); search.type = 'search'; search.className = 'b3-text-field';
    search.placeholder = t('drawingSearch'); search.setAttribute('aria-label', t('drawingSearch'));
    const button = (text: string, action: () => void, danger = false) => {
        const el = document.createElement('button'); el.type = 'button'; el.className = 'b3-button b3-button--outline';
        if (danger) el.classList.add('pa-drawings__danger'); el.textContent = text; el.addEventListener('click', action); return el;
    };
    const refresh = button(t('drawingRefresh'), () => void scan());
    const stop = button(t('exportCancel'), () => { controller?.abort(); message = t('drawingScanStopped'); render(); });
    tools.append(search, refresh, stop);
    const status = document.createElement('p'); status.className = 'pa-drawings__status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const note = document.createElement('p'); note.className = 'pa-drawings__hint'; note.textContent = t('drawingListHint');
    const list = document.createElement('div'); list.className = 'pa-drawings__rows';
    const more = button(t('drawingShowMore'), () => { limit += 50; render(); }); more.classList.add('pa-drawings__more');
    root.append(tools, status, note, list, more);
    function render() {
        if (disposed) return;
        refresh.disabled = busy; stop.hidden = !scanning; stop.disabled = busy;
        const query = search.value.trim().toLocaleLowerCase();
        const filtered = [...rows.values()].filter(row => [row.title, row.path, row.id].some(s => s.toLocaleLowerCase().includes(query)))
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
            detail.textContent = row.error || t('drawingStrokeCount', {count: String(row.count)});
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
                    void run(async () => { await options.remove(row); await scan(); });
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
    // ponytail: sequential, cancellable scans with 50 visible rows; introduce
    // reusable summaries only if large collections show measured scan latency.
    async function scan() {
        if (disposed) return;
        controller?.abort(); const current = new AbortController(); controller = current;
        scanning = true; checked = 0; total = 0; message = ''; rows.clear(); limit = 50; render();
        try {
            const ids = await options.candidates(current.signal); total = ids.length; render();
            for (const id of ids) {
                if (current.signal.aborted || disposed) break;
                try {
                    const row = await options.inspect(id, current.signal);
                    if (!current.signal.aborted && !disposed && (row.count > 0 || !row.verified)) rows.set(id, row);
                } catch (error) {
                    if (!current.signal.aborted && !disposed) rows.set(id, {id, title: id, path: '', generation: 0, count: 0, accessible: false, verified: false, error: t('drawingReadFailed')});
                }
                if (current.signal.aborted || controller !== current || disposed) break;
                checked++; render();
            }
        } catch (error) { if (!current.signal.aborted) message = t('drawingActionFailed', {msg: String((error as Error)?.message || error)}); }
        finally { if (controller === current) { scanning = false; render(); } }
    }
    search.addEventListener('input', () => { limit = 50; render(); });
    void scan(); queueMicrotask(() => { if (!disposed) search.focus(); });
    return dialog;
}
