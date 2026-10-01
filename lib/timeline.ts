import type { EditDoc, Grade, LutMeta, Mark, ProjectPayload, Review, Shot } from "./types";
import { RENDER_PRESETS } from "./types";
import { isNeutral } from "./color";

export const shotLength = (s: Shot) => (s.source ? Math.max((s.out - s.in) / (s.speed || 1), 0) : s.duration ?? 0);

export interface Placed {
  shot: Shot;
  index: number;
  start: number;
  end: number;
}

export function layout(shots: Shot[]): { placed: Placed[]; total: number } {
  let t = 0;
  const placed = shots.map((shot, index) => {
    const start = t;
    t += shotLength(shot);
    return { shot, index, start, end: t };
  });
  return { placed, total: t };
}

export function shotAt(placed: Placed[], t: number): Placed | null {
  if (!placed.length) return null;
  for (const p of placed) if (t < p.end) return p;
  return placed[placed.length - 1];
}

const f = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

/** Where a pinned comment sits now: it follows its shot's source frame when that is still in the cut. */
export function markTime(m: Mark, placed: Placed[]): number {
  const q = m.shotId ? placed.find((x) => x.shot.id === m.shotId) : null;
  if (q && m.sourceT !== undefined && q.shot.source && m.sourceT >= q.shot.in - 1e-3 && m.sourceT <= q.shot.out + 1e-3)
    return q.start + (m.sourceT - q.shot.in) / (q.shot.speed || 1);
  return m.t;
}

/** edits = cut changes Claude has to apply; comments = every note written (on shots, on moments, on removals, overall, on colour) */
export function reviewCounts(base: Shot[], review: Review) {
  const changes = diffShots(base, review.shots);
  const edits = changes.filter((c) => c.kind === "trimmed" || c.kind === "moved" || c.kind === "added" || c.kind === "removed").length;
  const removedIds = new Set(changes.filter((c) => c.kind === "removed").map((c) => c.shot.id));
  const comments =
    review.shots.filter((s) => s.comment?.trim()).length + (review.marks?.length ?? 0) +
    Object.entries(review.removed ?? {}).filter(([id, why]) => removedIds.has(id) && why.trim()).length +
    (review.notes.trim() ? 1 : 0) + (review.gradeComment.trim() ? 1 : 0);
  return { edits, comments };
}

