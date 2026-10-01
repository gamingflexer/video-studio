import fs from "node:fs";
import path from "node:path";
import { SPRITE_FRAMES, ensureProxy } from "@/lib/server/media";
import { VIDEO_EXT } from "@/lib/server/paths";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { path: file } = (await req.json()) as { path: string };
  const abs = path.resolve(file);
  if (!fs.existsSync(abs) || !VIDEO_EXT.has(path.extname(abs).toLowerCase())) return Response.json({ error: "not found" }, { status: 404 });
  try {
    const { proxy, sprite } = await ensureProxy(abs);
    return Response.json({ proxy, sprite, frames: SPRITE_FRAMES });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
