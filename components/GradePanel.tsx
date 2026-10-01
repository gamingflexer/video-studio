"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Grade, Look, LutMeta } from "@/lib/types";
import { defaultGrade, sampleLut, type Lut3D } from "@/lib/color";
import CurveEditor from "./CurveEditor";

interface Props {
  grade: Grade;
  /** "film" = the grade every shot gets; "shot" = this shot's own grade */
  scope: "film" | "shot";
  shotLabel: string | null;
  canScopeShot: boolean;
  onScope: (s: "film" | "shot") => void;
  onClearShot: () => void;
  onChange: (g: Grade) => void;
  luts: LutMeta[];
  looks: Look[];
  lutData: Map<string, Lut3D>;
  needLut: (id: string) => void;
  snapshot: ImageData | null;
  comment: string;
  onComment: (c: string) => void;
  onLibrary: (luts: LutMeta[]) => void;
  onLooks: (looks: Look[]) => void;
}

const GROUPS: { id: LutMeta["group"]; name: string }[] = [
  { id: "house", name: "House looks" },
  { id: "web", name: "Free looks (CC0 / CC BY-SA)" },
  { id: "pack", name: "Your packs" },
  { id: "upload", name: "Uploaded" },
  { id: "studio", name: "Made here" },
];

function LutThumb({ snap, lut }: { snap: ImageData | null; lut: Lut3D | null | undefined }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !snap) return;
    c.width = snap.width;
    c.height = snap.height;
    const out = new ImageData(new Uint8ClampedArray(snap.data), snap.width, snap.height);
    if (lut) {
      const px = new Float32Array(3), d = out.data;
      for (let i = 0; i < d.length; i += 4) {
        sampleLut(lut, d[i] / 255, d[i + 1] / 255, d[i + 2] / 255, px);
        d[i] = px[0] * 255;
        d[i + 1] = px[1] * 255;
        d[i + 2] = px[2] * 255;
      }
    }
    c.getContext("2d")!.putImageData(out, 0, 0);
  }, [snap, lut]);
  return <canvas ref={ref} className="lut-pic" />;
}

function Slider({ label, value, min, max, step, neutral, fmt, onChange }: { label: string; value: number; min: number; max: number; step: number; neutral: number; fmt: (v: number) => string; onChange: (v: number) => void }) {
  return (
    <label className={`slider${value !== neutral ? " on" : ""}`}>
      <span onDoubleClick={() => onChange(neutral)} title="double-click to reset">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(+e.target.value)} onDoubleClick={() => onChange(neutral)} />
      <output>{fmt(value)}</output>
    </label>
  );
}

