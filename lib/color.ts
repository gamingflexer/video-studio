// Colour maths shared by the browser preview and the ffmpeg render.
// A whole grade (primaries -> LUT at an intensity -> curves) is baked into ONE 3D LUT, so what
// the monitor shows and what ffmpeg's lut3d renders are the same numbers. Only the vignette is
// spatial and lives outside the cube (shader in the preview, `vignette` filter in the render).
import type { CurvePoint, Curves, Grade } from "./types";

export interface Lut3D {
  size: number;
  /** rgb triples, red changes fastest (same order as a .cube file) */
  data: Float32Array;
  title?: string;
}

export const BAKE_SIZE = 33;

export const identityCurves = (): Curves => ({
  master: [[0, 0], [1, 1]],
  r: [[0, 0], [1, 1]],
  g: [[0, 0], [1, 1]],
  b: [[0, 0], [1, 1]],
});

export const defaultGrade = (): Grade => ({
  lut: null,
  intensity: 0.6,
  exposure: 0,
  contrast: 0,
  saturation: 1,
  temperature: 0,
  tint: 0,
  vignette: 0,
  curves: identityCurves(),
});

export function normalizeGrade(g: Partial<Grade> | null | undefined): Grade {
  const d = defaultGrade();
  if (!g) return d;
  return { ...d, ...g, curves: { ...d.curves, ...(g.curves ?? {}) } };
}

const isIdentityCurve = (p: CurvePoint[]) =>
  p.length === 2 && p[0][0] === 0 && p[0][1] === 0 && p[1][0] === 1 && p[1][1] === 1;

export function isNeutral(g: Grade): boolean {
  return (
    (!g.lut || g.intensity === 0) &&
    g.exposure === 0 && g.contrast === 0 && g.saturation === 1 && g.temperature === 0 && g.tint === 0 &&
    g.vignette === 0 &&
    (["master", "r", "g", "b"] as const).every((c) => isIdentityCurve(g.curves[c]))
  );
}

export function identityLut(size: number): Lut3D {
  const data = new Float32Array(size * size * size * 3);
  let i = 0;
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) {
        data[i++] = r / (size - 1);
        data[i++] = g / (size - 1);
        data[i++] = b / (size - 1);
      }
  return { size, data };
}

/** Trilinear lookup; writes into out[0..2]. Input is clamped to 0..1. */
export function sampleLut(lut: Lut3D, r: number, g: number, b: number, out: Float32Array | number[]) {
  const n = lut.size, m = n - 1, d = lut.data;
  const fr = Math.min(Math.max(r, 0), 1) * m, fg = Math.min(Math.max(g, 0), 1) * m, fb = Math.min(Math.max(b, 0), 1) * m;
  const r0 = Math.min(Math.floor(fr), m - 1), g0 = Math.min(Math.floor(fg), m - 1), b0 = Math.min(Math.floor(fb), m - 1);
  const tr = fr - r0, tg = fg - g0, tb = fb - b0;
  const base = (r0 + g0 * n + b0 * n * n) * 3;
  const dg = n * 3, db = n * n * 3;
  for (let c = 0; c < 3; c++) {
    const i = base + c;
    const c00 = d[i] + (d[i + 3] - d[i]) * tr;
    const c10 = d[i + dg] + (d[i + dg + 3] - d[i + dg]) * tr;
    const c01 = d[i + db] + (d[i + db + 3] - d[i + db]) * tr;
    const c11 = d[i + db + dg] + (d[i + db + dg + 3] - d[i + db + dg]) * tr;
    const c0 = c00 + (c10 - c00) * tg, c1 = c01 + (c11 - c01) * tg;
    out[c] = c0 + (c1 - c0) * tb;
  }
}

