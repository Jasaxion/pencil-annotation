import {
    confirm,
    getAllEditor,
    getFrontend,
    Plugin,
    Setting,
    openTab,
    openMobileFileById,
    type Dialog,
} from "siyuan";
import {DocOverlay, type OverlayConfig, type OverlaySettings, type ProtyleLike} from "./overlay/overlay";
import {Palette, type PaletteAction, type ToolbarLayout} from "./overlay/toolbar";
import {TOPBAR_SVG} from "./overlay/icons";
import {checkPublicationBudget, drawingCandidates, drawingGeneration, drawingArchive, kernelJSON, cleanupRetiredDocument, DocumentRetiredError, fenceDocument, loadPayload, planDocumentDeletion, reconcileLegacy as importLegacyInk, releasePayloadCache, retiredDocumentIds, retireDocumentGeneration, savePayload, settleDocumentWrites, validDocumentId} from "./plugin/api";
import {SyncCapacityError, SyncTransientError} from "./engine/sync";
import {cancelExports, exportIsBusy, exportStrokesDialog} from "./plugin/exportDialog";
import {showTextMessage as showMessage} from './plugin/text';
import {DrawingListCache, drawingListDialog, type DrawingRow} from './plugin/drawingList';
import {
    DEFAULT_SETTINGS,
    loadSession,
    loadSettings,
    saveSession,
    saveSettings,
    type PencilSettings,
} from "./plugin/settings";
import {DocStore} from "./engine/store";
import type {ToolId} from "./engine/types";

const SAVE_DEBOUNCE = 1200;

export default class PencilAnnotationPlugin extends Plugin {
    private overlays = new Map<HTMLElement, DocOverlay>();
    private documents = new Map<string, DocStore>();
    private palette!: Palette;
    private activeOverlay: DocOverlay | null = null;
    private drawingList: Dialog | null = null;
    private settingsOpen = false;
    private drawingCache = new DrawingListCache();

    private settings: PencilSettings = {...DEFAULT_SETTINGS};
    private overlaySettings!: OverlaySettings;
    private config!: OverlayConfig;

    private modeOn = false;
    private saveTimer: number | null = null;
    private pendingSaves = new Set<DocStore>();
    private saveRetries = 0;
    private unloading = false;
    private syncingRemote = false;
    private syncAgain = false;
    private syncCheckLegacy = false;
    private syncPoll: number | null = null;
    private syncErrors = new Map<string, string>();
    private deletionJobs = new Map<string, Promise<void>>();
    private manualDeletions = new Set<string>();
    private queuedDeletionNotices = new Set<string>();
    private deletionTail: Promise<void> = Promise.resolve();
    private cleanupQueue = new Set<string>();
    private cleanupRunning = false;
    private cleanupErrors = new Set<string>();
    private failedDeletions = new Set<string>();

    // ------------------------------------------------------------------ i18n

    private t = (key: string, vars?: Record<string, string>): string => {
        let text = String((this.i18n as Record<string, string>)[key] ?? key);
        if (vars) {
            for (const [k, v] of Object.entries(vars)) {
                text = text.split(`{${k}}`).join(v);
            }
        }
        return text;
    };

    // -------------------------------------------------------------- lifecycle

