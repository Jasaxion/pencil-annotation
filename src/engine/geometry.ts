import type {Stroke} from "./types";

export interface BBox {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

export const strokeBBox = (stroke: Stroke): BBox => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of stroke.points) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
    }
    const pad = stroke.width / 2 + 2;
    return {minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad};
};

export const bboxesIntersect = (a: BBox, b: BBox): boolean =>
    a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;

export const unionBBox = (boxes: BBox[]): BBox | null => {
    if (boxes.length === 0) return null;
    return {
        minX: Math.min(...boxes.map((b) => b.minX)),
        minY: Math.min(...boxes.map((b) => b.minY)),
        maxX: Math.max(...boxes.map((b) => b.maxX)),
        maxY: Math.max(...boxes.map((b) => b.maxY)),
    };
};

/** squared distance from point p to segment a-b */
const distSqToSegment = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
    const abx = bx - ax, aby = by - ay;
    const lenSq = abx * abx + aby * aby;
    let t = lenSq > 0 ? ((px - ax) * abx + (py - ay) * aby) / lenSq : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = ax + abx * t - px, dy = ay + aby * t - py;
    return dx * dx + dy * dy;
};

/** Segment sweep fix adapted from upstream 6056a57 (MIT). */
const distSqSegToSeg = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): number => {
    const d1 = (dx-cx)*(ay-cy)-(dy-cy)*(ax-cx), d2 = (dx-cx)*(by-cy)-(dy-cy)*(bx-cx);
    const d3 = (bx-ax)*(cy-ay)-(by-ay)*(cx-ax), d4 = (bx-ax)*(dy-ay)-(by-ay)*(dx-ax);
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
    return Math.min(distSqToSegment(ax,ay,cx,cy,dx,dy), distSqToSegment(bx,by,cx,cy,dx,dy),
        distSqToSegment(cx,cy,ax,ay,bx,by), distSqToSegment(dx,dy,ax,ay,bx,by));
};

/** True when the eraser sweep is within threshold of any stroke segment,
 * including sparse lines, crossings and single-point dots. */
export const segmentHitsStroke = (
    stroke: Stroke,
    x1: number, y1: number, x2: number, y2: number,
    threshold: number, bounds?: BBox,
): boolean => {
    const bbox = bounds ?? strokeBBox(stroke);
    const hitBox: BBox = {
        minX: Math.min(x1, x2) - threshold,
        minY: Math.min(y1, y2) - threshold,
        maxX: Math.max(x1, x2) + threshold,
        maxY: Math.max(y1, y2) + threshold,
    };
    if (!bboxesIntersect(bbox, hitBox)) return false;

    const pts = stroke.points, thrSq = threshold * threshold;
    if (pts.length === 1) return distSqToSegment(pts[0].x, pts[0].y, x1, y1, x2, y2) <= thrSq;
    for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        // Reject distant segments cheaply before the exact distance calculation.
        if (Math.max(a.x, b.x) < hitBox.minX || Math.min(a.x, b.x) > hitBox.maxX ||
            Math.max(a.y, b.y) < hitBox.minY || Math.min(a.y, b.y) > hitBox.maxY) continue;
        if (distSqSegToSeg(a.x, a.y, b.x, b.y, x1, y1, x2, y2) <= thrSq) return true;
    }
    return false;
};

export const pointHitsStroke = (stroke: Stroke, x: number, y: number, threshold: number, bounds?: BBox): boolean =>
    segmentHitsStroke(stroke, x, y, x, y, threshold, bounds);

export const translateStroke = (stroke: Stroke, dx: number, dy: number) => {
    for (const p of stroke.points) {
        p.x = Math.round((p.x + dx) * 100) / 100;
        p.y = Math.round((p.y + dy) * 100) / 100;
    }
};

export const newId = (): string =>
    Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
