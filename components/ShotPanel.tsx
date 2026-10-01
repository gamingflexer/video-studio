"use client";

import { useEffect, useRef, useState } from "react";
import type { Mark, Review, Shot, SourceInfo } from "@/lib/types";
import { shotLength, timecode, type ShotChange } from "@/lib/timeline";

interface Props {
  shot: Shot | null;
  index: number;
  base: Shot | null;
  source: SourceInfo | null;
  changes: ShotChange[];
  review: Review;
  onPatch: (patch: Partial<Shot>) => void;
  onReset: () => void;
  onDelete: () => void;
  onSplit: () => void;
  onNotes: (notes: string) => void;
  onSelect: (id: string) => void;
  /** live playhead: seconds on the timeline + the label of the shot under it */
  now: () => { t: number; label: string; ok: boolean };
  fps: number;
  /** pinned comments with the time they sit at now */
  marks: (Mark & { at: number })[];
  onAddMark: (text: string) => void;
  onRemoveMark: (id: string) => void;
  onSeek: (t: number) => void;
}

const num = (v: string, fallback: number) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : fallback);

export default function ShotPanel(p: Props) {
  const s = p.shot;
  const [text, setText] = useState("");
  const tc = useRef<HTMLSpanElement>(null);
  const where = useRef<HTMLElement>(null);
  const { now, fps } = p;
  // the timecode follows the playhead without re-rendering the panel
  useEffect(() => {
    let raf = 0, last = "";
    const tick = () => {
      const n = now(), txt = timecode(n.t, fps);
      if (txt + n.label !== last) {
        last = txt + n.label;
        if (tc.current) tc.current.textContent = `${txt} · ${n.t.toFixed(2)} s`;
        if (where.current) where.current.textContent = n.label;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [now, fps]);
  const add = () => {
    if (!text.trim()) return;
    p.onAddMark(text.trim());
    setText("");
  };
  return (
    <div className="panel">
      <h4>Comment at <span className="mark-tc" ref={tc}>00:00:00</span> <small ref={where} /></h4>
      <form className="row" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <input id="mark-input" value={text} onChange={(e) => setText(e.target.value)} style={{ flex: 1 }}
          placeholder="What about this exact moment? e.g. cut here, the hand is already out of frame" />
        <button className="primary" type="submit" disabled={!text.trim()}>Add</button>
      </form>
      {p.marks.length > 0 && (
        <ul className="marks">
          {p.marks.map((m) => (
            <li key={m.id} onClick={() => p.onSeek(m.at)} title="jump to this moment">
              <b>{timecode(m.at, fps)}</b><span>{m.text}</span>
              <i onClick={(e) => { e.stopPropagation(); p.onRemoveMark(m.id); }} title="delete this comment">×</i>
            </li>
          ))}
        </ul>
      )}

      {s ? (
        <>
          <h4>Shot {p.index + 1} <small>{s.source ?? "generated"}</small></h4>
          <input className="title-input" value={s.label} onChange={(e) => p.onPatch({ label: e.target.value })} title="R"
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur(); }} />
          {s.source ? (
            <div className="fields">
              <label>In<input type="number" step={0.05} min={0} value={+s.in.toFixed(3)} onChange={(e) => p.onPatch({ in: Math.min(Math.max(num(e.target.value, s.in), 0), s.out - 0.1) })} /></label>
              <label>Out<input type="number" step={0.05} value={+s.out.toFixed(3)} onChange={(e) => p.onPatch({ out: Math.min(Math.max(num(e.target.value, s.out), s.in + 0.1), p.source?.duration ?? 1e6) })} /></label>
              <label>Speed<input type="number" step={0.1} min={0.1} max={8} value={s.speed} onChange={(e) => p.onPatch({ speed: Math.min(Math.max(num(e.target.value, s.speed), 0.1), 8) })} /></label>
              <label>Length<output>{shotLength(s).toFixed(2)} s</output></label>
            </div>
          ) : (
            <div className="fields">
              <label>Length<input type="number" step={0.05} min={0.05} value={s.duration ?? 1} onChange={(e) => p.onPatch({ duration: Math.max(num(e.target.value, 1), 0.05) })} /></label>
            </div>
          )}
          {s.note && (
            <div className="ai-note">
              <b>Why Claude cut it this way</b>
              {s.note}
              {p.base && s.source && <em>Claude’s cut: {p.base.in.toFixed(2)} → {p.base.out.toFixed(2)} s{p.base.speed !== 1 ? ` at ${p.base.speed}×` : ""}</em>}
            </div>
          )}
          <h4>Your comment <small>optional</small></h4>
          <textarea id="shot-comment" rows={3} value={s.comment ?? ""} onChange={(e) => p.onPatch({ comment: e.target.value })}
            placeholder="Why use it from here? e.g. start once the book is already down — the slide-in reads as a mistake" />
          <div className="row wrap">
            <button onClick={p.onSplit} disabled={!s.source} title="S">Split at playhead</button>
            <button onClick={p.onReset} disabled={!p.base}>Back to Claude’s cut</button>
            <button className="danger" onClick={p.onDelete} title="Delete">Remove shot</button>
          </div>
        </>
      ) : (
        <p className="hint">Select a shot in the timeline to trim it, comment on it or see why it was cut that way.</p>
      )}

      <h4>Changes since Claude’s cut <small>{p.changes.length || "none"}</small></h4>
      <ul className="changes">
        {p.changes.map((c) => (
          <li key={c.shot.id + c.kind} onClick={() => c.kind !== "removed" && p.onSelect(c.shot.id)} className={c.kind}>
            <b>{c.kind === "removed" ? "removed" : c.kind === "added" ? "new" : c.kind === "comment" ? "note" : c.kind === "graded" ? "graded" : c.kind}</b>
            <span>{c.shot.label}</span>
            {c.lines.length > 0 && <small>{c.lines.join(" · ")}</small>}
            {(c.kind === "removed" ? p.review.removed?.[c.shot.id] : c.shot.comment)?.trim() && <em>“{(c.kind === "removed" ? p.review.removed?.[c.shot.id] : c.shot.comment)!.trim()}”</em>}
          </li>
        ))}
      </ul>

      <h4>Overall notes <small>optional</small></h4>
      <textarea rows={3} value={p.review.notes} onChange={(e) => p.onNotes(e.target.value)}
        placeholder="Anything about the whole film: pacing, order, what the next version should feel like" />
    </div>
  );
}
