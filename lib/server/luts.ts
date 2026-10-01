import fs from "node:fs";
import path from "node:path";
import type { Grade, Look, LutMeta } from "../types";
import { bakeGrade, identityLut, parse3dl, parseCube, sampleLut, serializeCube, type Lut3D } from "../color";
import { HOUSE_LOOKS, buildHouseLut } from "../houseLuts";
import { STUDIO, bin, ensureDir, lookDir, lutDir, slugify, tmpDir } from "./paths";
import { run } from "./media";

const indexFile = () => path.join(lutDir(), "index.json");

function readIndex(): LutMeta[] {
  try {
    return JSON.parse(fs.readFileSync(indexFile(), "utf8")) as LutMeta[];
  } catch {
    return [];
  }
}
function writeIndex(list: LutMeta[]) {
  ensureDir(lutDir());
  fs.writeFileSync(indexFile(), JSON.stringify(list, null, 2));
}

function ensureHouse(list: LutMeta[]): LutMeta[] {
  let changed = false;
  for (const look of HOUSE_LOOKS) {
    const file = `${look.id}.cube`;
    if (list.some((l) => l.id === look.id) && fs.existsSync(path.join(lutDir(), file))) continue;
    ensureDir(lutDir());
    fs.writeFileSync(path.join(lutDir(), file), serializeCube(buildHouseLut(look), look.name));
    list = list.filter((l) => l.id !== look.id);
    list.push({ id: look.id, name: look.name, file, size: 33, group: "house", look: look.look, licence: "generated in the Studio — no restrictions", addedAt: new Date().toISOString() });
    changed = true;
  }
  if (changed) writeIndex(list);
  return list;
}

/**
 * The free LUTs shipped with the app (default-luts/) are copied into a workspace once; after that
 * they are ordinary library entries, so removing one sticks.
 */
function seedBundled(list: LutMeta[]): LutMeta[] {
  const src = path.join(STUDIO, "default-luts"), marker = path.join(lutDir(), ".seeded");
  if (fs.existsSync(marker) || !fs.existsSync(path.join(src, "index.json"))) return list;
  try {
    const bundled = JSON.parse(fs.readFileSync(path.join(src, "index.json"), "utf8")) as LutMeta[];
    ensureDir(lutDir());
    for (const meta of bundled) {
      if (list.some((l) => l.id === meta.id) || !fs.existsSync(path.join(src, meta.file))) continue;
      fs.copyFileSync(path.join(src, meta.file), path.join(lutDir(), meta.file));
      list.push({ ...meta, addedAt: new Date().toISOString() });
    }
    for (const f of fs.readdirSync(src)) if (/^LICEN[CS]E/i.test(f)) fs.copyFileSync(path.join(src, f), path.join(lutDir(), f));
    writeIndex(list);
    fs.writeFileSync(marker, "bundled LUTs copied\n");
  } catch {
    /* a missing or broken bundle is not fatal: the house looks are still there */
  }
  return list;
}

const ORDER = { house: 0, web: 1, pack: 2, upload: 3, studio: 4 } as const;

export function listLuts(): LutMeta[] {
  const list = seedBundled(ensureHouse(readIndex())).filter((l) => fs.existsSync(path.join(lutDir(), l.file)));
  return list.sort((a, b) => ORDER[a.group] - ORDER[b.group] || a.name.localeCompare(b.name, undefined, { numeric: true }));
}

const lutCache = new Map<string, { mtime: number; lut: Lut3D }>();

export function lutPath(id: string): string | null {
  const meta = listLuts().find((l) => l.id === id);
  return meta ? path.join(lutDir(), meta.file) : null;
}

export function loadLut(id: string | null): Lut3D | null {
  if (!id) return null;
  const file = lutPath(id);
  if (!file) return null;
  const mtime = fs.statSync(file).mtimeMs;
  const hit = lutCache.get(file);
  if (hit && hit.mtime === mtime) return hit.lut;
  const lut = parseCube(fs.readFileSync(file, "utf8"));
  lutCache.set(file, { mtime, lut });
  return lut;
}

/** Hald images can be 144 points a side (an 80 MB cube); 65 is as fine as any grading tool uses. */
function capSize(lut: Lut3D, max = 65): Lut3D {
  if (lut.size <= max) return lut;
  const out = identityLut(max), px = new Float32Array(3);
  for (let i = 0; i < out.data.length; i += 3) {
    sampleLut(lut, out.data[i], out.data[i + 1], out.data[i + 2], px);
    out.data.set(px, i);
  }
  out.title = lut.title;
  return out;
}

function register(input: Lut3D, name: string, extra: Partial<LutMeta>): LutMeta {
  const lut = capSize(input);
  const list = listLuts();
  const base = slugify(name);
  let id = base, n = 2;
  while (list.some((l) => l.id === id)) id = `${base}-${n++}`;
  const meta: LutMeta = { id, name, file: `${id}.cube`, size: lut.size, group: "upload", addedAt: new Date().toISOString(), ...extra };
  ensureDir(lutDir());
  fs.writeFileSync(path.join(lutDir(), meta.file), serializeCube(lut, name));
  writeIndex([...list, meta]);
  return meta;
}

