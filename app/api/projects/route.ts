import path from "node:path";
import fs from "node:fs";
import { createLooseProject, listLooseVideos, listProjects } from "@/lib/server/projects";
import { VIDEO_EXT, inside, workspace } from "@/lib/server/paths";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ projects: listProjects(), videos: listLooseVideos() });
}

export async function POST(req: Request) {
  const { file } = (await req.json()) as { file: string };
  const abs = path.isAbsolute(file) ? file : path.resolve(workspace(), file);
  if (!fs.existsSync(abs) || !VIDEO_EXT.has(path.extname(abs).toLowerCase())) return Response.json({ error: "not a video file" }, { status: 400 });
  if (!inside(workspace(), abs) && !abs.startsWith("/Volumes/") && !abs.startsWith("/Users/")) return Response.json({ error: "path not allowed" }, { status: 400 });
  try {
    return Response.json({ id: await createLooseProject(abs) });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
