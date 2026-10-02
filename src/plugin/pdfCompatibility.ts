import {fingerprint} from "../engine/sync";
import type {Stroke} from "../engine/types";

export interface PdfCompatibility {
    enabled: boolean;
    warnings: string[];
    degraded: Set<string>;
    changed: boolean;
    uncertainEmbedScope: boolean;
    staticEmbeds: Set<Element>;
    text: (key: string, fallback: string, vars?: Record<string, string>) => string;
    warn: (message: string) => void;
}
export function compatibility(enabled: boolean, translate?: (key: string, vars?: Record<string, string>) => string): PdfCompatibility {
    const warnings: string[] = [];
    return {enabled, warnings, degraded: new Set(), changed: false, uncertainEmbedScope: false, staticEmbeds: new Set(),
        text: (key, fallback, vars = {}) => {
            const translated = translate?.(key, vars);
            return translated && translated !== key ? translated : Object.entries(vars).reduce((text, [key, value]) => text.split(`{${key}}`).join(value), fallback);
        },
        warn: message => {
            if (warnings.includes(message)) return;
            if (warnings.length < 128) warnings.push(message);
            else if (warnings.length === 128) warnings.push(translate?.("exportMoreWarnings") || "Further compatibility details are shown by placeholders in the document.");
        }};
}
export function markChanged(node: Element, state: PdfCompatibility) {
    state.changed = true;
    for (const el of [node, ...node.querySelectorAll("[data-node-id]")]) {
        const id = el.getAttribute("data-node-id"); if (id) state.degraded.add(id);
    }
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        const id = parent.getAttribute("data-node-id"); if (id) state.degraded.add(id);
    }
}
export function placeholder(node: Element, state: PdfCompatibility, message: string, text = "") {
    markChanged(node, state); state.warn(message);
    const id = node.getAttribute("data-node-id"), box = document.createElement(id ? "div" : "span");
    box.className = "pa-pdf-placeholder";
    box.style.cssText = "display:block;box-sizing:border-box;max-width:100%;min-width:0;padding:8px;margin:6px 0;border:1px dashed #888;overflow-wrap:anywhere;white-space:normal;font-size:12px";
    if (id) { box.dataset.nodeId = id; box.dataset.type = "NodeParagraph"; }
    box.textContent = message;
    if (text && text.length <= 100000) {
        const pre = document.createElement("pre"); pre.textContent = text;
        pre.style.cssText = "white-space:pre-wrap;overflow-wrap:anywhere;max-width:100%;margin:6px 0 0"; box.append(pre);
    }
    node.replaceWith(box);
}
export function sanitizePdf(root: DocumentFragment, state: PdfCompatibility) {
    const unsafe = "script,style,link,base,meta,iframe,object,embed,audio,video,canvas,animate,animateMotion,animateTransform,set,[data-type='NodeAttributeView'],[data-type='NodeWidget'],[data-type='NodeBlockQueryEmbed']";
    for (const node of [...root.querySelectorAll(unsafe)]) {
        if (!root.contains(node) || state.staticEmbeds.has(node)) continue;
        if (!state.enabled) throw new Error("This document contains an unresolved database/media/embed. Full PDF export was stopped instead of omitting it");
        const kind = node.getAttribute("data-type") || node.tagName.toLowerCase();
        placeholder(node, state, state.text("exportUnsupported", "Unsupported {kind}: compatible placeholder", {kind}));
    }
    for (const el of root.querySelectorAll<HTMLElement>("*")) {
        for (const attr of [...el.attributes]) {
            if (/^on/i.test(attr.name) || attr.name === "autofocus") el.removeAttribute(attr.name);
            if (["src", "data-src", "href", "xlink:href"].includes(attr.name) && /^\s*(javascript|vbscript):/i.test(attr.value)) {
                if (!state.enabled) throw new Error("Unsafe resource in export HTML");
                el.removeAttribute(attr.name);
                state.warn(state.text("exportUnsafeResource", "An unsafe resource reference was removed"));
                markChanged(el, state);
            }
        }
        if (el.hasAttribute("contenteditable")) el.contentEditable = "false";
        if (el.hasAttribute("draggable")) el.draggable = false;
    }
}
function parsed(html: string): DocumentFragment { const t = document.createElement("template"); t.innerHTML = html; return t.content; }
function usefulChildren(parent: ParentNode): Node[] {
    return [...parent.childNodes].filter(n => n.nodeType === Node.ELEMENT_NODE || (n.nodeType === Node.TEXT_NODE && !!n.nodeValue?.trim()));
}
function signature(node: Node): string {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_ALL), tokens: unknown[] = [];
    const add = (n: Node) => {
        const attrs = n instanceof Element ? [...n.attributes].filter(a => !["id", "data-node-id", "updated", "data-node-index"].includes(a.name))
            .map(a => [a.name, a.value]).sort((a, b) => a[0] < b[0] ? -1 : 1) : [];
        tokens.push([n.nodeType, n.nodeName, n.nodeValue, n.childNodes.length, attrs]);
    };
    add(node);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) { if (tokens.length > 50000) throw new Error("Embed result is too large to match safely"); add(n); }
    return fingerprint(tokens);
}

