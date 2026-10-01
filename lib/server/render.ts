import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Grade, RenderPresetId, Review, Shot } from "../types";
import { bakeGrade, isNeutral, serializeCube, vignetteAngle } from "../color";
import { gradeCubeName, layout } from "../timeline";
import { loadLut } from "./luts";
import { loadProject } from "./projects";
import { bin, ensureDir, slugify, tmpDir } from "./paths";

export interface RenderJob {
  id: string;
  project: string;
  status: "running" | "done" | "error";
  progress: number;
  step: string;
  output: string;
  error?: string;
  startedAt: number;
}

const g = globalThis as unknown as { __studioJobs?: Map<string, RenderJob>; __studioSeq?: number };
const jobs = (g.__studioJobs ??= new Map<string, RenderJob>());
/** output paths of renders still running, so two jobs never pick the same file name */
const busyOutputs = () => new Set([...jobs.values()].filter((j) => j.status === "running").map((j) => j.output));

export const getJob = (id: string) => jobs.get(id) ?? null;

function ff(args: string[], seconds: number, onProgress: (frac: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin("ffmpeg"), ["-v", "error", "-y", "-progress", "pipe:1", "-nostats", ...args]);
    let err = "";
    p.stdout.on("data", (d: Buffer) => {
      const m = [...d.toString().matchAll(/out_time_(?:us|ms)=(\d+)/g)].pop();
      if (m && seconds > 0) onProgress(Math.min(Number(m[1]) / 1e6 / seconds, 1));
    });
    p.stderr.on("data", (d) => (err = (err + d).slice(-4000)));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.trim().slice(-1200) || `ffmpeg exited ${code}`))));
  });
}

/**
 * Write the baked cube(s) for a review into `dir` and return their paths. Old studio-grade*.cube
 * files in that folder are removed first, so a cube on disk always belongs to the review it sits next to.
 */
export function writeGradeCubes(dir: string, review: Review): { main: string | null; shots: Record<string, string> } {
  ensureDir(dir);
  for (const f of fs.readdirSync(dir)) if (/^studio-grade(_.+)?\.cube$/.test(f)) fs.rmSync(path.join(dir, f), { force: true });
  const shots: Record<string, string> = {};
  let main: string | null = null;
  // a grade whose LUT has been deleted from the library has no LUT
  const hasCube = (gr: Grade) => !isNeutral({ ...gr, vignette: 0, lut: loadLut(gr.lut) ? gr.lut : null });
  if (hasCube(review.grade)) {
    main = path.join(dir, gradeCubeName());
    fs.writeFileSync(main, serializeCube(bakeGrade(review.grade, loadLut(review.grade.lut)), "Studio grade"));
  }
  for (const s of review.shots) {
    if (!s.grade) continue;
    shots[s.id] = path.join(dir, gradeCubeName(s.id));
    fs.writeFileSync(shots[s.id], serializeCube(bakeGrade(s.grade, loadLut(s.grade.lut)), `Studio grade ${s.id}`));
  }
  return { main, shots };
}

interface Out {
  w: number;
  h: number;
  ext: string;
  video: string[];
  audio: string[];
}

