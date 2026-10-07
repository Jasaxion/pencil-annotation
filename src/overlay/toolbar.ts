import type {ToolId} from "../engine/types";
import type {OverlayConfig, OverlaySettings} from "./overlay";
import {ICONS} from "./icons";

export const PEN_COLORS = ["#1e1e1e", "#e03131", "#2f6fed", "#2f9e44", "#f76707", "#9c36b5"];
export const HL_COLORS = ["#ffd400", "#ff922b", "#69db7c", "#4dabf7", "#f783ac"];

/** slider ranges for stroke width / eraser size — pen max is settings-driven */
export const WIDTH_RANGE = {
    pen: {min: 1, max: 20, step: 1}, // max overridden by settings.penWidthMax
    highlighter: {min: 10, max: 60, step: 5},
    eraser: {min: 10, max: 50, step: 5},
} as const;

const snapToRange = (v: number, r: { min: number; max: number; step: number }) =>
    Math.min(r.max, Math.max(r.min, Math.round((v - r.min) / r.step) * r.step + r.min));

export type PaletteAction =
    | "undo" | "redo" | "clear" | "export" | "drawings" | "collapse" | "settings"
    | "deleteSel" | "dupSel" | "doneSel";

export interface PaletteState {
    mode: boolean;
    canUndo: boolean;
    canRedo: boolean;
    hasSelection: boolean;
    warning: string;
}

export type ToolbarLayout = "auto" | "horizontal" | "vertical";
export interface PaletteDeps {
    /** Host mobile frontend, including wide tablet/desktop mobile mode. */
    mobile?: boolean;
    i18n: (key: string, vars?: Record<string, string>) => string;
    config: OverlayConfig;
    settings: OverlaySettings;
    onSelectTool: (tool: ToolId) => void;
    onColor: (color: string) => void;
    onWidth: (width: number) => void;
    onAction: (action: PaletteAction) => void;
    /** tapping the floating handle toggles drawing mode */
    onHandleActivate: () => void;
}

const POS_KEY = "pencil-annotation.toolbar-pos";
const DOCK_KEY = "pencil-annotation.toolbar-dock";
const HANDLE_POS_KEY = "pencil-annotation.handle-pos";
const LAYOUT_KEY = "pencil-annotation.toolbar-layout";
interface VisibleBounds {left: number; top: number; right: number; bottom: number; width: number; height: number}

type Dock = "free" | "top" | "bottom" | "left" | "right";
const DOCK_SNAP = 34;   // px from an edge that triggers docking

const loadDock = (): Dock => {
    try {
        const v = localStorage.getItem(DOCK_KEY);
        return v === "top" || v === "bottom" || v === "left" || v === "right" ? v : "free";
    } catch { return "free"; }
};
const loadLayout = (): ToolbarLayout => {
    try { const value = localStorage.getItem(LAYOUT_KEY); return value === "horizontal" || value === "vertical" ? value : "auto"; }
    catch { return "auto"; }
};

const saveDock = (dock: Dock) => {
    try {
        localStorage.setItem(DOCK_KEY, dock);
    } catch { /* ignore */ }
};

const loadPos = (key: string): { x: number; y: number } | null => {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const v = JSON.parse(raw);
        if (Number.isFinite(v?.x) && Number.isFinite(v?.y)) return v;
    } catch { /* ignore */ }
    return null;
};

const savePos = (key: string, pos: { x: number; y: number }) => {
    try {
        localStorage.setItem(key, JSON.stringify(pos));
    } catch { /* ignore */ }
};

export class Palette {
    readonly toolbar: HTMLDivElement;
    readonly handle: HTMLButtonElement;

    private readonly deps: PaletteDeps;
    private state: PaletteState = {mode: false, canUndo: false, canRedo: false, hasSelection: false, warning: ""};
    private suppressClick = false;
    private stopDrag: (() => void) | null = null;
    private showHandle = true;
    private dock: Dock = loadDock();
    private layout: ToolbarLayout = loadLayout();
    private content!: HTMLDivElement;
    private destroyed = false;
    private positionFrame: number | null = null;
    private sizeObserver: ResizeObserver | null = null;
    private visualViewport = window.visualViewport;

