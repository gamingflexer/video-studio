"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as RPointerEvent } from "react";
import type { Shot, SourceInfo } from "@/lib/types";
import { layout, shotLength, sourceHue, type Placed } from "@/lib/timeline";

export interface Clock {
  mode: "edit" | "render" | "source";
  t: number;
  sourceId: string | null;
  sourceT: number;
}

export interface SourceMedia {
  proxy: string;
  sprite: string;
  frames: number;
}

interface Props {
  shots: Shot[];
  baseShots: Shot[];
  sources: SourceInfo[];
  media: Record<string, SourceMedia | undefined>;
  mediaUrl: (abs: string) => string;
  selectedId: string | null;
  changedIds: Set<string>;
  clock: React.RefObject<Clock>;
  fps: number;
  onSelect: (id: string | null) => void;
  onSeek: (t: number) => void;
  /** live edit of a shot's in/out while dragging; `edge` says which frame to show in the monitor */
  onTrim: (id: string, patch: { in?: number; out?: number }, edge: "in" | "out") => void;
  onTrimEnd: (id: string, kind: "trimmed" | "slipped") => void;
  onReorder: (id: string, toIndex: number) => void;
  onSourcePreview: (sourceId: string, t: number) => void;
  onAddFromSource: (sourceId: string, t: number) => void;
  /** double-click a shot: open its inspector (reasoning, code, comment) */
  onOpen: (id: string) => void;
  /** right-click a shot: show the shot menu at this screen position */
  onMenu: (id: string, x: number, y: number) => void;
  /** comments pinned to a moment: shown as flags on the ruler */
  marks: { id: string; at: number; text: string }[];
}

const LABEL_W = 132;
const MIN_LEN = 0.1;
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

type Drag =
  | { kind: "seek" }
  | { kind: "body"; id: string; x0: number; moved: boolean }
  | { kind: "edge"; id: string; edge: "in" | "out"; x0: number; in0: number; out0: number; scale: number; max: number }
  | { kind: "slip"; id: string; x0: number; in0: number; out0: number; scale: number; max: number; moved: boolean }
  | { kind: "source"; sourceId: string };

function Filmstrip({ src, width, height, m, url }: { src: SourceInfo; width: number; height: number; m: SourceMedia; url: string }) {
  const fw = Math.round((72 * src.width) / src.height / 2) * 2; // matches ffmpeg scale=-2:72
  const cellW = Math.max((height * src.width) / src.height, 30);
  const cells = clamp(Math.round(width / cellW), 1, 60);
  const cw = width / cells;
  const k = Math.max(cw / fw, height / 72);
  return (
    <>
      {Array.from({ length: cells }, (_, i) => {
        const frame = clamp(Math.round(((i + 0.5) / cells) * m.frames - 0.5), 0, m.frames - 1);
        return (
          <div key={i} className="tl-cell" style={{
            left: i * cw, width: cw + 0.5, height,
            backgroundImage: `url("${url}")`,
            backgroundSize: `${m.frames * fw * k}px ${72 * k}px`,
            backgroundPosition: `${-(frame * fw * k + (fw * k - cw) / 2)}px ${-(72 * k - height) / 2}px`,
          }} />
        );
      })}
    </>
  );
}