function target(preset: RenderPresetId, w: number, h: number): Out {
  const even = (n: number) => Math.round(n / 2) * 2;
  const short = Math.min(w, h);
  const scaleTo = (s: number) => ({ w: even((w * s) / short), h: even((h * s) / short) });
  const tags = ["-pix_fmt", "yuv420p", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"];
  if (preset === "preview") return { ...scaleTo(Math.min(720, short)), ext: "mp4", video: ["-c:v", "libx264", "-preset", "veryfast", "-crf", "24", ...tags], audio: ["-c:a", "aac", "-b:a", "128k"] };
  // Final / 4K follow the workspace export standard (start.md §0c): H.264 High, CRF 10, preset slow, AAC 256k
  const std = ["-c:v", "libx264", "-profile:v", "high", "-preset", "slow", "-crf", "10", ...tags];
  if (preset === "uhd") return { ...scaleTo(2160), ext: "mp4", video: std, audio: ["-c:a", "aac", "-b:a", "256k"] };
  if (preset === "master") return { w: even(w), h: even(h), ext: "mov", video: ["-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le", "-vendor", "apl0"], audio: ["-c:a", "pcm_s16le"] };
  return { w: even(w), h: even(h), ext: "mp4", video: std, audio: ["-c:a", "aac", "-b:a", "256k"] };
}

const TRANSPOSE: Record<number, string> = { 90: "transpose=1", 180: "hflip,vflip", 270: "transpose=2" };

export interface RenderRequest {
  project: string;
  review: Review;
  /** "cut": conform every shot from its source. "regrade": put the grade on an existing render. */
  mode: "cut" | "regrade";
  renderFile?: string;
}

export async function startRender(req: RenderRequest): Promise<RenderJob> {
  const p = await loadProject(req.project);
  if (!p) throw new Error("unknown project");
  const { edit } = p;
  const review = req.review;
  const out = target(review.preset, edit.width, edit.height);
  const rendersDir = ensureDir(path.resolve(p.dirAbs, edit.rendersDir ?? "renders"));
  const tag = `${slugify(edit.id)}_studio_${review.preset}${review.applyGrade ? "" : "_nograde"}`;
  let n = 1;
  const taken = busyOutputs();
  while (fs.existsSync(path.join(rendersDir, `${tag}_v${n}.${out.ext}`)) || taken.has(path.join(rendersDir, `${tag}_v${n}.${out.ext}`))) n++;
  const output = path.join(rendersDir, `${tag}_v${n}.${out.ext}`);
  g.__studioSeq = (g.__studioSeq ?? 0) + 1;
  const job: RenderJob = { id: `${Date.now()}-${g.__studioSeq}`, project: req.project, status: "running", progress: 0, step: "starting", output, startedAt: Date.now() };
  jobs.set(job.id, job);

  const work = tmpDir("studio-render-");
  // Cubes for this render live in the temp folder (lut3d wants a path without quotes or colons, and a
  // trial render must not touch the cubes a hand-off wrote into <project>/grade/).
  const cubes = review.applyGrade ? writeGradeCubes(path.join(work, "grade"), review) : { main: null, shots: {} as Record<string, string> };
  const gradeFilters = (shot?: Shot) => {
    if (!review.applyGrade) return [] as string[];
    const cube = shot?.grade ? cubes.shots[shot.id] : cubes.main;
    const gr = shot?.grade ?? review.grade;
    const fl: string[] = [];
    if (cube) fl.push("format=gbrp16le", `lut3d=file=${cube}:interp=tetrahedral`);
    // in RGB, like the monitor: on YUV the filter would also scale the black offset and come out darker
    if (gr.vignette > 0) fl.push("format=rgb24", `vignette=angle=${vignetteAngle(gr.vignette).toFixed(4)}`);
    return fl;
  };
  // every segment leaves as limited-range bt709, whatever came in (stills are often full-range)
  const finish = ["scale=out_color_matrix=bt709:out_range=tv"];
  const rangeTag = ["-color_range", "tv"];

  (async () => {
    if (req.mode === "regrade") {
      const src = p.renders.find((r) => r.abs === req.renderFile);
      if (!src) throw new Error("pick one of this project's renders to regrade");
      const { probe } = await import("./media");
      const info = await probe(src.abs);
      job.step = "grading the render";
      const vf = [`scale=${out.w}:${out.h}:force_original_aspect_ratio=decrease:flags=lanczos`, `pad=${out.w}:${out.h}:(ow-iw)/2:(oh-ih)/2`, ...gradeFilters(), ...finish].join(",");
      await ff(["-i", src.abs, "-vf", vf, ...out.video, ...rangeTag, ...(info.hasAudio ? out.audio : ["-an"]), ...(out.ext === "mp4" ? ["-movflags", "+faststart"] : []), output],
        info.duration, (f) => (job.progress = f));
      return;
    }

    const { placed, total } = layout(review.shots);
    // whole frames per shot, rounded on the running total so the cuts never drift against the audio
    const frameAt = (t: number) => Math.round(t * edit.fps + 1e-6);
    const totalFrames = frameAt(total);
    if (!placed.length || totalFrames <= 0) throw new Error("the timeline is empty");
    for (const { shot, index } of placed) {
      if (!shot.source) continue;
      const src = p.sources.find((s) => s.id === shot.source);
      if (!src?.online) throw new Error(`source ${shot.source} is offline (${src?.abs ?? "not listed"}) — mount it, or regrade an existing render instead`);
      if (shot.out > src.duration + 0.05 || shot.in < 0 || shot.out <= shot.in)
        throw new Error(`shot ${index + 1} "${shot.label}" asks for ${shot.in.toFixed(2)}–${shot.out.toFixed(2)} s but ${shot.source} is ${src.duration.toFixed(2)} s long`);
    }
    const segs: string[] = [];
    for (const { shot, index, start, end } of placed) {
      const frames = frameAt(end) - frameAt(start);
      if (frames <= 0) continue;
      const len = frames / edit.fps;
      job.step = `shot ${index + 1} of ${placed.length} — ${shot.label}`;
      const seg = path.join(work, `seg${String(index).padStart(3, "0")}.${out.ext}`);
      const fit = [`scale=${out.w}:${out.h}:force_original_aspect_ratio=increase:flags=lanczos`, `crop=${out.w}:${out.h}`, "setsar=1"];
      let input: string[];
      const vf: string[] = [];
      if (shot.source) {
        const src = p.sources.find((s) => s.id === shot.source)!;
        input = ["-ss", shot.in.toFixed(4), "-t", (shot.out - shot.in + 0.1).toFixed(4), "-i", src.abs];
        if (shot.rotate && TRANSPOSE[shot.rotate]) vf.push(TRANSPOSE[shot.rotate]);
        if (shot.crop) vf.push(`crop=${shot.crop.join(":")}`);
        vf.push(`setpts=PTS/${shot.speed || 1}`);
      } else {
        const still = shot.image ? path.resolve(p.dirAbs, shot.image) : null;
        input = still && fs.existsSync(still) ? ["-loop", "1", "-t", (len + 1).toFixed(4), "-i", still] : ["-f", "lavfi", "-t", (len + 1).toFixed(4), "-i", `color=c=black:s=${out.w}x${out.h}`];
      }
      // tpad holds the last frame if the source runs out a frame early; -frames:v makes the count exact
      vf.push(`fps=${edit.fps}`, "tpad=stop_mode=clone:stop_duration=1", ...fit, ...gradeFilters(shot), ...finish);
      const base = frameAt(start) / totalFrames;
      await ff([...input, "-an", "-vf", vf.join(","), "-frames:v", String(frames), ...out.video, ...rangeTag, seg], len, (f) => (job.progress = (base + (f * frames) / totalFrames) * 0.94));
      segs.push(seg);
    }
    if (!segs.length) throw new Error("the timeline is empty");
    job.step = "joining";
    const list = path.join(work, "list.txt");
    fs.writeFileSync(list, segs.map((s) => `file '${s}'`).join("\n"));
    // the picture decides the length: a short audio bed just ends, a long one is cut at the last frame
    const audio = p.audioAbs ? ["-i", p.audioAbs, "-map", "0:v:0", "-map", "1:a:0?", ...out.audio] : ["-map", "0:v:0"];
    await ff(["-f", "concat", "-safe", "0", "-i", list, ...audio, "-c:v", "copy", "-t", (totalFrames / edit.fps).toFixed(4), ...(out.ext === "mp4" ? ["-movflags", "+faststart"] : []), output], total, () => {});
  })()
    .then(() => {
      job.status = "done";
      job.progress = 1;
      job.step = "done";
    })
    .catch((e: Error) => {
      job.status = "error";
      job.error = e.message;
      fs.rmSync(output, { force: true });
    })
    .finally(() => fs.rmSync(work, { recursive: true, force: true }));
  return job;
}
