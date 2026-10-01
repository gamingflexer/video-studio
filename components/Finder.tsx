"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface Entry {
  name: string;
  rel: string;
  kind: "dir" | "video";
  size: number;
  mtime: number;
}
interface Column {
  dir: string;
  entries: Entry[];
  sel: number;
}

const mb = (n: number) => (n > 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(1)} MB`);
const day = (t: number) => new Date(t).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });

/** Finder-style column browser: ↑ ↓ move, → or ⏎ opens a folder, ← goes back, ⏎ on a video opens it. */
export default function Finder({ onOpen, busy }: { onOpen: (rel: string) => void; busy: string }) {
  const [cols, setCols] = useState<Column[]>([]);
  const [error, setError] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: "", at: 0 });

  const load = useCallback(async (dir: string): Promise<Column | null> => {
    const res = await (await fetch(`/api/browse?dir=${encodeURIComponent(dir)}`)).json();
    if (res.error) {
      setError(res.error);
      return null;
    }
    return { dir: res.dir, entries: res.entries, sel: 0 };
  }, []);

  useEffect(() => {
    load("").then((c) => c && setCols([c]));
    box.current?.focus({ preventScroll: true }); // arrow keys work straight away
  }, [load]);

  // keep the selected row and the newest column in view
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.scrollTo({ left: el.scrollWidth });
    el.querySelectorAll(".fd-col").forEach((c) => c.querySelector(".fd-row.sel")?.scrollIntoView({ block: "nearest" }));
  }, [cols]);

  const last = cols[cols.length - 1];
  const current = last?.entries[last.sel];

  /** select row `i` in column `c`; a folder opens as the next column, a video becomes the preview */
  const pick = async (c: number, i: number, enter: boolean) => {
    const col = cols[c], entry = col?.entries[i];
    if (!entry) return;
    const base = [...cols.slice(0, c), { ...col, sel: i }];
    if (entry.kind === "dir" && enter) {
      const next = await load(entry.rel);
      setCols(next ? [...base, next] : base);
    } else {
      setCols(base);
      if (entry.kind === "video" && enter) onOpen(entry.rel);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (!last || e.metaKey || e.ctrlKey || e.altKey) return;
    const c = cols.length - 1;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const i = Math.min(Math.max(last.sel + (e.key === "ArrowDown" ? 1 : -1), 0), last.entries.length - 1);
      pick(c, i, false);
    } else if (e.key === "ArrowRight" || e.key === "Enter") {
      e.preventDefault();
      if (current?.kind === "dir" || e.key === "Enter") pick(c, last.sel, true);
    } else if (e.key === "ArrowLeft" || e.key === "Backspace") {
      e.preventDefault();
      if (cols.length > 1) setCols(cols.slice(0, -1));
    } else if (e.key.length === 1 && /\S/.test(e.key)) {
      // type a few letters to jump, as in Finder
      const now = Date.now(), t = typed.current;
      t.text = now - t.at < 700 ? t.text + e.key.toLowerCase() : e.key.toLowerCase();
      t.at = now;
      const i = last.entries.findIndex((x) => x.name.toLowerCase().startsWith(t.text));
      if (i >= 0) pick(c, i, false);
    }
  };

  return (
    <div className="finder">
      <div className="fd-path">
        <button onClick={() => setCols(cols.slice(0, 1))} disabled={cols.length < 2}>Workspace</button>
        {cols.slice(1).map((c, i) => (
          <span key={c.dir}>›<button onClick={() => setCols(cols.slice(0, i + 2))}>{c.dir.split("/").pop()}</button></span>
        ))}
        <span className="spacer" />
        <em>↑ ↓ move · → or ⏎ open folder · ← back · ⏎ open video · type to jump</em>
      </div>
      <div className="fd-body">
        <div className="fd-cols" ref={box} tabIndex={0} onKeyDown={onKey}>
          {cols.map((col, c) => (
            <div className={`fd-col${c === cols.length - 1 ? " active" : ""}`} key={col.dir || "root"}>
              {col.entries.map((en, i) => (
                <div key={en.rel} className={`fd-row ${en.kind}${col.sel === i ? " sel" : ""}`}
                  onClick={() => { box.current?.focus(); pick(c, i, en.kind === "dir"); }}
                  onDoubleClick={() => en.kind === "video" && onOpen(en.rel)}>
                  <i>{en.kind === "dir" ? "▸" : "▶"}</i>
                  <span title={en.name}>{en.name}</span>
                  <small>{en.kind === "dir" ? `${en.size} video${en.size === 1 ? "" : "s"}` : mb(en.size)}</small>
                </div>
              ))}
              {!col.entries.length && <p className="hint">No videos in here.</p>}
            </div>
          ))}
        </div>
        <div className="fd-preview">
          {current?.kind === "video" ? (
            <>
              <video key={current.rel} src={`/api/media?path=${encodeURIComponent(current.rel)}#t=0.5`} muted playsInline preload="metadata" controls />
              <b title={current.rel}>{current.name}</b>
              <small>{mb(current.size)} · {day(current.mtime)}</small>
              <small className="dim">{current.rel}</small>
              <button className="primary" onClick={() => onOpen(current.rel)} disabled={!!busy}>{busy === current.rel ? "Opening…" : "Open in Studio  ⏎"}</button>
            </>
          ) : current ? (
            <>
              <b>{current.name}</b>
              <small>{current.size} video{current.size === 1 ? "" : "s"} inside · changed {day(current.mtime)}</small>
              <small className="dim">Press → or ⏎ to open the folder.</small>
            </>
          ) : (
            <small className="dim">{error || "Loading…"}</small>
          )}
        </div>
      </div>
    </div>
  );
}