    async onload() {
        this.settings = await loadSettings(this);
        this.overlaySettings = {
            mouseDrawing: this.settings.mouseDrawing,
            doubleTapToggle: this.settings.doubleTapToggle,
            shapeSnap: this.settings.shapeSnap,
            showEraserCursor: this.settings.showEraserCursor,
            eraserRadius: this.settings.eraserRadius,
            penWidthMax: this.settings.penWidthMax,
        };
        const session = loadSession();
        this.config = {
            tool: (["pen", "highlighter", "eraser", "select"] as ToolId[]).includes(session.tool as ToolId)
                ? (session.tool as ToolId) : "pen",
            penColor: session.penColor || this.settings.penColor,
            // clamp stale session widths that exceed the (possibly new) slider cap
            penWidth: Math.min(session.penWidth || this.settings.penWidth, this.settings.penWidthMax),
            hlColor: session.hlColor || this.settings.hlColor,
            hlWidth: session.hlWidth || this.settings.hlWidth,
        };

        // core wiring first — the overlay must never depend on UI extras below
        this.eventBus.on("ws-main", this.onWsMain);
        this.eventBus.on("loaded-protyle-static", ({detail}) => this.attachProtyle(detail.protyle));
        this.eventBus.on("loaded-protyle-dynamic", ({detail}) => this.attachProtyle(detail.protyle));
        this.eventBus.on("destroy-protyle", ({detail}) => this.detachProtyle(detail.protyle));
        this.eventBus.on("switch-protyle", ({detail}) => this.setActiveProtyle(detail.protyle));
        this.eventBus.on("click-editorcontent", ({detail}) => this.setActiveProtyle(detail.protyle));

        this.palette = new Palette({
            mobile: ['mobile', 'browser-mobile'].includes(getFrontend()),
            i18n: this.t,
            config: this.config,
            settings: this.overlaySettings,
            onSelectTool: (tool) => {
                this.config.tool = tool;
                this.persistSession();
                this.palette.refresh();
            },
            onColor: (color) => {
                if (this.config.tool === "highlighter") this.config.hlColor = color;
                else this.config.penColor = color;
                this.persistSession();
                this.palette.refresh();
            },
            onWidth: (width) => {
                // no palette.refresh() here: the slider updates itself in place,
                // and a re-render mid-drag would tear the input from the pointer
                if (this.config.tool === "highlighter") this.config.hlWidth = width;
                else if (this.config.tool === "eraser") this.overlaySettings.eraserRadius = width;
                else this.config.penWidth = width;
                this.persistSession();
            },
            onAction: (action) => this.onPaletteAction(action),
            onHandleActivate: () => this.toggleMode(),
        });
        this.palette.setHandleVisible(this.settings.showFloatingBall);
        this.palette.setMode(false);

        if (["desktop", "desktop-window", "browser-desktop"].includes(getFrontend())) {
            this.addTopBar({
                icon: TOPBAR_SVG,
                title: this.t("topbarTitle"),
                callback: () => this.toggleMode(),
            });
        }

        this.addCommand({
            langKey: "topbarTitle",
            hotkey: "",
            callback: () => this.toggleMode(),
        });

        this.addCommand({langKey: 'drawingList', hotkey: '', callback: () => this.showDrawingList()});
        this.buildSettingDialog();

        // when the plugin is enabled mid-session, editors are already open and
        // no loaded-protyle event will fire — pick them up after onload settles
        window.setTimeout(() => this.attachExisting(), 600);

        document.addEventListener("keydown", this.onKeyDown, true);
        document.addEventListener("visibilitychange", this.onVisibilityChange);
        window.addEventListener("pagehide", this.onPageHide);
        window.addEventListener("online", this.onOnline);
        // Nested file notifications vary between hosts. Poll only open/retained
        // documents while visible, and fetch only newly named immutable files.
        this.syncPoll = window.setInterval(() => {
            if (document.visibilityState === "visible") {
                if (this.documents.size) void this.onDataChanged("overwrite", false);
                void this.reapOneRetiredDocument();
            }
        }, 5000);
        void retiredDocumentIds(this).then(ids => { for (const id of ids) this.cleanupQueue.add(id); })
            .catch(error => console.warn("[pencil-annotation] retirement cleanup discovery deferred", error));
    }

    onLayoutReady() {
        this.attachExisting();
    }

    /** attach overlays to every editor that is already open */
    private attachExisting() {
        if (this.unloading) return;
        for (const editor of getAllEditor()) {
            this.attachProtyle(editor as unknown as ProtyleLike);
        }
    }

    async onunload() {
        this.unloading = true;
        this.eventBus.off("ws-main", this.onWsMain);
        cancelExports();
        this.drawingList?.destroy();
        if (this.settingsOpen) (this.setting as Setting & {dialog?: Dialog})?.dialog?.destroy();
        if (this.syncPoll !== null) window.clearInterval(this.syncPoll);
        this.syncPoll = null;
        window.removeEventListener("pagehide", this.onPageHide);
        window.removeEventListener("online", this.onOnline);
        document.removeEventListener("keydown", this.onKeyDown, true);
        document.removeEventListener("visibilitychange", this.onVisibilityChange);
        for (const overlay of this.overlays.values()) {
            overlay.destroy(); // stop input and finalize BEFORE the final persistence barrier
            if (overlay.store.dirty || overlay.store.saving) this.pendingSaves.add(overlay.store);
        }
        this.overlays.clear();
        this.palette.destroy();
        await this.flushAll();
    }

    /**
     * Kernel pushed a data change: "sync" means another device merged new
     * strokes into this doc's payload — pull and merge them into open editors.
     */
    async onDataChanged(reason?: string, checkLegacy = true, refreshCatalogue = checkLegacy) {
        if (this.unloading || (reason !== "sync" && reason !== "overwrite")) return;
        if (refreshCatalogue) this.drawingCache.invalidate();
        if (reason === "sync") void retiredDocumentIds(this).then(ids => { for (const id of ids) this.cleanupQueue.add(id); }).catch(() => {});
        this.syncAgain = true;
        this.syncCheckLegacy ||= checkLegacy;
        if (this.syncingRemote) return;
        this.syncingRemote = true;
        try {
            do {
                this.syncAgain = false;
                const verifyLegacy = this.syncCheckLegacy; this.syncCheckLegacy = false;
                for (const [docId, store] of this.documents) {
                    if (!store.loaded || store.retiredDocument || this.deletionJobs.has(docId)) continue;
                    try {
                        const remote = await loadPayload(this, docId, verifyLegacy);
                        if (this.unloading) break;
                        if (this.documents.get(docId) !== store || store.retiredDocument || this.deletionJobs.has(docId)) continue;
                        if ((remote.generation ?? 0) > store.generation) {
                            this.retireStore(store, true); continue;
                        }
                        if (verifyLegacy) {
                            if (store.blocked?.kind === "capacity" && store.dirty) checkPublicationBudget(store.serialize(), remote);
                            store.unblock(); this.syncErrors.delete(docId);
                            if (store.dirty) this.armSave(SAVE_DEBOUNCE);
                        }
                        if (store.mergeRemote(remote)) {
                            this.drawingCache.invalidate(docId);
                            for (const overlay of this.overlays.values()) if (overlay.store === store) overlay.refreshFromStore();
                            this.refreshPalette();
                            showMessage(this.t(store.conflictCount ? "syncConflicts" : "syncMerged"));
                        }
                    } catch (e) {
                        if (store.retiredDocument || this.deletionJobs.has(docId) || this.documents.get(docId) !== store) continue;
                        if (e instanceof DocumentRetiredError && e.generation > store.generation) {
                            this.retireStore(store); continue;
                        }
                        const message = String(e);
                        if (!(e instanceof TypeError) && !(e instanceof SyncTransientError) && (e as Error)?.name !== "AbortError") {
                            store.block(e instanceof SyncCapacityError ? "capacity" : "integrity", message);
                            for (const overlay of this.overlays.values()) if (overlay.store === store) overlay.refreshFromStore();
                        }
                        if (this.syncErrors.get(docId) !== message) showMessage(this.t("loadFailed", {msg: message}), 6000, "error");
                        this.syncErrors.set(docId, message);
                    }
                }
            } while (this.syncAgain && !this.unloading);
            this.refreshPalette();
        } finally { this.syncingRemote = false; }
    }

