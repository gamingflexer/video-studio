"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Grade, Look, LutMeta, ProjectPayload, RenderFile, Review, Shot, SourceInfo } from "@/lib/types";
import { BAKE_SIZE, bakeGrade, defaultGrade, identityLut, isNeutral, normalizeGrade, type Lut3D } from "@/lib/color";
import { GradeRenderer, IDENTITY_UV, type UV } from "@/lib/gl";
import { diffShots, layout, markTime, reviewCounts, shotAt, shotLength, timecode, type Placed } from "@/lib/timeline";
import Timeline, { type Clock, type SourceMedia } from "./Timeline";
import GradePanel from "./GradePanel";
import ShotPanel from "./ShotPanel";
import SendPanel from "./SendPanel";
import ShotInspector from "./ShotInspector";
import ThemeToggle from "./ThemeToggle";
import { copyText } from "@/lib/clipboard";

const mediaUrl = (abs: string) => `/api/media?path=${encodeURIComponent(abs)}`;
const newId = () => `n${Date.now().toString(36)}${Math.floor(Math.random() * 36).toString(36)}`;
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

type Mode = { kind: "edit" } | { kind: "render"; abs: string } | { kind: "source"; sourceId: string };

interface Slot {
  el: HTMLVideoElement;
  /** shot id (edit mode) or "file" */
  key: string | null;
  url: string | null;
}

interface PendingNote {
  shotId: string;
  kind: "trimmed" | "slipped" | "moved" | "added" | "removed" | "split";
  label: string;
}

/** Where on the source picture each corner of the output frame lands (crop, extra rotation, centre-fill). */
function shotUV(shot: Shot, src: SourceInfo, aspect: number): UV {
  const rot = shot.rotate ?? 0;
  const [Wr, Hr] = rot % 180 ? [src.height, src.width] : [src.width, src.height];
  let [w, h, x, y] = shot.crop ?? [Wr, Hr, 0, 0];
  if (w / h > aspect) {
    const nw = h * aspect;
    x += (w - nw) / 2;
    w = nw;
  } else {
    const nh = w / aspect;
    y += (h - nh) / 2;
    h = nh;
  }
  const a = w / Wr, b = x / Wr, c = h / Hr, d = y / Hr;
  if (rot === 90) return [0, c, d, -a, 0, 1 - b];
  if (rot === 180) return [-a, 0, 1 - b, 0, -c, 1 - d];
  if (rot === 270) return [0, -c, 1 - d, a, 0, b];
  return [a, 0, b, 0, c, d];
}

