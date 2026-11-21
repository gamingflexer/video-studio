import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FinalsDoc, FinalsPayload, MediaInfo } from "../types";
import { LOOSE_PROJECTS, rel, workspace } from "./paths";

const SKIP = new Set(["node_modules", ".git", ".next", ".cache", "tools", "venv", "__pycache__"]);

function findFinals(dir: string, depth: number, out: string[]) {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isFile() && e.name === "finals.json") out.push(path.join(dir, e.name));
    else if (e.isDirectory() && depth > 0 && !SKIP.has(e.name) && !e.name.startsWith(".")) findFinals(path.join(dir, e.name), depth - 1, out);
  }
}

/** "~/Downloads/x.mp4", "/Volumes/…", or relative to the finals.json folder */
export function resolveIn(dir: string, file: string) {
  if (file.startsWith("~/")) return path.join(os.homedir(), file.slice(2));
  return path.resolve(dir, file);
}

function info(dir: string, file: string): MediaInfo {
  const abs = resolveIn(dir, file);
  try {
    const st = fs.statSync(abs);
    return { file, abs, exists: st.isFile(), size: st.size, mtime: st.mtimeMs };
  } catch {
    return { file, abs, exists: false, size: 0, mtime: 0 };
  }
}

function files(doc: FinalsDoc) {
  const out = [doc.trunk.file];
  for (const b of doc.branches) out.push(b.file, b.preview, b.still);
  return out.filter((f): f is string => !!f);
}

let scan: { at: number; files: string[] } | null = null;

/** every finals.json in the workspace; the walk is cached for 5 s because the media route asks on every byte-range request */
export function finalsFiles(): string[] {
  if (scan && Date.now() - scan.at < 5000) return scan.files;
  const out: string[] = [];
  findFinals(workspace(), 5, out);
  findFinals(LOOSE_PROJECTS, 2, out);
  scan = { at: Date.now(), files: out };
  return out;
}

export function listFinals(): FinalsPayload[] {
  const list: FinalsPayload[] = [];
  for (const f of finalsFiles()) {
    try {
      const doc = JSON.parse(fs.readFileSync(f, "utf8")) as FinalsDoc;
      if (!doc.id || !Array.isArray(doc.branches)) continue;
      const dir = path.dirname(f);
      const media: Record<string, MediaInfo> = {};
      for (const m of files(doc)) media[m] = info(dir, m);
      list.push({ doc, dir: rel(dir), media });
    } catch {
      /* not one of ours */
    }
  }
  return list.sort((a, b) => (b.doc.updatedAt ?? "").localeCompare(a.doc.updatedAt ?? ""));
}

/** every media file a finals.json points at (the media route serves these even outside the workspace) */
export function finalsMedia(): Set<string> {
  const set = new Set<string>();
  for (const f of finalsFiles()) {
    try {
      const doc = JSON.parse(fs.readFileSync(f, "utf8")) as FinalsDoc;
      for (const m of files(doc)) set.add(resolveIn(path.dirname(f), m));
    } catch {
      /* skip */
    }
  }
  return set;
}

/** Only status, note and "chosen" are changed from the Studio; everything else belongs to whoever builds the variations. */
export function updateBranch(id: string, branchId: string, patch: { status?: FinalsDoc["branches"][number]["status"]; note?: string }) {
  const file = finalsFiles().find((f) => {
    try {
      return (JSON.parse(fs.readFileSync(f, "utf8")) as FinalsDoc).id === id;
    } catch {
      return false;
    }
  });
  if (!file) return null;
  const doc = JSON.parse(fs.readFileSync(file, "utf8")) as FinalsDoc;
  const b = doc.branches.find((x) => x.id === branchId);
  if (!b) return null;
  if (patch.status === "chosen") for (const o of doc.branches) if (o.status === "chosen" && o.id !== branchId) o.status = "final";
  if (patch.status) b.status = patch.status;
  if (typeof patch.note === "string") b.note = patch.note;
  doc.updatedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(doc, null, 1) + "\n");
  return doc;
}
