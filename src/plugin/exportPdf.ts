// Adapted from BUGdefender404/pencil-annotation (MIT), a46944b.
// Browser-only PDF module: no Electron, Node, or kernel PDF/HTML-file exporter.
import {domToSvg} from "modern-screenshot";
import {jsPDF} from "jspdf";
import {fingerprint} from "../engine/sync";
import {paintStrokes, StrokeRenderer, type OffsetFn} from "../engine/renderer";
import type {Stroke} from "../engine/types";
import {captureCurrentLayout, currentInkTarget, prepareCurrentLayout} from "./pdfLayout";
import {appendCompatibilityReport, compatibility, mapStaticEmbeds, markChanged, placeholder, sanitizePdf, type PdfCompatibility} from "./pdfCompatibility";

export interface PdfInput {docId: string; source: HTMLElement; strokes: Stroke[]}
export interface PdfOptions {
    signal: AbortSignal;
    request: (path: string, body: unknown, signal?: AbortSignal) => Promise<any>;
    renderers?: Record<string, (element: HTMLElement) => void>;
    onProgress?: (stage: "prepare" | "page", done: number, total: number) => void;
    bestEffort?: boolean;
    layout?: "current" | "native";
    text?: (key: string, vars?: Record<string, string>) => string;
}
export interface PdfResult {blob: Blob; name: string; pages: number; warnings: string[]}
const MAX_PAGES = 200, MAX_OUTPUT = 64 * 1024 * 1024;
const MAX_SIDE = 3800, MAX_AREA = 8e6;
const cancelled = (signal: AbortSignal) => { if (signal.aborted) throw new DOMException("PDF export cancelled", "AbortError"); };
const pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    cancelled(signal);
    const abort = () => { clearTimeout(timer); reject(new DOMException("PDF export cancelled", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, {once: true});
});
async function boundedWait(promise: Promise<unknown>, signal: AbortSignal, label: string) {
    // Observe rejections even when cancellation already happened before this wait.
    void promise.catch(() => {});
    let timer: ReturnType<typeof setTimeout>;
    let abort: () => void;
    const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not finish loading`)), 15000);
        abort = () => reject(new DOMException("PDF export cancelled", "AbortError"));
        signal.addEventListener("abort", abort, {once: true});
    });
    try { cancelled(signal); await Promise.race([promise, deadline]); }
    finally { clearTimeout(timer!); signal.removeEventListener("abort", abort!); }
}
function fragment(html: string): DocumentFragment {
    const template = document.createElement("template"); template.innerHTML = html; return template.content;
}
function documentFingerprint(root: Node, hash = true): string {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ALL);
    const tokens: unknown[] = []; let count = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (++count > 200000) throw new Error("Document is too large to verify safely");
        if (!hash) continue;
        const attributes = node instanceof Element ? [...node.attributes].map(a => [a.name, a.value]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0) : [];
        tokens.push([node.nodeType, node.nodeName, node.nodeValue, node.childNodes.length, attributes]);
    }
    return hash ? fingerprint(tokens) : '';
}
function needsAssetPreparation(root: ParentNode): boolean {
    return [...root.querySelectorAll('img')].some(image => {
        const src = image.getAttribute('data-src') || image.getAttribute('src') || '';
        return src !== '' && !/^(data:|blob:)/i.test(src);
    });
}
function blockIds(root: ParentNode): Set<string> {
    return new Set([...root.querySelectorAll<HTMLElement>("[data-node-id]")].map(el => el.dataset.nodeId!));
}
function typography(source: HTMLElement): string {
    const s = getComputedStyle(source);
    return [source.clientWidth, s.fontFamily, s.fontSize, s.lineHeight, s.letterSpacing, s.color].join("|");
}
function background(source: HTMLElement): string {
    for (let el: HTMLElement | null = source; el; el = el.parentElement) {
        const color = getComputedStyle(el).backgroundColor;
        if (color !== "transparent" && color !== "rgba(0, 0, 0, 0)") return color;
    }
    return "#ffffff";
}
function expandIcons(body: HTMLElement, state: PdfCompatibility) {
    for (const use of body.querySelectorAll("svg use")) {
        if (!body.contains(use)) continue;
        const href = use.getAttribute("href") ?? use.getAttribute("xlink:href");
        const symbol = href?.startsWith("#") ? document.getElementById(href.slice(1)) : null;
        if (!symbol) {
            if (!state.enabled) throw new Error(`Missing or unsupported document icon ${href}`);
            placeholder(use.closest("svg")!, state, state.text("exportMissingIcon", "An unavailable icon was replaced"));
            continue;
        }
        const svg = use.closest("svg")!;
        if (!svg.hasAttribute("viewBox") && symbol.hasAttribute("viewBox")) svg.setAttribute("viewBox", symbol.getAttribute("viewBox")!);
        const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
        const content = document.createDocumentFragment(); content.append(...[...symbol.childNodes].map(node => node.cloneNode(true)));
        const iconState: PdfCompatibility = {...state, changed: false, degraded: new Set()};
        sanitizePdf(content, iconState); // referenced symbols are outside the already-sanitized fragment
        if (iconState.changed) markChanged(use, state);
        group.append(content); use.replaceWith(group);
    }
}
async function readyVisuals(body: HTMLElement, options: PdfOptions, state: PdfCompatibility) {
    const {signal} = options;
    const dynamic: Array<{el: HTMLElement; ready: string}> = [];
    const kinds = new Set<string>();
    for (const el of body.querySelectorAll<HTMLElement>(".render-node")) {
        if (state.staticEmbeds.has(el)) continue;
        const kind = el.dataset.subtype || el.dataset.type || "";
        const name = /math/i.test(kind) ? "math" : kind;
        if (name !== "math" || !options.renderers?.math) {
            if (!state.enabled) throw new Error(`This dynamic block has no reliable PDF completion signal: ${kind}`);
            placeholder(el, state, state.text("exportUnsupported", "Unsupported {kind}: compatible placeholder", {kind}));
            continue;
        }
        kinds.add(name); dynamic.push({el, ready: ".katex"});
    }
    for (const el of body.querySelectorAll<HTMLElement>('[data-type="NodeCodeBlock"]')) {
        const language = el.querySelector(".protyle-action__language")?.textContent?.trim().toLowerCase() ?? "";
        if (["mermaid", "flowchart", "graphviz", "echarts", "abc", "plantuml", "mindmap"].includes(language)) {
            if (!state.enabled) throw new Error(`This diagram needs a reliable completion signal before full PDF export is supported: ${language}`);
            placeholder(el, state, state.text("exportDiagramText", "{kind} was exported as source text", {kind: language}), el.querySelector(".hljs")?.textContent ?? "");
        }
    }
    for (const name of kinds) {
        try { options.renderers![name](body); }
        catch (error) {
            if (!state.enabled || signal.aborted) throw error;
            for (const item of dynamic) if (body.contains(item.el)) placeholder(item.el, state, state.text("exportMathText", "A formula was exported as source text"), item.el.dataset.content ?? "");
        }
    }
    const end = performance.now() + 15000;
    while (dynamic.some(item => body.contains(item.el) && !item.el.querySelector(item.ready))) {
        if (performance.now() > end) {
            if (!state.enabled) throw new Error("A formula/diagram failed to render; no incomplete PDF was generated");
            for (const item of dynamic) if (body.contains(item.el) && !item.el.querySelector(item.ready)) placeholder(item.el, state, state.text("exportMathText", "A formula was exported as source text"), item.el.dataset.content ?? "");
            break;
        }
        await pause(30, signal);
    }
    for (const image of body.querySelectorAll("img")) {
        try {
            image.loading = "eager";
            const src = image.getAttribute("data-src") || image.getAttribute("src");
            if (!src) throw new Error("An image has no source");
            if (/^assets\//.test(src)) image.src = new URL(`/${src}`, location.origin).href;
            else image.src = new URL(src, location.href).href;
            await boundedWait(image.decode(), signal, "Image");
            if (!image.naturalWidth || !image.naturalHeight) throw new Error("An image is missing");
        } catch (error) {
            if (!state.enabled || signal.aborted || (error as Error)?.name === "AbortError") throw error;
            placeholder(image, state, state.text("exportMissingImage", "An unavailable image was replaced by a placeholder"));
        }
    }
    await boundedWait(document.fonts.ready, signal, "Fonts");
    await pause(40, signal);
    expandIcons(body, state);
}

/** Full kernel preview + independently checked source manifest, never the live DOM subset. */
export async function buildNotePdfBlob(input: PdfInput, options: PdfOptions): Promise<PdfResult> {
    const {signal, request} = options;
    const state = compatibility(options.bestEffort !== false, options.text);
    cancelled(signal);
    if (!input.source.isConnected) throw new Error("The source editor was closed");
    const width = input.source.clientWidth;
    if (width < 50) throw new Error("The document has no usable layout width");
    const sourceStyle = getComputedStyle(input.source), styleKey = typography(input.source);
    const bg = background(input.source);
    const strokes = input.strokes.map(s => ({...s, points: s.points.map(p => ({...p})),
        ...(s.anchor ? {anchor: {...s.anchor}} : {})}));
    const current = options.layout !== "native" ? captureCurrentLayout(input.source, strokes) : null;
    options.onProgress?.("prepare", 0, 0);
    const previewRequest = {id: input.docId, image: true, keepFold: false, merge: false, addTitle: false, keepJSEmbed: false};
    const [source, metadata] = await Promise.all([
        request('/api/block/getBlockDOM', {id: input.docId}, signal),
        current ? request('/api/block/getDocInfo', {id: input.docId}, signal) : request('/api/export/exportPreviewHTML', previewRequest, signal),
    ]);
    if (source?.id !== input.docId || typeof source.dom !== 'string') throw new Error('Invalid full-document source');
    if (current ? metadata?.id !== input.docId || metadata.rootID !== input.docId
        : typeof metadata?.content !== 'string' || metadata.id !== input.docId || metadata.type !== 'NodeDocument') throw new Error('Invalid document metadata/preview');
    const sourceDOM = fragment(source.dom);
    // Text/SQL-only current-layout exports need no redundant full native render.
    // Keep native resource preparation for file/network images to retain host compatibility.
    if (current && (needsAssetPreparation(sourceDOM) || needsAssetPreparation(current.live))) {
        const prepared = await request('/api/export/exportPreviewHTML', previewRequest, signal);
        if (prepared?.id !== input.docId || prepared.type !== 'NodeDocument') throw new Error('Invalid export resource preparation');
    }
    const after = await request('/api/block/getBlockDOM', {id: input.docId}, signal);
    if (after?.id !== input.docId || typeof after.dom !== 'string') throw new Error('Invalid source verification');
    if (source.dom === after.dom) documentFingerprint(sourceDOM, false);
    else if (documentFingerprint(sourceDOM) !== documentFingerprint(fragment(after.dom))) throw new Error('The document changed during export preparation; retry when editing stops');
    const preview = current ? {id: input.docId, type: 'NodeDocument', name: metadata.name, attrs: metadata.ial ?? {}} : metadata;
    const expected = blockIds(sourceDOM), html = current ? sourceDOM.cloneNode(true) as DocumentFragment : fragment(preview.content);
    html.querySelectorAll('a[href^="pdf-outline://"]').forEach(link => link.remove());
    html.querySelector(`[data-node-id="${CSS.escape(input.docId)}"][data-type="NodeHeading"]`)?.remove();
    if (current) await prepareCurrentLayout(html, current, input.docId, request, signal, state);
    else await mapStaticEmbeds(sourceDOM, html, input.source, input.docId, request, signal, state);
    for (const reference of current ? [] : sourceDOM.querySelectorAll('[data-type~="block-ref"]')) {
        const block = reference.closest<HTMLElement>("[data-node-id]");
        if (!block) continue;
        const target = html.querySelector(`[data-node-id="${CSS.escape(block.dataset.nodeId!)}"]`);
        const text = (node: Element) => (node.textContent ?? "").replace(/\u200b/g, "").replace(/\s+/g, " ").trim();
        if (!target || text(block) !== text(target)) markChanged(block, state);
        state.warn(state.text("exportStaticReference", "Block references use SiYuan's static export representation"));
    }
    if (sourceDOM.querySelector('[fold="1"]')) state.changed = true;
    sanitizePdf(html, state);
    expected.delete(input.docId);
    const actual = blockIds(html), missing = [...expected].filter(id => !actual.has(id));
    if (missing.length && !state.enabled) throw new Error(`Full export is missing ${missing.length} source blocks (${missing.slice(0, 3).join(", ")})`);
    for (const id of missing) {
        if (!state.degraded.has(id)) state.warn(state.text("exportMissingBlock", "Block {id} was not preserved by the native export; its content could not be verified", {id}));
        const missingSource = sourceDOM.querySelector(`[data-node-id="${CSS.escape(id)}"]`);
        if (missingSource) markChanged(missingSource, state);
        state.degraded.add(id); state.changed = true;
    }
    if (!current) for (const id of actual) if (!expected.has(id)) state.degraded.add(id);
    if (!expected.size) throw new Error("The document is empty");

    const host = document.createElement("div"); host.className = "pa-pdf-host protyle"; host.inert = true;
    host.style.cssText = `position:fixed;left:-100000px;top:0;width:${width}px;pointer-events:none;background:${bg};`;
    const page = document.createElement("div"); page.style.cssText = `position:relative;width:${width}px;overflow:hidden;background:${bg};`;
    const sheet = document.createElement("div"); sheet.style.width = `${width}px`;
    const title = document.createElement("h1"); title.textContent = String(preview.name || "Note");
    title.style.cssText = `box-sizing:border-box;margin:0;padding:16px ${sourceStyle.paddingRight} 24px ${sourceStyle.paddingLeft};font-family:${sourceStyle.fontFamily};font-size:${parseFloat(sourceStyle.fontSize) * 1.6}px;line-height:1.3;color:${sourceStyle.color};`;
    const body = document.createElement("div"); body.className = input.source.className; body.classList.remove("pa-writing");
    body.dataset.docType = preview.type;
    body.style.cssText = `box-sizing:border-box;width:${width}px;min-height:0;margin:0;`;
    for (const property of ["font-family", "font-size", "font-weight", "line-height", "letter-spacing", "word-break", "color", "padding-top", "padding-right", "padding-bottom", "padding-left", "direction"]) {
        body.style.setProperty(property, sourceStyle.getPropertyValue(property));
    }
    for (const property of sourceStyle) if (property.startsWith("--")) host.style.setProperty(property, sourceStyle.getPropertyValue(property));
    for (const [key, value] of Object.entries(preview.attrs ?? {})) if (/^(custom-|data-)[\w-]+$/.test(key) && typeof value === "string") body.setAttribute(key, value);
    body.append(html); sheet.append(title, body); page.append(sheet); host.append(page); document.body.append(host);
    try {
        await readyVisuals(body, options, state);
        cancelled(signal);
        // A full document must not quietly omit the offscreen columns of a nested scroller.
        const captureRect = sheet.getBoundingClientRect();
        const degradeOverflow = (element: Element) => {
            const block = element.closest<HTMLElement>("[data-node-id]") ?? element;
            if (block === body) throw new Error("The export body cannot be safely fitted to the PDF width");
            const table = block.querySelector("table");
            const text = table ? [...table.rows].map(row => [...row.cells].map(cell => cell.textContent ?? "").join(" | ")).join("\n")
                : block.querySelector(".hljs")?.textContent ?? block.textContent ?? "";
            placeholder(block, state, state.text("exportOverflowText", "Clipped or oversized content was converted to wrapped text"), text);
        };
        for (const el of [...body.querySelectorAll<HTMLElement>("*")]) {
            if (!body.contains(el)) continue;
            const style = getComputedStyle(el);
            const clippedX = el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 2 && /auto|scroll|hidden|clip/.test(style.overflowX);
            const clippedY = el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 2 && /auto|scroll|hidden|clip/.test(style.overflowY);
            if (clippedX || clippedY) {
                if (!state.enabled) throw new Error("A table/code block has hidden content. Fit or expand it before exporting the full document");
                degradeOverflow(el);
            }
        }
        for (const el of [...body.querySelectorAll<HTMLElement>("[data-node-id],img,svg,canvas,table,pre")]) {
            if (!body.contains(el)) continue;
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && (rect.left < captureRect.left - 1 || rect.right > captureRect.right + 1 || el.scrollWidth > width + 2)) {
                if (!state.enabled) throw new Error("Document content extends outside the PDF width. Resize or wrap it first; no cropped PDF was generated");
                degradeOverflow(el);
            }
        }
        if (body.scrollWidth > width + 2) throw new Error("The export body still exceeds its width after compatibility conversion");
        const anchors = new Map<string, HTMLElement>(), placed: Stroke[] = [], orphans: Stroke[] = [];
        if (strokes.length && state.uncertainEmbedScope) state.warn(state.text("exportEmbedInkUncertain", "SQL embeds and older block-ID-only ink do not carry historical instance identity; ink is shown separately to avoid attaching it to the wrong occurrence"));
        for (const stroke of strokes) {
            if (state.uncertainEmbedScope) {
                if (!state.enabled) throw new Error("Ink placement in a document containing SQL embeds cannot be historically verified");
                orphans.push(stroke); continue;
            }
            if (!stroke.anchor) {
                if (state.changed) {
                    if (!state.enabled) throw new Error("Unanchored ink cannot be positioned safely after content conversion");
                    orphans.push(stroke);
                } else placed.push(stroke);
                continue;
            }
            const id = stroke.anchor.blockId;
            const target = current ? currentInkTarget(body, id, current) : (() => {
                const matches = body.querySelectorAll<HTMLElement>(`[data-node-id="${CSS.escape(id)}"]`);
                return matches.length === 1 ? matches[0] : null;
            })();
            if (state.degraded.has(id) || !target) {
                if (!state.enabled) throw new Error(`Ink anchor is missing, converted or ambiguous in the full document: ${id}`);
                orphans.push(stroke); continue;
            }
            anchors.set(id, target); placed.push(stroke);
        }
        const beforeReport = sheet.getBoundingClientRect(), beforeBodyY = body.getBoundingClientRect().top - beforeReport.top;
        for (let i = placed.length - 1; i >= 0; i--) {
            const stroke = placed[i], block = stroke.anchor ? anchors.get(stroke.anchor.blockId)!.getBoundingClientRect() : null;
            const x = block ? block.left - beforeReport.left : 0, y = block ? block.top - beforeReport.top : beforeBodyY;
            if (stroke.points.some(point => point.x + x - stroke.width < 0 || point.x + x + stroke.width > width || point.y + y - stroke.width < 0)) {
                if (!state.enabled) throw new Error("Ink extends outside the document bounds; adjust its position before export");
                orphans.push(stroke); placed.splice(i, 1);
            }
        }
        const report = appendCompatibilityReport(body, orphans, state, bg);
        const rootRect = sheet.getBoundingClientRect(), bodyY = body.getBoundingClientRect().top - rootRect.top;
        const origins = new Map([...anchors].map(([id, element]) => {
            const rect = element.getBoundingClientRect();
            return [id, {dx: rect.left - rootRect.left, dy: rect.top - rootRect.top}] as const;
        }));
        const offsets: OffsetFn = stroke => stroke.anchor ? origins.get(stroke.anchor.blockId)! : {dx: 0, dy: bodyY};
        let height = Math.max(title.getBoundingClientRect().bottom - rootRect.top,
            ...[...body.children].filter(el => el !== report).map(el => el.getBoundingClientRect().bottom - rootRect.top));
        // Editor bottom padding is a typing affordance, not document content.
        // Ink below the last block still extends the export explicitly below.
        for (const stroke of placed) {
            const offset = offsets(stroke)!;
            for (const point of stroke.points) {
                if (point.x + offset.dx - stroke.width < 0 || point.x + offset.dx + stroke.width > width) throw new Error("Ink extends outside the document width; adjust its position before export");
                height = Math.max(height, point.y + offset.dy + stroke.width + 12);
            }
        }
        if (report) {
            // Shift only the final report, not the body/anchors already measured.
            // Below-document handwriting remains above, never on top of its notes.
            const shift = Math.max(0, height + 12 - (report.getBoundingClientRect().top - rootRect.top));
            if (shift) { report.style.position = "relative"; report.style.top = `${shift}px`; }
            height = Math.max(height, report.getBoundingClientRect().bottom - rootRect.top);
        }
        const pageHeight = Math.floor(width * 841.89 / 595.28);
        const bottoms = [...body.querySelectorAll<HTMLElement>(":scope > [data-node-id], .pa-pdf-compatibility li, .pa-pdf-compatibility p, .pa-pdf-compatibility svg")].map(el => el.getBoundingClientRect().bottom - rootRect.top).sort((a, b) => a - b);
        const ranges: Array<[number, number]> = [];
        for (let start = 0; start < height;) {
            const target = Math.min(height, start + pageHeight);
            const seam = bottoms.filter(b => b <= target && b >= start + pageHeight * .6).pop();
            const end = target < height && seam ? Math.floor(seam) : target;
            if (end <= start || ranges.length >= MAX_PAGES) throw new Error("PDF exceeds the safe page limit; split the document first");
            ranges.push([start, end]); start = end;
        }
        const scale = Math.min(2, window.devicePixelRatio || 1, MAX_SIDE / width, MAX_SIDE / pageHeight, Math.sqrt(MAX_AREA / (width * pageHeight)));
        const pdf = new jsPDF({unit: "pt", format: "a4", compress: true});
        pdf.setProperties({title: String(preview.name || "Note"), creator: "Pencil Annotation"});
        const renderer = new StrokeRenderer();
        let encodedBytes = 0;
        for (let index = 0; index < ranges.length; index++) {
            cancelled(signal);
            if (!input.source.isConnected || typography(input.source) !== styleKey) throw new Error("The editor layout changed during export; retry");
            const [start, end] = ranges[index], used = end - start;
            page.style.height = `${used}px`; sheet.style.transform = `translateY(${-start}px)`;
            options.onProgress?.("page", index, ranges.length);
            let canvas: HTMLCanvasElement | null = null;
            try {
                const svg = await domToSvg(page, {scale, width, height: used, backgroundColor: bg, timeout: 15000, maximumCanvasSize: MAX_SIDE,
                    fetch: {requestInit: {signal, credentials: "same-origin"}, placeholderImage: () => { throw new Error("A PDF image could not be embedded"); }}});
                const image = new Image(); image.src = svg;
                await boundedWait(image.decode(), signal, "PDF page rasterization");
                if (!image.naturalWidth || !image.naturalHeight) throw new Error("PDF page image failed to decode");
                cancelled(signal);
                canvas = document.createElement("canvas");
                canvas.width = Math.ceil(width * scale); canvas.height = Math.ceil(used * scale);
                if (!canvas.width || !canvas.height || canvas.width > MAX_SIDE + 1 || canvas.height > MAX_SIDE + 1 || canvas.width * canvas.height > MAX_AREA + 10000) throw new Error("PDF canvas exceeded its resource budget");
                const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("Canvas rendering is unavailable");
                // Do not use domToCanvas: its final drawImage failures can be swallowed.
                ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
                ctx.save(); ctx.setTransform(scale, 0, 0, scale, 0, 0);
                ctx.beginPath(); ctx.rect(0, 0, width, used); ctx.clip();
                const viewport = {originX: 0, originY: start, width, height: used};
                ctx.globalCompositeOperation = "multiply"; paintStrokes(ctx, placed, renderer, viewport, s => s.tool !== "highlighter", offsets);
                ctx.globalCompositeOperation = "source-over"; paintStrokes(ctx, placed, renderer, viewport, s => s.tool !== "pen", offsets);
                ctx.restore();
                const encoded = canvas.toDataURL("image/jpeg", .94); encodedBytes += encoded.length * .75;
                if (encodedBytes > MAX_OUTPUT) throw new Error("PDF exceeds the safe output size; split the document first");
                if (index) pdf.addPage("a4", "portrait");
                pdf.addImage(encoded, "JPEG", 0, 0, 595.28, used / width * 595.28);
            } finally { if (canvas) canvas.width = canvas.height = 0; }
            options.onProgress?.("page", index + 1, ranges.length);
            await pause(0, signal);
        }
        cancelled(signal);
        const blob = pdf.output("blob");
        if (blob.size > MAX_OUTPUT) throw new Error("PDF exceeds the safe output size");
        const name = `${String(preview.name || "note").replace(/[\\/:*?"<>|\r\n]/g, "_").slice(0, 100)}.pdf`;
        return {blob, name, pages: ranges.length, warnings: state.warnings};
    } finally { host.remove(); }
}
