import type {Stroke} from "../engine/types";
import {fingerprint} from '../engine/sync';
import {markChanged, placeholder, type PdfCompatibility} from "./pdfCompatibility";

export const INK_TARGET = "data-pa-pdf-anchor";
const QUERY = '[data-type="NodeBlockQueryEmbed"]';
interface Hint {key: string; scope: string | null; width: number; height: number; text: string | null}
function contentFingerprint(element: Element): string | null {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const parts: string[] = []; let length = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.parentElement?.closest('.protyle-icons,.protyle-attr,.sb__resize-tip,.katex-mathml,.pa-overlay,.pa-toolbar,.pa-handle')) continue;
        const value = node.nodeValue ?? ''; length += value.length;
        if (length > 200000) return null;
        parts.push(value);
    }
    const images = [...element.querySelectorAll('img')].map(image => {
        const src = image.getAttribute('data-src') || image.getAttribute('src') || '';
        try { return new URL(/^assets\//.test(src) ? `/${src}` : src, location.href).href; } catch { return src; }
    });
    return fingerprint([parts.join('').replace(/\u200b/g, '').replace(/\s+/g, ' ').trim(), images]);
}
export interface CurrentLayout {live: HTMLElement; hints: Map<string, Hint | null>}

/** Snapshot the same first DOM occurrence used by DocOverlay.buildOffsets.
 * This is current-display identity, not a reconstruction of historical authorship. */
export function captureCurrentLayout(source: HTMLElement, strokes: Stroke[]): CurrentLayout {
    const live = source.cloneNode(true) as HTMLElement;
    live.querySelectorAll(`[${INK_TARGET}]`).forEach(el => el.removeAttribute(INK_TARGET));
    const ids = new Set(strokes.flatMap(s => s.anchor ? [s.anchor.blockId] : []));
    const originals = [...source.querySelectorAll<HTMLElement>('[data-node-id]')];
    const copies = [...live.querySelectorAll<HTMLElement>('[data-node-id]')];
    if (originals.length > 50000) throw new Error('The live layout exceeds the export verification limit');
    const hints = new Map<string, Hint | null>();
    originals.forEach((element, index) => {
        const id = element.dataset.nodeId!;
        if (!ids.has(id) || hints.has(id)) return;
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) { hints.set(id, null); return; }
        const hint = {key: `ink-${index}`, scope: element.closest<HTMLElement>(QUERY)?.dataset.nodeId ?? null, width: rect.width, height: rect.height, text: contentFingerprint(element)};
        copies[index].setAttribute(INK_TARGET, hint.key); hints.set(id, hint);
    });
    return {live, hints};
}

