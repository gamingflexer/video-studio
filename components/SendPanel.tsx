"use client";

import { useEffect, useRef, useState } from "react";
import type { ProjectPayload, RenderFile, Review } from "@/lib/types";
import { RENDER_PRESETS } from "@/lib/types";
import { copyText } from "@/lib/clipboard";
import PromptBox from "./PromptBox";

interface Job {
  id: string;
  status: "running" | "done" | "error";
  progress: number;
  step: string;
  output: string;
  error?: string;
}

interface Props {
  project: ProjectPayload;
  review: Review;
  renders: RenderFile[];
  viewing: string | null;
  changeCount: number;
  commentCount: number;
  onReview: (patch: Partial<Review>) => void;
  onView: (abs: string) => void;
  onRendersChanged: () => Promise<RenderFile[]>;
}

const mb = (n: number) => (n > 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(1)} MB`);

export default function SendPanel(p: Props) {
  const offline = p.project.sources.filter((s) => !s.online).length;
  const [mode, setMode] = useState<"cut" | "regrade">(offline ? "regrade" : "cut");
  const [regradeFile, setRegradeFile] = useState<string>("");
  const [job, setJob] = useState<Job | null>(null);
  const [prompt, setPrompt] = useState("");
  const [sent, setSent] = useState("");
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);

  const pickable = p.renders.filter((r) => !r.name.includes("_studio_"));
  const regrade = regradeFile || pickable.find((r) => r.name.includes("nograde"))?.abs || pickable[0]?.abs || "";

  const render = async () => {
    setJob({ id: "", status: "running", progress: 0, step: "starting", output: "" });
    const res = await (await fetch("/api/render", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: p.project.edit.id, review: p.review, mode, renderFile: regrade }),
    })).json();
    if (res.error) return setJob({ id: "", status: "error", progress: 0, step: "", output: "", error: res.error });
    setJob(res);
    timer.current = setInterval(async () => {
      const j = (await (await fetch(`/api/render?id=${res.id}`)).json()) as Job;
      setJob(j);
      if (j.status !== "running") {
        clearInterval(timer.current!);
        timer.current = null;
        if (j.status === "done") {
          await p.onRendersChanged();
          p.onView(j.output);
        }
      }
    }, 500);
  };

  const send = async () => {
    setSent("Preparing…");
    const res = await (await fetch("/api/handoff", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: p.project.edit.id, review: p.review }),
    })).json();
    if (res.error) return setSent(res.error);
    setPrompt(res.prompt);
    setSent((await copyText(res.prompt))
      ? `Copied to the clipboard — paste it into Claude Code. Also saved as ${res.file}`
      : `Saved as ${res.file} — the browser blocked automatic copying, use the Copy button.`);
  };

  return (
    <div className="panel">
      <h4>Render here <small>straight cuts + grade{p.project.audioAbs ? " + audio bed" : ""}</small></h4>
      <div className="seg">
        <button className={mode === "cut" ? "on" : ""} onClick={() => setMode("cut")}>Cut from sources</button>
        <button className={mode === "regrade" ? "on" : ""} onClick={() => setMode("regrade")} disabled={!pickable.length}>Regrade a render</button>
      </div>
      {mode === "cut" && offline > 0 && <p className="warn">{offline} source{offline > 1 ? "s are" : " is"} offline — mount the drive, or regrade an existing render.</p>}
      {mode === "cut" && p.project.edit.build?.notes && <p className="hint">The Studio render has no transitions, text or effects — {p.project.edit.build.notes}</p>}
      {mode === "regrade" && (
        <>
          <select value={regrade} onChange={(e) => setRegradeFile(e.target.value)}>
            {pickable.map((r) => <option key={r.abs} value={r.abs}>{r.name}</option>)}
          </select>
          <p className="hint">Puts the film grade on a finished render (keeps its transitions and sound). Pick an ungraded one, or the look is applied twice.</p>
        </>
      )}
      <div className="presets">
        {RENDER_PRESETS.map((x) => (
          <label key={x.id} className={p.review.preset === x.id ? "on" : ""}>
            <input type="radio" name="preset" checked={p.review.preset === x.id} onChange={() => p.onReview({ preset: x.id })} />
            <b>{x.name}</b><span>{x.detail}</span>
          </label>
        ))}
      </div>
      <label className="check"><input type="checkbox" checked={p.review.applyGrade} onChange={(e) => p.onReview({ applyGrade: e.target.checked })} />Apply the grade (off = ungraded render of the same cut)</label>
      <div className="row">
        <button className="primary" onClick={render} disabled={job?.status === "running" || (mode === "regrade" && !regrade)}>Render</button>
        {job?.status === "running" && <span className="progress"><i style={{ width: `${Math.round(job.progress * 100)}%` }} /><em>{Math.round(job.progress * 100)} % · {job.step}</em></span>}
      </div>
      {job?.status === "error" && <p className="warn">Render failed: {job.error}</p>}
      {job?.status === "done" && <p className="ok">Rendered {job.output.split("/").pop()} — now showing in the monitor.</p>}

      <h4>Renders <small>{p.renders.length}</small></h4>
      <ul className="renders">
        {p.renders.map((r) => (
          <li key={r.abs} className={p.viewing === r.abs ? "on" : ""} onClick={() => p.onView(r.abs)} title="open in the monitor">
            <span>{r.name}</span><small>{mb(r.size)} · {new Date(r.mtime).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</small>
          </li>
        ))}
        {!p.renders.length && <li className="empty">nothing rendered yet</li>}
      </ul>

      <h4>Send to Claude Code <small>{p.changeCount} edit{p.changeCount === 1 ? "" : "s"} · {p.commentCount} comment{p.commentCount === 1 ? "" : "s"} · grade</small></h4>
      <p className="hint">Writes your cut, comments and the baked grade into the project folder and copies one prompt. Paste it into Claude Code to get the full-quality version (transitions, text, sound) rebuilt from your review.</p>
      <div className="row"><button className="primary" onClick={send}>Send to Claude Code</button></div>
      {sent && <p className="ok">{sent}</p>}
      {prompt && <PromptBox prompt={prompt} rows={12} />}
    </div>
  );
}