const signed = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(2)}`;

export default function GradePanel(p: Props) {
  const g = p.grade;
  const set = (patch: Partial<Grade>) => p.onChange({ ...g, ...patch });
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");

  // thumbnails need every LUT's data; ask for them once the panel is open
  useEffect(() => {
    for (const l of p.luts) if (!p.lutData.has(l.id)) p.needLut(l.id);
  }, [p.luts, p.lutData, p.needLut]);

  const histogram = useMemo(() => {
    if (!p.snapshot) return null;
    const r = new Uint32Array(256), gg = new Uint32Array(256), b = new Uint32Array(256), y = new Uint32Array(256), d = p.snapshot.data;
    for (let i = 0; i < d.length; i += 4) {
      r[d[i]]++;
      gg[d[i + 1]]++;
      b[d[i + 2]]++;
      y[Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2])]++;
    }
    return { r, g: gg, b, y };
  }, [p.snapshot]);

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy("Importing…");
    const form = new FormData();
    for (const f of files) form.append("file", f);
    try {
      const res = await (await fetch("/api/luts", { method: "POST", body: form })).json();
      p.onLibrary(res.luts);
      const bad = (res.failed as { name: string; error: string }[]).map((f) => `${f.name}: ${f.error}`);
      setMsg(`${res.added.length} LUT${res.added.length === 1 ? "" : "s"} added${bad.length ? ` · could not read ${bad.join("; ")}` : ""}`);
      if (res.added.length === 1) set({ lut: res.added[0].id });
    } catch (e) {
      setMsg(`Import failed: ${(e as Error).message}`);
    }
    setBusy("");
    if (file.current) file.current.value = "";
  };

  const [name, setName] = useState("");
  const post = async (url: string) => (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: name.trim(), grade: g }) })).json();

  /** "Create a new LUT": bakes primaries + LUT + curves into one .cube in luts/ */
  const saveLut = async () => {
    setBusy("Saving LUT…");
    const res = await post("/api/luts/create");
    setBusy("");
    if (res.error) return setMsg(res.error);
    p.onLibrary(res.luts);
    setName("");
    setMsg(`Saved luts/${res.lut.file}${g.vignette ? " (the vignette is not part of a LUT)" : ""}`);
  };

  const saveLook = async () => {
    const res = await post("/api/looks");
    if (res.error) return setMsg(res.error);
    p.onLooks(res.looks);
    setMsg(`Look “${name.trim()}” saved — every control stays editable`);
    setName("");
  };

  const [confirming, setConfirming] = useState<string | null>(null);
  const remove = async (l: LutMeta) => {
    if (confirming !== l.id) return setConfirming(l.id); // first click arms, second deletes
    setConfirming(null);
    const res = await (await fetch(`/api/luts/${l.id}`, { method: "DELETE" })).json();
    if (res.luts) p.onLibrary(res.luts);
    if (g.lut === l.id) set({ lut: null });
    setMsg(`Removed “${l.name}” (luts/${l.file})`);
  };

  const active = p.luts.find((l) => l.id === g.lut);

  return (
    <div className="panel">
      <div className="seg">
        <button className={p.scope === "film" ? "on" : ""} onClick={() => p.onScope("film")}>Whole film</button>
        <button className={p.scope === "shot" ? "on" : ""} disabled={!p.canScopeShot} onClick={() => p.onScope("shot")} title={p.canScopeShot ? "" : "select a shot first"}>
          {p.shotLabel ? `Only shot ${p.shotLabel}` : "Only this shot"}
        </button>
      </div>

      <h4>1 · Primaries <small>before the LUT</small></h4>
      <Slider label="Exposure" value={g.exposure} min={-2} max={2} step={0.01} neutral={0} fmt={signed} onChange={(v) => set({ exposure: v })} />
      <Slider label="Contrast" value={g.contrast} min={-1} max={1} step={0.01} neutral={0} fmt={signed} onChange={(v) => set({ contrast: v })} />
      <Slider label="Saturation" value={g.saturation} min={0} max={2} step={0.01} neutral={1} fmt={(v) => v.toFixed(2)} onChange={(v) => set({ saturation: v })} />
      <Slider label="Temperature" value={g.temperature} min={-1} max={1} step={0.01} neutral={0} fmt={signed} onChange={(v) => set({ temperature: v })} />
      <Slider label="Tint" value={g.tint} min={-1} max={1} step={0.01} neutral={0} fmt={signed} onChange={(v) => set({ tint: v })} />

      <h4>2 · LUT <small>{active ? active.name : "none"}</small></h4>
      <Slider label="Intensity" value={g.intensity} min={0} max={1} step={0.01} neutral={0.6} fmt={(v) => `${Math.round(v * 100)} %`} onChange={(v) => set({ intensity: v })} />
      <div className="lut-grid">
        <button className={`lut${g.lut === null ? " on" : ""}`} onClick={() => set({ lut: null })}>
          <LutThumb snap={p.snapshot} lut={null} />
          <span>None</span>
        </button>
      </div>
      {GROUPS.map((grp) => {
        const list = p.luts.filter((l) => l.group === grp.id);
        if (!list.length) return null;
        return (
          <div key={grp.id}>
            <div className="lut-group">{grp.name}</div>
            <div className="lut-grid">
              {list.map((l) => (
                <button key={l.id} className={`lut${g.lut === l.id ? " on" : ""}`} onClick={() => set({ lut: l.id })}
                  title={[l.look, l.licence && `Licence: ${l.licence}`, `${l.size}-point cube · luts/${l.file}`].filter(Boolean).join("\n")}>
                  <LutThumb snap={p.snapshot} lut={p.lutData.get(l.id)} />
                  <span>{l.name}</span>
                  {l.group !== "house" && <i className={`lut-x${confirming === l.id ? " arm" : ""}`} title="remove from library" onClick={(e) => { e.stopPropagation(); remove(l); }} onMouseLeave={() => setConfirming(null)}>{confirming === l.id ? "delete?" : "×"}</i>}
                </button>
              ))}
            </div>
          </div>
        );
      })}
      <div className="row">
        <input ref={file} type="file" multiple hidden accept=".cube,.3dl,.png,.tif,.tiff,.dat,.m3d,.csp,.zip" onChange={(e) => upload(e.target.files)} />
        <button onClick={() => file.current?.click()} disabled={!!busy}>Upload LUTs…</button>
        <span className="hint">.cube · .3dl · Hald .png · .dat · .m3d · .csp · .zip</span>
      </div>
      <p className="hint">{busy || msg || "Uploads are converted to a clean .cube in luts/, so ffmpeg, Resolve and Premiere can all load them."}</p>

      <h4>3 · Curves <small>after the LUT</small></h4>
      <div className="force-dark"><CurveEditor curves={g.curves} onChange={(curves) => set({ curves })} histogram={histogram} /></div>

      <h4>4 · Vignette</h4>
      <Slider label="Amount" value={g.vignette} min={0} max={1} step={0.01} neutral={0} fmt={(v) => `${Math.round(v * 100)} %`} onChange={(v) => set({ vignette: v })} />

      <h4>Save this grade</h4>
      <div className="row">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, e.g. Talking head warm" style={{ flex: 1 }} />
        <button onClick={saveLut} disabled={!name.trim() || !!busy} title="bake primaries + LUT + curves into one new .cube in luts/">As new LUT</button>
        <button onClick={saveLook} disabled={!name.trim() || !!busy} title="keep every control editable, like a PowerGrade">As look</button>
      </div>
      <div className="row wrap">
        {p.looks.map((l) => (
          <span key={l.id} className="chip">
            <button onClick={() => p.onChange({ ...l.grade })} title="apply this look">{l.name}</button>
            <i onClick={async () => { const res = await (await fetch(`/api/looks?id=${l.id}`, { method: "DELETE" })).json(); p.onLooks(res.looks); }} title="delete look">×</i>
          </span>
        ))}
        <button onClick={() => p.onChange(defaultGrade())}>Reset grade</button>
        {p.scope === "shot" && <button onClick={p.onClearShot}>Remove this shot’s grade</button>}
      </div>

      <h4>Note on colour <small>optional</small></h4>
      <textarea value={p.comment} onChange={(e) => p.onComment(e.target.value)} rows={2}
        placeholder="What should Claude know about the colour? e.g. keep skin warm, don't crush the lamp shot" />
    </div>
  );
}
