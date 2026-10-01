import fs from "node:fs";
import path from "node:path";
import { buildPrompt, buildShotPrompt } from "@/lib/timeline";
import { listLuts } from "@/lib/server/luts";
import { loadProject, saveReview } from "@/lib/server/projects";
import { writeGradeCubes } from "@/lib/server/render";
import type { Review } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Save the review, bake the grade cube(s) into <project>/grade/, and return the prompt for Claude Code. */
export async function POST(req: Request) {
  const { project, review, shotId, lines } = (await req.json()) as { project: string; review: Review; shotId?: string; lines?: number[] };
  const p = await loadProject(project);
  if (!p) return Response.json({ error: "unknown project" }, { status: 404 });
  try {
    saveReview(project, review);
    if (review.applyGrade) writeGradeCubes(path.join(p.dirAbs, "grade"), review);
    // shotId = send one shot's note on its own instead of the whole review
    const prompt = shotId ? buildShotPrompt(p, review, shotId, listLuts(), (lines ?? []).map(String)) : buildPrompt(p, review, listLuts());
    fs.writeFileSync(path.join(p.dirAbs, "STUDIO_HANDOFF.md"), prompt + "\n");
    return Response.json({ prompt, file: `${p.dir}/STUDIO_HANDOFF.md` });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
