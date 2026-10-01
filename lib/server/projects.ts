import fs from "node:fs";
import path from "node:path";
import type { EditDoc, ProjectPayload, RenderFile, Review, SourceInfo } from "../types";
import { normalizeGrade } from "../color";
import { LOOSE_PROJECTS, VIDEO_EXT, WORKSPACE_FOLDERS, bin, ensureDir, inside, rel, slugify, workspace } from "./paths";
import { probe, run } from "./media";

const SKIP = new Set(["node_modules", ".git", ".next", ".cache", "tools", "venv", "__pycache__"]);

function findEdits(dir: string, depth: number, out: string[]) {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isFile() && e.name === "edit.json") out.push(path.join(dir, e.name));
    else if (e.isDirectory() && depth > 0 && !SKIP.has(e.name) && !e.name.startsWith(".")) findEdits(path.join(dir, e.name), depth - 1, out);
  }
}

export interface ProjectRef {
  id: string;
  title: string;
  description?: string;
  dir: string;
  file: string;
  shots: number;
  width: number;
  height: number;
  mtime: number;
}

export function listProjects(): ProjectRef[] {
  const files: string[] = [];
  findEdits(workspace(), 5, files);
  // videos opened on their own live in the app folder, which may sit outside the workspace
  if (!inside(workspace(), LOOSE_PROJECTS)) findEdits(LOOSE_PROJECTS, 2, files);
  const refs: ProjectRef[] = [];
  for (const file of files) {
    try {
      const e = JSON.parse(fs.readFileSync(file, "utf8")) as EditDoc;
      if (!e.id || !Array.isArray(e.shots)) continue;
      const review = path.join(path.dirname(file), "edit.review.json");
      refs.push({
        id: e.id, title: e.title ?? e.id, description: e.description, dir: rel(path.dirname(file)), file,
        shots: e.shots.length, width: e.width, height: e.height,
        mtime: Math.max(fs.statSync(file).mtimeMs, fs.existsSync(review) ? fs.statSync(review).mtimeMs : 0),
      });
    } catch {
      /* not one of ours */
    }
  }
  return refs.sort((a, b) => b.mtime - a.mtime);
}

export function findProject(id: string): ProjectRef | null {
  return listProjects().find((p) => p.id === id) ?? null;
}

export const reviewPath = (ref: ProjectRef) => path.join(path.dirname(ref.file), "edit.review.json");

export async function loadProject(id: string): Promise<ProjectPayload | null> {
  const ref = findProject(id);
  if (!ref) return null;
  const dirAbs = path.dirname(ref.file);
  const edit = JSON.parse(fs.readFileSync(ref.file, "utf8")) as EditDoc;
  edit.shots = edit.shots.map((s) => ({ ...s, speed: s.speed || 1 }));
  if (edit.grade) edit.grade = normalizeGrade(edit.grade);

  const sources: SourceInfo[] = [];
  for (const s of edit.sources ?? []) {
    let abs = path.resolve(dirAbs, s.file);
    if (abs.includes("*") && fs.existsSync(path.dirname(abs))) {
      // "IMG_6647*.MOV": camera files that were renamed with a note after the number
      const [pre, post] = path.basename(abs).split("*");
      const hit = fs.readdirSync(path.dirname(abs)).find((n) => n.startsWith(pre) && n.endsWith(post ?? ""));
      if (hit) abs = path.join(path.dirname(abs), hit);
    }
    const used = edit.shots.filter((x) => x.source === s.id);
    const guess = Math.max(1, ...used.map((x) => x.out));
    let info: SourceInfo = { ...s, abs, online: false, duration: guess, width: edit.width, height: edit.height, fps: edit.fps };
    if (fs.existsSync(abs)) {
      try {
        const p = await probe(abs);
        info = { ...s, abs, online: true, duration: p.duration, width: p.width, height: p.height, fps: p.fps };
      } catch {
        /* unreadable file: keep it listed as offline */
      }
    }
    sources.push(info);
  }

  const rendersAbs = path.resolve(dirAbs, edit.rendersDir ?? "renders");
  const renders: RenderFile[] = [];
  if (fs.existsSync(rendersAbs)) {
    for (const name of fs.readdirSync(rendersAbs)) {
      if (!VIDEO_EXT.has(path.extname(name).toLowerCase()) || name.startsWith(".")) continue;
      const st = fs.statSync(path.join(rendersAbs, name));
      renders.push({ name, abs: path.join(rendersAbs, name), size: st.size, mtime: st.mtimeMs });
    }
    renders.sort((a, b) => b.mtime - a.mtime);
  }

  let review: Review | null = null;
  const rp = reviewPath(ref);
  if (fs.existsSync(rp)) {
    try {
      review = JSON.parse(fs.readFileSync(rp, "utf8")) as Review;
      review.grade = normalizeGrade(review.grade);
      review.shots = review.shots.map((s) => ({ ...s, grade: s.grade ? normalizeGrade(s.grade) : s.grade }));
    } catch {
      review = null;
    }
  }
  const audioAbs = edit.audio?.file ? path.resolve(dirAbs, edit.audio.file) : null;
  return { dir: ref.dir, dirAbs, edit, review, sources, renders, audioAbs: audioAbs && fs.existsSync(audioAbs) ? audioAbs : null };
}