export default function Timeline(p: Props) {
  const { placed, total } = useMemo(() => layout(p.shots), [p.shots]);
  const base = useMemo(() => layout(p.baseShots), [p.baseShots]);
  const wrap = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const srcHead = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  const [zoom, setZoom] = useState(1);
  const drag = useRef<Drag | null>(null);
  const [drop, setDrop] = useState<number | null>(null);
  const [showSources, setShowSources] = useState(true);

  useLayoutEffect(() => {
    const el = wrap.current!;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const trackW = Math.max(width - LABEL_W - 16, 200);
  const span = Math.max(total, base.total, 1);
  const pps = (trackW / span) * zoom;
  const maxDur = Math.max(1, ...p.sources.map((s) => s.duration));
  const srcPps = trackW / maxDur;
  const srcById = useMemo(() => new Map(p.sources.map((s) => [s.id, s])), [p.sources]);

  // playheads are moved straight in the DOM every frame — no React render while playing
  const ppsRef = useRef(pps);
  ppsRef.current = pps;
  const srcPpsRef = useRef(srcPps);
  srcPpsRef.current = srcPps;
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const c = p.clock.current;
      if (head.current && c) {
        head.current.style.transform = `translateX(${c.t * ppsRef.current}px)`;
        head.current.style.opacity = c.mode === "source" ? "0.25" : "1";
      }
      if (srcHead.current && c) {
        const row = c.mode === "source" && c.sourceId ? document.getElementById(`lane-${c.sourceId}`) : null;
        if (row) {
          srcHead.current.style.display = "block";
          srcHead.current.style.top = `${row.offsetTop}px`;
          srcHead.current.style.height = `${row.offsetHeight}px`;
          srcHead.current.style.transform = `translateX(${LABEL_W + c.sourceT * srcPpsRef.current}px)`;
        } else srcHead.current.style.display = "none";
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [p.clock]);

  const timeAt = (clientX: number) => {
    const r = scroller.current!.getBoundingClientRect();
    return clamp((clientX - r.left + scroller.current!.scrollLeft) / pps, 0, span);
  };
  const dropIndex = (clientX: number, id: string) => {
    const t = timeAt(clientX);
    let idx = placed.length;
    for (const q of placed) if (t < (q.start + q.end) / 2) { idx = q.index; break; }
    const from = placed.findIndex((q) => q.shot.id === id);
    return idx > from ? idx - 1 : idx;
  };

  const down = (e: RPointerEvent, d: Drag) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* pointer already gone: the drag still works while it stays over the element */
    }
    drag.current = d;
    if (d.kind === "seek") p.onSeek(timeAt(e.clientX));
  };

  const move = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (d.kind === "seek") p.onSeek(timeAt(e.clientX));
    else if (d.kind === "body") {
      if (Math.abs(e.clientX - d.x0) > 5) d.moved = true;
      if (d.moved) setDrop(dropIndex(e.clientX, d.id));
    } else if (d.kind === "edge") {
      const ds = (e.clientX - d.x0) / d.scale;
      if (d.edge === "in") p.onTrim(d.id, { in: clamp(d.in0 + ds, 0, d.out0 - MIN_LEN) }, "in");
      else p.onTrim(d.id, { out: clamp(d.out0 + ds, d.in0 + MIN_LEN, d.max) }, "out");
    } else if (d.kind === "slip") {
      if (Math.abs(e.clientX - d.x0) > 3) d.moved = true;
      if (!d.moved) return;
      const len = d.out0 - d.in0;
      const nin = clamp(d.in0 + (e.clientX - d.x0) / d.scale, 0, Math.max(d.max - len, 0));
      p.onTrim(d.id, { in: nin, out: nin + len }, "in");
    } else if (d.kind === "source") {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const s = srcById.get(d.sourceId)!;
      p.onSourcePreview(d.sourceId, clamp((e.clientX - r.left) / srcPps, 0, s.duration));
    }
  };

  const up = (e: RPointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.kind === "body") {
      if (d.moved) {
        const to = dropIndex(e.clientX, d.id);
        if (to !== placed.findIndex((q) => q.shot.id === d.id)) p.onReorder(d.id, to);
      } else {
        p.onSelect(d.id);
        p.onSeek(timeAt(e.clientX));
      }
      setDrop(null);
    } else if (d.kind === "edge") p.onTrimEnd(d.id, "trimmed");
    else if (d.kind === "slip") {
      if (d.moved) p.onTrimEnd(d.id, "slipped");
      else p.onSelect(d.id);
    }
  };

  const ticks = useMemo(() => {
    const step = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60].find((s) => s * pps >= 56) ?? 120;
    return Array.from({ length: Math.floor(span / step) + 1 }, (_, i) => i * step);
  }, [span, pps]);

  const usedBy = (sourceId: string) => placed.filter((q) => q.shot.source === sourceId);
  const totalShot = p.sources.reduce((a, s) => a + s.duration, 0);
  const totalUsed = p.shots.reduce((a, s) => a + (s.source ? s.out - s.in : 0), 0);
  const unusedTakes = p.sources.filter((s) => !p.shots.some((x) => x.source === s.id)).length;
  const dropX = drop === null ? null : drop >= placed.length ? total * pps : (() => {
    const others = placed.filter((q) => q.shot.id !== (drag.current as { id?: string } | null)?.id);
    return (others[drop]?.start ?? total) * pps;
  })();

  const block = (q: Placed, ghost: boolean) => {
    const s = q.shot, hue = sourceHue(s.source), w = Math.max((q.end - q.start) * pps, 3);
    const src = s.source ? srcById.get(s.source) : null;
    if (ghost)
      return <div key={s.id} className="tl-ghost" title={`Claude's cut: ${s.label}`} style={{ left: q.start * pps, width: w - 1, background: s.source ? `hsl(${hue} 30% 34%)` : "#3a3a42" }} />;
    const sel = p.selectedId === s.id;
    return (
      <div key={s.id} className={`tl-block${sel ? " sel" : ""}${s.source ? "" : " gen"}`}
        style={{ left: q.start * pps, width: w - 1, ["--hue" as string]: hue }}
        title={`${q.index + 1}. ${s.label}\n${s.source ?? "generated"} · ${shotLength(s).toFixed(2)} s\ndouble-click: reasoning, code and comment · right-click: menu`}
        onDoubleClick={() => p.onOpen(s.id)}
        onContextMenu={(e) => { e.preventDefault(); p.onMenu(s.id, e.clientX, e.clientY); }}
        onPointerDown={(e) => down(e, { kind: "body", id: s.id, x0: e.clientX, moved: false })} onPointerMove={move} onPointerUp={up}>
        <span className="tl-num">{q.index + 1}</span>
        <span className="tl-name">{s.label}</span>
        <span className="tl-meta">{s.source ? `${s.source} · ` : ""}{shotLength(s).toFixed(2)}s{s.speed !== 1 ? ` · ${s.speed}×` : ""}</span>
        <span className="tl-flags">
          {p.changedIds.has(s.id) && <i className="flag changed" title="changed from Claude's cut" />}
          {s.comment?.trim() && <i className="flag note" title={s.comment} />}
          {s.grade && <i className="flag grade" title="has its own grade" />}
        </span>
        {s.source && src && (
          <>
            <b className="tl-edge l" onPointerDown={(e) => down(e, { kind: "edge", id: s.id, edge: "in", x0: e.clientX, in0: s.in, out0: s.out, scale: pps / (s.speed || 1), max: src.duration })} onPointerMove={move} onPointerUp={up} />
            <b className="tl-edge r" onPointerDown={(e) => down(e, { kind: "edge", id: s.id, edge: "out", x0: e.clientX, in0: s.in, out0: s.out, scale: pps / (s.speed || 1), max: src.duration })} onPointerMove={move} onPointerUp={up} />
          </>
        )}
      </div>
    );
  };

  return (
    <div className="tl" ref={wrap}>
      <div className="tl-bar">
        <span className="tl-title">Timeline</span>
        <span className="tl-stat">{placed.length} shots · {total.toFixed(2)} s</span>
        <span className="tl-stat dim">footage used {totalUsed.toFixed(1)} s of {totalShot.toFixed(1)} s ({totalShot ? Math.round((totalUsed / totalShot) * 100) : 0} %){unusedTakes ? ` · ${unusedTakes} take${unusedTakes > 1 ? "s" : ""} not used` : ""}</span>
        <span className="spacer" />
        <label className="tl-zoom">zoom<input type="range" min={1} max={12} step={0.1} value={zoom} onChange={(e) => setZoom(+e.target.value)} /></label>
      </div>

      <div className="tl-rows">
        <div className="tl-labels">
          <div className="tl-label ruler" />
          <div className="tl-label ghost">Claude’s cut</div>
          <div className="tl-label cut">Your cut<small>drag to reorder · edges to trim</small></div>
        </div>
        <div className="tl-scroll" ref={scroller}>
          <div className="tl-track" style={{ width: span * pps + 8 }}>
            <div className="tl-ruler" onPointerDown={(e) => down(e, { kind: "seek" })} onPointerMove={move} onPointerUp={up}>
              {ticks.map((t) => <span key={t} style={{ left: t * pps }}>{t % 1 ? t.toFixed(2) : t}s</span>)}
              {p.marks.map((m) => <i key={m.id} className="tl-mark" style={{ left: m.at * pps }} title={m.text} />)}
            </div>
            <div className="tl-ghosts">{base.placed.map((q) => block(q, true))}</div>
            <div className="tl-cut" onPointerDown={(e) => { if (e.target === e.currentTarget) { p.onSelect(null); down(e, { kind: "seek" }); } }} onPointerMove={move} onPointerUp={up}>
              {placed.map((q) => block(q, false))}
              {dropX !== null && <div className="tl-drop" style={{ left: dropX }} />}
            </div>
            <div className="tl-head" ref={head} />
          </div>
        </div>
      </div>

      <div className="tl-bar sub">
        <button className="tl-fold" onClick={() => setShowSources(!showSources)}>{showSources ? "▾" : "▸"} Source footage</button>
        <span className="tl-stat dim">bright = in the cut · dim = left out · drag a bright piece to slip it, its edges to trim · double-click dim footage to add a shot · double-click a shot for its code</span>
      </div>
      <div className="tl-sources" style={{ display: showSources ? undefined : "none" }}>
        <div className="tl-srchead" ref={srcHead} />
        {p.sources.map((s) => {
          const used = usedBy(s.id), usedLen = used.reduce((a, q) => a + q.shot.out - q.shot.in, 0);
          const m = p.media[s.id], w = Math.max(s.duration * srcPps, 4), hue = sourceHue(s.id);
          return (
            <div className="tl-lane-row" key={s.id} id={`lane-${s.id}`}>
              <div className="tl-label src" style={{ ["--hue" as string]: hue }}>
                <span>{s.id}</span>
                <small>{s.online ? `${usedLen.toFixed(1)} of ${s.duration.toFixed(1)} s · ${Math.round((usedLen / s.duration) * 100)} %` : "offline"}</small>
              </div>
              <div className={`tl-lane${s.online ? "" : " offline"}`} style={{ width: w }}
                onPointerDown={(e) => { if (s.online) { down(e, { kind: "source", sourceId: s.id }); const r = e.currentTarget.getBoundingClientRect(); p.onSourcePreview(s.id, clamp((e.clientX - r.left) / srcPps, 0, s.duration)); } }}
                onPointerMove={move} onPointerUp={up}
                onDoubleClick={(e) => { if (!s.online) return; const r = e.currentTarget.getBoundingClientRect(); p.onAddFromSource(s.id, clamp((e.clientX - r.left) / srcPps, 0, s.duration)); }}>
                {m && <Filmstrip src={s} width={w} height={38} m={m} url={p.mediaUrl(m.sprite)} />}
                <div className="tl-dim" />
                {used.map((q) => {
                  const x = q.shot.in * srcPps, sw = Math.max((q.shot.out - q.shot.in) * srcPps, 3);
                  return (
                    <div key={q.shot.id} className={`tl-used${p.selectedId === q.shot.id ? " sel" : ""}`} style={{ left: x, width: sw, ["--hue" as string]: hue }}
                      title={`shot ${q.index + 1}: ${q.shot.in.toFixed(2)} → ${q.shot.out.toFixed(2)} s`}
                      onDoubleClick={(e) => { e.stopPropagation(); p.onOpen(q.shot.id); }}
                      onContextMenu={(e) => { e.preventDefault(); p.onMenu(q.shot.id, e.clientX, e.clientY); }}
                      onPointerDown={(e) => down(e, { kind: "slip", id: q.shot.id, x0: e.clientX, in0: q.shot.in, out0: q.shot.out, scale: srcPps, max: s.duration, moved: false })} onPointerMove={move} onPointerUp={up}>
                      {m && <div className="tl-used-pic" style={{ left: -x, width: w }}><Filmstrip src={s} width={w} height={38} m={m} url={p.mediaUrl(m.sprite)} /></div>}
                      <span className="tl-chip">{q.index + 1}</span>
                      <b className="tl-edge l" onPointerDown={(e) => down(e, { kind: "edge", id: q.shot.id, edge: "in", x0: e.clientX, in0: q.shot.in, out0: q.shot.out, scale: srcPps, max: s.duration })} onPointerMove={move} onPointerUp={up} />
                      <b className="tl-edge r" onPointerDown={(e) => down(e, { kind: "edge", id: q.shot.id, edge: "out", x0: e.clientX, in0: q.shot.in, out0: q.shot.out, scale: srcPps, max: s.duration })} onPointerMove={move} onPointerUp={up} />
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
