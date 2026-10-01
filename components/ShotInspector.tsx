"use client";

import { useEffect, useMemo, useState } from "react";
import type { EditDoc, Shot, SourceInfo } from "@/lib/types";
import { shotCommand, shotLength, timecode } from "@/lib/timeline";
import PromptBox from "./PromptBox";

interface Snippet {
  file: string;
  line: number;
  from: number;
  text: string;
}

interface Props {
  projectId: string;
  edit: EditDoc;
  shot: Shot;
  index: number;
  /** the same shot in Claude's edit.json, if it exists there */
  base: Shot | null;
  source: SourceInfo | null;
  changes: string[];
  onComment: (c: string) => void;
  /** saves the comment and hands this one shot to Claude Code; resolves to the status line + prompt */
  onSend: (comment: string, lines: number[]) => Promise<{ message: string; prompt: string }>;
  onClose: () => void;
  /** go to the previous (-1) or next (+1) shot without closing */
  onStep: (d: number) => void;
  total: number;
}

const strip = (s: Shot) => {
  const { comment: _c, grade: _g, ...rest } = s;
  return rest;
};

export default function ShotInspector(p: Props) {
  const { shot, base, edit } = p;
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [script, setScript] = useState<string | null>(null);
  const [comment, setComment] = useState(shot.comment ?? "");
  const [sent, setSent] = useState<{ message: string; prompt: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let dead = false;
    fetch(`/api/projects/${p.projectId}/code?shot=${encodeURIComponent(shot.id)}`)
      .then((r) => r.json())
      .then((d) => {
        if (dead) return;
        setSnippets(d.snippets ?? []);
        setScript(d.script ?? null);
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [p.projectId, shot.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") p.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [p]);

  const yours = useMemo(() => JSON.stringify(strip(shot), null, 2), [shot]);
  const claudes = useMemo(() => (base ? JSON.stringify(strip(base), null, 2) : null), [base]);
  const same = claudes === yours;
  const command = useMemo(() => shotCommand(shot, p.source?.abs ?? null, edit), [shot, p.source, edit]);

  const step = (d: number) => {
    if (comment !== (shot.comment ?? "")) p.onComment(comment); // keep what was typed
    p.onStep(d);
  };
  const save = () => {
    p.onComment(comment);
    p.onClose();
  };
  const send = async () => {
    setBusy(true);
    setSent(await p.onSend(comment, snippets.map((s) => s.line)));
    setBusy(false);
  };

  return (
    <div className="modal-back" onPointerDown={(e) => { if (e.target === e.currentTarget) p.onClose(); }}>
      <div className="modal" role="dialog" aria-label={`Shot ${p.index + 1}`}>
        <header>
          <span className="nav">
            <button onClick={() => step(-1)} disabled={p.index === 0} title="previous shot" aria-label="Previous shot">‹</button>
            <button onClick={() => step(1)} disabled={p.index >= p.total - 1} title="next shot" aria-label="Next shot">›</button>
          </span>
          <b>Shot {p.index + 1} of {p.total}</b>
          <span>{shot.label}</span>
          <button onClick={p.onClose} title="Esc">Close</button>
        </header>
        <div className="modal-body">
          <section>
            <h4>Why Claude cut it this way</h4>
            <p className="ai-note">{base?.note || shot.note || (base ? "No reason was recorded for this shot." : "You added this shot — it is not in Claude’s cut.")}</p>
            {(base?.considered || shot.considered) && <p className="ai-note"><b>Also considered</b>{base?.considered || shot.considered}</p>}
            {p.source?.note && <p className="ai-note"><b>About this take</b>{p.source.note}</p>}
            <dl className="facts">
              <dt>Source</dt><dd>{shot.source ?? "generated"}{p.source ? ` · ${p.source.width}×${p.source.height} · ${p.source.fps.toFixed(2)} fps · ${p.source.duration.toFixed(2)} s long${p.source.online ? "" : " · offline"}` : ""}</dd>
              {shot.source && <><dt>Used</dt><dd>{timecode(shot.in, p.source?.fps ?? edit.fps)} → {timecode(shot.out, p.source?.fps ?? edit.fps)} ({shot.in.toFixed(3)} → {shot.out.toFixed(3)} s){shot.speed !== 1 ? ` at ${shot.speed}×` : ""}</dd></>}
              <dt>On the timeline</dt><dd>{shotLength(shot).toFixed(2)} s · {Math.round(shotLength(shot) * edit.fps)} frames at {edit.fps} fps</dd>
              {shot.crop && <><dt>Crop</dt><dd>{shot.crop[0]}×{shot.crop[1]} at {shot.crop[2]},{shot.crop[3]}{shot.rotate ? ` · rotated ${shot.rotate}°` : ""}</dd></>}
              <dt>Your changes</dt><dd>{p.changes.length ? p.changes.join(" · ") : "none — same as Claude’s cut"}</dd>
            </dl>
          </section>

          <section>
            <h4>The cut as data <small>{edit.id} · edit.json → shots[id={shot.id}]</small></h4>
            <div className={`code-cols${same || !claudes ? " one" : ""}`}>
              {claudes && !same && <div><em>Claude’s cut (edit.json)</em><pre>{claudes}</pre></div>}
              <div><em>{same ? "edit.json (unchanged)" : "Your cut (edit.review.json)"}</em><pre>{yours}</pre></div>
            </div>
          </section>

          <section>
            <h4>In the build script <small>{script ?? "this project has no build script"}</small></h4>
            {snippets.map((s) => (
              <div key={s.line} className="snippet">
                <em>{s.file}:{s.line}</em>
                <pre>{s.text.split("\n").map((l, i) => <span key={i} className={s.from + i === s.line ? "hit" : ""}>{String(s.from + i).padStart(4)}  {l}{"\n"}</span>)}</pre>
              </div>
            ))}
            {script && !snippets.length && <p className="hint">No line in the script names this clip — it may be built from a list or generated.</p>}
            <em className="hint">Equivalent ffmpeg call (what the Studio render runs for this shot, before the grade)</em>
            <pre>{command}</pre>
          </section>

          <section>
            <h4>Your comment <small>optional</small></h4>
            <textarea autoFocus rows={3} value={comment} onChange={(e) => setComment(e.target.value)}
              placeholder="Why use it from here? e.g. start once the book is already down — the slide-in reads as a mistake" />
            <div className="row">
              <button onClick={save}>Save comment</button>
              <button className="primary" onClick={send} disabled={busy}>Send this shot to Claude Code</button>
              <span className="hint">Sends only this shot. The whole review goes from “Render &amp; send”.</span>
            </div>
            {sent && <p className="ok">{sent.message}</p>}
            {sent?.prompt && <PromptBox prompt={sent.prompt} rows={9} />}
          </section>
        </div>
      </div>
    </div>
  );
}