/** Verify a focused native preview against a bounded region of the full preview.
 * SiYuan regenerates result IDs, so comparison ignores only generated identity attrs.
 * Markers do not change the native result DOM or duplicate its content. */
export async function mapStaticEmbeds(source: DocumentFragment, html: DocumentFragment, live: HTMLElement, docId: string,
    request: (path: string, body: unknown, signal?: AbortSignal) => Promise<any>, signal: AbortSignal, state: PdfCompatibility) {
    const embeds = [...source.querySelectorAll<HTMLElement>('[data-type="NodeBlockQueryEmbed"]')];
    if (!embeds.length) return;
    state.changed = true;
    // Current results cannot prove where an older block-ID-only anchor was drawn.
    // Until anchors carry historical embed-instance identity, keep all such ink
    // separate in documents containing SQL embeds (even when results are loaded).
    state.uncertainEmbedScope = true;
    const cache = new WeakMap<Node, string>();
    const key = (node: Node) => { let value = cache.get(node); if (!value) { value = signature(node); cache.set(node, value); } return value; };
    for (let index = 0; index < embeds.length; index++) {
        const embed = embeds[index], id = embed.dataset.nodeId!;
        markChanged(embed, state);
        const liveEmbeds = live.querySelectorAll(`[data-node-id="${CSS.escape(id)}"]`);
        for (const el of liveEmbeds) {
            for (const child of el.querySelectorAll<HTMLElement>("[data-node-id]")) state.degraded.add(child.dataset.nodeId!);
        }
        try {
            if (index >= 32) throw new Error("Embed verification request limit reached");
            if (/^\s*\/\/!js/.test(embed.dataset.content ?? "")) throw new Error("JavaScript embeds are not executed by PDF export");
            const result = await request("/api/export/exportPreviewHTML", {id, image: true, keepFold: false, merge: false, addTitle: false, keepJSEmbed: false}, signal);
            if (result?.id !== id || result.type !== "NodeBlockQueryEmbed" || typeof result.content !== "string") throw new Error("Invalid embed preview");
            const candidate = parsed(result.content);
            candidate.querySelector(`[data-node-id="${CSS.escape(docId)}"][data-type="NodeHeading"]`)?.remove();
            candidate.querySelectorAll('a[href^="pdf-outline://"]').forEach(n => n.remove());
            const pieces = usefulChildren(candidate);
            if (!pieces.length || candidate.querySelector('[data-type="NodeBlockQueryEmbed"]')) throw new Error("No complete static embed result");
            const parentId = embed.parentElement?.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId;
            const parents = parentId ? html.querySelectorAll(`[data-node-id="${CSS.escape(parentId)}"]`) : null;
            if (parents && parents.length !== 1) throw new Error("Ambiguous embed parent");
            const parent: ParentNode & Node = parents ? parents[0] : html;
            const nodes = usefulChildren(parent);
            if (nodes.length > 5000) throw new Error("Embed result region is too large");
            let left = 0, right = nodes.length;
            for (let n = embed.previousElementSibling; n; n = n.previousElementSibling) {
                const previous = n.getAttribute("data-node-id"); if (!previous) continue;
                const matches = nodes.map((node, i) => node instanceof Element && (node.getAttribute("data-pdf-embed-end") === previous || node.getAttribute("data-node-id") === previous) ? i : -1).filter(i => i >= 0);
                if (matches.length) { left = Math.max(...matches) + 1; break; }
            }
            for (let n = embed.nextElementSibling; n; n = n.nextElementSibling) {
                const next = n.getAttribute("data-node-id"); if (!next) continue;
                const matches = nodes.map((node, i) => node instanceof Element && node.getAttribute("data-node-id") === next ? i : -1).filter(i => i >= 0);
                if (matches.length === 1) { right = matches[0]; break; }
            }
            const candidates: number[] = [];
            const expected = pieces.map(signature);
            for (let i = left; i + pieces.length <= right; i++) if (expected.every((s, j) => key(nodes[i+j]) === s)) candidates.push(i);
            if (candidates.length !== 1) throw new Error("Static embed result does not have a unique matching range");
            const at = candidates[0];
            const start = document.createElement("span"), end = document.createElement("span");
            start.dataset.nodeId = id; start.dataset.type = "NodeParagraph"; start.style.display = "none";
            end.dataset.pdfEmbedEnd = id; end.style.display = "none";
            parent.insertBefore(start, nodes[at]); parent.insertBefore(end, nodes[at + pieces.length - 1].nextSibling);
            for (const node of nodes.slice(at, at + pieces.length)) if (node instanceof Element) markChanged(node, state);
            state.warn(state.text("exportStaticEmbed", "SQL embed {id} is a static native export; query/export limits may apply", {id}));
        } catch (error) {
            if (signal.aborted || (error as Error)?.name === "AbortError") throw error;
            if (!state.enabled) throw new Error(`SQL embed could not be verified: ${id}`);
            state.warn(state.text("exportUnverifiedEmbed", "SQL embed {id}: native static output was retained, but its exact mapping/results could not be verified (empty, filtered or limited results are possible)", {id}));
        }
    }
}