    private retireStore(store: DocStore, reattach = false) {
        this.drawingCache.invalidate(store.docId);
        const protyles: ProtyleLike[] = [];
        cancelExports(store.docId);
        for (const [key, view] of this.overlays) if (view.store === store) {
            protyles.push(view.protyle);
            view.destroy(); this.overlays.delete(key);
            if (this.activeOverlay === view) this.activeOverlay = null;
        }
        store.retireDocument(); this.pendingSaves.delete(store);
        if (this.documents.get(store.docId) === store) this.documents.delete(store.docId);
        this.syncErrors.delete(store.docId); this.cleanupQueue.add(store.docId);
        releasePayloadCache(this, store.docId, store.generation + 1);
        if (reattach && !this.unloading) for (const protyle of protyles) if (protyle.element.isConnected && this.docIdOf(protyle) === store.docId) this.attachProtyle(protyle);
        this.refreshPalette();
    }

    // Only successful kernel deletion events authorize retirement. Missing files,
    // closed notebooks and temporary sync gaps never enqueue a deletion.
    private onWsMain = ({detail}: {detail?: {cmd?: string; code?: number; data?: {ids?: unknown}}}) => {
        if (!this.unloading && detail?.code === 0 && ['rename', 'movedoc', 'movedocs', 'renamenotebook', 'closenotebook', 'opennotebook'].includes(detail.cmd?.toLowerCase() ?? '')) this.drawingCache.invalidate(undefined, true);
        const ids = detail?.data?.ids;
        if (this.unloading || detail?.cmd !== "removeDoc" || detail.code !== 0 || !Array.isArray(ids) || ids.length > 50000 || !ids.every(validDocumentId)) return;
        for (const id of new Set<string>(ids)) {
            if (this.deletionJobs.has(id)) {
                if (this.manualDeletions.has(id)) this.queuedDeletionNotices.add(id);
                continue;
            }
            const store = this.documents.get(id), captured = store?.loaded ? store.generation : undefined;
            const release = fenceDocument(this, id);
            this.cleanupQueue.add(id);
            cancelExports(id);
            for (const view of this.overlays.values()) if (view.docId === id) view.setMode(false); // finalizes active input
            store?.block("integrity", this.t("documentDeletionPending"));
            const job = this.deletionTail.then(async () => {
                const plan = await planDocumentDeletion(this, id, captured);
                if (this.failedDeletions.has(id)) plan.confirm = true;
                if (plan.confirm) {
                    const accepted = await new Promise<boolean>(resolve => confirm(this.t("documentDeletionTitle"), this.t("documentDeletionConfirm", {id}), () => resolve(true), () => resolve(false)));
                    if (!accepted || this.unloading) { this.failedDeletions.delete(id); return; }
                }
                await retireDocumentGeneration(this, id, plan.generation, plan.confirm);
                this.drawingCache.invalidate(id);
                this.cleanupQueue.add(id);
                if (store && store.generation <= plan.generation) this.retireStore(store);
                await settleDocumentWrites(this, id);
                await cleanupRetiredDocument(this, id);
                this.failedDeletions.delete(id);
            }).catch(error => {
                this.failedDeletions.add(id);
                console.warn("[pencil-annotation] document cleanup deferred", error);
                showMessage(this.t("documentCleanupFailed", {id}), 8000, "error");
            }).finally(() => {
                release(); this.deletionJobs.delete(id);
                if (!this.unloading) {
                    this.attachExisting(); this.refreshPalette();
                    // A declined/ambiguous event does not poison a still-valid store.
                    if (store && !store.retiredDocument) void loadPayload(this, id).then(payload => {
                        if (this.documents.get(id) !== store || store.retiredDocument || this.deletionJobs.has(id)) return;
                        if (!store.loaded) store.adoptPayload(payload);
                        else if ((payload.generation ?? 0) > store.generation) { this.retireStore(store, true); return; }
                        else store.mergeRemote(payload);
                        store.unblock();
                        if (store.dirty) this.armSave(SAVE_DEBOUNCE);
                        for (const view of this.overlays.values()) if (view.store === store) { view.setMode(this.modeOn); view.refreshFromStore(); }
                        this.refreshPalette();
                    }).catch(() => { /* Keep the paused copy available for raw backup. */ });
                }
            });
            this.deletionJobs.set(id, job); this.deletionTail = job;
        }
    };

