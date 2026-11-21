import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { listFinals, resolveIn } from "@/lib/server/finals";
import { inside, workspace } from "@/lib/server/paths";

export const dynamic = "force-dynamic";

/** Show a variation in Finder: its render selected (finished file, else draft), else its project folder. Only paths a finals.json names. */
export async function POST(req: Request) {
  const { id, branch } = (await req.json()) as { id: string; branch?: string };
  const p = listFinals().find((x) => x.doc.id === id);
  if (!p) return Response.json({ error: "not found" }, { status: 404 });
  const dir = path.resolve(workspace(), p.dir);
  let target: string | null = null;
  let select = true;
  if (!branch) {
    const f = p.doc.trunk.file && p.media[p.doc.trunk.file];
    target = f && f.exists ? f.abs : dir;
    select = !!(f && f.exists);
  } else {
    const b = p.doc.branches.find((x) => x.id === branch);
    if (!b) return Response.json({ error: "no such branch" }, { status: 404 });
    const hit = [b.file, b.preview].map((f) => (f ? p.media[f] : undefined)).find((m) => m?.exists);
    if (hit) target = hit.abs;
    else if (b.project) {
      const proj = resolveIn(workspace(), b.project);
      if (inside(workspace(), proj) && fs.existsSync(proj)) { target = proj; select = false; }
    }
    if (!target) { target = dir; select = false; }
  }
  await new Promise<void>((res) => execFile("open", select ? ["-R", target!] : [target!], () => res()));
  return Response.json({ ok: true, opened: target });
}