    constructor(deps: PaletteDeps) {
        this.deps = deps;

        this.toolbar = document.createElement("div");
        this.toolbar.className = "pa-toolbar";
        this.toolbar.dataset.preventSwipe = "";
        this.toolbar.style.display = "none";
        document.body.appendChild(this.toolbar);

        this.handle = document.createElement("button");
        this.handle.className = "pa-handle";
        this.handle.dataset.preventSwipe = "";
        this.handle.setAttribute("aria-label", deps.i18n("topbarTitle"));
        this.handle.innerHTML = ICONS.penStroke;
        this.handle.style.display = "none";
        document.body.appendChild(this.handle);

        this.restorePositions();
        this.bindDragging();
        this.handle.addEventListener("click", () => {
            if (!this.suppressClick) this.deps.onHandleActivate();
            this.suppressClick = false;
        });
        this.renderToolbar();
        window.addEventListener('resize', this.requestReposition);
        this.visualViewport?.addEventListener('resize', this.requestReposition);
        this.visualViewport?.addEventListener('scroll', this.requestReposition);
        this.sizeObserver = new ResizeObserver(this.requestReposition);
        this.sizeObserver.observe(this.toolbar);
        this.sizeObserver.observe(this.handle);
        this.sizeObserver.observe(this.content);
    }

    // -------------------------------------------------------------- layout

    private restorePositions() {
        this.applyDockClass();
        const pos = loadPos(POS_KEY);
        if (pos) this.place(this.toolbar, pos);
        else this.defaultToolbarPos();
        this.snapToDock();
        const hpos = loadPos(HANDLE_POS_KEY);
        if (hpos) this.place(this.handle, hpos);
        else this.defaultHandlePos();
    }

    private visibleBounds(): VisibleBounds {
        const vv = window.visualViewport;
        const width = Math.min(innerWidth, vv && vv.width > 0 ? vv.width : innerWidth);
        const height = Math.min(innerHeight, vv && vv.height > 0 ? vv.height : innerHeight);
        const x = Math.max(0, Math.min(vv?.offsetLeft ?? 0, innerWidth - width));
        const y = Math.max(0, Math.min(vv?.offsetTop ?? 0, innerHeight - height));
        const style = getComputedStyle(this.toolbar);
        const inset = (edge: string) => Math.max(0, parseFloat(style.getPropertyValue(`--pa-safe-${edge}`)) || 0);
        const left = x + 8 + inset('left'), top = y + 8 + inset('top');
        const right = Math.max(left + 1, x + width - 8 - inset('right'));
        const bottom = Math.max(top + 1, y + height - 8 - inset('bottom'));
        return {left, top, right, bottom, width: right - left, height: bottom - top};
    }

    private applyDockClass() {
        const bounds = this.visibleBounds();
        const compact = !!this.deps.mobile || bounds.width < 900;
        const vertical = this.layout === 'vertical' || (this.layout === 'auto' && !compact && (this.dock === 'left' || this.dock === 'right'));
        this.toolbar.classList.toggle('pa-toolbar--compact', compact);
        this.toolbar.classList.toggle('pa-toolbar--vertical', vertical);
        this.toolbar.style.setProperty('--pa-view-width', `${bounds.width}px`);
        this.toolbar.style.setProperty('--pa-view-height', `${bounds.height}px`);
        this.handle.style.maxWidth = `${bounds.width}px`;
        this.handle.style.maxHeight = `${bounds.height}px`;
    }

    getLayout(): ToolbarLayout { return this.layout; }
    setLayout(layout: ToolbarLayout) {
        const previous = this.toolbar.getBoundingClientRect();
        this.layout = layout === 'horizontal' || layout === 'vertical' ? layout : 'auto';
        try { localStorage.setItem(LAYOUT_KEY, this.layout); } catch { /* current session still works */ }
        this.repositionAfterLayout(previous);
    }

    private repositionAfterLayout(previous: DOMRect) {
        this.applyDockClass();
        if (previous.width && previous.height && this.toolbar.style.display !== 'none') {
            const b = this.visibleBounds();
            const x = Math.abs(previous.right - b.right) <= DOCK_SNAP ? b.right - this.toolbar.offsetWidth : previous.left;
            const y = Math.abs(previous.bottom - b.bottom) <= DOCK_SNAP ? b.bottom - this.toolbar.offsetHeight : previous.top;
            this.place(this.toolbar, {x, y});
        }
        this.repositionForViewport();
    }