    private async reapOneRetiredDocument() {
        if (this.unloading || this.cleanupRunning || !this.cleanupQueue.size) return;
        const id = this.cleanupQueue.values().next().value!;
        this.cleanupQueue.delete(id); this.cleanupQueue.add(id);
        if (this.deletionJobs.has(id)) return;
        this.cleanupRunning = true;
        try { await cleanupRetiredDocument(this, id); this.cleanupErrors.delete(id); }
        catch (error) {
            if (!this.cleanupErrors.has(id)) {
                this.cleanupErrors.add(id);
                console.warn("[pencil-annotation] retired files retained for retry", error);
                showMessage(this.t("documentCleanupFailed", {id}), 6000, "error");
            }
        } finally { this.cleanupRunning = false; }
    }

    // --------------------------------------------------------------- protyle

    private docIdOf(protyle: ProtyleLike): string | undefined {
        // Mobile reuses the editor and can retain options.rootId from the previous
        // document. The loaded block's rootID is the authoritative document ID.
        return protyle.block?.rootID || protyle.options?.rootId || undefined;
    }

    private attachProtyle(protyle: ProtyleLike) {
        const p = protyle as ProtyleLike;
        if (!p?.element || this.unloading) return;

        const key = p.element;
        const existing = this.overlays.get(key);
        if (existing) {
            const docId = this.docIdOf(p);
            if (!docId) return;
            if (existing.docId === docId) {
                existing.refreshProtyle(p);
                return;
            }
            // mobile reuses one protyle for every doc — rebuild the overlay
            this.detachProtyle(p);
        }

        const docId = this.docIdOf(p);
        if (!docId || this.deletionJobs.has(docId)) return;
        let store = this.documents.get(docId);
        if (!store) {
            store = new DocStore(docId);
            this.documents.set(docId, store);
        }
        const overlay = DocOverlay.attach(p, {
            store,
            settings: this.overlaySettings,
            config: this.config,
            onDirty: () => this.scheduleSave(overlay as DocOverlay),
            onStateChange: () => this.refreshPalette(),
            onDoubleTapToggle: () => this.togglePenEraser(),
            loadPayload: (docId) => loadPayload(this, docId),
            onActivate: () => { this.activeOverlay = overlay; },
            onLoadError: (e) => {
                if (overlay && !overlay.store.loaded && !overlay.store.retiredDocument && !this.deletionJobs.has(docId)) showMessage(this.t("loadFailed", {msg: String(e)}), 6000, "error");
            },
        });
        if (!overlay) return;
        this.overlays.set(key, overlay);
        this.activeOverlay = overlay;
        if (this.modeOn) overlay.setMode(true);
        this.refreshPalette();
    }

    private detachProtyle(protyle: ProtyleLike) {
        const p = protyle as ProtyleLike;
        const key = p?.element;
        const overlay = this.overlays.get(key);
        if (!overlay) return;
        overlay.destroy(); // finalize completed dots and interrupted strokes BEFORE saving
        if (overlay.store.dirty || overlay.store.saving) {
            this.pendingSaves.add(overlay.store);
            void this.flushAll();
        }
        this.overlays.delete(key);
        this.releaseUnusedDocuments();
        if (this.activeOverlay === overlay) this.activeOverlay = null;
        this.refreshPalette();
    }

    private setActiveProtyle(protyle: ProtyleLike) {
        if (!protyle?.element) return;
        const overlay = this.overlays.get(protyle.element);
        if (overlay) {
            this.activeOverlay = overlay;
        } else {
            this.attachProtyle(protyle);
            this.activeOverlay = this.overlays.get(protyle.element) ?? this.activeOverlay;
        }
        this.refreshPalette();
    }

    // ------------------------------------------------------------------ mode

    private toggleMode() {
        this.modeOn = !this.modeOn;
        for (const overlay of this.overlays.values()) {
            overlay.setMode(this.modeOn);
        }
        this.palette.setMode(this.modeOn);
        showMessage(this.t(this.modeOn ? "modeOn" : "modeOff"));
    }

    private togglePenEraser() {
        this.config.tool = this.config.tool === "eraser" ? "pen" : "eraser";
        this.persistSession();
        this.palette.refresh();
        showMessage(this.t("doubleTapToggled", {tool: this.t(this.config.tool)}));
    }

