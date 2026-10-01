"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ProjectRef } from "@/lib/server/projects";
import ThemeToggle from "./ThemeToggle";
import Finder from "./Finder";

export default function Home({ projects, workspace }: { projects: ProjectRef[]; workspace: string }) {
  const router = useRouter();
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");

  const open = async (file: string) => {
    setBusy(file);
    setErr("");
    const res = await (await fetch("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ file }) })).json();
    if (res.id) router.push(`/p/${res.id}`);
    else {
      setErr(res.error ?? "Could not open that file");
      setBusy("");
    }
  };

  return (
    <main className="home">
      <div className="row"><h1>Studio</h1><span className="spacer" /><ThemeToggle /></div>
      <p className="dim">Grade with LUTs and curves, see and move Claude’s cuts, leave notes, render, and hand the review back to Claude Code.</p>

      <p className="hint">Video folder: {workspace}</p>

      <h2>Videos with a cut</h2>
      <div className="cards">
        {projects.map((p) => (
          <Link key={p.id} href={`/p/${p.id}`} className="card">
            <b>{p.title}</b>
            <span>{p.shots} shots · {p.width}×{p.height}</span>
            <small>{p.dir}</small>
            {p.description && <em>{p.description}</em>}
          </Link>
        ))}
        {!projects.length && <p className="dim">No edit.json found yet. Claude writes one next to each video’s build script.</p>}
      </div>

      <h2>Open any video</h2>
      <p className="dim">Browse the footage and render folders like Finder. Opening a video makes a one-source project (cuts guessed by scene detection) so you can grade it or mark it up.</p>
      <Finder onOpen={open} busy={busy} />
      {err && <p className="warn">{err}</p>}
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (path.trim()) open(path.trim()); }}>
        <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="…or paste a path from anywhere, e.g. /Volumes/MediaShare/…/clip.mov" />
        <button type="submit" disabled={!!busy || !path.trim()}>Open path</button>
      </form>
    </main>
  );
}