export default function Studio({ id }: { id: string }) {
  const [project, setProject] = useState<ProjectPayload | null>(null);
  const [error, setError] = useState("");
  const [review, setReviewState] = useState<Review | null>(null);
  const [luts, setLuts] = useState<LutMeta[]>([]);
  const [looks, setLooks] = useState<Look[]>([]);
  const [lutData, setLutData] = useState<Map<string, Lut3D>>(new Map());
  const [media, setMedia] = useState<Record<string, SourceMedia | undefined>>({});
  const [proxyNote, setProxyNote] = useState("");
  const [renders, setRenders] = useState<RenderFile[]>([]);
  const [tab, setTab] = useState<"colour" | "cut" | "send">("colour");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setModeState] = useState<Mode>({ kind: "edit" });
  const [playing, setPlayingState] = useState(false);
  const [gradeOn, setGradeOn] = useState(true);
  const [split, setSplit] = useState(false);
  const [scope, setScope] = useState<"film" | "shot">("film");
  const [snapshot, setSnapshot] = useState<ImageData | null>(null);
  const [pending, setPending] = useState<PendingNote | null>(null);
  const [pendingText, setPendingText] = useState("");
  const [saved, setSaved] = useState<"saved" | "saving" | "dirty">("saved");
  const [glError, setGlError] = useState("");
  const [inspectId, setInspectId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [showKeys, setShowKeys] = useState(false);

  const canvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<GradeRenderer | null>(null);
  const slots = useRef<Slot[]>([]);
  const activeIdx = useRef(0);
  const audio = useRef<HTMLAudioElement | null>(null);
  const images = useRef<Map<string, HTMLImageElement>>(new Map());
  const clock = useRef<Clock>({ mode: "edit", t: 0, sourceId: null, sourceT: 0 });
  const fileSeek = useRef<number | null>(null);
  const tcRef = useRef<HTMLSpanElement>(null);
  const shotRef = useRef<HTMLSpanElement>(null);
  const whyRef = useRef<HTMLSpanElement>(null);
  const history = useRef<{ stack: Review[]; redo: Review[]; last: number; tag: string }>({ stack: [], redo: [], last: 0, tag: "" });
  const lutRequested = useRef<Set<string>>(new Set());
  const drawOpts = useRef({ uv: IDENTITY_UV, gradeOn: true, split: 0, vignette: 0 });
  /** where the before | after line sits across the picture, 0..1 */
  const splitPos = useRef(0.5);
  const splitLine = useRef<HTMLDivElement>(null);

  // values the animation loop reads without re-subscribing
  const live = useRef({ review, project, media, mode, playing, gradeOn, split, placed: [] as Placed[], total: 0, baked: { main: identityLut(2), shots: new Map<string, Lut3D>() } });
  const lay = useMemo(() => layout(review?.shots ?? []), [review?.shots]);
  live.current.review = review;
  live.current.project = project;
  live.current.media = media;
  live.current.mode = mode;
  live.current.playing = playing;
  live.current.gradeOn = gradeOn;
  live.current.split = split;
  live.current.placed = lay.placed;
  live.current.total = lay.total;

  // ------------------------------------------------------------------ load
  useEffect(() => {
    let dead = false;
    (async () => {
      const res = await fetch(`/api/projects/${id}`);
      if (!res.ok) return setError("This project could not be found. It may have been moved — go back to the list.");
      const p = (await res.json()) as ProjectPayload;
      const lib = await (await fetch("/api/luts")).json();
      if (dead) return;
      setProject(p);
      setRenders(p.renders);
      setLuts(lib.luts);
      setLooks(lib.looks);
      setReviewState(p.review ?? {
        shots: clone(p.edit.shots), grade: normalizeGrade(p.edit.grade), notes: "", gradeComment: "", removed: {},
        preset: "final", applyGrade: true, updatedAt: new Date().toISOString(),
      });
      document.title = `${p.edit.title} — Studio`;
      // sources offline (drive not mounted): open on the latest render instead of a black monitor
      if (p.sources.length && p.sources.every((s) => !s.online) && p.renders[0]) {
        setModeState({ kind: "render", abs: p.renders[0].abs });
        setGradeOn(/nograde/i.test(p.renders[0].abs));
      }
      // browser-friendly stand-ins for the camera originals, one at a time
      const online = p.sources.filter((s) => s.online);
      for (let i = 0; i < online.length; i++) {
        if (dead) return;
        setProxyNote(`Preparing proxies ${i + 1} / ${online.length}`);
        try {
          const r = await (await fetch("/api/proxy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: online[i].abs }) })).json();
          if (!r.error && !dead) setMedia((m) => ({ ...m, [online[i].id]: r }));
        } catch {
          /* leave this source without a proxy */
        }
      }
      setProxyNote("");
    })();
    return () => {
      dead = true;
    };
  }, [id]);

  // ------------------------------------------------------------------ review state, undo, autosave
  const reviewRef = useRef<Review | null>(null);
  reviewRef.current = review;
  /** `tag` groups a continuous gesture (a drag, typing in one field) into a single undo step. */
  const update = useCallback((fn: (r: Review) => Review, tag = "") => {
    const prev = reviewRef.current;
    if (!prev) return;
    const now = Date.now(), h = history.current;
    if (!tag || tag !== h.tag || now - h.last > 700) {
      h.stack.push(prev);
      if (h.stack.length > 80) h.stack.shift();
    }
    h.redo = [];
    h.last = now;
    h.tag = tag;
    const next = fn(prev);
    reviewRef.current = next;
    setReviewState(next);
    setSaved("dirty");
  }, []);
  const undo = useCallback(() => {
    const prev = history.current.stack.pop();
    if (!prev) return;
    if (reviewRef.current) history.current.redo.push(reviewRef.current);
    history.current.last = 0;
    reviewRef.current = prev;
    setReviewState(prev);
    setPending(null);
    setSaved("dirty");
  }, []);

  const redo = useCallback(() => {
    const next = history.current.redo.pop();
    if (!next) return;
    if (reviewRef.current) history.current.stack.push(reviewRef.current);
    history.current.last = 0;
    reviewRef.current = next;
    setReviewState(next);
    setPending(null);
    setSaved("dirty");
  }, []);

  useEffect(() => {
    if (saved !== "dirty" || !review) return;
    const t = setTimeout(async () => {
      setSaved("saving");
      await fetch(`/api/projects/${id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(review) });
      setSaved((s) => (s === "saving" ? "saved" : s));
    }, 700);
    return () => clearTimeout(t);
  }, [review, saved, id]);

  // ------------------------------------------------------------------ LUT data + baked grades
  const needLut = useCallback((lutId: string) => {
    if (lutRequested.current.has(lutId)) return;
    lutRequested.current.add(lutId);
    (async () => {
      const res = await fetch(`/api/luts/${lutId}`);
      if (!res.ok) return;
      const size = Number(res.headers.get("X-Lut-Size"));
      const data = new Float32Array(await res.arrayBuffer());
      setLutData((m) => new Map(m).set(lutId, { size, data }));
    })();
  }, []);

  useEffect(() => {
    if (!review) return;
    const bake = (g: Grade) => {
      if (g.lut && !lutData.has(g.lut)) needLut(g.lut);
      return bakeGrade(g, g.lut ? lutData.get(g.lut) ?? null : null, BAKE_SIZE);
    };
    const shots = new Map<string, Lut3D>();
    for (const s of review.shots) if (s.grade) shots.set(s.id, bake(s.grade));
    live.current.baked = { main: bake(review.grade), shots };
  }, [review, lutData, needLut]);

  // ------------------------------------------------------------------ player
  const setMode = useCallback((m: Mode) => {
    setPlayingState(false);
    for (const s of slots.current) {
      s.el.pause();
      s.key = null;
    }
    audio.current?.pause();
    if (m.kind === "render") {
      fileSeek.current = clock.current.t;
      setGradeOn(/nograde/i.test(m.abs));
    } else if (m.kind === "edit") setGradeOn(true);
    setModeState(m);
  }, []);

  const setPlaying = useCallback((on: boolean) => {
    const L = live.current;
    if (on && L.mode.kind === "edit" && clock.current.t >= L.total - 0.02) clock.current.t = 0;
    setPlayingState(on);
  }, []);

  const seek = useCallback((t: number) => {
    const L = live.current;
    if (L.mode.kind === "source") setMode({ kind: "edit" });
    clock.current.t = Math.max(0, t);
    if (L.mode.kind === "render") fileSeek.current = t;
  }, [setMode]);

  const previewSource = useCallback((sourceId: string, t: number) => {
    const L = live.current;
    if (L.mode.kind !== "source" || L.mode.sourceId !== sourceId) setMode({ kind: "source", sourceId });
    clock.current.sourceId = sourceId;
    clock.current.sourceT = t;
    fileSeek.current = t;
  }, [setMode]);

  useEffect(() => {
    if (!project || !canvas.current) return;
    try {
      renderer.current = new GradeRenderer(canvas.current);
    } catch (e) {
      setGlError((e as Error).message);
      return;
    }
    slots.current = [0, 1].map(() => {
      const el = document.createElement("video");
      el.muted = true;
      el.playsInline = true;
      el.preload = "auto";
      return { el, key: null, url: null };
    });
    if (project.audioAbs) {
      audio.current = new Audio(mediaUrl(project.audioAbs));
      audio.current.preload = "auto";
    }
    const R = renderer.current;
    const aspect = project.edit.width / project.edit.height;
    let raf = 0, lastNow = performance.now(), lastShot = "";

    const size = (w: number, h: number) => {
      const k = Math.min(1, 900 / Math.min(w, h)), cw = Math.round(w * k), ch = Math.round(h * k), c = canvas.current!;
      if (c.width !== cw || c.height !== ch) {
        c.width = cw;
        c.height = ch;
      }
    };
    const assign = (slot: Slot, key: string, url: string, time: number, rate: number) => {
      if (slot.url !== url) {
        slot.el.src = url;
        slot.url = url;
      }
      slot.key = key;
      slot.el.playbackRate = rate;
      try {
        slot.el.currentTime = time;
      } catch {
        /* not seekable yet: the loop re-seeks */
      }
    };

    const tick = (now: number) => {
      const dt = Math.min((now - lastNow) / 1000, 0.25);
      lastNow = now;
      const L = live.current, C = clock.current, rev = L.review;
      const S = slots.current;
      let uv: UV = IDENTITY_UV, lut = L.baked.main, vig = rev?.grade.vignette ?? 0, label = "";
      C.mode = L.mode.kind;

      if (L.mode.kind === "edit" && rev) {
        size(project.edit.width, project.edit.height);
        if (L.playing) {
          C.t += dt;
          if (C.t >= L.total) {
            C.t = L.total;
            setPlayingState(false);
          }
        }
        C.t = Math.min(C.t, L.total);
        const cur = shotAt(L.placed, Math.min(C.t, Math.max(L.total - 1e-4, 0)));
        if (cur) {
          const shot = cur.shot;
          label = `${cur.index + 1} · ${shot.label}`;
          if (shot.grade) {
            lut = L.baked.shots.get(shot.id) ?? lut;
            vig = shot.grade.vignette;
          }
          const src = shot.source ? project.sources.find((s) => s.id === shot.source) : null;
          const m = src ? L.media[src.id] : null;
          if (shot.source && src && m) {
            if (S[activeIdx.current].key !== shot.id) {
              const other = 1 - activeIdx.current;
              if (S[other].key === shot.id) {
                S[activeIdx.current].el.pause();
                activeIdx.current = other;
              } else assign(S[activeIdx.current], shot.id, mediaUrl(m.proxy), shot.in, shot.speed || 1);
            }
            const a = S[activeIdx.current], el = a.el;
            const want = Math.min(Math.max(shot.in + (C.t - cur.start) * (shot.speed || 1), 0), Math.max(src.duration - 0.02, 0));
            el.playbackRate = shot.speed || 1;
            if (L.playing) {
              if (el.paused) el.play().catch(() => {});
              if (Math.abs(el.currentTime - want) > 0.3 && !el.seeking) el.currentTime = want;
            } else {
              if (!el.paused) el.pause();
              if (Math.abs(el.currentTime - want) > 0.008 && !el.seeking) el.currentTime = want;
            }
            // cue the next shot on the other element so the cut lands without a seek
            const next = L.placed[cur.index + 1];
            const nsrc = next?.shot.source ? L.media[next.shot.source] : null;
            const o = S[1 - activeIdx.current];
            if (next && nsrc && o.key !== next.shot.id) {
              o.el.pause();
              assign(o, next.shot.id, mediaUrl(nsrc.proxy), next.shot.in, next.shot.speed || 1);
            }
            uv = shotUV(shot, src, aspect);
            R.upload(el);
          } else {
            for (const s of S) if (!s.el.paused) s.el.pause();
            const still = shot.image ? mediaUrl(`${project.dirAbs}/${shot.image}`) : null;
            let img: HTMLImageElement | null = null;
            if (still) {
              img = images.current.get(still) ?? null;
              if (!img) {
                img = new Image();
                img.src = still;
                images.current.set(still, img);
              }
            }
            if (img && img.complete && img.naturalWidth) {
              uv = shotUV({ ...shot, crop: null, rotate: 0 }, { width: img.naturalWidth, height: img.naturalHeight } as SourceInfo, aspect);
              R.upload(img);
            } else R.upload(null);
          }
          if (shot.id !== lastShot) {
            lastShot = shot.id;
            if (shotRef.current) shotRef.current.textContent = label;
            // the reasoning for whatever is on screen, without having to click the shot
            if (whyRef.current) whyRef.current.textContent = shot.note?.trim() || (project.edit.shots.some((s) => s.id === shot.id) ? "No reason was recorded for this shot." : "You added this shot.");
          }
        } else R.upload(null);
        // audio bed follows the picture clock
        const au = audio.current;
        if (au) {
          if (L.playing && C.t < (au.duration || 1e9)) {
            if (au.paused) au.play().catch(() => {});
            if (Math.abs(au.currentTime - C.t) > 0.2) au.currentTime = C.t;
          } else if (!au.paused) au.pause();
        }
      } else if (L.mode.kind !== "edit") {
        const a = S[0], el = a.el;
        const file = L.mode.kind === "render" ? L.mode.abs : L.media[L.mode.sourceId]?.proxy ?? null;
        if (file) {
          const url = mediaUrl(file);
          if (a.url !== url || a.key !== "file") {
            a.el.muted = false;
            assign(a, "file", url, fileSeek.current ?? 0, 1);
          }
          if (fileSeek.current !== null && !el.seeking && el.readyState >= 1) {
            el.currentTime = Math.min(fileSeek.current, Math.max((el.duration || 1e9) - 0.03, 0));
            fileSeek.current = null;
          }
          if (L.playing) {
            if (el.ended) setPlayingState(false);
            else if (el.paused) el.play().catch(() => {});
          } else if (!el.paused) el.pause();
          if (L.mode.kind === "render") {
            if (fileSeek.current === null) C.t = el.currentTime;
            const cur = shotAt(L.placed, C.t);
            const lbl = cur ? `${cur.index + 1} · ${cur.shot.label}` : "";
            if (lbl !== lastShot) {
              lastShot = lbl;
              if (shotRef.current) shotRef.current.textContent = lbl;
            }
          } else {
            if (fileSeek.current === null) C.sourceT = el.currentTime;
            C.sourceId = L.mode.sourceId;
            const lbl = `source ${L.mode.sourceId}`;
            if (lbl !== lastShot) {
              lastShot = lbl;
              if (shotRef.current) shotRef.current.textContent = lbl;
            }
          }
          if (el.videoWidth) size(el.videoWidth, el.videoHeight);
          R.upload(el);
        } else R.upload(null);
      }
      for (const s of S) s.el.muted = !(L.mode.kind !== "edit" && s === S[0]);

      R.setLut(lut);
      drawOpts.current = { uv, gradeOn: L.gradeOn, split: L.split ? splitPos.current : 0, vignette: vig };
      R.draw(drawOpts.current);
      // the wipe line follows the picture, not the (wider) monitor area
      const line = splitLine.current, cv = canvas.current;
      if (line && cv) {
        line.style.left = `${cv.offsetLeft + splitPos.current * cv.clientWidth}px`;
        line.style.top = `${cv.offsetTop}px`;
        line.style.height = `${cv.clientHeight}px`;
      }
      if (tcRef.current) tcRef.current.textContent = timecode(L.mode.kind === "source" ? C.sourceT : C.t, project.edit.fps);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      for (const s of slots.current) {
        s.el.pause();
        s.el.removeAttribute("src");
        s.el.load();
      }
      audio.current?.pause();
      audio.current = null;
    };
  }, [project]);

  // ungraded still of the monitor for the LUT thumbnails and the histogram
  useEffect(() => {
    if (tab !== "colour") return;
    let lastKey = "";
    const grab = () => {
      const C = clock.current, key = `${C.mode}:${C.mode === "source" ? C.sourceT.toFixed(2) : C.t.toFixed(2)}:${JSON.stringify(drawOpts.current.uv)}`;
      if (key === lastKey && snapshotRef.current) return;
      const snap = renderer.current?.snapshot(drawOpts.current);
      if (snap) {
        lastKey = key;
        snapshotRef.current = snap;
        setSnapshot(snap);
      }
    };
    const t = setInterval(grab, 500);
    return () => clearInterval(t);
  }, [tab, project]);
  const snapshotRef = useRef<ImageData | null>(null);

  // ------------------------------------------------------------------ edits
  const baseById = useMemo(() => new Map((project?.edit.shots ?? []).map((s) => [s.id, s])), [project]);
  const changes = useMemo(() => (project && review ? diffShots(project.edit.shots, review.shots) : []), [project, review]);
  const changedIds = useMemo(() => new Set(changes.filter((c) => c.kind === "trimmed" || c.kind === "moved" || c.kind === "added").map((c) => c.shot.id)), [changes]);
  const marks = useMemo(() => (review?.marks ?? []).map((m) => ({ ...m, at: markTime(m, lay.placed) })).sort((a, b) => a.at - b.at), [review?.marks, lay.placed]);
  const counts = useMemo(() => (project && review ? reviewCounts(project.edit.shots, review) : { edits: 0, comments: 0 }), [project, review]);
  /** what the playhead is on, for the "comment at this moment" box */
  const nowAt = useCallback(() => {
    const L = live.current, t = clock.current.t;
    const q = L.mode.kind === "source" ? null : shotAt(L.placed, Math.min(t, Math.max(L.total - 1e-4, 0)));
    return { t, ok: L.mode.kind !== "source", label: L.mode.kind === "source" ? "raw footage — go back to the cut to comment" : q ? `shot ${q.index + 1} · ${q.shot.label}` : "" };
  }, []);
  const addMark = useCallback((text: string) => {
    const L = live.current, t = clock.current.t;
    const q = shotAt(L.placed, Math.min(t, Math.max(L.total - 1e-4, 0)));
    const sourceT = q?.shot.source ? +(q.shot.in + (t - q.start) * (q.shot.speed || 1)).toFixed(3) : undefined;
    update((r) => ({ ...r, marks: [...(r.marks ?? []), { id: newId(), t: +t.toFixed(3), text, shotId: q?.shot.id, sourceT }] }));
  }, [update]);
  const selected = review?.shots.find((s) => s.id === selectedId) ?? null;
  const selectedIndex = selected && review ? review.shots.indexOf(selected) : -1;

  const patchShot = useCallback((shotId: string, patch: Partial<Shot>) => {
    update((r) => ({ ...r, shots: r.shots.map((s) => (s.id === shotId ? { ...s, ...patch } : s)) }), `shot:${shotId}:${Object.keys(patch).join()}`);
  }, [update]);

  const ask = (shotId: string, kind: PendingNote["kind"]) => {
    const s = reviewRef.current?.shots.find((x) => x.id === shotId) ?? baseById.get(shotId);
    setPending({ shotId, kind, label: s?.label ?? shotId });
    setPendingText(kind === "removed" ? reviewRef.current?.removed?.[shotId] ?? "" : s?.comment ?? "");
  };

  const onTrim = useCallback((shotId: string, patch: { in?: number; out?: number }, edge: "in" | "out") => {
    patchShot(shotId, patch);
    setSelectedId(shotId);
    // show the frame being chosen: the new first frame, or the new last one
    const r = reviewRef.current;
    if (!r) return;
    const q = layout(r.shots).placed.find((x) => x.shot.id === shotId);
    if (q) {
      if (live.current.mode.kind !== "edit") setMode({ kind: "edit" });
      clock.current.t = edge === "in" ? q.start + 1e-3 : Math.max(q.end - 1.5 / (project?.edit.fps ?? 30), q.start);
    }
  }, [patchShot, project, setMode]);

  const reorder = useCallback((shotId: string, to: number) => {
    update((r) => {
      const shots = r.shots.filter((s) => s.id !== shotId), moved = r.shots.find((s) => s.id === shotId)!;
      shots.splice(to, 0, moved);
      return { ...r, shots };
    });
    setSelectedId(shotId);
    ask(shotId, "moved");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [update]);

  const addFromSource = useCallback((sourceId: string, t: number) => {
    const src = project?.sources.find((s) => s.id === sourceId);
    if (!src) return;
    const shot: Shot = { id: newId(), source: sourceId, in: +t.toFixed(3), out: +Math.min(t + 2, src.duration).toFixed(3), speed: 1, crop: null, label: `new shot from ${sourceId}`, note: "" };
    update((r) => {
      const sel = selectedId ? r.shots.findIndex((s) => s.id === selectedId) : -1;
      const at = sel >= 0 ? sel + 1 : r.shots.length;
      const shots = [...r.shots];
      shots.splice(at, 0, shot);
      return { ...r, shots };
    });
    setSelectedId(shot.id);
    setMode({ kind: "edit" });
    setTab("cut");
    setPending({ shotId: shot.id, kind: "added", label: shot.label });
    setPendingText("");
  }, [project, selectedId, update, setMode]);

  const removeShot = useCallback((shotId: string) => {
    const wasBase = baseById.has(shotId);
    update((r) => ({ ...r, shots: r.shots.filter((s) => s.id !== shotId) }));
    setSelectedId(null);
    if (wasBase) ask(shotId, "removed");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [update, baseById]);

  const splitShot = useCallback(() => {
    const r = reviewRef.current;
    if (!r) return;
    const q = shotAt(layout(r.shots).placed, clock.current.t);
    if (!q || !q.shot.source) return;
    const at = q.shot.in + (clock.current.t - q.start) * (q.shot.speed || 1);
    if (at - q.shot.in < 0.1 || q.shot.out - at < 0.1) return;
    const second: Shot = { ...clone(q.shot), id: newId(), in: +at.toFixed(3), comment: "", label: `${q.shot.label} (2)` };
    update((rv) => {
      const shots = [...rv.shots];
      shots.splice(q.index, 1, { ...q.shot, out: +at.toFixed(3) }, second);
      return { ...rv, shots };
    });
    setSelectedId(second.id);
    ask(q.shot.id, "split");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [update]);

  const savePending = () => {
    if (!pending) return;
    const text = pendingText.trim();
    if (pending.kind === "removed") update((r) => ({ ...r, removed: { ...(r.removed ?? {}), [pending.shotId]: text } }));
    else patchShot(pending.shotId, { comment: text });
    setPending(null);
  };

  /** Save a shot's comment and hand just that shot to Claude Code (prompt copied + written to STUDIO_HANDOFF.md). */
  const sendShot = useCallback(async (shotId: string, comment: string, lines: number[]) => {
    const r = reviewRef.current;
    if (!r) return { message: "Nothing to send", prompt: "" };
    const next = { ...r, shots: r.shots.map((s) => (s.id === shotId ? { ...s, comment } : s)) };
    update(() => next);
    try {
      const res = await (await fetch("/api/handoff", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: id, review: next, shotId, lines }) })).json();
      if (res.error) return { message: res.error as string, prompt: "" };
      setSaved("saved");
      return (await copyText(res.prompt))
        ? { message: `Copied to the clipboard — paste it into Claude Code. Also saved as ${res.file}`, prompt: res.prompt as string }
        : { message: `Saved as ${res.file} — the browser blocked automatic copying, use the Copy button.`, prompt: res.prompt as string };
    } catch (e) {
      return { message: `Could not send: ${(e as Error).message}`, prompt: "" };
    }
  }, [id, update]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", close);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  // grade being edited: the film's, or the selected shot's own
  const shotScoped = scope === "shot" && !!selected;
  const grade = shotScoped ? selected!.grade ?? review!.grade : review?.grade ?? defaultGrade();
  const setGrade = useCallback((g: Grade) => {
    if (scope === "shot" && selectedId) patchShot(selectedId, { grade: g });
    else update((r) => ({ ...r, grade: g }), "grade");
  }, [scope, selectedId, patchShot, update]);
  const changeScope = (s: "film" | "shot") => {
    if (s === "shot" && selected && !selected.grade) patchShot(selected.id, { grade: clone(review!.grade) });
    setScope(s);
  };
  useEffect(() => {
    setScope(selected?.grade ? "shot" : "film");
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ------------------------------------------------------------------ keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (document.querySelector(".modal-back")) return; // the shot inspector owns the keyboard while it is open
      if (e.defaultPrevented || el.closest("svg")) return; // the curve editor owns its own keys
      if (el.closest("input, textarea, select, [contenteditable]") && !(el instanceof HTMLInputElement && el.type === "range")) return;
      const fps = project?.edit.fps ?? 30;
      const cmd = e.metaKey || e.ctrlKey, key = e.key.toLowerCase();
      const editing = live.current.mode.kind === "edit";
      const under = () => (editing ? shotAt(live.current.placed, Math.min(clock.current.t, Math.max(live.current.total - 1e-4, 0))) : null);
      if (e.code === "Space") {
        e.preventDefault();
        setPlaying(!live.current.playing);
      } else if (!cmd && (key === "k" || key === "l")) {
        setPlaying(key === "l"); // K stop, L play
      } else if (cmd && (key === "k" || key === "b")) {
        // Premiere "Add Edit" (⌘K) / Final Cut "Blade" (⌘B)
        e.preventDefault();
        splitShot();
      } else if (!cmd && (key === "q" || key === "w")) {
        // Premiere ripple trim: Q = start of the shot to the playhead, W = end of the shot to the playhead
        const q = under();
        if (!q || !q.shot.source) return;
        const at = +(q.shot.in + (clock.current.t - q.start) * (q.shot.speed || 1)).toFixed(3);
        if (at - q.shot.in < 0.05 && key === "q") return;
        if (q.shot.out - at < 0.05 && key === "w") return;
        if (key === "q") {
          if (q.shot.out - at < 0.1) return;
          patchShot(q.shot.id, { in: at });
          clock.current.t = q.start;
        } else {
          if (at - q.shot.in < 0.1) return;
          patchShot(q.shot.id, { out: at });
          clock.current.t = Math.max(q.start + (at - q.shot.in) / (q.shot.speed || 1) - 1 / fps, q.start);
        }
        setSelectedId(q.shot.id);
        ask(q.shot.id, "trimmed");
      } else if (!cmd && key === "r") {
        // rename: the shot that is selected, or the one under the playhead
        const sid = selectedId ?? under()?.shot.id;
        if (!sid) return;
        e.preventDefault();
        setSelectedId(sid);
        setTab("cut");
        setTimeout(() => {
          const inp = document.querySelector<HTMLInputElement>(".title-input");
          inp?.focus();
          inp?.select();
        }, 60);
      } else if (key === "?" || (e.shiftKey && e.key === "/")) {
        setShowKeys((v) => !v);
      } else if (e.key === "Escape") {
        setShowKeys(false);
      } else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && editing) {
        // previous / next cut
        if (el instanceof HTMLInputElement) return;
        e.preventDefault();
        const t = clock.current.t, starts = [...live.current.placed.map((q) => q.start), live.current.total];
        const to = e.key === "ArrowDown" ? starts.find((s) => s > t + 1e-3) : [...starts].reverse().find((s) => s < t - 0.5 / fps);
        if (to !== undefined) seek(to);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        if (el instanceof HTMLInputElement) return;
        e.preventDefault();
        const d = (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 10 : 1) / fps;
        if (live.current.mode.kind === "source") previewSource(clock.current.sourceId!, Math.max(clock.current.sourceT + d, 0));
        else seek(Math.min(Math.max(clock.current.t + d, 0), live.current.mode.kind === "edit" ? live.current.total : 1e9));
      } else if (cmd && key === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if ((e.key === "Backspace" || e.key === "Delete") && selectedId) {
        e.preventDefault();
        removeShot(selectedId);
      } else if (e.key === "Enter" && selectedId) {
        e.preventDefault();
        setInspectId(selectedId);
      } else if (key === "m" && !cmd) {
        // Premiere's marker key: comment on this exact moment
        e.preventDefault();
        setTab("cut");
        setTimeout(() => document.getElementById("mark-input")?.focus(), 60);
      } else if (key === "s" && !cmd) splitShot();
      else if (key === "g" && !cmd) setGradeOn((v) => !v);
    };
    // Space is play/pause everywhere: stop a focused button from also "clicking" on key-up
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space" && (e.target as HTMLElement).closest("button")) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [project, selectedId, seek, previewSource, undo, removeShot, splitShot, setPlaying, patchShot, redo]); // eslint-disable-line react-hooks/exhaustive-deps

  const reloadRenders = useCallback(async () => {
    const p = (await (await fetch(`/api/projects/${id}`)).json()) as ProjectPayload;
    setRenders(p.renders);
    return p.renders;
  }, [id]);

  if (error) return <main className="center"><p>{error}</p><Link href="/">← All videos</Link></main>;
  if (!project || !review) return <main className="center"><p>Opening…</p></main>;

  const e = project.edit;
  const neutral = isNeutral(grade);
  const pendingVerb = { trimmed: "trimmed", slipped: "moved inside its take", moved: "moved", added: "added", removed: "removed", split: "split" }[pending?.kind ?? "trimmed"];

  return (
    <div className="studio">
      <header className="top">
        <Link href="/" className="back">← Videos</Link>
        <h1>{e.title}</h1>
        <span className="dim">{e.width}×{e.height} · {e.fps} fps · {project.dir}</span>
        <span className="spacer" />
        {proxyNote && <span className="pill busy">{proxyNote}</span>}
        <span className={`pill ${saved}`}>{saved === "saved" ? "Saved" : "Saving…"}</span>
        <button className={`pill tally${counts.edits + counts.comments ? " on" : ""}`} onClick={() => setTab("send")} title="what would go to Claude Code right now — click to review and send">
          <b>{counts.edits}</b> edit{counts.edits === 1 ? "" : "s"} · <b>{counts.comments}</b> comment{counts.comments === 1 ? "" : "s"}
        </button>
        <span className="hist">
          <button onClick={undo} disabled={!history.current.stack.length} title="Undo — step back (⌘Z)" aria-label="Undo">↶</button>
          <button onClick={redo} disabled={!history.current.redo.length} title="Redo — step forward (⇧⌘Z)" aria-label="Redo">↷</button>
        </span>
        <ThemeToggle />
      </header>

      <section className="stage">
        <div className="monitor-bar">
          <div className="seg">
            <button className={mode.kind === "edit" ? "on" : ""} onClick={() => setMode({ kind: "edit" })} title="your cut, played from the source clips with the grade live">Cut</button>
            <button className={mode.kind === "render" ? "on" : ""} disabled={!renders.length} onClick={() => setMode({ kind: "render", abs: renders[0].abs })} title="a finished render file">Render</button>
            <button className={mode.kind === "source" ? "on" : ""} disabled title="click a source lane below to look at raw footage">Source</button>
          </div>
          {mode.kind === "render" && (
            <select value={mode.abs} onChange={(ev) => setMode({ kind: "render", abs: ev.target.value })}>
              {renders.map((r) => <option key={r.abs} value={r.abs}>{r.name}</option>)}
            </select>
          )}
          <span className="spacer" />
          <button className={gradeOn ? "toggle on" : "toggle"} onClick={() => setGradeOn(!gradeOn)} title="G">Grade {gradeOn ? "on" : "off"}</button>
          <button className={split ? "toggle on" : "toggle"} onClick={() => setSplit(!split)} disabled={!gradeOn}>Before | After</button>
        </div>
        <div className="monitor">
          {glError ? <p className="warn">{glError}</p> : <canvas ref={canvas} onClick={() => setPlaying(!playing)} />}
          {split && gradeOn && (
            <div className="split-line" ref={splitLine} title="drag to compare · double-click to centre"
              onDoubleClick={() => (splitPos.current = 0.5)}
              onPointerDown={(ev) => { ev.preventDefault(); ev.currentTarget.setPointerCapture(ev.pointerId); }}
              onPointerMove={(ev) => {
                if (!ev.currentTarget.hasPointerCapture(ev.pointerId) || !canvas.current) return;
                const r = canvas.current.getBoundingClientRect();
                splitPos.current = Math.min(Math.max((ev.clientX - r.left) / r.width, 0.02), 0.98);
              }}>
              <span>before</span><span>after</span><i />
            </div>
          )}
          {mode.kind === "render" && gradeOn && !/nograde/i.test(mode.abs) && !neutral && <div className="monitor-note">Grade is being applied on top of a render that may already be graded</div>}
        </div>
        <div className="transport">
          <button className="play" onClick={() => setPlaying(!playing)} title="Space">{playing ? "❚❚" : "▶"}</button>
          <span className="tc" ref={tcRef}>00:00:00</span>
          <span className="now" ref={shotRef} />
          <span className="spacer" />
          <span className="dim keys">⌘K cut · Q / W trim to playhead · R rename · ⏎ details</span>
          <button onClick={() => setShowKeys(!showKeys)} title="?">Shortcuts</button>
          {showKeys && (
            <div className="keys-pop" onPointerDown={(ev) => ev.stopPropagation()}>
              {[
                ["Space  ·  K / L", "play / stop  ·  stop / play"],
                ["← →  ·  ⇧← ⇧→", "one frame  ·  ten frames"],
                ["↑ ↓", "previous / next cut"],
                ["⌘K  (also ⌘B, S)", "cut the shot at the playhead"],
                ["Q  ·  W", "trim the start / the end of the shot to the playhead"],
                ["R", "rename the shot"],
                ["M", "comment on this exact moment"],
                ["⏎", "shot details: reasoning, code, comment, send"],
                ["⌫", "remove the selected shot"],
                ["G", "grade on / off"],
                ["⌘Z  ·  ⇧⌘Z", "undo  ·  redo"],
              ].map(([k, d]) => <div key={k}><kbd>{k}</kbd><span>{d}</span></div>)}
            </div>
          )}
        </div>

        {mode.kind === "edit" && (
          <div className="why" title="Claude’s reason for the shot under the playhead — double-click the shot for the full details">
            <b>Why this cut</b><span ref={whyRef} />
          </div>
        )}

        {pending && (
          <form className="askbar" onSubmit={(ev) => { ev.preventDefault(); savePending(); }}>
            <span><b>{pending.label}</b> {pendingVerb}.</span>
            <input autoFocus value={pendingText} onChange={(ev) => setPendingText(ev.target.value)}
              placeholder={pending.kind === "removed" ? "Why drop it? (optional) e.g. nothing happens in this shot" : "Why use it from here? (optional) e.g. start once the book is already down"} />
            <button className="primary" type="submit">Save note</button>
            <button type="button" onClick={() => setPending(null)}>Skip</button>
          </form>
        )}

        <Timeline
          shots={review.shots} baseShots={e.shots} sources={project.sources} media={media} mediaUrl={mediaUrl}
          selectedId={selectedId} changedIds={changedIds} clock={clock} fps={e.fps}
          onSelect={(sid) => { setSelectedId(sid); if (sid) setTab((t) => (t === "send" ? "cut" : t)); }}
          onSeek={seek} onTrim={onTrim} onTrimEnd={(sid, kind) => ask(sid, kind)} onReorder={reorder}
          onSourcePreview={previewSource} onAddFromSource={addFromSource}
          onOpen={(sid) => { setSelectedId(sid); setInspectId(sid); }}
          onMenu={(sid, x, y) => { setSelectedId(sid); setMenu({ id: sid, x, y }); }}
          marks={marks}
        />
      </section>

      {menu && (() => {
        const shot = review.shots.find((s) => s.id === menu.id);
        if (!shot) return null;
        const item = (label: string, run: () => void, opts: { disabled?: boolean; danger?: boolean } = {}) => (
          <button className={opts.danger ? "danger" : ""} disabled={opts.disabled} onPointerDown={(ev) => ev.stopPropagation()} onClick={() => { setMenu(null); run(); }}>{label}</button>
        );
        return (
          <div className="ctx" style={{ left: Math.min(menu.x, window.innerWidth - 250), top: Math.min(menu.y, window.innerHeight - 230) }}>
            <em>Shot {review.shots.indexOf(shot) + 1} · {shot.label}</em>
            {item("See reasoning and code…", () => setInspectId(shot.id))}
            {item("Comment and send to Claude Code…", () => setInspectId(shot.id))}
            {item("Grade only this shot", () => { setTab("colour"); if (!shot.grade) patchShot(shot.id, { grade: clone(review.grade) }); setScope("shot"); })}
            {item("Split at playhead", splitShot, { disabled: !shot.source })}
            {item("Back to Claude’s cut", () => { const b = baseById.get(shot.id); if (b) patchShot(b.id, { in: b.in, out: b.out, speed: b.speed }); }, { disabled: !baseById.has(shot.id) })}
            {item("Remove shot", () => removeShot(shot.id), { danger: true })}
          </div>
        );
      })()}

      {inspectId && (() => {
        const shot = review.shots.find((s) => s.id === inspectId);
        if (!shot) return null;
        return (
          <ShotInspector key={shot.id} projectId={id} edit={e} shot={shot} index={review.shots.indexOf(shot)} base={baseById.get(shot.id) ?? null}
            source={shot.source ? project.sources.find((s) => s.id === shot.source) ?? null : null}
            changes={changes.find((c) => c.shot.id === shot.id)?.lines ?? []}
            onComment={(c) => patchShot(shot.id, { comment: c })}
            onSend={(c, lines) => sendShot(shot.id, c, lines)} onClose={() => setInspectId(null)}
            onStep={(d) => { const to = review.shots[review.shots.indexOf(shot) + d]; if (to) { setInspectId(to.id); setSelectedId(to.id); } }}
            total={review.shots.length} />
        );
      })()}

      <aside className="side">
        <nav className="tabs">
          <button className={tab === "colour" ? "on" : ""} onClick={() => setTab("colour")}>Colour</button>
          <button className={tab === "cut" ? "on" : ""} onClick={() => setTab("cut")}>Cut &amp; notes{counts.edits + counts.comments ? <i>{counts.edits + counts.comments}</i> : null}</button>
          <button className={tab === "send" ? "on" : ""} onClick={() => setTab("send")}>Render &amp; send</button>
        </nav>
        {tab === "colour" && (
          <GradePanel grade={grade} scope={shotScoped ? "shot" : "film"} shotLabel={selected ? String(selectedIndex + 1) : null} canScopeShot={!!selected}
            onScope={changeScope} onClearShot={() => { if (selected) patchShot(selected.id, { grade: null }); setScope("film"); }} onChange={setGrade} luts={luts} looks={looks} lutData={lutData} needLut={needLut} snapshot={snapshot}
            comment={review.gradeComment} onComment={(c) => update((r) => ({ ...r, gradeComment: c }), "gradeComment")} onLibrary={setLuts} onLooks={setLooks} />
        )}
        {tab === "cut" && (
          <ShotPanel shot={selected} index={selectedIndex} base={selected ? baseById.get(selected.id) ?? null : null}
            source={selected?.source ? project.sources.find((s) => s.id === selected.source) ?? null : null}
            changes={changes} review={review}
            onPatch={(patch) => selected && patchShot(selected.id, patch)}
            onReset={() => { const b = selected && baseById.get(selected.id); if (b) patchShot(b.id, { in: b.in, out: b.out, speed: b.speed }); }}
            onDelete={() => selected && removeShot(selected.id)} onSplit={splitShot}
            onNotes={(notes) => update((r) => ({ ...r, notes }), "notes")} onSelect={setSelectedId}
            reasoning={e.reasoning} unused={project.sources.filter((src) => !review.shots.some((sh) => sh.source === src.id)).map((src) => ({ id: src.id, note: src.note }))}
            now={nowAt} fps={e.fps} marks={marks} onAddMark={addMark} onSeek={seek}
            onRemoveMark={(mid) => update((r) => ({ ...r, marks: (r.marks ?? []).filter((m) => m.id !== mid) }))} />
        )}
        {/* stays mounted so a running render keeps its progress when you look at another tab */}
        <div style={{ display: tab === "send" ? "contents" : "none" }}>
          <SendPanel project={project} review={review} renders={renders} viewing={mode.kind === "render" ? mode.abs : null}
            changeCount={counts.edits} commentCount={counts.comments}
            onReview={(patch) => update((r) => ({ ...r, ...patch }))} onView={(abs) => setMode({ kind: "render", abs })} onRendersChanged={reloadRenders} />
        </div>
      </aside>
    </div>
  );
}