    private onPaletteAction(action: PaletteAction) {
        const overlay = this.activeOverlay;
        switch (action) {
            case "undo":
                overlay?.undo();
                break;
            case "redo":
                overlay?.redo();
                break;
            case "clear":
                if (!overlay) return;
                confirm(this.t("clearAll"), this.t("confirmClear"), () => {
                    overlay.clearAll();
                    showMessage(this.t("clearDone"));
                });
                break;
            case "drawings":
                this.showDrawingList();
                break;
            case "export":
                if (overlay) exportStrokesDialog(overlay, this.t, this.name, () => this.reconcileLegacy(overlay));
                break;
            case "collapse":
                // collapsing the toolbar exits drawing mode (handle comes back)
                this.toggleMode();
                break;
            case "settings":
                this.openSetting();
                break;
            case "deleteSel":
                overlay?.deleteSelection();
                break;
            case "dupSel":
                overlay?.duplicateSelection();
                break;
            case "doneSel":
                overlay?.deselect();
                break;
        }
    }

    private showDrawingList() {
        if (this.unloading) return;
        if (this.drawingList) { this.drawingList.element.querySelector<HTMLInputElement>('input')?.focus(); return; }
        for (const view of this.overlays.values()) view.finalizeInput();
        const toolbarVisibility = this.palette.toolbar.style.visibility, handleVisibility = this.palette.handle.style.visibility;
        const restorePalette = () => { this.palette.toolbar.style.visibility = toolbarVisibility; this.palette.handle.style.visibility = handleVisibility; };
        this.palette.toolbar.style.visibility = this.palette.handle.style.visibility = 'hidden';
        try { this.drawingList = drawingListDialog({t: this.t, cache: this.drawingCache,
            candidates: async signal => {
                const candidates = new Map((await drawingCandidates(this, signal)).map(item => [item.id, item]));
                for (const id of this.documents.keys()) if (validDocumentId(id) && !candidates.has(id)) candidates.set(id, {id, legacy: false});
                return [...candidates.values()];
            },
            inspect: async (candidate, signal, previous, forceMetadata) => {
                const metadataEpoch = this.drawingCache.metadataEpoch;
                const archive = await drawingArchive(this, candidate, signal), id = candidate.id;
                const local = this.documents.get(id);
                const pending = !!(local?.loaded && !local.retiredDocument && local.generation === archive.generation && (local.dirty || (!archive.archived && local.strokes.length > 0)));
                const row: DrawingRow = {...archive, pending, title: id, path: '', accessible: false, verified: true, metadataAt: 0, metadataEpoch};
                if (!archive.archived && !pending) return row;
                if (!forceMetadata && previous?.accessible && previous.generation === row.generation && Date.now() - previous.metadataAt < 300000) {
                    return {...row, title: previous.title, path: previous.path, accessible: true, metadataAt: previous.metadataAt};
                }
                try {
                    const info = await kernelJSON('/api/block/getDocInfo', {id}, signal);
                    if (info?.id !== id || info.rootID !== id) throw new Error('Invalid document metadata');
                    row.title = String(info.name || id).slice(0, 500); row.accessible = true; row.metadataAt = Date.now();
                    try { const path = await kernelJSON('/api/filetree/getHPathByID', {id}, signal); if (typeof path === 'string') row.path = path.slice(0, 2048); } catch { /* title/id still searchable */ }
                } catch { row.error = this.t('drawingUnavailable'); }
                return row;
            },
            open: (id, exportDocument, signal) => this.openDrawingDocument(id, exportDocument, signal),
            remove: row => this.deleteDrawing(row),
            canDelete: () => !window.siyuan?.config?.readonly && !window.siyuan?.isPublish,
            onClose: () => { this.drawingList = null; restorePalette(); },
        }); } catch (error) { restorePalette(); throw error; }
    }

    private async openDrawingDocument(id: string, exportDocument: boolean, signal: AbortSignal) {
        if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        if (this.unloading || !validDocumentId(id)) throw new Error(this.t('drawingUnavailable'));
        if (exportIsBusy()) throw new Error(this.t('exportAlreadyRunning'));
        if (['mobile', 'browser-mobile'].includes(getFrontend())) openMobileFileById(this.app, id);
        else await openTab({app: this.app, doc: {id}});
        if (!exportDocument) return;
        const deadline = Date.now() + 15000;
        let previous = '', refreshed: DocStore | null = null;
        while (!this.unloading && !signal.aborted && Date.now() < deadline) {
            if (this.deletionJobs.has(id)) throw new Error(this.t('documentDeletionPending'));
            this.attachExisting();
            const view = [...this.overlays.values()].find(o => o.docId === id && o.protyle.element.isConnected && (o.protyle.wysiwyg?.element.clientWidth ?? 0) >= 50);
            if (view && !view.store.loaded && !view.store.loading && view.store.blocked) throw new Error(view.store.blocked.message);
            if (view?.store.loaded) {
                if (refreshed !== view.store) {
                    const payload = await loadPayload(this, id, true, signal);
                    if (Date.now() >= deadline) throw new Error(this.t('drawingOpenFailed'));
                    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
                    if (this.deletionJobs.has(id) || view.store.retiredDocument) throw new Error(this.t('documentDeletionPending'));
                    if ((payload.generation ?? 0) > view.store.generation) { this.retireStore(view.store, true); continue; }
                    view.store.mergeRemote(payload); view.refreshFromStore(); refreshed = view.store;
                }
                const rect = view.protyle.wysiwyg!.element.getBoundingClientRect();
                const key = [rect.left, rect.top, rect.width, rect.height].join(',');
                if (rect.right > 0 && rect.left < innerWidth && key === previous) {
                    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
                    if (exportIsBusy()) throw new Error(this.t('exportAlreadyRunning'));
                    this.activeOverlay = view;
                    exportStrokesDialog(view, this.t, this.name, () => this.reconcileLegacy(view));
                    return;
                }
                previous = key;
            }
            await new Promise(resolve => window.setTimeout(resolve, 50));
        }
        throw new Error(this.t('drawingOpenFailed'));
    }