async function fromRgb48(args: string[], what: string, eightBit = false): Promise<Lut3D> {
  // read 8-bit pictures as 8-bit: ffmpeg's widening to 16 bits is inexact (white lands ~1/255 low)
  const { stdout } = await run(bin("ffmpeg"), ["-v", "error", ...args, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", eightBit ? "rgb24" : "rgb48le", "-"]);
  const bytes = eightBit ? 3 : 6;
  const px = stdout.length / bytes, size = Math.round(Math.cbrt(px));
  if (size < 2 || size ** 3 !== px) throw new Error(`${what}: ${px} pixels is not a cube of colours (expected a Hald CLUT image)`);
  const data = new Float32Array(px * 3);
  if (eightBit) for (let i = 0; i < data.length; i++) data[i] = stdout[i] / 255;
  else {
    const u16 = new Uint16Array(stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + px * 6));
    for (let i = 0; i < data.length; i++) data[i] = u16[i] / 65535;
  }
  // a LUT moves colours around, but brighter input still gives brighter output; an ordinary picture has no such order
  const id = identityLut(size), n = px;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < data.length; i += 3) {
    const x = 0.2126 * id.data[i] + 0.7152 * id.data[i + 1] + 0.0722 * id.data[i + 2];
    const y = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
  }
  const corr = (sxy - (sx * sy) / n) / Math.sqrt(Math.max((sxx - (sx * sx) / n) * (syy - (sy * sy) / n), 1e-12));
  if (corr < 0.6) throw new Error(`${what}: this looks like an ordinary picture, not a Hald CLUT`);
  return { size, data };
}

export const LUT_EXT = [".cube", ".3dl", ".png", ".tif", ".tiff", ".dat", ".m3d", ".csp"];

/** Any supported LUT file -> a clean red-fastest .cube in the library. */
async function decode(file: string): Promise<Lut3D> {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".cube") return parseCube(fs.readFileSync(file, "utf8"));
  if (ext === ".3dl") {
    try {
      return parse3dl(fs.readFileSync(file, "utf8"));
    } catch {
      /* odd dialect: let ffmpeg try below */
    }
  }
  if (ext === ".png" || ext === ".tif" || ext === ".tiff") {
    const { stdout } = await run(bin("ffprobe"), ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=pix_fmt", "-of", "csv=p=0", file]);
    const deep = /(16|48|64|f32|12|10)/.test(stdout.toString());
    return fromRgb48(["-i", file], path.basename(file), !deep);
  }
  // .dat / .m3d / .csp (and .3dl dialects): run an identity Hald image through ffmpeg's own reader
  const dir = tmpDir();
  const safe = path.join(dir, "in" + ext);
  fs.copyFileSync(file, safe);
  try {
    // the identity is generated at 16 bits (an 8-bit one would be rounded before the LUT even sees it)
    return await fromRgb48(["-f", "lavfi", "-i", "haldclutsrc=6,format=rgb48le", "-vf", `lut3d=file=${safe}:interp=tetrahedral`], path.basename(file));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export interface ImportResult {
  added: LutMeta[];
  failed: { name: string; error: string }[];
}

export async function importLutFile(file: string, displayName: string, extra: Partial<LutMeta> = {}, res: ImportResult = { added: [], failed: [] }): Promise<ImportResult> {
  const ext = path.extname(displayName).toLowerCase();
  if (ext === ".zip") {
    const dir = tmpDir();
    try {
      await run("unzip", ["-oq", file, "-d", dir]);
      const walk = (d: string): string[] =>
        fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
      const pack = path.basename(displayName, ext).replace(/-\d{8}T\d{6}Z.*$/, "").trim();
      for (const f of walk(dir).sort()) {
        if (path.basename(f).startsWith(".") || f.includes("__MACOSX")) continue;
        if (LUT_EXT.includes(path.extname(f).toLowerCase())) await importLutFile(f, path.basename(f), { group: "pack", origin: pack, ...extra }, res);
      }
    } catch (e) {
      res.failed.push({ name: displayName, error: (e as Error).message });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    return res;
  }
  if (!LUT_EXT.includes(ext)) {
    res.failed.push({ name: displayName, error: `unsupported type ${ext || "(none)"} — use ${LUT_EXT.join(" ")} or a .zip of them` });
    return res;
  }
  try {
    const lut = await decode(file);
    const name = path.basename(displayName, path.extname(displayName)).replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
    const title = lut.title && lut.title.toLowerCase() !== name.toLowerCase() ? lut.title : undefined;
    res.added.push(register(lut, name, { origin: displayName, look: title, ...extra }));
  } catch (e) {
    res.failed.push({ name: displayName, error: (e as Error).message });
  }
  return res;
}

/** "Create a new LUT": bake the current grade (primaries + LUT + curves) into a library cube. */
export function saveGradeAsLut(name: string, grade: Grade): LutMeta {
  const lut = bakeGrade(grade, loadLut(grade.lut));
  const base = grade.lut ? listLuts().find((l) => l.id === grade.lut)?.name : null;
  return register(lut, name, { group: "studio", look: base ? `made in the Studio on top of ${base}` : "made in the Studio", licence: "yours" });
}

export function deleteLut(id: string) {
  const list = listLuts();
  const meta = list.find((l) => l.id === id);
  if (!meta || meta.group === "house") return false;
  fs.rmSync(path.join(lutDir(), meta.file), { force: true });
  writeIndex(list.filter((l) => l.id !== id));
  return true;
}

export function listLooks(): Look[] {
  if (!fs.existsSync(lookDir())) return [];
  return fs.readdirSync(lookDir()).filter((f) => f.endsWith(".json")).flatMap((f) => {
    try {
      return [JSON.parse(fs.readFileSync(path.join(lookDir(), f), "utf8")) as Look];
    } catch {
      return [];
    }
  }).sort((a, b) => a.name.localeCompare(b.name));
}

export function saveLook(name: string, grade: Grade): Look {
  ensureDir(lookDir());
  const look: Look = { id: slugify(name), name, grade, savedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(lookDir(), `${look.id}.json`), JSON.stringify(look, null, 2));
  return look;
}

export function deleteLook(id: string) {
  fs.rmSync(path.join(lookDir(), `${slugify(id)}.json`), { force: true });
}