    private requestReposition = () => {
        if (this.destroyed || this.positionFrame !== null) return;
        this.positionFrame = requestAnimationFrame(() => { this.positionFrame = null; this.repositionForViewport(); });
    };

    private defaultToolbarPos() {
        const b = this.visibleBounds();
        this.place(this.toolbar, {x: b.right, y: b.top + 8});
    }

    private defaultHandlePos() {
        const b = this.visibleBounds();
        this.place(this.handle, {x: b.right - 46, y: b.top + b.height * 0.3});
    }

    /** viewport is `fixed`-positioned: x/y are the top-left corner */
    private place(el: HTMLElement, pos: { x: number; y: number }) {
        const bounds = this.visibleBounds();
        const w = el.offsetWidth || (el === this.handle ? 46 : 60);
        const h = el.offsetHeight || 46;
        const x = Math.min(Math.max(bounds.left, pos.x), Math.max(bounds.left, bounds.right - w));
        const y = Math.min(Math.max(bounds.top, pos.y), Math.max(bounds.top, bounds.bottom - h));
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
        el.style.right = "auto";
        el.style.bottom = "auto";
    }

    /** clamps a docked toolbar flush against its edge, sliding along it */
    private snapToDock() {
        if (this.dock === "free") return;
        const el = this.toolbar;
        this.applyDockClass();
        const w = el.offsetWidth || 60;
        const h = el.offsetHeight || 46;
        const cur = {x: parseFloat(el.style.left || "0"), y: parseFloat(el.style.top || "0")};
        let x = cur.x, y = cur.y;
        const bounds = this.visibleBounds();
        if (this.dock === "left") x = bounds.left;
        else if (this.dock === "right") x = bounds.right - w;
        else if (this.dock === "top") y = bounds.top;
        else if (this.dock === "bottom") y = bounds.bottom - h;
        this.place(el, {x, y});
    }

    /** live edge-snapping while the toolbar is dragged (edges detected by pointer) */
    private applyDockDrag(x: number, y: number, px: number, py: number) {
        const el = this.toolbar;
        let dock: Dock = "free";
        const bounds = this.visibleBounds();
        if (px < bounds.left + DOCK_SNAP) dock = "left";
        else if (px > bounds.right - DOCK_SNAP) dock = "right";
        else if (py < bounds.top + DOCK_SNAP) dock = "top";
        else if (py > bounds.bottom - DOCK_SNAP) dock = "bottom";
        this.dock = dock;
        this.applyDockClass();
        const w2 = el.offsetWidth || 60;
        const h2 = el.offsetHeight || 46;
        let lx = x, ly = y;
        if (dock === "left") lx = bounds.left;
        else if (dock === "right") lx = bounds.right - w2;
        else if (dock === "top") ly = bounds.top;
        else if (dock === "bottom") ly = bounds.bottom - h2;
        this.place(el, {x: lx, y: ly});
    }

    private placeDefaultIfFloating() {
        if (!loadPos(POS_KEY)) this.defaultToolbarPos();
    }