    /** Explicit management action: retire ink only; never remove the note. */
    private async deleteDrawing(row: DrawingRow): Promise<void> {
        const {id, generation} = row;
        if (window.siyuan?.config?.readonly || window.siyuan?.isPublish) throw new Error(this.t('drawingReadOnly'));
        if (this.unloading || !row.verified || !validDocumentId(id) || this.deletionJobs.has(id)) throw new Error(this.t('documentDeletionPending'));
        this.manualDeletions.add(id);
        this.drawingCache.invalidate(id);
        const release = fenceDocument(this, id), store = this.documents.get(id);
        for (const view of this.overlays.values()) if (view.docId === id) view.setMode(false);
        store?.block('integrity', this.t('drawingWorking'));
        const job = (async () => {
            if (await drawingGeneration(this, id) !== generation) throw new Error(this.t('drawingChanged'));
            await retireDocumentGeneration(this, id, generation, true);
            this.cleanupQueue.add(id);
            if (store && store.generation <= generation) this.retireStore(store);
            await settleDocumentWrites(this, id);
            await cleanupRetiredDocument(this, id);
        })().finally(() => {
            release(); this.deletionJobs.delete(id); this.manualDeletions.delete(id);
            if (!this.unloading) {
                if (this.queuedDeletionNotices.delete(id)) {
                    // A real note-deletion notice raced an ink-only action. Its
                    // lifetime is ambiguous now: retain the notice and confirm.
                    this.failedDeletions.add(id);
                    this.onWsMain({detail: {cmd: 'removeDoc', code: 0, data: {ids: [id]}}});
                }
                this.attachExisting();
                for (const view of this.overlays.values()) if (view.docId === id) view.setMode(this.modeOn);
                void this.onDataChanged('overwrite', true, false); this.refreshPalette();
            }
        });
        this.deletionJobs.set(id, job);
        await job;
    }

    private async reconcileLegacy(overlay: DocOverlay) {
        overlay.finalizeInput();
        try {
            const payload = await importLegacyInk(this, overlay.docId);
            const store = this.documents.get(overlay.docId);
            if (!store || store !== overlay.store || store.retiredDocument || this.unloading || this.deletionJobs.has(overlay.docId)) return;
            if (!store.loaded) store.adoptPayload(payload); else store.mergeRemote(payload);
            store.unblock(); this.syncErrors.delete(overlay.docId);
            for (const view of this.overlays.values()) if (view.store === store) view.refreshFromStore();
            this.refreshPalette();
            if (store.dirty) this.armSave(SAVE_DEBOUNCE);
        } finally {
            if (!this.documents.has(overlay.docId)) releasePayloadCache(this, overlay.docId);
        }
    }

    private refreshPalette() {
        const overlay = this.activeOverlay;
        this.palette.update({
            canUndo: overlay?.store.canUndo ?? false,
            canRedo: overlay?.store.canRedo ?? false,
            hasSelection: (overlay?.selected.length ?? 0) > 0,
            warning: overlay?.store.blocked?.message ?? "",
        });
    }

    private persistSession() {
        saveSession({
            tool: this.config.tool,
            penColor: this.config.penColor,
            penWidth: this.config.penWidth,
            hlColor: this.config.hlColor,
            hlWidth: this.config.hlWidth,
            eraserRadius: this.overlaySettings.eraserRadius,
        });
    }

    // ------------------------------------------------------------ persistence

    private scheduleSave(overlay: DocOverlay) {
        if (overlay.store.retiredDocument) return;
        this.drawingCache.invalidate(overlay.docId);
        this.pendingSaves.add(overlay.store);
        this.saveRetries = 0;
        // Split views share one document, including undo and unsaved ink.
        for (const other of this.overlays.values()) {
            if (other !== overlay && other.store === overlay.store) other.refreshFromStore();
        }
        this.armSave(SAVE_DEBOUNCE);
    }

    private armSave(delay: number) {
        if (this.unloading) return;
        if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
        this.saveTimer = window.setTimeout(() => {
            this.saveTimer = null;
            void this.flushAll();
        }, delay);
    }

