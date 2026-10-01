"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** First run: the app does not know where the videos live yet. */
export default function Setup({ suggested, folders }: { suggested: string; folders: string[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [path, setPath] = useState("");

  const go = async (body: { action: "default" | "choose" | "path"; path?: string }) => {
    setBusy(body.action);
    setErr("");
    const res = await (await fetch("/api/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
    setBusy("");
    if (res.error) return setErr(res.error);
    if (res.workspace) router.refresh();
  };

  return (
    <main className="home setup">
      <h1>Welcome to Studio</h1>
      <p className="dim">One thing to set: the folder your videos live in. Studio keeps everything there — footage, renders, LUTs and the cut data — and adds these sub-folders if they are missing: {folders.map((f) => `${f}/`).join(" · ")}. Nothing already in the folder is changed.</p>
      <div className="cards">
        <button className="card" disabled={!!busy} onClick={() => go({ action: "default" })}>
          <b>{busy === "default" ? "Setting up…" : "Use the standard folder"}</b>
          <span>{suggested}</span>
          <em>Recommended. Created for you, ready to drop videos into.</em>
        </button>
        <button className="card" disabled={!!busy} onClick={() => go({ action: "choose" })}>
          <b>{busy === "choose" ? "Waiting for the folder window…" : "Choose a folder…"}</b>
          <span>Opens the Mac folder picker</span>
          <em>For an existing video-editing folder, or one on an external drive.</em>
        </button>
      </div>
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (path.trim()) go({ action: "path", path }); }}>
        <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="…or type a full path, e.g. /Volumes/Work/Video Editing" />
        <button type="submit" disabled={!!busy || !path.trim()}>Use this path</button>
      </form>
      {err && <p className="warn">{err}</p>}
      <p className="hint">You can change it later by editing ~/.video-studio/config.json.</p>
    </main>
  );
}