    private bindDragging() {
        for (const [elRaw, key] of [[this.toolbar, POS_KEY], [this.handle, HANDLE_POS_KEY]] as const) {
            const el = elRaw as HTMLElement;
            el.addEventListener("pointerdown", (e: PointerEvent) => {
                if (this.stopDrag || e.button !== 0) return;
                const target = e.target as HTMLElement;
                if (el === this.toolbar && target.closest("button,input,select,.pa-width")) return;
                if (el === this.toolbar && this.content.scrollHeight > this.content.clientHeight + 1 && !target.closest('.pa-toolbar__grip')) return;
                e.preventDefault();
                e.stopPropagation();
                this.suppressClick = false;
                const pointerId = e.pointerId;
                try { el.setPointerCapture(pointerId); } catch { /* window listeners cover capture refusal */ }
                const rect = el.getBoundingClientRect();
                const offX = e.clientX - rect.left;
                const offY = e.clientY - rect.top;
                let moved = false;
                const startX = e.clientX;
                const startY = e.clientY;
                const move = (ev: PointerEvent) => {
                    if (ev.pointerId !== pointerId) return;
                    // sub-threshold drift (Apple Pencil taps jitter ~1-2px) is
                    // a tap, not a drag — otherwise the ball never activates
                    if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 8) return;
                    moved = true;
                    if (el === this.toolbar) {
                        this.applyDockDrag(ev.clientX - offX, ev.clientY - offY, ev.clientX, ev.clientY);
                    } else {
                        this.place(el, {x: ev.clientX - offX, y: ev.clientY - offY});
                    }
                };
                const cleanup = () => {
                    window.removeEventListener("pointermove", move);
                    window.removeEventListener("pointerup", up);
                    window.removeEventListener("pointercancel", cancel);
                    window.removeEventListener("blur", cleanup);
                    if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId);
                    this.stopDrag = null;
                };
                const cancel = (ev: PointerEvent) => {
                    if (ev.pointerId !== pointerId) return;
                    this.suppressClick = true;
                    cleanup();
                };
                const up = (ev: PointerEvent) => {
                    if (ev.pointerId !== pointerId) return;
                    cleanup();
                    if (moved) {
                        if (el === this.toolbar) {
                            savePos(key, {
                                x: parseFloat(el.style.left || "0"),
                                y: parseFloat(el.style.top || "0"),
                            });
                            saveDock(this.dock);
                            this.requestReposition();
                        } else {
                            savePos(key, {x: parseFloat(el.style.left || '0'), y: parseFloat(el.style.top || '0')});
                            this.suppressClick = true; // drag, not a tap
                        }
                    } else if (el === this.handle) {
                        // a plain tap on the handle toggles drawing mode
                        this.deps.onHandleActivate();
                        this.suppressClick = true;
                    }
                };
                this.stopDrag = cleanup;
                window.addEventListener("pointermove", move);
                window.addEventListener("pointerup", up);
                window.addEventListener("pointercancel", cancel);
                window.addEventListener("blur", cleanup);
            });
        }
    }

    // -------------------------------------------------------------- render

    private btn(icon: string, title: string, onClick: () => void, cls = ""): HTMLButtonElement {
        const b = document.createElement("button");
        b.className = `pa-btn ${cls}`.trim();
        b.innerHTML = icon;
        b.title = title;
        b.setAttribute("aria-label", title);
        b.addEventListener("click", (e) => {
            e.stopPropagation();
            onClick();
        });
        return b;
    }

    /** rheostat-style width slider; live value flows out through deps.onWidth */
    private widthSlider(
        kind: keyof typeof WIDTH_RANGE,
        value: number,
        dotColor: string,
    ): HTMLDivElement {
        let range: {min: number; max: number; step: number} = WIDTH_RANGE[kind];
        if (kind === "pen") {
            // cap is user-adjustable in settings
            const max = Math.max(range.min, Math.round(this.deps.settings.penWidthMax || 20));
            range = {min: range.min, max, step: range.step};
        }
        const wrap = document.createElement("div");
        wrap.className = "pa-width";

        const dot = document.createElement("i");
        dot.className = "pa-width__dot";
        dot.style.background = dotColor;
        const setDot = (v: number) => {
            const d = Math.round(6 + ((v - range.min) / (range.max - range.min)) * 14);
            dot.style.width = `${d}px`;
            dot.style.height = `${d}px`;
        };

        const sliderBox = document.createElement("div");
        sliderBox.className = "pa-width__slider";
        const input = document.createElement("input");
        input.type = "range";
        input.setAttribute('aria-label', this.deps.i18n('toolbarWidth'));
        input.min = String(range.min);
        input.max = String(range.max);
        input.step = String(range.step);
        input.value = String(snapToRange(value, range));
        sliderBox.appendChild(input);

        const val = document.createElement("span");
        val.className = "pa-width__val";
        val.textContent = input.value;
        const syncTitle = () => {
            wrap.title = `${input.value}px`;
        };
        syncTitle();
        setDot(Number(input.value));

        input.addEventListener("input", () => {
            const v = Number(input.value);
            setDot(v);
            val.textContent = input.value;
            syncTitle();
            this.deps.onWidth(v);
        });
        // dragging the thumb must not drag the toolbar itself
        input.addEventListener("pointerdown", (e) => e.stopPropagation());

        wrap.append(dot, sliderBox, val);
        return wrap;
    }

    private renderToolbar() {
        const previous = this.toolbar.getBoundingClientRect();
        const t = this.deps.i18n;
        const cfg = this.deps.config;
        const tool = cfg.tool;

        this.sizeObserver?.unobserve(this.content);
        this.toolbar.replaceChildren();
        const grip = document.createElement('div'); grip.className = 'pa-toolbar__grip';
        grip.title = t('toolbarDrag'); grip.setAttribute('aria-label', t('toolbarDrag'));
        grip.innerHTML = '<svg viewBox="0 0 12 24" width="12" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h.01M8 6h.01M4 12h.01M8 12h.01M4 18h.01M8 18h.01"/></svg>';
        this.content = document.createElement('div'); this.content.className = 'pa-toolbar__content';
        this.toolbar.append(grip, this.content);
        if (this.state.warning) {
            const warning = this.btn("", this.state.warning, () => this.deps.onAction("export"), "pa-sync-warning");
            warning.textContent = t("syncPaused");
            this.content.append(warning);
        }

        // tool buttons
        const toolsGroup = document.createElement("div");
        toolsGroup.className = "pa-toolbar__group";
        const toolDefs: Array<[ToolId, string, string]> = [
            ["pen", ICONS.penStroke, t("toolPen")],
            ["highlighter", ICONS.highlighter, t("toolHighlighter")],
            ["eraser", ICONS.eraser, t("toolEraser")],
            ["select", ICONS.select, t("toolSelect")],
        ];
        for (const [id, icon, label] of toolDefs) {
            const b = this.btn(icon, label, () => this.deps.onSelectTool(id),
                tool === id ? "pa-btn--active" : "");
            toolsGroup.appendChild(b);
        }
        this.content.appendChild(toolsGroup);

        this.content.appendChild(this.sep());

        // contextual options
        const options = document.createElement("div");
        options.className = "pa-toolbar__options";
        if (tool === "pen" || tool === "highlighter") {
            const colors = tool === "pen" ? PEN_COLORS : HL_COLORS;
            const activeColor = tool === "pen" ? cfg.penColor : cfg.hlColor;
            const swatches = document.createElement('div'); swatches.className = 'pa-toolbar__colors';
            for (const c of colors) {
                const sw = document.createElement("button");
                sw.className = `pa-swatch ${c.toLowerCase() === activeColor.toLowerCase() ? "pa-swatch--active" : ""}`;
                sw.style.background = c;
                sw.title = c; sw.setAttribute('aria-label', c);
                sw.addEventListener("click", (e) => {
                    e.stopPropagation();
                    this.deps.onColor(c);
                });
                swatches.appendChild(sw);
            }
            options.appendChild(swatches);
            const activeWidth = tool === "pen" ? cfg.penWidth : cfg.hlWidth;
            options.appendChild(this.widthSlider(tool, activeWidth, activeColor));
        } else if (tool === "eraser") {
            options.appendChild(this.widthSlider(
                "eraser", this.deps.settings.eraserRadius, "rgba(255,255,255,.9)"));
        } else if (tool === "select") {
            const hint = document.createElement("span");
            hint.className = 'pa-toolbar__hint';
            hint.style.cssText = "font-size:12px;color:rgba(255,255,255,.65);";
            hint.textContent = this.state.hasSelection
                ? t("strokeDelete")
                : t("toolSelect");
            options.appendChild(hint);
        }
        this.content.appendChild(options);

        // selection actions
        if (this.state.hasSelection) {
            this.content.appendChild(this.sep());
            const selGroup = document.createElement("div");
            selGroup.className = "pa-toolbar__selection";
            selGroup.appendChild(this.btn(ICONS.duplicate, this.deps.i18n("strokeDuplicate"), () => this.deps.onAction("dupSel")));
            selGroup.appendChild(this.btn(ICONS.trash, this.deps.i18n("strokeDelete"), () => this.deps.onAction("deleteSel")));
            selGroup.appendChild(this.btn(ICONS.check, this.deps.i18n("strokeDeselect"), () => this.deps.onAction("doneSel")));
            this.content.appendChild(selGroup);
        }

        this.content.appendChild(this.sep());

        // global actions
        const actionsGroup = document.createElement("div");
        actionsGroup.className = "pa-toolbar__group";
        const undoBtn = this.btn(ICONS.undo, this.deps.i18n("undo"), () => this.deps.onAction("undo"));
        (undoBtn as HTMLButtonElement & { disabled: boolean }).disabled = !this.state.canUndo;
        const redoBtn = this.btn(ICONS.redo, this.deps.i18n("redo"), () => this.deps.onAction("redo"));
        (redoBtn as HTMLButtonElement & { disabled: boolean }).disabled = !this.state.canRedo;
        actionsGroup.append(
            undoBtn,
            redoBtn,
            this.btn(ICONS.list, this.deps.i18n("drawingList"), () => this.deps.onAction("drawings")),
            this.btn(ICONS.export, this.deps.i18n("exportImage"), () => this.deps.onAction("export")),
            this.btn(ICONS.trash, this.deps.i18n("clearAll"), () => this.deps.onAction("clear")),
        );
        this.content.appendChild(actionsGroup);

        this.content.appendChild(this.sep());
        this.content.appendChild(
            this.btn(ICONS.gear, this.deps.i18n("settings"), () => this.deps.onAction("settings")),
        );
        this.content.appendChild(
            this.btn(ICONS.collapse, this.deps.i18n("collapse"), () => this.deps.onAction("collapse")),
        );

        this.sizeObserver?.observe(this.content);
        this.repositionAfterLayout(previous);
    }

    private sep(): HTMLDivElement {
        const s = document.createElement("div");
        s.className = "pa-toolbar__sep";
        return s;
    }

    // --------------------------------------------------------------- state

    setMode(on: boolean) {
        this.state.mode = on;
        this.toolbar.style.display = on ? "" : "none";
        this.handle.style.display = on || !this.showHandle ? "none" : "";
        this.handle.classList.toggle("pa-handle--on", on);
        if (on && this.dock === "free") this.placeDefaultIfFloating();
        // Hidden controls have no measurable size. Clamp again after display is
        // restored, including when a saved floating position already exists.
        this.repositionForViewport();
    }

    setHandleVisible(visible: boolean) {
        this.showHandle = visible;
        this.handle.style.display = this.state.mode || !visible ? "none" : "";
        this.repositionForViewport();
    }

    update(state: Partial<PaletteState>) {
        const prev = this.state;
        this.state = {...prev, ...state};
        const structural =
            prev.canUndo !== this.state.canUndo ||
            prev.canRedo !== this.state.canRedo ||
            prev.hasSelection !== this.state.hasSelection || prev.warning !== this.state.warning;
        if (structural) this.renderToolbar();
        this.handle.classList.toggle("pa-handle--on", this.state.mode);
    }

    /** force a full re-render (tool/color/width changes) */
    refresh() {
        this.renderToolbar();
    }

    destroy() {
        this.destroyed = true;
        this.stopDrag?.();
        if (this.positionFrame !== null) cancelAnimationFrame(this.positionFrame);
        this.positionFrame = null;
        this.sizeObserver?.disconnect();
        window.removeEventListener('resize', this.requestReposition);
        this.visualViewport?.removeEventListener('resize', this.requestReposition);
        this.visualViewport?.removeEventListener('scroll', this.requestReposition);
        this.toolbar.remove();
        this.handle.remove();
    }

    repositionForViewport() {
        if (this.destroyed) return;
        this.applyDockClass();
        if (this.toolbar.style.display !== 'none') {
            this.place(this.toolbar, {x: parseFloat(this.toolbar.style.left || '0'), y: parseFloat(this.toolbar.style.top || '0')});
            this.snapToDock();
            this.toolbar.classList.toggle('pa-toolbar--scrollable', this.content.scrollHeight > this.content.clientHeight + 1);
        }
        if (this.handle.style.display !== 'none') this.place(this.handle, {x: parseFloat(this.handle.style.left || '0'), y: parseFloat(this.handle.style.top || '0')});
    }
}
