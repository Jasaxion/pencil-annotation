import {confirm, Dialog, ProtyleMethod} from "siyuan";
import {showTextMessage as showMessage} from './text';
import type {DocOverlay} from "../overlay/overlay";
import {appendBlockMarkdown, kernelJSON, uploadAssetPng} from "./api";
import {strokesToPngBlob} from "./exportImage";
import type * as PdfModule from "./exportPdf";

declare const __PENCIL_DEV__: boolean;
declare const __PENCIL_VERSION__: string;
type I18nFn = (key: string, vars?: Record<string, string>) => string;
const jobs = new Set<AbortController>();
const dialogs = new Map<Dialog, string>();
export const exportIsBusy = () => jobs.size > 0;
export function cancelExports(docId?: string) {
    if (docId === undefined) for (const controller of jobs) controller.abort();
    for (const [dialog, id] of dialogs) if (docId === undefined || id === docId) dialog.destroy();
}

export function exportStrokesDialog(overlay: DocOverlay, t: I18nFn, pluginName = "pencil-annotation", reconcile?: () => Promise<void>) {
    overlay.finalizeInput();
    let active: AbortController | null = null, disposed = false, downloadUrl: string | null = null;
    let hasInk = overlay.store.strokes.length > 0;
    const dialog = new Dialog({
        title: t("exportTitle"), width: "min(560px, calc(100vw - 24px))",
        content: `<div class="pa-export">
            <section class="b3-label config-item">
                <h3 class="config-name">${t("exportPdfSection")}</h3>
                <p class="b3-label__text">${t("exportPdfHint")}</p>
                <label class="pa-export__layout">${t("exportLayout")} <select class="b3-select" data-pdf-layout><option value="current">${t("exportLayoutCurrent")}</option><option value="native">${t("exportLayoutNative")}</option></select></label>
                <label class="pa-export__best-effort"><input type="checkbox" class="b3-switch" data-best-effort checked> ${t("exportBestEffort")}</label>
                <p class="b3-label__text">${t("exportBestEffortHint")}</p>
                <div class="pa-export__row">
                    <button class="b3-button" data-action="pdf">${t("exportPdf")}</button>
                    <button class="b3-button b3-button--outline" data-action="cancel" hidden>${t("exportCancel")}</button>
                    <a class="b3-button b3-button--outline" data-action="download" hidden>${t("exportPdfDownload")}</a>
                </div>
                <p class="pa-export__status b3-label__text" role="status" aria-live="polite"></p>
                <progress class="pa-export__progress" hidden></progress>
                <details class="pa-export__warnings" hidden><summary></summary><ul></ul></details>
            </section>
            <section class="b3-label config-item">
                <h3 class="config-name">${t("exportInkSection")}</h3>
                <p class="b3-label__text">${t("exportInkDesc")}</p>
                <div class="pa-export__radios">
                    <label><input class="b3-radio" type="radio" name="pa-export-bg" value="white" checked> ${t("exportBgWhite")}</label>
                    <label><input class="b3-radio" type="radio" name="pa-export-bg" value="transparent"> ${t("exportBgTransparent")}</label>
                </div>
                <div class="pa-export__row">
                    <button class="b3-button b3-button--outline" data-action="save" ${hasInk ? "" : "disabled"}>${t("exportSaveOnly")}</button>
                    <button class="b3-button b3-button--outline" data-action="insert" ${hasInk ? "" : "disabled"}>${t("exportInsert")}</button>
                </div>
                <p class="pa-export__empty b3-label__text" ${hasInk ? "hidden" : ""}>${t("exportNone")}</p>
            </section>
            <section class="b3-label config-item">
                <h3 class="config-name">${t("exportBackupSection")}</h3>
                <p class="b3-label__text">${t("exportBackupHint")}</p>
                <p class="pa-export__blocked b3-label__text"></p>
                <a class="b3-button b3-button--outline" href="#" data-action="backup" aria-disabled="${!overlay.store.loaded}">${t("exportBackup")}</a>
                <button class="b3-button b3-button--outline" data-action="reconcile" ${reconcile && /old plugin changed/i.test(overlay.store.blocked?.message ?? "") ? "" : "hidden"}>${t("syncImportLegacy")}</button>
            </section>
        </div>`,
        destroyCallback: () => {
            dialogs.delete(dialog);
            disposed = true; active?.abort();
            if (downloadUrl) { const url = downloadUrl; window.setTimeout(() => URL.revokeObjectURL(url), 60000); downloadUrl = null; }
        },
    });
    dialogs.set(dialog, overlay.docId);
    const root = dialog.element;
    root.querySelector<HTMLElement>(".pa-export__blocked")!.textContent = overlay.store.blocked?.message ?? "";
    const status = root.querySelector<HTMLElement>(".pa-export__status")!;
    const progress = root.querySelector<HTMLProgressElement>("progress")!;
    const layout = root.querySelector<HTMLSelectElement>('[data-pdf-layout]')!;
    const bestEffort = root.querySelector<HTMLInputElement>("[data-best-effort]")!;
    const warnings = root.querySelector<HTMLDetailsElement>(".pa-export__warnings")!;
    const cancel = root.querySelector<HTMLButtonElement>('[data-action="cancel"]')!;
    const download = root.querySelector<HTMLAnchorElement>('[data-action="download"]')!;
    const busy = (on: boolean) => {
        hasInk = overlay.store.strokes.length > 0;
        root.querySelector<HTMLElement>(".pa-export__empty")!.hidden = hasInk;
        root.querySelector<HTMLElement>(".pa-export__blocked")!.textContent = overlay.store.blocked?.message ?? "";
        root.querySelectorAll<HTMLButtonElement>('button[data-action="pdf"],button[data-action="save"],button[data-action="insert"],button[data-action="backup"],button[data-action="reconcile"]')
            .forEach(button => { const action = button.dataset.action;
                button.disabled = on || ((action === "save" || action === "insert") && !hasInk) || (action === "backup" && !overlay.store.loaded); });
        const backup = root.querySelector<HTMLAnchorElement>('[data-action="backup"]')!;
        backup.setAttribute("aria-disabled", String(on || !overlay.store.loaded));
        backup.tabIndex = on || !overlay.store.loaded ? -1 : 0;
        bestEffort.disabled = on; layout.disabled = on;
        cancel.hidden = !on; progress.hidden = !on;
    };
    const begin = () => {
        if (active || disposed) return null;
        if (jobs.size) { status.textContent = t("exportAlreadyRunning"); return null; }
        const controller = new AbortController(); active = controller; jobs.add(controller); busy(true);
        progress.removeAttribute("value"); status.textContent = t("exportPreparing");
        return controller;
    };
    const finish = (controller: AbortController) => {
        jobs.delete(controller);
        if (active === controller) active = null;
        if (!disposed) busy(false);
    };
    const fail = (error: unknown, signal: AbortSignal) => {
        if (disposed) return;
        const cancelled = signal.aborted || (error as Error)?.name === "AbortError";
        status.textContent = cancelled ? t("exportCancelled") : t("exportFailed", {msg: String((error as Error)?.message || error)});
        if (!cancelled) showMessage(status.textContent, 7000, "error");
    };
    root.querySelector('[data-action="backup"]')!.addEventListener("click", event => {
        if (jobs.size || !overlay.store.loaded) { event.preventDefault(); return; }
        const blob = new Blob([JSON.stringify(overlay.store.backup())], {type: "application/json"});
        const url = URL.createObjectURL(blob), link = event.currentTarget as HTMLAnchorElement;
        // Let the trusted link's default action download it (no synthetic second click).
        link.href = url; link.download = `pencil-${overlay.docId}-backup.json`;
        window.setTimeout(() => URL.revokeObjectURL(url), 60000);
    });
    root.querySelector('[data-action="reconcile"]')!.addEventListener("click", () => {
        if (!reconcile || jobs.size) return;
        confirm(t("syncImportLegacy"), t("syncImportLegacyConfirm"), () => {
            const controller = begin(); if (!controller) return;
            cancel.hidden = true; download.hidden = true;
            void reconcile().then(() => {
                if (!disposed) {
                    status.textContent = t("syncImportLegacyDone");
                    root.querySelector<HTMLElement>('[data-action="reconcile"]')!.hidden = true;
                }
            }).catch(error => fail(error, controller.signal)).finally(() => finish(controller));
        });
    });
    cancel.addEventListener("click", () => active?.abort());
    download.addEventListener("click", () => showMessage(t("exportPdfDownloadStarted")));
    root.querySelector('[data-action="pdf"]')!.addEventListener("click", () => {
        const controller = begin(); if (!controller) return;
        download.hidden = true; warnings.hidden = true; warnings.querySelector("ul")!.replaceChildren();
        const compatible = bestEffort.checked, selectedLayout = layout.value === "native" ? "native" : "current";
        void (async () => {
            try {
                if (!overlay.store.loaded) throw new Error("Wait for handwriting to load before exporting");
                const source = overlay.protyle.wysiwyg?.element;
                if (!source) throw new Error("No document editor");
                // Resolve the module first; the PDF engine then takes the single
                // immutable ink snapshot together with the current layout.
                const url = __PENCIL_DEV__ ? "/src/plugin/exportPdf.ts" : `/plugins/${encodeURIComponent(pluginName)}/pdf.js?v=${encodeURIComponent(__PENCIL_VERSION__)}`;
                const module = await import(/* @vite-ignore */ url) as typeof PdfModule;
                const rootId = overlay.protyle.block?.rootID || overlay.protyle.options?.rootId;
                if (rootId !== overlay.docId || overlay.store.retiredDocument) throw new Error('The source document changed; reopen export');
                const input = {docId: overlay.docId, source, strokes: overlay.store.strokes};
                const result = await module.buildNotePdfBlob(input, {signal: controller.signal, request: kernelJSON, bestEffort: compatible, layout: selectedLayout, text: t,
                    renderers: {math: el => ProtyleMethod.mathRender(el)},
                    onProgress: (stage, done, total) => {
                        if (disposed || controller.signal.aborted) return;
                        if (stage === "prepare") { progress.removeAttribute("value"); status.textContent = t("exportPreparing"); }
                        else { progress.max = total; progress.value = done; status.textContent = t("exportPdfProgress", {done: String(done), total: String(total)}); }
                    }});
                if (disposed) return;
                if (controller.signal.aborted) throw new DOMException("Cancelled", "AbortError");
                if (downloadUrl) URL.revokeObjectURL(downloadUrl);
                downloadUrl = URL.createObjectURL(result.blob); download.href = downloadUrl; download.download = result.name; download.hidden = false;
                status.textContent = result.warnings.length ? t("exportPdfReadyWarnings", {pages: String(result.pages), count: String(result.warnings.length)}) : t("exportPdfReady", {pages: String(result.pages)});
                if (result.warnings.length) {
                    warnings.hidden = false;
                    warnings.querySelector("summary")!.textContent = t("exportWarningsSummary", {count: String(result.warnings.length)});
                    for (const message of result.warnings) { const item = document.createElement("li"); item.textContent = message; warnings.querySelector("ul")!.append(item); }
                }
            } catch (error) { fail(error, controller.signal); controller.abort(); }
            finally { finish(controller); }
        })();
    });
    const png = async (insert: boolean) => {
        const controller = begin(); if (!controller) return;
        try {
            const bg = root.querySelector<HTMLInputElement>('input[name="pa-export-bg"]:checked')?.value === "transparent" ? "transparent" : "white";
            const blob = await strokesToPngBlob(overlay.store, bg, overlay.strokeOffsets());
            if (controller.signal.aborted) throw new DOMException("Cancelled", "AbortError");
            const path = await uploadAssetPng(`pencil-${overlay.docId}-${Date.now()}.png`, blob, controller.signal);
            if (insert) await appendBlockMarkdown(overlay.docId, `![](${path})`, controller.signal);
            if (!disposed && !controller.signal.aborted) { showMessage(t("exportDone", {path})); dialog.destroy(); }
        } catch (error) { fail(error, controller.signal); }
        finally { finish(controller); }
    };
    root.querySelector('[data-action="save"]')!.addEventListener("click", () => void png(false));
    root.querySelector('[data-action="insert"]')!.addEventListener("click", () => void png(true));
    return dialog;
}