    private async flushStore(store: DocStore) {
        if (store.saving) {
            await store.saving;
            return;
        }
        if (!store.loaded || !store.dirty || store.blocked || store.retiredDocument || this.deletionJobs.has(store.docId)) return;
        store.saving = (async () => {
            while (store.dirty && !store.blocked) {
                const payload = store.serialize();
                try {
                    const ok = await savePayload(this, payload);
                    if (store.retiredDocument || this.deletionJobs.has(store.docId)) break;
                    if (!ok) {
                        showMessage(this.t("saveFailed", {msg: this.t("saveRetry")}), 6000, "error");
                        break;
                    }
                    store.acknowledge(payload.snapshot.sequence);
                    this.drawingCache.invalidate(store.docId);
                } catch (e) {
                    if (store.retiredDocument || this.deletionJobs.has(store.docId)) break;
                    if (e instanceof DocumentRetiredError && e.generation > store.generation) { this.retireStore(store); break; }
                    store.block(e instanceof SyncCapacityError ? "capacity" : "integrity", String(e));
                    showMessage(this.t("syncBlocked", {msg: String(e)}), 0, "error");
                    this.refreshPalette();
                }
            }
        })().finally(() => {
            store.saving = null;
            if (store.blocked) store.rejectUnsentPublication();
            this.refreshPalette();
        });
        await store.saving;
    }