export function saveReview(id: string, review: Review) {
  const ref = findProject(id);
  if (!ref) throw new Error("unknown project");
  if (!review || typeof review !== "object" || !Array.isArray(review.shots) || !review.grade || typeof review.grade !== "object")
    throw new Error("not a review: needs shots[] and a grade");
  if (review.shots.some((s) => !s || typeof s.id !== "string" || typeof s.label !== "string" || (s.source !== null && !(s.out > s.in))))
    throw new Error("not a review: every shot needs an id, a label and out > in");
  fs.writeFileSync(reviewPath(ref), JSON.stringify({ ...review, updatedAt: new Date().toISOString() }, null, 2));
}

/** Videos in the workspace that can be opened as a one-source project (renders, references, raw takes). */
export function listLooseVideos(limit = 60) {
  const out: { abs: string; rel: string; size: number; mtime: number }[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth > 0 && e.name !== "studio" && e.name !== "snapshots") walk(abs, depth - 1);
      } else if (VIDEO_EXT.has(path.extname(e.name).toLowerCase())) {
        const st = fs.statSync(abs);
        out.push({ abs, rel: rel(abs), size: st.size, mtime: st.mtimeMs });
      }
    }
  };
  walk(workspace(), 5);
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

/** The folders the home page's file browser starts from (the places footage and renders live). */
export const BROWSE_ROOTS = WORKSPACE_FOLDERS.filter((f) => f !== "luts");

export interface BrowseEntry {
  name: string;
  rel: string;
  kind: "dir" | "video";
  /** videos: bytes · folders: number of videos anywhere inside */
  size: number;
  mtime: number;
}

function countVideos(dir: string, depth = 6): number {
  let n = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
    if (e.isDirectory()) n += depth > 0 ? countVideos(path.join(dir, e.name), depth - 1) : 0;
    else if (VIDEO_EXT.has(path.extname(e.name).toLowerCase())) n++;
  }
  return n;
}

/** One folder of the browser: sub-folders that hold videos first, then the videos, both by name. `dir` "" = the roots. */
export function browse(dir: string): { dir: string; entries: BrowseEntry[] } {
  const clean = path.normalize(dir).replace(/^([/\\]|\.\.([/\\]|$))+/, "");
  const abs = path.resolve(workspace(), clean);
  const isRoot = clean === "" || clean === ".";
  if (!isRoot && !BROWSE_ROOTS.some((r) => clean === r || clean.startsWith(r + path.sep))) throw new Error("that folder is not part of the browser");
  const names = isRoot ? BROWSE_ROOTS.filter((r) => fs.existsSync(path.join(workspace(), r))) : fs.readdirSync(abs).filter((n) => !n.startsWith(".") && !SKIP.has(n));
  const entries: BrowseEntry[] = [];
  for (const name of names) {
    const full = path.join(isRoot ? workspace() : abs, name);
    let st: fs.Stats;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      const n = countVideos(full);
      if (n) entries.push({ name, rel: rel(full), kind: "dir", size: n, mtime: st.mtimeMs });
    } else if (VIDEO_EXT.has(path.extname(name).toLowerCase())) entries.push({ name, rel: rel(full), kind: "video", size: st.size, mtime: st.mtimeMs });
  }
  const order = (e: BrowseEntry) => (isRoot ? BROWSE_ROOTS.indexOf(e.name) : e.kind === "dir" ? 0 : 1);
  entries.sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { dir: isRoot ? "" : clean, entries };
}

/** Open any single video: one source, cuts found by scene detection (each is editable afterwards). */
export async function createLooseProject(file: string): Promise<string> {
  // opening the same file twice returns the project made the first time
  if (fs.existsSync(LOOSE_PROJECTS))
    for (const d of fs.readdirSync(LOOSE_PROJECTS)) {
      try {
        const e = JSON.parse(fs.readFileSync(path.join(LOOSE_PROJECTS, d, "edit.json"), "utf8")) as EditDoc;
        if (e.sources.length === 1 && path.resolve(LOOSE_PROJECTS, d, e.sources[0].file) === file) return e.id;
      } catch {
        /* not a project folder */
      }
    }
  const info = await probe(file);
  const base = slugify(path.basename(file, path.extname(file)));
  let id = base, n = 2;
  while (findProject(id) || fs.existsSync(path.join(LOOSE_PROJECTS, id))) id = `${base}-${n++}`;
  const { stderr } = await run(bin("ffmpeg"), ["-hide_banner", "-i", file, "-vf", "select='gt(scene,0.28)',showinfo", "-an", "-f", "null", "-"], { fullStderr: true });
  const cuts = [...stderr.matchAll(/pts_time:([0-9.]+)/g)].map((m) => +m[1]).filter((t) => t > 0.2 && t < info.duration - 0.2);
  const marks = [0, ...cuts.filter((t, i) => i === 0 || t - cuts[i - 1] > 0.2), info.duration];
  const dir = ensureDir(path.join(LOOSE_PROJECTS, id));
  const edit: EditDoc = {
    id,
    title: path.basename(file),
    description: `Opened from ${rel(file)} — cuts are scene-detection guesses.`,
    width: info.width, height: info.height, fps: Math.round(info.fps * 100) / 100,
    sources: [{ id: "video", file: path.relative(dir, file) }],
    shots: marks.slice(0, -1).map((t, i) => ({
      id: `s${i + 1}`, source: "video", in: +t.toFixed(3), out: +marks[i + 1].toFixed(3), speed: 1,
      label: `cut ${i + 1}`, note: i === 0 ? "start of the file" : "scene change detected here",
    })),
    audio: info.hasAudio ? { file: path.relative(dir, file) } : null,
    rendersDir: "renders",
  };
  fs.writeFileSync(path.join(dir, "edit.json"), JSON.stringify(edit, null, 2));
  return id;
}