export function timecode(t: number, fps: number) {
  const s = Math.max(t, 0), m = Math.floor(s / 60), sec = Math.floor(s % 60), fr = Math.floor((s % 1) * fps + 1e-6);
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}:${String(fr).padStart(2, "0")}`;
}

/** A stable colour per source clip, so the same take reads the same in the cut and in the source lanes. */
export function sourceHue(id: string | null) {
  if (!id) return 0;
  let h = 7;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

export interface ShotChange {
  kind: "trimmed" | "moved" | "added" | "removed" | "comment" | "graded";
  shot: Shot;
  lines: string[];
}

/** What the reviewer changed, measured against the cut Claude wrote into edit.json. */
export function diffShots(base: Shot[], now: Shot[]): ShotChange[] {
  const out: ShotChange[] = [];
  const baseById = new Map(base.map((s) => [s.id, s]));
  const nowIds = new Set(now.map((s) => s.id));
  // order: the longest run of original shots still in their original order "stayed"; the rest moved
  const seq = now.filter((s) => baseById.has(s.id)).map((s) => base.indexOf(baseById.get(s.id)!));
  const best: number[] = seq.map(() => 1), prev: number[] = seq.map(() => -1);
  for (let i = 0; i < seq.length; i++)
    for (let j = 0; j < i; j++)
      if (seq[j] < seq[i] && best[j] + 1 > best[i]) {
        best[i] = best[j] + 1;
        prev[i] = j;
      }
  const stayed = new Set<number>();
  for (let i = best.indexOf(Math.max(0, ...best)); i >= 0; i = prev[i]) stayed.add(seq[i]);
  now.forEach((s, i) => {
    const b = baseById.get(s.id);
    const lines: string[] = [];
    if (!b) {
      out.push({
        kind: "added", shot: s,
        lines: [`NEW shot at position ${i + 1}: ${s.source} ${f(s.in)} → ${f(s.out)} s${s.speed !== 1 ? ` at ${s.speed}×` : ""} (${f(shotLength(s))} s on the timeline)`],
      });
      return;
    }
    if (Math.abs(b.in - s.in) > 0.004) lines.push(`in ${f(b.in)} → ${f(s.in)} s`);
    if (Math.abs(b.out - s.out) > 0.004) lines.push(`out ${f(b.out)} → ${f(s.out)} s`);
    if ((b.speed || 1) !== (s.speed || 1)) lines.push(`speed ${b.speed}× → ${s.speed}×`);
    if (lines.length || Math.abs(shotLength(b) - shotLength(s)) > 0.004) lines.push(`length ${f(shotLength(b))} → ${f(shotLength(s))} s`);
    if (b.label !== s.label) lines.push(`renamed from "${b.label}"`);
    const moved = !stayed.has(base.indexOf(b));
    if (moved) lines.push(`moved: was shot ${base.indexOf(b) + 1}, now shot ${i + 1}`);
    if (lines.length) out.push({ kind: lines.every((l) => l.startsWith("moved")) ? "moved" : "trimmed", shot: s, lines });
    else if (s.grade) out.push({ kind: "graded", shot: s, lines: [] });
    else if (s.comment?.trim()) out.push({ kind: "comment", shot: s, lines: [] });
  });
  for (const b of base) if (!nowIds.has(b.id)) out.push({ kind: "removed", shot: b, lines: ["REMOVED from the cut"] });
  return out;
}

export function describeGrade(g: Grade, luts: LutMeta[]): string[] {
  const lines: string[] = [];
  const lut = luts.find((l) => l.id === g.lut);
  if (g.lut && !lut) lines.push(`LUT "${g.lut}" is no longer in the library, so NO LUT is applied (and none is in the cube)`);
  else if (lut && g.intensity > 0) lines.push(`LUT: ${lut.name} (luts/${lut.file}) at ${Math.round(g.intensity * 100)} %`);
  const prim: string[] = [];
  if (g.exposure) prim.push(`exposure ${g.exposure > 0 ? "+" : ""}${g.exposure.toFixed(2)} stops`);
  if (g.contrast) prim.push(`contrast ${g.contrast > 0 ? "+" : ""}${g.contrast.toFixed(2)}`);
  if (g.saturation !== 1) prim.push(`saturation ${g.saturation.toFixed(2)}`);
  if (g.temperature) prim.push(`temperature ${g.temperature > 0 ? "+" : ""}${g.temperature.toFixed(2)} (${g.temperature > 0 ? "warmer" : "cooler"})`);
  if (g.tint) prim.push(`tint ${g.tint > 0 ? "+" : ""}${g.tint.toFixed(2)}`);
  if (prim.length) lines.push(`Primaries (before the LUT): ${prim.join(", ")}`);
  for (const c of ["master", "r", "g", "b"] as const) {
    const p = g.curves[c];
    const ident = p.length === 2 && p[0][0] === 0 && p[0][1] === 0 && p[1][0] === 1 && p[1][1] === 1;
    if (!ident) lines.push(`Curve ${c} (after the LUT): ${p.map(([x, y]) => `(${x.toFixed(2)}, ${y.toFixed(2)})`).join(" ")}`);
  }
  if (g.vignette) lines.push(`Vignette ${Math.round(g.vignette * 100)} % (not inside the cube — after the cube, in RGB: \`format=rgb24,vignette=angle=${(g.vignette * 1.1).toFixed(3)}\`)`);
  return lines;
}

export const gradeCubeName = (shotId?: string) => (shotId ? `studio-grade_${shotId}.cube` : "studio-grade.cube");