    private async flushAll() {
        if (this.saveTimer !== null) {
            window.clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        for (const overlay of this.overlays.values()) {
            if (overlay.store.dirty || overlay.store.saving) this.pendingSaves.add(overlay.store);
        }
        await Promise.all([...this.pendingSaves].map(store => this.flushStore(store)));
        for (const store of this.pendingSaves) {
            if (!store.dirty && !store.saving) this.pendingSaves.delete(store);
        }
        // Keep failed/detached stores until success; bounded automatic retries avoid a busy loop.
        if ([...this.pendingSaves].some(store => !store.blocked) && this.saveRetries < 3) {
            this.armSave(2000 * 2 ** this.saveRetries++);
        }
        this.releaseUnusedDocuments();
    }

    private releaseUnusedDocuments() {
        for (const [id, store] of this.documents) {
            if (!store.dirty && !store.saving &&
                ![...this.overlays.values()].some(o => o.store === store)) {
                this.documents.delete(id); this.syncErrors.delete(id); releasePayloadCache(this, id);
            }
        }
    }

    private onPageHide = () => {
        for (const overlay of this.overlays.values()) overlay.finalizeInput();
        void this.flushAll();
    };

    private onOnline = () => {
        // Retry only remembered explicit events; a reconnect/404 is never evidence
        // of a new deletion. Retried ambiguous retirement requires confirmation.
        if (this.failedDeletions.size) this.onWsMain({detail: {cmd: "removeDoc", code: 0, data: {ids: [...this.failedDeletions]}}});
        this.saveRetries = 0;
        for (const overlay of this.overlays.values()) overlay.setMode(this.modeOn);
        void this.flushAll();
        void this.onDataChanged("overwrite");
    };

    private onVisibilityChange = () => {
        if (document.visibilityState === "hidden") this.onPageHide();
        else this.onOnline();
    };

    // -------------------------------------------------------------- keyboard

    private onKeyDown = (e: KeyboardEvent) => {
        if (!this.modeOn || !this.activeOverlay) return;
        const target = e.target as HTMLElement | null;
        if (target?.closest("input, textarea, [contenteditable='true'], .b3-dialog")) return;

        const mod = e.ctrlKey || e.metaKey;
        const key = e.key.toLowerCase();
        if (mod && key === "z" && !e.shiftKey) {
            e.preventDefault();
            e.stopPropagation();
            this.activeOverlay.undo();
        } else if ((mod && key === "z" && e.shiftKey) || (mod && key === "y")) {
            e.preventDefault();
            e.stopPropagation();
            this.activeOverlay.redo();
        } else if (key === "escape") {
            e.preventDefault();
            this.toggleMode();
        }
    };

    // -------------------------------------------------------------- settings

    private buildSettingDialog() {
        let paletteLayer: [string, string] | null = null;
        const closed = () => {
            this.settingsOpen = false;
            if (paletteLayer) {
                this.palette.toolbar.style.zIndex = paletteLayer[0]; this.palette.handle.style.zIndex = paletteLayer[1];
                paletteLayer = null;
            }
        };
        this.setting = new Setting({
            height: "44vh",
            width: "600px",
            confirmCallback: () => this.applyAndPersistSettings(),
            destroyCallback: closed,
        });
        // Guard the shared Setting entry, not just the toolbar button: native
        // callers can open it too, and the controls below are reused DOM nodes.
        const open = this.setting.open.bind(this.setting);
        this.setting.open = name => {
            if (this.unloading || this.settingsOpen) return;
            this.settingsOpen = true;
            try {
                open(name);
                const dialog = (this.setting as Setting & {dialog?: Dialog}).dialog;
                if (dialog) {
                    const element = dialog.element.querySelector<HTMLElement>('.b3-dialog') ?? dialog.element;
                    const z = parseInt(getComputedStyle(element).zIndex);
                    if (Number.isFinite(z)) {
                        paletteLayer = [this.palette.toolbar.style.zIndex, this.palette.handle.style.zIndex];
                        this.palette.toolbar.style.zIndex = this.palette.handle.style.zIndex = String(z - 1);
                    }
                }
            } catch (error) { closed(); throw error; }
        };
        const s: Setting = this.setting;
        const row = (
            title: string,
            description: string | undefined,
            control: HTMLElement,
        ) => {
            s.addItem({
                title,
                description,
                direction: "row",
                createActionElement: () => control,
            });
        };

        const mkCheckbox = (get: () => boolean, set: (v: boolean) => void) => {
            const box = document.createElement("input");
            box.type = "checkbox";
            box.className = "b3-switch";
            box.checked = get();
            box.addEventListener("change", () => {
                set(box.checked);
                this.applyAndPersistSettings();
            });
            return box;
        };
        const mkColor = (get: () => string, set: (v: string) => void) => {
            const input = document.createElement("input");
            input.type = "color";
            input.className = "b3-text-field";
            input.style.width = "64px";
            input.value = get();
            input.addEventListener("change", () => {
                set(input.value);
                this.applyAndPersistSettings();
                this.palette.refresh();
            });
            return input;
        };
        const mkNumber = (get: () => number, set: (v: number) => void, min: number, max: number, step = 1) => {
            const input = document.createElement("input");
            input.type = "number";
            input.className = "b3-text-field";
            input.style.width = "90px";
            input.min = String(min);
            input.max = String(max);
            input.step = String(step);
            input.value = String(get());
            input.addEventListener("change", () => {
                const v = Math.min(max, Math.max(min, parseFloat(input.value) || min));
                set(v);
                input.value = String(v);
                this.applyAndPersistSettings();
                this.palette.refresh();
            });
            return input;
        };

        const listButton = document.createElement('button'); listButton.className = 'b3-button'; listButton.textContent = this.t('drawingList');
        listButton.addEventListener('click', () => this.showDrawingList());
        row(this.t('drawingList'), this.t('drawingListHint'), listButton);

        const layout = document.createElement('select'); layout.className = 'b3-select'; layout.setAttribute('aria-label', this.t('settingToolbarLayout'));
        for (const [value, key] of [['auto', 'toolbarLayoutAuto'], ['horizontal', 'toolbarLayoutHorizontal'], ['vertical', 'toolbarLayoutVertical']]) {
            const option = document.createElement('option'); option.value = value; option.textContent = this.t(key); layout.append(option);
        }
        layout.value = this.palette.getLayout();
        layout.addEventListener('change', () => this.palette.setLayout(layout.value as ToolbarLayout));
        row(this.t('settingToolbarLayout'), this.t('settingToolbarLayoutHint'), layout);

        row(this.t("settingShowFloatingBall"), this.t("settingShowFloatingBallHint"),
            mkCheckbox(() => this.settings.showFloatingBall, (v) => {
                this.settings.showFloatingBall = v;
                this.palette.setHandleVisible(v);
            }));
        // Keep the switch on all frontends: Android tablets/phones can also use a mouse.
        row(this.t("settingMouseDrawing"), this.t("settingMouseDrawingHint"),
            mkCheckbox(() => this.settings.mouseDrawing, (v) => {
                this.settings.mouseDrawing = v;
                this.overlaySettings.mouseDrawing = v;
            }));

        row(this.t("settingDoubleTap"), this.t("settingDoubleTapHint"),
            mkCheckbox(() => this.overlaySettings.doubleTapToggle, (v) => {
                this.overlaySettings.doubleTapToggle = v;
                this.settings.doubleTapToggle = v;
            }));
        row(this.t("settingShapeSnap"), this.t("settingShapeSnapHint"),
            mkCheckbox(() => this.overlaySettings.shapeSnap, (v) => {
                this.overlaySettings.shapeSnap = v;
                this.settings.shapeSnap = v;
            }));
        row(this.t("settingShowEraserCursor"), undefined,
            mkCheckbox(() => this.overlaySettings.showEraserCursor, (v) => {
                this.overlaySettings.showEraserCursor = v;
                this.settings.showEraserCursor = v;
            }));
        row(this.t("settingPenColor"), undefined,
            mkColor(() => this.config.penColor, (v) => {
                this.config.penColor = v;
                this.settings.penColor = v;
            }));
        row(this.t("settingPenWidth"), undefined,
            mkNumber(() => this.config.penWidth, (v) => {
                this.config.penWidth = v;
                this.settings.penWidth = v;
            }, 1, 100));
        row(this.t("settingPenWidthMax"), this.t("settingPenWidthMaxHint"),
            mkNumber(() => this.settings.penWidthMax, (v) => {
                this.settings.penWidthMax = v;
                this.overlaySettings.penWidthMax = v;
                if (this.config.penWidth > v) {
                    this.config.penWidth = v;
                    this.persistSession();
                }
            }, 5, 100));
        row(this.t("settingHlColor"), undefined,
            mkColor(() => this.config.hlColor, (v) => {
                this.config.hlColor = v;
                this.settings.hlColor = v;
            }));
        row(this.t("settingHlWidth"), undefined,
            mkNumber(() => this.config.hlWidth, (v) => {
                this.config.hlWidth = v;
                this.settings.hlWidth = v;
            }, 8, 48));
        row(this.t("settingEraserSize"), undefined,
            mkNumber(() => this.overlaySettings.eraserRadius, (v) => {
                this.overlaySettings.eraserRadius = v;
                this.settings.eraserRadius = v;
            }, 4, 60));
    }

    private applyAndPersistSettings() {
        for (const overlay of this.overlays.values()) overlay.refreshInputPolicy();
        saveSettings(this, this.settings);
        this.persistSession();
    }
}
