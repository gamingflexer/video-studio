"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Branch, BranchStatus, FinalsPayload } from "@/lib/types";
import ThemeToggle from "./ThemeToggle";
import TopTabs from "./TopTabs";

const STATUS: Record<BranchStatus, string> = {
  idea: "Idea", building: "Editing", draft: "Ready to review", final: "Final", chosen: "Chosen", dropped: "Dropped",
};

const media = (abs: string) => `/api/media?path=${encodeURIComponent(abs)}`;

function ago(iso?: string) {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/** the file to play for a branch: the finished render, else its draft */
function playable(p: FinalsPayload, b: Branch) {
  for (const f of [b.file, b.preview]) {
    if (!f || !p.media[f]?.exists) continue;
    const px = p.doc.proxies?.[f]; // light 720p copy: the CRF 10 / 60 fps masters stutter in a browser tab
    const abs = px && p.media[px]?.exists ? p.media[px].abs : p.media[f].abs;
    return { abs, draft: f !== b.file, original: p.media[f].abs };
  }
  return null;
}

/** branches in tree order with their depth (a branch forks from the trunk or from another branch) */
function tree(branches: Branch[]) {
  const out: { b: Branch; depth: number }[] = [];
  const walk = (parent: string | undefined, depth: number) => {
    for (const b of branches.filter((x) => (x.parent ?? undefined) === parent)) {
      out.push({ b, depth });
      walk(b.id, depth + 1);
    }
  };
  walk(undefined, 0);
  for (const b of branches) if (!out.some((o) => o.b.id === b.id)) out.push({ b, depth: 0 }); // parent missing
  return out;
}

/** "Nothing is editing" / "3 videos editing · about 46 % done" — across every video */
function Progress({ all }: { all: FinalsPayload[] }) {
  const editing = all.flatMap((p) => p.doc.branches.filter((b) => b.status === "building").map((b) => ({ p, b })));
  const review = all.flatMap((p) => p.doc.branches.filter((b) => b.status === "draft"));
  const avg = editing.length ? Math.round(editing.reduce((n, { b }) => n + (b.progress?.pct ?? 0), 0) / editing.length) : 0;
  const latest = editing.map(({ b }) => b.progress?.at).filter(Boolean).sort().pop();
  return (
    <section className="fin-progress" aria-live="polite">
      <div className="fin-headline">
        {editing.length === 0 ? (
          <b>Nothing is editing right now</b>
        ) : (
          <b>{editing.length === 1 ? "1 video editing" : `${editing.length} videos editing`} · about {avg} % done</b>
        )}
        {review.length > 0 && <span className="pill ready">{review.length} ready to review</span>}
        {latest && <span className="dim">last update {ago(latest)}</span>}
      </div>
      {editing.length > 0 && (
        <ul className="fin-bars">
          {editing.map(({ p, b }) => (
            <li key={p.doc.id + b.id}>
              <span className="fin-name">{b.label}</span>
              <span className="bar"><i style={{ width: `${b.progress?.pct ?? 0}%` }} /></span>
              <span className="fin-pct">{b.progress?.pct ?? 0} %</span>
              <span className="dim fin-step">{b.progress?.step || "started"}{b.progress?.at ? ` · ${ago(b.progress.at)}` : ""}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Player({ p, b, refCb, controls, muted = false }: { p: FinalsPayload; b: Branch; refCb?: (v: HTMLVideoElement | null) => void; controls: boolean; muted?: boolean }) {
  const src = playable(p, b);
  if (!src)
    return (
      <div className="fin-empty">
        <b>Not rendered yet</b>
        {b.progress ? <span>{b.progress.pct} % · {b.progress.step}</span> : <span className="dim">{STATUS[b.status]}</span>}
      </div>
    );
  return (
    <div className="fin-video">
      <video key={src.abs} ref={refCb} src={media(src.abs)} controls={controls} muted={muted} playsInline preload="metadata" />
      {src.draft && <span className="fin-draft">Draft</span>}
    </div>
  );
}

export default function Finals({ initial }: { initial: FinalsPayload[] }) {
  const [all, setAll] = useState(initial);
  const [videoId, setVideoId] = useState(initial[0]?.doc.id ?? "");
  const [sel, setSel] = useState<string>("");
  const [compare, setCompare] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const vids = useRef<(HTMLVideoElement | null)[]>([]);

  // sessions write progress into finals.json; poll so the bars move without a reload
  useEffect(() => {
    const t = setInterval(async () => {
      try {
        setAll(await (await fetch("/api/finals", { cache: "no-store" })).json());
      } catch {
        /* keep the last list */
      }
    }, 10000);
    return () => clearInterval(t);
  }, []);

  const p = all.find((x) => x.doc.id === videoId) ?? all[0];
  const rows = useMemo(() => (p ? tree(p.doc.branches) : []), [p]);
  const branch = p?.doc.branches.find((b) => b.id === sel) ?? null;
  useEffect(() => setNote(branch?.note ?? ""), [branch?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (b: Branch, patch: { status?: BranchStatus; note?: string }) => {
    await fetch("/api/finals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: p!.doc.id, branch: b.id, ...patch }) });
    setAll(await (await fetch("/api/finals", { cache: "no-store" })).json());
  };

  const toggleCompare = (id: string) => setCompare((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id].slice(-4)));
  const all3 = (fn: (v: HTMLVideoElement) => void) => vids.current.forEach((v) => v && fn(v));

  if (!p)
    return (
      <main className="home">
        <div className="row"><h1>Studio</h1><TopTabs active="finals" /><span className="spacer" /><ThemeToggle /></div>
        <Progress all={all} />
        <p className="dim">No final edits yet. A video gets here when its folder has a <code>finals.json</code> listing its base cut and its variations.</p>
      </main>
    );

  const showing = compare.length >= 2 ? compare : branch ? [branch.id] : [];
  return (
    <main className="home fin">
      <div className="row"><h1>Studio</h1><TopTabs active="finals" /><span className="spacer" /><ThemeToggle /></div>
      <Progress all={all} />

      {all.length > 1 && (
        <div className="row wrap fin-videos">
          {all.map((x) => (
            <button key={x.doc.id} className={x.doc.id === p.doc.id ? "toggle on" : "toggle"} onClick={() => { setVideoId(x.doc.id); setSel(""); setCompare([]); }}>
              {x.doc.title}
            </button>
          ))}
        </div>
      )}

      <div className="fin-grid">
        <aside className="fin-tree">
          <div className="fin-title">
            <b>{p.doc.title}</b>
            {p.doc.owner && <span className="dim">{p.doc.owner}</span>}
          </div>
          <button className={`fin-node trunk ${!sel && !compare.length ? "on" : ""}`} onClick={() => { setSel(""); setCompare([]); }}>
            <i className="dot" />
            <span><b>{p.doc.trunk.label}</b><small>{p.doc.trunk.about}</small></span>
          </button>
          <ul>
            {rows.map(({ b, depth }) => (
              <li key={b.id} style={{ paddingLeft: 18 + depth * 18 }} className={`fin-branch s-${b.status}`}>
                <span className="elbow" style={{ left: 7 + depth * 18 }} />
                <button className={`fin-node ${sel === b.id && compare.length < 2 ? "on" : ""}`} onClick={() => { setSel(b.id); setCompare([]); }}>
                  <i className="dot" />
                  <span>
                    <b>{b.label}</b>
                    <small>
                      {STATUS[b.status]}
                      {b.status === "building" && b.progress ? ` · ${b.progress.pct} %` : ""}
                    </small>
                    {b.status === "building" && <span className="bar thin"><i style={{ width: `${b.progress?.pct ?? 0}%` }} /></span>}
                  </span>
                </button>
                <label className="fin-cmp" title="Add to side-by-side">
                  <input type="checkbox" checked={compare.includes(b.id)} onChange={() => toggleCompare(b.id)} disabled={!playable(p, b)} />
                </label>
              </li>
            ))}
          </ul>
          <p className="hint">Tick two to four branches to watch them side by side.</p>
        </aside>

        <section className="fin-main">
          {showing.length === 0 && (
            <div className="fin-trunk">
              <p>{p.doc.description}</p>
              {p.doc.trunk.file && p.media[p.doc.trunk.file]?.exists && (
                <div className="fin-video"><video src={media(p.media[p.doc.proxies?.[p.doc.trunk.file] ?? ""]?.exists ? p.media[p.doc.proxies![p.doc.trunk.file]].abs : p.media[p.doc.trunk.file].abs)} controls playsInline preload="metadata" /></div>
              )}
              <p className="dim">Pick a branch on the left to watch it, or tick several to compare.</p>
            </div>
          )}

          {showing.length >= 2 && (
            <>
              <div className="row fin-sync">
                <button className="primary" onClick={() => all3((v) => { v.currentTime = 0; void v.play(); })}>Play all from start</button>
                <button onClick={() => all3((v) => (v.paused ? void v.play() : v.pause()))}>Play / pause</button>
                <button onClick={() => all3((v) => (v.muted = !v.muted))}>Mute / unmute</button>
                <span className="dim">Sound plays from the first one; unmute another on its own player.</span>
              </div>
              <div className="fin-compare" style={{ gridTemplateColumns: `repeat(${showing.length}, minmax(0, 1fr))` }}>
                {showing.map((id, i) => {
                  const b = p.doc.branches.find((x) => x.id === id)!;
                  return (
                    <div key={id} className="fin-col">
                      <div className="row"><b>{b.label}</b><span className={`pill s-${b.status}`}>{STATUS[b.status]}</span></div>
                      <Player p={p} b={b} controls muted={i > 0} refCb={(v) => (vids.current[i] = v)} />
                      <div className="row wrap">
                        <button onClick={() => save(b, { status: "chosen" })} className={b.status === "chosen" ? "primary" : ""}>Pick this one</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {showing.length === 1 && branch && (
            <div className="fin-one">
              <Player p={p} b={branch} controls />
              <div className="fin-info">
                <div className="row wrap"><h2>{branch.label}</h2><span className={`pill s-${branch.status}`}>{STATUS[branch.status]}</span></div>
                {branch.progress && branch.status === "building" && (
                  <div className="fin-prog">
                    <span className="bar"><i style={{ width: `${branch.progress.pct}%` }} /></span>
                    <span>{branch.progress.pct} % · {branch.progress.step} · {ago(branch.progress.at)}</span>
                  </div>
                )}
                {branch.about && <p>{branch.about}</p>}
                {branch.reference && (
                  <p className="dim">Look from: {branch.reference.url ? <a href={branch.reference.url} target="_blank" rel="noreferrer">{branch.reference.label}</a> : branch.reference.label}</p>
                )}
                <label className="fin-note">
                  <span className="dim">Your note</span>
                  <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="What works, what to change…" rows={4} />
                </label>
                <div className="row wrap">
                  <button onClick={() => save(branch, { note })} disabled={note === (branch.note ?? "")}>Save note</button>
                  <span className="spacer" />
                  <button onClick={() => save(branch, { status: "dropped" })} className="danger">Drop</button>
                  <button onClick={() => save(branch, { status: "final" })}>Mark final</button>
                  <button className="primary" onClick={() => save(branch, { status: "chosen" })}>Pick this one</button>
                </div>
                {playable(p, branch) && <p className="hint">Playing a light preview. Full quality: {playable(p, branch)!.original}</p>}
              </div>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
