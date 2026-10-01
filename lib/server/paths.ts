import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import crypto from "node:crypto";

/** The app folder (this repo). Everything about a video lives in the *workspace*, which is a separate, configurable folder. */
export const STUDIO = process.cwd();
export const CACHE = path.join(STUDIO, ".cache");
export const LOOSE_PROJECTS = path.join(STUDIO, "projects");
/** per-user settings and the tools the setup script installs (node, ffmpeg) */
export const HOME_DIR = path.join(os.homedir(), ".video-studio");
const CONFIG = path.join(HOME_DIR, "config.json");
export const DEFAULT_WORKSPACE = path.join(os.homedir(), "Movies", "Video Studio");
/** the folders every workspace has; the first three are what the file browser shows */
export const WORKSPACE_FOLDERS = ["new-media", "videos", "newly transferred videos and B-rolls", "luts"];

let cached: { at: number; value: string | null } | null = null;

/**
 * Where the videos live: STUDIO_WORKSPACE, then ~/.video-studio/config.json, then the folder this
 * app sits in when that is already a video workspace (start.md next to videos/). null = not set up yet.
 */
export function configuredWorkspace(): string | null {
  if (cached && Date.now() - cached.at < 1000) return cached.value;
  let value: string | null = null;
  const parent = path.resolve(STUDIO, "..");
  try {
    if (process.env.STUDIO_WORKSPACE) value = path.resolve(process.env.STUDIO_WORKSPACE);
    else if (fs.existsSync(CONFIG)) {
      const w = (JSON.parse(fs.readFileSync(CONFIG, "utf8")) as { workspace?: string }).workspace;
      if (w && fs.existsSync(w)) value = w;
    }
    if (!value && fs.existsSync(path.join(parent, "start.md")) && (fs.existsSync(path.join(parent, "videos")) || fs.existsSync(path.join(parent, "new-media")))) value = parent;
  } catch {
    value = null;
  }
  cached = { at: Date.now(), value };
  return value;
}

export const workspace = () => configuredWorkspace() ?? DEFAULT_WORKSPACE;
export const lutDir = () => path.join(workspace(), "luts");
export const lookDir = () => path.join(lutDir(), "looks");

/** Remember the workspace folder and give it the standard sub-folders (existing files are never touched). */
export function setWorkspace(dir: string) {
  const abs = path.resolve(dir);
  fs.mkdirSync(abs, { recursive: true });
  for (const f of WORKSPACE_FOLDERS) fs.mkdirSync(path.join(abs, f), { recursive: true });
  fs.mkdirSync(HOME_DIR, { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify({ workspace: abs }, null, 2));
  cached = null;
  return abs;
}

/** ffmpeg / ffprobe: the copy the setup script put in ~/.video-studio/bin when there is one, else whatever is on PATH. */
export function bin(name: "ffmpeg" | "ffprobe"): string {
  const env = process.env[name === "ffmpeg" ? "FFMPEG_PATH" : "FFPROBE_PATH"];
  if (env) return env;
  const local = path.join(HOME_DIR, "bin", name);
  return fs.existsSync(local) ? local : name;
}

export const MEDIA_EXT = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv", ".jpg", ".jpeg", ".png", ".webp", ".wav", ".mp3", ".m4a", ".aac"]);
export const VIDEO_EXT = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv"]);

/** path as written in prompts and the UI: relative to the workspace, or absolute when it lives outside it */
export const rel = (abs: string) => {
  const r = path.relative(workspace(), abs);
  return r.startsWith("..") ? abs : r || ".";
};

export const inside = (parent: string, child: string) => {
  const r = path.relative(parent, child);
  return !!r && !r.startsWith("..") && !path.isAbsolute(r);
};

export const slugify = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "untitled";

export const hash = (s: string) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);

/** ffmpeg filter arguments choke on quotes/colons, so LUTs are handed over from a plain temp path. */
export function tmpDir(prefix = "studio-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function ensureDir(d: string) {
  fs.mkdirSync(d, { recursive: true });
  return d;
}
