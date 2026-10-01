import fs from "node:fs";
import path from "node:path";
import { loadProject } from "@/lib/server/projects";

export const dynamic = "force-dynamic";

export interface CodeSnippet {
  file: string;
  line: number;
  /** the matching line plus two either side */
  text: string;
  from: number;
}

/** Where a shot lives in the project's build script: lines naming its clip, best matches (same in-point) first. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const p = await loadProject((await params).id);
  if (!p) return Response.json({ error: "unknown project" }, { status: 404 });
  const shotId = new URL(req.url).searchParams.get("shot") ?? "";
  const shot = p.edit.shots.find((s) => s.id === shotId);
  const script = p.edit.build?.script ? path.resolve(p.dirAbs, p.edit.build.script) : null;
  if (!shot || !script || !fs.existsSync(script)) return Response.json({ script: p.edit.build?.script ?? null, snippets: [] });
  const lines = fs.readFileSync(script, "utf8").split("\n");
  // "IMG_6647" is written as "6647" in some scripts
  const names = shot.source ? [shot.source, shot.source.replace(/^[A-Za-z]+_/, "")] : [shot.label.slice(0, 24)];
  const inPoint = shot.source ? [shot.in.toFixed(2), String(shot.in), shot.in.toFixed(1)] : [];
  const hits = lines
    .map((text, i) => ({ i, text }))
    .filter(({ text }) => names.some((n) => n && text.includes(n)))
    .map(({ i, text }) => ({ i, score: inPoint.some((t) => new RegExp(`(^|[^0-9.])${t.replace(".", "\\.")}0*([^0-9]|$)`).test(text)) ? 2 : 1 }))
    .sort((a, b) => b.score - a.score || a.i - b.i);
  const best = hits.filter((h) => h.score === hits[0]?.score).slice(0, 3);
  const snippets: CodeSnippet[] = best.map(({ i }) => {
    const from = Math.max(i - 2, 0), to = Math.min(i + 3, lines.length);
    return { file: `${p.dir}/${p.edit.build!.script}`, line: i + 1, from: from + 1, text: lines.slice(from, to).join("\n") };
  });
  return Response.json({ script: `${p.dir}/${p.edit.build!.script}`, snippets });
}