/** Monotone cubic (Fritsch-Carlson) through the control points -> table of `n` samples over 0..1. */
export function curveTable(points: CurvePoint[], n = 1024): Float32Array {
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  const out = new Float32Array(n);
  if (pts.length === 0) {
    for (let i = 0; i < n; i++) out[i] = i / (n - 1);
    return out;
  }
  if (pts.length === 1) return out.fill(pts[0][1]);
  const k = pts.length;
  const dx: number[] = [], sl: number[] = [];
  for (let i = 0; i < k - 1; i++) {
    dx.push(Math.max(pts[i + 1][0] - pts[i][0], 1e-6));
    sl.push((pts[i + 1][1] - pts[i][1]) / dx[i]);
  }
  const m: number[] = new Array(k);
  m[0] = sl[0];
  m[k - 1] = sl[k - 2];
  for (let i = 1; i < k - 1; i++) m[i] = sl[i - 1] * sl[i] <= 0 ? 0 : (sl[i - 1] + sl[i]) / 2;
  for (let i = 0; i < k - 1; i++) {
    if (sl[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / sl[i], b = m[i + 1] / sl[i], s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * sl[i];
      m[i + 1] = t * b * sl[i];
    }
  }
  let seg = 0;
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    if (x <= pts[0][0]) out[i] = pts[0][1];
    else if (x >= pts[k - 1][0]) out[i] = pts[k - 1][1];
    else {
      while (seg < k - 2 && x > pts[seg + 1][0]) seg++;
      const h = dx[seg], t = (x - pts[seg][0]) / h, t2 = t * t, t3 = t2 * t;
      out[i] =
        (2 * t3 - 3 * t2 + 1) * pts[seg][1] + (t3 - 2 * t2 + t) * h * m[seg] +
        (-2 * t3 + 3 * t2) * pts[seg + 1][1] + (t3 - t2) * h * m[seg + 1];
    }
    out[i] = Math.min(Math.max(out[i], 0), 1);
  }
  return out;
}

const lookup = (t: Float32Array, x: number) => {
  const f = Math.min(Math.max(x, 0), 1) * (t.length - 1), i = Math.min(Math.floor(f), t.length - 2);
  return t[i] + (t[i + 1] - t[i]) * (f - i);
};

/**
 * Bake a grade into one cube. Order (the usual node tree):
 *   white balance -> exposure -> contrast -> saturation -> creative LUT (mixed by intensity) -> curves
 */
export function bakeGrade(grade: Grade, lut: Lut3D | null, size = BAKE_SIZE): Lut3D {
  const out = identityLut(size);
  const d = out.data;
  const gainR = 1 + 0.2 * grade.temperature + 0.1 * grade.tint;
  const gainG = 1 - 0.2 * grade.tint;
  const gainB = 1 - 0.2 * grade.temperature + 0.1 * grade.tint;
  const ev = Math.pow(2, grade.exposure);
  const con = Math.pow(2, grade.contrast);
  const sat = grade.saturation;
  const useLut = !!lut && grade.intensity > 0;
  const k = grade.intensity;
  const tm = curveTable(grade.curves.master), tr = curveTable(grade.curves.r),
    tg = curveTable(grade.curves.g), tb = curveTable(grade.curves.b);
  const px = new Float32Array(3);
  for (let i = 0; i < d.length; i += 3) {
    let r = d[i] * gainR * ev, g = d[i + 1] * gainG * ev, b = d[i + 2] * gainB * ev;
    r = (r - 0.5) * con + 0.5;
    g = (g - 0.5) * con + 0.5;
    b = (b - 0.5) * con + 0.5;
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    r = Math.min(Math.max(y + (r - y) * sat, 0), 1);
    g = Math.min(Math.max(y + (g - y) * sat, 0), 1);
    b = Math.min(Math.max(y + (b - y) * sat, 0), 1);
    if (useLut) {
      sampleLut(lut!, r, g, b, px);
      r += (px[0] - r) * k;
      g += (px[1] - g) * k;
      b += (px[2] - b) * k;
    }
    d[i] = lookup(tr, lookup(tm, r));
    d[i + 1] = lookup(tg, lookup(tm, g));
    d[i + 2] = lookup(tb, lookup(tm, b));
  }
  return out;
}

/** ffmpeg `vignette` angle for a 0..1 amount (the preview shader uses the same cos^4 falloff). */
export const vignetteAngle = (amount: number) => amount * 1.1;

// ---------------------------------------------------------------- .cube (Resolve / Adobe)