export function appendCompatibilityReport(body: HTMLElement, orphans: Stroke[], state: PdfCompatibility, background: string) {
    if (orphans.length) state.warn(state.text("exportUnplacedInk", "{count} strokes could not be safely attached to the exported content; thumbnail copies follow", {count: String(orphans.length)}));
    if (!state.warnings.length && !orphans.length) return;
    const report = document.createElement("section"); report.className = "pa-pdf-compatibility";
    report.style.cssText = "margin-top:24px;border-top:1px solid #888;padding:12px 0;white-space:normal;overflow-wrap:anywhere";
    const heading = document.createElement("h2"); heading.textContent = state.text("exportCompatibilityTitle", "PDF compatibility notes"); report.append(heading);
    const list = document.createElement("ul"); for (const warning of state.warnings) { const li = document.createElement("li"); li.textContent = warning; list.append(li); } report.append(list);
    const groups = new Map<string, Stroke[]>();
    for (const stroke of orphans) { const id = stroke.anchor?.blockId ?? "document"; const values = groups.get(id) ?? []; values.push(stroke); groups.set(id, values); }
    let groupCount = 0, pointBudget = 50000;
    const style = getComputedStyle(body), available = Math.max(1, body.clientWidth - parseFloat(style.paddingLeft || "0") - parseFloat(style.paddingRight || "0"));
    for (const [id, strokes] of groups) {
        if (groupCount >= 40) {
            const rest = document.createElement("p");
            rest.textContent = `${groups.size - groupCount} — ${state.text("exportPreviewLimited", "Preview limit reached; use the JSON backup for full data")}`;
            report.append(rest); break;
        }
        groupCount++;
        const label = document.createElement("p"); label.textContent = `${state.text("exportInkAppendix", "Unplaced ink preview — not its document position")} (${id}, ${strokes.length})`; report.append(label);
        // ponytail: bounded SVG thumbnails, not another full-resolution ink export.
        // Original data stays in the note/JSON backup; avoid one canvas per orphan.
        if (pointBudget <= 0) { label.append(` — ${state.text("exportPreviewLimited", "Preview limit reached; use the JSON backup for full data")}`); continue; }
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const s of strokes) for (const p of s.points) { minX = Math.min(minX, p.x - s.width); minY = Math.min(minY, p.y - s.width); maxX = Math.max(maxX, p.x + s.width); maxY = Math.max(maxY, p.y + s.width); }
        if (![minX,minY,maxX,maxY].every(Number.isFinite)) continue;
        const width = Math.max(1, maxX-minX), height = Math.max(1, maxY-minY), scale = Math.min(available/width, 240/height, 1);
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", `${minX} ${minY} ${width} ${height}`); svg.setAttribute("width", String(width*scale)); svg.setAttribute("height", String(height*scale));
        svg.style.cssText = `display:block;max-width:100%;background:${background}`;
        let drawn = 0;
        for (const stroke of strokes) {
            if (pointBudget <= 0) break;
            const step = Math.max(1, Math.ceil(stroke.points.length / Math.min(1000, pointBudget)));
            const samples = stroke.points.filter((_, i) => i % step === 0); const last = stroke.points[stroke.points.length-1];
            if (samples[samples.length-1] !== last) samples.push(last); pointBudget -= samples.length;
            if (samples.length === 1) {
                const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
                dot.setAttribute("cx", String(samples[0].x)); dot.setAttribute("cy", String(samples[0].y));
                dot.setAttribute("r", String(stroke.width / 2)); dot.setAttribute("fill", stroke.color); dot.setAttribute("fill-opacity", String(stroke.opacity));
                svg.append(dot); drawn++; continue;
            }
            const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
            line.setAttribute("points", samples.map(p => `${p.x},${p.y}`).join(" ")); line.setAttribute("fill", "none");
            line.setAttribute("stroke", stroke.color); line.setAttribute("stroke-width", String(stroke.width)); line.setAttribute("stroke-opacity", String(stroke.opacity));
            line.setAttribute("stroke-linecap", "round"); line.setAttribute("stroke-linejoin", "round"); svg.append(line); drawn++;
        }
        if (drawn < strokes.length) label.append(` — ${state.text("exportPreviewLimited", "Preview limit reached; use the JSON backup for full data")}`);
        report.append(svg);
    }
    body.append(report);
    return report;
}
