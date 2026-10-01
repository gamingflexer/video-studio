"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { curveTable, identityCurves } from "@/lib/color";
import type { CurveChannel, CurvePoint, Curves } from "@/lib/types";
import styles from "./CurveEditor.module.css";

export interface CurveEditorProps {
  curves: Curves;
  /** called continuously while dragging */
  onChange: (next: Curves) => void;
  /** called once when a drag / add / remove finishes (for undo history) */
  onCommit?: () => void;
  /** optional 256-bin histograms of the current frame, values are raw counts */
  histogram?: { r: Uint32Array; g: Uint32Array; b: Uint32Array; y: Uint32Array } | null;
}

const CHANNELS: { id: CurveChannel; label: string; title: string; color: string }[] = [
  { id: "master", label: "Master", title: "Master (all channels)", color: "#d8d6d2" },
  { id: "r", label: "R", title: "Red", color: "#ff5d5d" },
  { id: "g", label: "G", title: "Green", color: "#5fd38a" },
  { id: "b", label: "B", title: "Blue", color: "#5aa2ff" },
];
const COLOR: Record<CurveChannel, string> = { master: "#d8d6d2", r: "#ff5d5d", g: "#5fd38a", b: "#5aa2ff" };

/** inner margin so the handles on the edges of the 0..1 square are not clipped */
const PAD = 10;
/** minimum x distance between neighbouring points */
const GAP = 0.01;
/** handle radius (9px circle) and hit radius (16px hit area) */
const HANDLE_R = 4.5;
const HIT_R = 8;
/** dragging a point this far above / below the graph removes it */
const REMOVE_PX = 40;
/** pointer travel before a press becomes a drag */
const MOVE_PX = 3;
const DOUBLE_CLICK_MS = 350;
const GRID = [0, 0.25, 0.5, 0.75, 1];
const CURVE_SAMPLES = 512;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const round4 = (v: number) => Math.round(v * 1e4) / 1e4;

/** sorted copy with at least two points; never returns the caller's arrays */
function normalizePoints(points: CurvePoint[] | undefined): CurvePoint[] {
  if (!points || points.length < 2) return [[0, 0], [1, 1]];
  return points.map((p): CurvePoint => [p[0], p[1]]).sort((a, b) => a[0] - b[0]);
}

const isIdentity = (p: CurvePoint[] | undefined) =>
  !p || p.length < 2 || (p.length === 2 && p[0][0] === 0 && p[0][1] === 0 && p[1][0] === 1 && p[1][1] === 1);

/** allowed x range for the point at `index`, given its neighbours (0.01 gap; ends reach 0 / 1) */
function xBounds(points: CurvePoint[], index: number): [number, number] {
  const lo = index === 0 ? 0 : points[index - 1][0] + GAP;
  const hi = index === points.length - 1 ? 1 : points[index + 1][0] - GAP;
  // neighbours closer than two gaps (only possible with hand-written data): pin x
  return hi < lo ? [points[index][0], points[index][0]] : [lo, hi];
}

/** value of the real (renderer) curve at x */
function sampleCurve(points: CurvePoint[], x: number): number {
  const t = curveTable(points, 1024);
  const f = clamp(x, 0, 1) * (t.length - 1);
  const i = Math.min(Math.floor(f), t.length - 2);
  return t[i] + (t[i + 1] - t[i]) * (f - i);
}

/** bins scaled 0..1 against the 99th-percentile bin, so one spike does not flatten the rest */
function normalizeHistogram(bins: Uint32Array | undefined): number[] | null {
  if (!bins || bins.length < 2) return null;
  const sorted = Float64Array.from(bins).sort();
  let ref = sorted[Math.floor(0.99 * (sorted.length - 1))];
  if (!(ref > 0)) ref = sorted[sorted.length - 1];
  if (!(ref > 0)) return null;
  return Array.from(bins, (v) => Math.min(v / ref, 1));
}

interface Drag {
  pointerId: number;
  channel: CurveChannel;
  /** index of the dragged point in the full, sorted list */
  index: number;
  /** every other point of the channel, sorted */
  others: CurvePoint[];
  /** last emitted position of the dragged point */
  point: CurvePoint;
  lo: number;
  hi: number;
  /** end points can never be removed */
  removable: boolean;
  /** point minus pointer at grab time (0..1 units), so grabbing a handle off-centre does not jump */
  offX: number;
  offY: number;
  startX: number;
  startY: number;
  /** the pointer has travelled far enough to count as a drag */
  tracking: boolean;
  /** currently pulled out of the graph (the point is absent from the emitted curve) */
  removed: boolean;
  /** something was emitted, so the gesture needs a commit */
  changed: boolean;
}

