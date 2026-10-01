import fs from "node:fs";
import path from "node:path";
import { importLutFile, listLooks, listLuts, type ImportResult } from "@/lib/server/luts";
import { tmpDir } from "@/lib/server/paths";
import type { LutMeta } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ luts: listLuts(), looks: listLooks() });
}

/** multipart upload: one or more `file` parts (.cube .3dl .png .dat .m3d .csp or a .zip of them) */
export async function POST(req: Request) {
  const form = await req.formData();
  const extra: Partial<LutMeta> = {};
  for (const k of ["group", "licence", "sourceUrl", "look", "origin"] as const) {
    const v = form.get(k);
    if (typeof v !== "string" || !v) continue;
    if (k === "group" && !["web", "pack", "upload"].includes(v)) continue; // "house" and "studio" are made by the app itself
    (extra as Record<string, string>)[k] = v;
  }
  const rename = form.get("name");
  const res: ImportResult = { added: [], failed: [] };
  const dir = tmpDir("studio-lut-");
  try {
    for (const part of form.getAll("file")) {
      if (typeof part === "string") continue;
      const ext = path.extname(part.name).toLowerCase();
      const tmp = path.join(dir, `upload-${res.added.length + res.failed.length}${ext}`);
      fs.writeFileSync(tmp, Buffer.from(await part.arrayBuffer()));
      const display = typeof rename === "string" && rename ? rename + ext : part.name;
      await importLutFile(tmp, display, extra, res);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return Response.json({ ...res, luts: listLuts() });
}
