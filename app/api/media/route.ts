import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { CACHE, LOOSE_PROJECTS, MEDIA_EXT, inside, workspace } from "@/lib/server/paths";
import { listProjects } from "@/lib/server/projects";
import type { EditDoc } from "@/lib/types";

export const dynamic = "force-dynamic";

const TYPES: Record<string, string> = {
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
  ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac",
};

/** Only media inside the workspace, or files a project's edit.json points at (camera cards, NAS). */
function allowed(abs: string) {
  if (!MEDIA_EXT.has(path.extname(abs).toLowerCase())) return false;
  if (inside(workspace(), abs) || inside(CACHE, abs) || inside(LOOSE_PROJECTS, abs)) return true;
  for (const ref of listProjects()) {
    try {
      const e = JSON.parse(fs.readFileSync(ref.file, "utf8")) as EditDoc;
      const dir = path.dirname(ref.file);
      if ([...(e.sources ?? []).map((s) => s.file), e.audio?.file].some((f) => f && path.resolve(dir, f) === abs)) return true;
    } catch {
      /* skip */
    }
  }
  return false;
}

export async function GET(req: Request) {
  // relative paths are relative to the video workspace (the file browser uses those)
  const abs = path.resolve(workspace(), new URL(req.url).searchParams.get("path") ?? "");
  if (!allowed(abs) || !fs.existsSync(abs)) return new Response("not found", { status: 404 });
  const size = fs.statSync(abs).size;
  const type = TYPES[path.extname(abs).toLowerCase()] ?? "application/octet-stream";
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.get("range") ?? "");
  const headers: Record<string, string> = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "no-cache" };
  if (range && (range[1] || range[2])) {
    let start = range[1] ? parseInt(range[1], 10) : size - parseInt(range[2], 10);
    let end = range[1] && range[2] ? parseInt(range[2], 10) : size - 1;
    start = Math.max(0, start);
    end = Math.min(end, size - 1);
    if (start > end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    const body = Readable.toWeb(fs.createReadStream(abs, { start, end })) as ReadableStream;
    return new Response(body, { status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) } });
  }
  return new Response(Readable.toWeb(fs.createReadStream(abs)) as ReadableStream, { headers: { ...headers, "Content-Length": String(size) } });
}