/** The message pasted into Claude Code. Everything is referenced by path so a fresh session can act on it. */
export function buildPrompt(p: ProjectPayload, review: Review, luts: LutMeta[]): string {
  const e: EditDoc = p.edit;
  const changes = diffShots(e.shots, review.shots);
  const preset = RENDER_PRESETS.find((x) => x.id === review.preset)!;
  const L: string[] = [];
  L.push(`Apply my Studio review to "${e.title}" and re-render it.`);
  L.push("");
  L.push(`Read start.md first (§0d Studio hand-off, §0c export standard), then these files:`);
  L.push(`- ${p.dir}/edit.json — the cut you made (source of truth for the timeline)`);
  L.push(`- ${p.dir}/edit.review.json — the same cut after my changes in the Studio, with my comments and grade`);
  if (e.build?.script) L.push(`- ${p.dir}/${e.build.script} — the build script that actually renders this video${e.build.command ? ` (\`${e.build.command}\`)` : ""}`);
  L.push("");

  const cut = changes.filter((c) => c.kind !== "comment" && c.kind !== "graded");
  L.push("Shot numbers below are positions in my cut (edit.review.json); ids in [brackets] are stable.");
  L.push("");
  L.push(`## Cut changes (${cut.length ? cut.length : "none"})`);
  if (!cut.length) L.push("I did not move any cuts.");
  cut.forEach((c, i) => {
    // shot numbers are positions in MY cut; a removed shot has none, so it is named by its place in yours
    const where = c.kind === "removed" ? `Your shot ${e.shots.findIndex((s) => s.id === c.shot.id) + 1}` : `Shot ${review.shots.indexOf(c.shot) + 1}`;
    L.push(`${i + 1}. ${where} "${c.shot.label}" [${c.shot.id}${c.shot.source ? `, ${c.shot.source}` : ""}] — ${c.lines.join("; ")}`);
    const why = c.kind === "removed" ? review.removed?.[c.shot.id] : c.shot.comment;
    if (why?.trim()) L.push(`   Why: ${why.trim()}`);
  });
  const notes = changes.filter((c) => (c.kind === "comment" || c.kind === "graded") && c.shot.comment?.trim());
  if (notes.length) {
    L.push("");
    L.push("## Comments on shots I left where they were");
    for (const c of notes) L.push(`- Shot ${review.shots.indexOf(c.shot) + 1} "${c.shot.label}" [${c.shot.id}]: ${c.shot.comment!.trim()}`);
  }
  const marks = [...(review.marks ?? [])];
  if (marks.length) {
    const { placed } = layout(review.shots);
    L.push("");
    L.push("## Comments at a moment (timecodes are in my cut)");
    for (const m of marks.sort((a, b) => markTime(a, placed) - markTime(b, placed))) {
      const t = markTime(m, placed), q = shotAt(placed, t);
      const src = q?.shot.source ? `, ${q.shot.source} at ${f(q.shot.in + (t - q.start) * (q.shot.speed || 1))} s` : "";
      L.push(`- ${timecode(t, e.fps)} (${f(t)} s — shot ${q ? q.index + 1 : "?"} "${q?.shot.label ?? ""}" [${q?.shot.id ?? "?"}]${src}): ${m.text.trim()}`);
    }
  }
  L.push("");
  L.push("## Grade");
  // a LUT that has been deleted from the library is not applied, so it does not count as a grade
  const film = { ...review.grade, lut: luts.some((l) => l.id === review.grade.lut) ? review.grade.lut : null };
  if (!review.applyGrade) L.push("Leave the colour as it is — render ungraded / with the existing look.");
  else if (isNeutral(film) && !review.shots.some((s) => s.grade)) L.push("No grade set in the Studio — keep the existing look.");
  else {
    for (const l of describeGrade(review.grade, luts)) L.push(`- ${l}`);
    if (!isNeutral({ ...film, vignette: 0 }))
      L.push(`- Baked as one 33-point cube: ${p.dir}/grade/${gradeCubeName()} → \`format=gbrp16le,lut3d=file='…':interp=tetrahedral\` on the conformed picture (RGB), before any text or graphics. This is the look I approved in the monitor; it replaces the previous look unless a comment says otherwise.`);
    else L.push(`- The film grade has no cube (${review.grade.vignette ? "vignette only" : "neutral"}) — shots without their own grade keep the existing look.`);
    for (const s of review.shots.filter((x) => x.grade)) {
      L.push(`- Shot ${review.shots.indexOf(s) + 1} "${s.label}" has its own grade: ${p.dir}/grade/${gradeCubeName(s.id)}`);
      for (const l of describeGrade(s.grade!, luts)) L.push(`    - ${l}`);
    }
  }
  if (review.gradeComment.trim()) L.push(`- My note on colour: ${review.gradeComment.trim()}`);
  if (review.notes.trim()) {
    L.push("");
    L.push("## Overall notes");
    L.push(review.notes.trim());
  }
  L.push("");
  L.push("## Render");
  L.push(`${preset.name} — ${preset.detail}, exported to the §0c standard. Output goes in ${p.dir}/${e.rendersDir ?? "renders"}/ with a new version number; also keep an ungraded render of the same cut.`);
  L.push("");
  L.push("## What to do");
  L.push("1. Apply the cut changes to the build script and to edit.json (edit.json must match what the build renders; keep shot ids stable, keep my comments as the shot's `note` history).");
  L.push("2. Apply the grade with the baked cube(s). Do not re-derive the look from the numbers above — they are only there so you understand it.");
  L.push("3. Render, check the result against my comments shot by shot (frame sheet), then delete edit.review.json so the Studio starts clean from the new edit.json.");
  L.push("4. Tell me what changed, and anything you could not do exactly as asked.");
  return L.join("\n");
}

const ROTATE: Record<number, string> = { 90: "transpose=1", 180: "hflip,vflip", 270: "transpose=2" };

/** The ffmpeg call that conforms one shot the way the Studio render does (no grade) — shown in the shot inspector. */
export function shotCommand(shot: Shot, sourcePath: string | null, e: Pick<EditDoc, "width" | "height" | "fps">): string {
  const fit = `scale=${e.width}:${e.height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${e.width}:${e.height}`;
  const frames = Math.max(Math.round(shotLength(shot) * e.fps), 1);
  if (!shot.source)
    return shot.image
      ? `ffmpeg -loop 1 -i "${shot.image}" \\\n  -vf "fps=${e.fps},${fit}" \\\n  -frames:v ${frames} shot_${shot.id}.mp4`
      : `# generated in the build script — ${frames} frames (${f(shotLength(shot))} s), no source clip`;
  const vf = [shot.rotate ? ROTATE[shot.rotate] : "", shot.crop ? `crop=${shot.crop.join(":")}` : "", `setpts=PTS/${shot.speed || 1}`, `fps=${e.fps}`, fit].filter(Boolean).join(",");
  return `ffmpeg -ss ${shot.in.toFixed(3)} -t ${(shot.out - shot.in).toFixed(3)} -i "${sourcePath ?? shot.source}" \\\n  -vf "${vf}" \\\n  -frames:v ${frames} -an shot_${shot.id}.mp4`;
}

/** A one-shot note: the comment on a single shot, sent on its own without the rest of the review. */
export function buildShotPrompt(p: ProjectPayload, review: Review, shotId: string, luts: LutMeta[], where: string[] = []): string {
  const e = p.edit;
  const shot = review.shots.find((s) => s.id === shotId);
  if (!shot) throw new Error("that shot is no longer in the cut");
  const n = review.shots.indexOf(shot) + 1;
  const base = e.shots.find((s) => s.id === shotId);
  const change = diffShots(e.shots, review.shots).find((c) => c.shot.id === shotId);
  const others = diffShots(e.shots, review.shots).filter((c) => c.shot.id !== shotId).length;
  const L: string[] = [];
  L.push(`One note from the Studio on "${e.title}" — shot ${n} "${shot.label}" [${shot.id}].`);
  L.push("");
  L.push("Read start.md first (§0d Studio hand-off, §0c export standard), then:");
  L.push(`- ${p.dir}/edit.json — your cut; this shot is \`shots[id=${shot.id}]\``);
  L.push(`- ${p.dir}/edit.review.json — my version of the cut (same shot id)`);
  if (e.build?.script) L.push(`- ${p.dir}/${e.build.script} — the build script${where.length ? `; this shot is around line ${where.join(", ")}` : ""}`);
  L.push("");
  L.push("## The shot");
  if (shot.source) L.push(`- Now: ${shot.source} ${f(shot.in)} → ${f(shot.out)} s${shot.speed !== 1 ? ` at ${shot.speed}×` : ""} (${f(shotLength(shot))} s on the timeline, position ${n} of ${review.shots.length})`);
  else L.push(`- Generated shot, ${f(shotLength(shot))} s, position ${n} of ${review.shots.length}`);
  if (!base) L.push("- This is a NEW shot I added; it is not in your edit.json yet.");
  else if (change?.lines.length) L.push(`- Changed from your cut: ${change.lines.join("; ")}`);
  else L.push("- Timing is unchanged from your cut.");
  if (base?.note) L.push(`- Your reason at the time: ${base.note}`);
  if (shot.grade) {
    L.push(`- It has its own grade: ${p.dir}/grade/${gradeCubeName(shot.id)}`);
    for (const l of describeGrade(shot.grade, luts)) L.push(`    - ${l}`);
  }
  L.push("");
  L.push("## My comment");
  L.push(shot.comment?.trim() || "(no comment — just apply the timing above)");
  L.push("");
  L.push("## What to do");
  L.push("1. Apply this to the build script and to edit.json for this shot only; keep its id, and add my comment to its `note`.");
  L.push(`2. Leave every other shot as it is in edit.json${others ? ` — edit.review.json holds ${others} other change${others > 1 ? "s" : ""} of mine that I have NOT sent yet` : ""}. Do not delete edit.review.json.`);
  L.push("3. Re-render (plus the ungraded twin), check this shot on a frame sheet against my comment, and tell me what changed.");
  return L.join("\n");
}