interface Measure {
  /** pointer in svg pixels */
  px: number;
  py: number;
  /** pointer in curve coordinates (unclamped; y up) */
  x: number;
  y: number;
  /** plot size in pixels */
  pw: number;
  ph: number;
  /** svg height in pixels */
  height: number;
}

function measure(svg: SVGSVGElement, clientX: number, clientY: number): Measure {
  const rect = svg.getBoundingClientRect();
  const px = clientX - rect.left;
  const py = clientY - rect.top;
  const pw = Math.max(rect.width - 2 * PAD, 1);
  const ph = Math.max(rect.height - 2 * PAD, 1);
  return { px, py, x: (px - PAD) / pw, y: 1 - (py - PAD) / ph, pw, ph, height: rect.height };
}

export default function CurveEditor({ curves, onChange, onCommit, histogram }: CurveEditorProps) {
  const [channel, setChannel] = useState<CurveChannel>("master");
  const [selected, setSelected] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  const wrapRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const lastDownRef = useRef<{ channel: CurveChannel; index: number; time: number } | null>(null);
  const nudgedRef = useRef(false);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const apply = (w: number, h: number) =>
      setSize((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
    apply(el.clientWidth, el.clientHeight);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[entries.length - 1]?.contentRect;
      if (r) apply(r.width, r.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const points = useMemo(() => normalizePoints(curves[channel]), [curves, channel]);
  const sel = selected !== null && selected < points.length ? selected : null;
  const color = COLOR[channel];

  const emit = (ch: CurveChannel, next: CurvePoint[]) => onChange({ ...curves, [ch]: next });

  // ------------------------------------------------------------------ geometry / paths

  const pw = size ? Math.max(size.w - 2 * PAD, 1) : 0;
  const ph = size ? Math.max(size.h - 2 * PAD, 1) : 0;
  const X = (x: number) => PAD + x * pw;
  const Y = (y: number) => PAD + (1 - y) * ph;

  const curvePath = (pts: CurvePoint[], n: number) => {
    const t = curveTable(pts, n);
    let d = "";
    for (let i = 0; i < n; i++) d += `${i ? "L" : "M"}${X(i / (n - 1)).toFixed(2)} ${Y(t[i]).toFixed(2)}`;
    return d;
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const activePath = useMemo(() => (size ? curvePath(points, CURVE_SAMPLES) : ""), [points, pw, ph]);

  const ghostPaths = useMemo(
    () =>
      size
        ? CHANNELS.filter((c) => c.id !== channel && !isIdentity(curves[c.id])).map((c) => ({
            id: c.id,
            color: c.color,
            d: curvePath(normalizePoints(curves[c.id]), 192),
          }))
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [curves, channel, pw, ph],
  );

  const histBins = histogram ? (channel === "master" ? histogram.y : histogram[channel]) : undefined;
  const histNorm = useMemo(() => normalizeHistogram(histBins), [histBins]);
  const histPath = useMemo(() => {
    if (!size || !histNorm) return "";
    const n = histNorm.length;
    let d = `M${X(0).toFixed(2)} ${Y(0).toFixed(2)}`;
    for (let i = 0; i < n; i++) d += `L${X(i / (n - 1)).toFixed(2)} ${Y(histNorm[i]).toFixed(2)}`;
    return `${d}L${X(1).toFixed(2)} ${Y(0).toFixed(2)}Z`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [histNorm, pw, ph]);

  // ------------------------------------------------------------------ pointer

  const beginDrag = (
    e: ReactPointerEvent<SVGSVGElement>,
    m: Measure,
    full: CurvePoint[],
    index: number,
    changed: boolean,
  ) => {
    const [lo, hi] = xBounds(full, index);
    const p = full[index];
    dragRef.current = {
      pointerId: e.pointerId,
      channel,
      index,
      others: full.filter((_, i) => i !== index),
      point: [p[0], p[1]],
      lo,
      hi,
      removable: index > 0 && index < full.length - 1,
      // a freshly added point sits on the curve, possibly far from the pointer in y: it snaps to
      // the pointer once the drag starts. An existing handle keeps its small grab offset.
      offX: changed ? 0 : p[0] - m.x,
      offY: changed ? 0 : p[1] - m.y,
      startX: m.px,
      startY: m.py,
      tracking: false,
      removed: false,
      changed,
    };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // the pointer is already gone (e.g. synthetic event); the drag simply ends on the next up
    }
    setSelected(index);
    setDragging(true);
  };

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 || dragRef.current) return;
    const svg = e.currentTarget;
    const m = measure(svg, e.clientX, e.clientY);
    e.preventDefault(); // no text selection / native drag
    svg.focus({ preventScroll: true });

    // 1. on a handle?
    let hit = -1;
    let best = HIT_R * HIT_R;
    points.forEach((p, i) => {
      const dx = (p[0] - m.x) * m.pw;
      const dy = (p[1] - m.y) * m.ph;
      const d = dx * dx + dy * dy;
      if (d <= best) {
        best = d;
        hit = i;
      }
    });
    if (hit >= 0) {
      const last = lastDownRef.current;
      const interior = hit > 0 && hit < points.length - 1;
      if (interior && last && last.channel === channel && last.index === hit && e.timeStamp - last.time < DOUBLE_CLICK_MS) {
        // double-click on an interior point removes it
        lastDownRef.current = null;
        emit(channel, points.filter((_, i) => i !== hit));
        setSelected(null);
        onCommit?.();
        return;
      }
      lastDownRef.current = { channel, index: hit, time: e.timeStamp };
      beginDrag(e, m, points, hit, false);
      return;
    }
    lastDownRef.current = null;

    // 2. empty area: add a point on the curve at this x, if there is room for one
    const nearestInX = () => {
      let idx = 0;
      points.forEach((p, i) => {
        if (Math.abs(p[0] - m.x) < Math.abs(points[idx][0] - m.x)) idx = i;
      });
      return idx;
    };
    const near = nearestInX();
    if (Math.abs(points[near][0] - m.x) * m.pw <= HIT_R) {
      // directly above / below an existing point: select it instead of stacking a second one
      setSelected(near);
      return;
    }
    let seg = -1;
    for (let i = 0; i < points.length - 1; i++) {
      if (m.x > points[i][0] && m.x < points[i + 1][0]) {
        seg = i;
        break;
      }
    }
    if (seg < 0) {
      // left of the black point or right of the white point
      setSelected(near);
      return;
    }
    const lo = points[seg][0] + GAP;
    const hi = points[seg + 1][0] - GAP;
    if (hi < lo) {
      setSelected(near);
      return;
    }
    const x = round4(clamp(m.x, lo, hi));
    const y = round4(clamp(sampleCurve(points, x), 0, 1));
    const next = points.slice();
    next.splice(seg + 1, 0, [x, y]);
    emit(channel, next);
    beginDrag(e, m, next, seg + 1, true);
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const m = measure(e.currentTarget, e.clientX, e.clientY);
    if (!d.tracking) {
      if (Math.hypot(m.px - d.startX, m.py - d.startY) < MOVE_PX) return;
      d.tracking = true;
      lastDownRef.current = null; // a drag is not the first half of a double-click
    }
    if (d.removable && (m.py < -REMOVE_PX || m.py > m.height + REMOVE_PX)) {
      if (!d.removed) {
        d.removed = true;
        d.changed = true;
        emit(d.channel, d.others.slice());
        setSelected(null);
      }
      return;
    }
    const x = round4(clamp(m.x + d.offX, d.lo, d.hi));
    const y = round4(clamp(m.y + d.offY, 0, 1));
    if (!d.removed && x === d.point[0] && y === d.point[1]) return;
    d.removed = false; // dragged back in before releasing: the point returns
    d.changed = true;
    d.point = [x, y];
    const next = d.others.slice();
    next.splice(d.index, 0, [x, y]);
    emit(d.channel, next);
    setSelected(d.index);
  };

  const endDrag = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    dragRef.current = null; // first, so the lostpointercapture that follows is a no-op
    setDragging(false);
    const svg = e.currentTarget;
    if (svg.hasPointerCapture(d.pointerId)) svg.releasePointerCapture(d.pointerId);
    if (d.removed) setSelected(null);
    if (d.changed) onCommit?.();
  };

  // ------------------------------------------------------------------ keyboard

  const commitNudge = () => {
    if (!nudgedRef.current) return;
    nudgedRef.current = false;
    onCommit?.();
  };

  const onKeyDown = (e: ReactKeyboardEvent<SVGSVGElement>) => {
    if (sel === null || dragRef.current) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      if (sel === 0 || sel === points.length - 1) return; // end points stay
      nudgedRef.current = false;
      emit(channel, points.filter((_, i) => i !== sel));
      setSelected(null);
      onCommit?.();
      return;
    }
    const step = e.shiftKey ? 0.02 : 0.005;
    let dx = 0;
    let dy = 0;
    if (e.key === "ArrowLeft") dx = -step;
    else if (e.key === "ArrowRight") dx = step;
    else if (e.key === "ArrowUp") dy = step;
    else if (e.key === "ArrowDown") dy = -step;
    else return;
    e.preventDefault();
    const p = points[sel];
    const [lo, hi] = xBounds(points, sel);
    const x = round4(clamp(p[0] + dx, lo, hi));
    const y = round4(clamp(p[1] + dy, 0, 1));
    if (x === p[0] && y === p[1]) return;
    const next = points.slice();
    next[sel] = [x, y];
    nudgedRef.current = true;
    emit(channel, next);
  };

  const onKeyUp = (e: ReactKeyboardEvent<SVGSVGElement>) => {
    if (e.key.startsWith("Arrow")) commitNudge(); // one undo step per held key, not per repeat
  };

  // ------------------------------------------------------------------ actions

  const selectChannel = (c: CurveChannel) => {
    if (dragRef.current || c === channel) return;
    commitNudge();
    lastDownRef.current = null;
    setChannel(c);
    setSelected(null);
  };

  const resetChannel = () => {
    emit(channel, [[0, 0], [1, 1]]);
    setSelected(null);
    onCommit?.();
  };

  const resetAll = () => {
    onChange(identityCurves());
    setSelected(null);
    onCommit?.();
  };

  const channelIsIdentity = isIdentity(curves[channel]);
  const allIdentity = CHANNELS.every((c) => isIdentity(curves[c.id]));
  const selPoint = sel !== null ? points[sel] : null;

  return (
    <div className={styles.root}>
      <div className={styles.tabs} role="tablist" aria-label="Curve channel">
        {CHANNELS.map((c) => (
          <button
            key={c.id}
            type="button"
            role="tab"
            aria-selected={c.id === channel}
            title={c.title}
            className={`${styles.tab} ${c.id === channel ? styles.tabActive : ""}`}
            style={{ "--ch": c.color } as CSSProperties}
            onClick={() => selectChannel(c.id)}
          >
            <span className={styles.swatch} />
            {c.label}
            {!isIdentity(curves[c.id]) && <span className={styles.modified} aria-label="edited" />}
          </button>
        ))}
      </div>

      <div ref={wrapRef} className={styles.graphWrap}>
        <svg
          className={`${styles.graph} ${dragging ? styles.dragging : ""}`}
          width="100%"
          height="100%"
          tabIndex={0}
          role="application"
          aria-label={`${CHANNELS.find((c) => c.id === channel)?.title ?? channel} curve. Click to add a point, drag to move, arrow keys to nudge, Delete to remove.`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onLostPointerCapture={endDrag}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onBlur={commitNudge}
        >
          {size && (
            <>
              {histPath && <path className={styles.histogram} d={histPath} fill={color} />}
              <g className={styles.grid}>
                {GRID.map((g) => (
                  <line key={`v${g}`} x1={X(g)} y1={Y(0)} x2={X(g)} y2={Y(1)} />
                ))}
                {GRID.map((g) => (
                  <line key={`h${g}`} x1={X(0)} y1={Y(g)} x2={X(1)} y2={Y(g)} />
                ))}
              </g>
              <line className={styles.identity} x1={X(0)} y1={Y(0)} x2={X(1)} y2={Y(1)} />
              {ghostPaths.map((g) => (
                <path key={g.id} className={styles.ghost} d={g.d} stroke={g.color} />
              ))}
              <path className={styles.curve} d={activePath} stroke={color} />
              {points.map((p, i) => (
                <g key={i} transform={`translate(${X(p[0]).toFixed(2)} ${Y(p[1]).toFixed(2)})`}>
                  <circle className={styles.hit} r={HIT_R} />
                  <circle
                    className={`${styles.handle} ${i === sel ? styles.handleSelected : ""}`}
                    r={HANDLE_R}
                    stroke={color}
                    fill={i === sel ? color : undefined}
                  />
                </g>
              ))}
            </>
          )}
        </svg>
      </div>

      <div className={styles.footer}>
        <div className={styles.readout} aria-live="polite">
          {selPoint ? (
            <>
              in <b>{selPoint[0].toFixed(3)}</b> → out <b>{selPoint[1].toFixed(3)}</b>
            </>
          ) : (
            <span className={styles.hint}>Click to add a point</span>
          )}
        </div>
        <div className={styles.actions}>
          <button type="button" className={styles.button} onClick={resetChannel} disabled={channelIsIdentity}>
            Reset channel
          </button>
          <button type="button" className={styles.button} onClick={resetAll} disabled={allIdentity}>
            Reset all
          </button>
        </div>
      </div>
    </div>
  );
}