export function parseCube(text: string): Lut3D {
  let size3 = 0, size1 = 0, title: string | undefined;
  let lo = [0, 0, 0], hi = [1, 1, 1];
  const vals: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === "#") continue;
    const c = line.charCodeAt(0);
    if ((c >= 48 && c <= 57) || c === 45 || c === 46 || c === 43) {
      const p = line.split(/\s+/);
      if (p.length >= 3) vals.push(+p[0], +p[1], +p[2]);
      continue;
    }
    const [key, ...rest] = line.split(/\s+/);
    const K = key.toUpperCase();
    if (K === "TITLE") title = rest.join(" ").replace(/^"|"$/g, "");
    else if (K === "LUT_3D_SIZE") size3 = parseInt(rest[0], 10);
    else if (K === "LUT_1D_SIZE") size1 = parseInt(rest[0], 10);
    else if (K === "DOMAIN_MIN") lo = rest.slice(0, 3).map(Number);
    else if (K === "DOMAIN_MAX") hi = rest.slice(0, 3).map(Number);
    else if (K === "LUT_3D_INPUT_RANGE" || K === "LUT_1D_INPUT_RANGE") {
      lo = [+rest[0], +rest[0], +rest[0]];
      hi = [+rest[1], +rest[1], +rest[1]];
    }
  }
  let lut: Lut3D;
  if (size3 >= 2) {
    if (vals.length < size3 ** 3 * 3) throw new Error(`cube has ${vals.length / 3} rows, expected ${size3 ** 3}`);
    lut = { size: size3, data: Float32Array.from(vals.slice(0, size3 ** 3 * 3)), title };
  } else if (size1 >= 2) {
    // 1D LUT -> equivalent 3D cube
    if (vals.length < size1 * 3) throw new Error("1D cube is truncated");
    const ch = [0, 1, 2].map((c) => Float32Array.from({ length: size1 }, (_, i) => vals[i * 3 + c]));
    lut = identityLut(33);
    lut.title = title;
    // the table covers DOMAIN_MIN..DOMAIN_MAX; sample it at full resolution here, so no resample below
    for (let i = 0; i < lut.data.length; i++) lut.data[i] = lookup(ch[i % 3], (lut.data[i] - lo[i % 3]) / (hi[i % 3] - lo[i % 3]));
    lo = [0, 0, 0];
    hi = [1, 1, 1];
  } else throw new Error("not a .cube LUT (no LUT_3D_SIZE / LUT_1D_SIZE)");
  if (lo.some((v) => v !== 0) || hi.some((v) => v !== 1)) {
    // resample onto the standard 0..1 input domain
    const src = lut, res = identityLut(src.size), px = new Float32Array(3);
    for (let i = 0; i < res.data.length; i += 3) {
      sampleLut(src, (res.data[i] - lo[0]) / (hi[0] - lo[0]), (res.data[i + 1] - lo[1]) / (hi[1] - lo[1]),
        (res.data[i + 2] - lo[2]) / (hi[2] - lo[2]), px);
      res.data.set(px, i);
    }
    res.title = title;
    lut = res;
  }
  for (let i = 0; i < lut.data.length; i++) if (!Number.isFinite(lut.data[i])) throw new Error("cube contains non-numeric rows");
  return lut;
}

export function serializeCube(lut: Lut3D, title: string): string {
  const rows: string[] = [`TITLE "${title.replace(/"/g, "'")}"`, `LUT_3D_SIZE ${lut.size}`, ""];
  const d = lut.data;
  for (let i = 0; i < d.length; i += 3) rows.push(`${d[i].toFixed(6)} ${d[i + 1].toFixed(6)} ${d[i + 2].toFixed(6)}`);
  return rows.join("\n") + "\n";
}

// ---------------------------------------------------------------- .3dl (Autodesk / Lustre, also exported by Premiere)

export function parse3dl(text: string): Lut3D {
  const rows: number[][] = [];
  let mesh: number[] | null = null;
  let outBits = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const head = /^mesh\s+\d+\s+(\d+)/i.exec(line); // "Mesh <input bits> <output bits>"
    if (head) outBits = +head[1];
    if (!line || line[0] === "#" || /^[A-Za-z<]/.test(line)) continue;
    const p = line.split(/\s+/).map(Number);
    if (p.some((v) => !Number.isFinite(v))) continue;
    if (!mesh && p.length > 3) mesh = p;
    else if (p.length === 3) rows.push(p);
  }
  const size = mesh ? mesh.length : Math.round(Math.cbrt(rows.length));
  if (size < 2 || rows.length < size ** 3) throw new Error("not a valid .3dl LUT");
  let max = 0;
  for (const r of rows) max = Math.max(max, r[0], r[1], r[2]);
  // output depth: the header when there is one, otherwise the smallest depth that holds the largest value
  const scale = outBits >= 8 ? 2 ** outBits - 1 : max <= 1 ? 1 : max <= 255 ? 255 : max <= 1023 ? 1023 : max <= 4095 ? 4095 : 65535;
  const data = new Float32Array(size ** 3 * 3);
  // .3dl is blue-fastest; .cube is red-fastest
  for (let r = 0; r < size; r++)
    for (let g = 0; g < size; g++)
      for (let b = 0; b < size; b++) {
        const s = rows[r * size * size + g * size + b], o = (r + g * size + b * size * size) * 3;
        data[o] = s[0] / scale;
        data[o + 1] = s[1] / scale;
        data[o + 2] = s[2] / scale;
      }
  return { size, data };
}