export async function prepareCurrentLayout(html: DocumentFragment, snapshot: CurrentLayout, docId: string,
    request: (path: string, body: unknown, signal?: AbortSignal) => Promise<any>, signal: AbortSignal, state: PdfCompatibility) {
    html.querySelectorAll(`[${INK_TARGET}]`).forEach(el => el.removeAttribute(INK_TARGET));
    // Keep the complete kernel source structure, including superblock columns.
    for (const element of html.querySelectorAll('[fold="1"]')) {
        markChanged(element, state); element.removeAttribute('fold');
    }
    const embeds = [...html.querySelectorAll<HTMLElement>(QUERY)];
    if (embeds.length) state.warn(state.text('exportCurrentInk', 'Ink uses its current displayed document/embedded occurrence, not an inferred historical position. Please check the exported layout.'));
    let requests = 0;
    for (let index = 0; index < embeds.length; index++) {
        const original = embeds[index];
        if (!html.contains(original)) continue;
        const id = original.dataset.nodeId;
        try {
            if (!id || /^\s*\/\/!js/.test(original.dataset.content ?? '')) throw new Error('JavaScript or unidentified embed');
            const candidates = snapshot.live.querySelectorAll<HTMLElement>(`[data-node-id="${CSS.escape(id)}"]`);
            const live = candidates.length === 1 ? candidates[0] : null;
            if (live && live.dataset.content === original.dataset.content && live.querySelector('[data-node-id]')) {
                const copy = live.cloneNode(true) as HTMLElement;
                copy.querySelectorAll('.protyle-icons,.protyle-attr,.pa-overlay,.pa-toolbar,.pa-handle').forEach(el => el.remove());
                original.replaceWith(copy);
                for (const query of [copy, ...copy.querySelectorAll<HTMLElement>(QUERY)]) {
                    if (!/^\s*\/\/!js/.test(query.dataset.content ?? '') && query.querySelector('[data-node-id]')) state.staticEmbeds.add(query);
                }
                state.warn(state.text('exportCurrentEmbed', 'Embed {id}: current displayed static results were preserved', {id}));
            } else {
                if (requests++ >= 32) throw new Error('Embed verification limit reached');
                const result = await request('/api/export/exportPreviewHTML', {id, image: true, keepFold: false, merge: false, addTitle: false, keepJSEmbed: false}, signal);
                if (result?.id !== id || result.type !== 'NodeBlockQueryEmbed' || typeof result.content !== 'string' || result.content.length > 16 * 1024 * 1024) throw new Error('Invalid focused embed response');
                const template = document.createElement('template'); template.innerHTML = result.content;
                template.content.querySelectorAll(`[${INK_TARGET}]`).forEach(el => el.removeAttribute(INK_TARGET));
                template.content.querySelector(`[data-node-id="${CSS.escape(docId)}"][data-type="NodeHeading"]`)?.remove();
                template.content.querySelectorAll('a[href^="pdf-outline://"]').forEach(el => el.remove());
                if (!template.content.textContent?.trim() && !template.content.querySelector('img,svg')) throw new Error('Empty/unverified embed result');
                markChanged(original, state);
                original.replaceChildren(template.content); state.staticEmbeds.add(original);
                // Regenerated IDs cannot identify ink that belonged inside an unloaded embed.
                original.querySelectorAll<HTMLElement>('[data-node-id]').forEach(el => state.degraded.add(el.dataset.nodeId!));
                state.warn(state.text('exportUnloadedEmbed', 'Embed {id} was not loaded in the editor; native static results were used and ink on this converted region may be separate', {id}));
            }
        } catch (error) {
            if (signal.aborted || (error as Error)?.name === 'AbortError') throw error;
            if (!state.enabled) throw new Error(`Cannot prepare embedded content: ${id ?? 'unknown'}`);
            placeholder(original, state, state.text('exportUnverifiedEmbed', 'Embed {id} could not be verified; its content is represented by this placeholder', {id: id ?? 'unknown'}));
        }
    }
    for (const [id, hint] of snapshot.hints) {
        if (!hint || hint.scope) continue;
        const matches = [...html.querySelectorAll<HTMLElement>(`[data-node-id="${CSS.escape(id)}"]`)].filter(el => !el.closest(QUERY));
        if (matches.length === 1) matches[0].setAttribute(INK_TARGET, hint.key);
    }
}

export function currentInkTarget(body: HTMLElement, id: string, snapshot: CurrentLayout): HTMLElement | null {
    if (snapshot.hints.has(id)) {
        const hint = snapshot.hints.get(id);
        if (!hint) return null;
        const matches = body.querySelectorAll<HTMLElement>(`[${INK_TARGET}="${hint.key}"]`);
        if (matches.length !== 1 || matches[0].dataset.nodeId !== id) return null;
        const rect = matches[0].getBoundingClientRect();
        if (Math.abs(rect.width - hint.width) > 2 || Math.abs(rect.height - hint.height) > 2 || hint.text === null || contentFingerprint(matches[0]) !== hint.text) return null;
        return matches[0];
    }
    // An unmounted ordinary source block can still have a unique full-document
    // occurrence. Ambiguous duplicates get their own fallback, never a global one.
    const matches = body.querySelectorAll<HTMLElement>(`[data-node-id="${CSS.escape(id)}"]`);
    return matches.length === 1 ? matches[0] : null;
}
