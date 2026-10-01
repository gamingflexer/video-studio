export type CurvePoint = [number, number];
export type CurveChannel = "master" | "r" | "g" | "b";
export type Curves = Record<CurveChannel, CurvePoint[]>;

export interface Grade {
  /** id of a LUT in the workspace library (luts/index.json), or null */
  lut: string | null;
  /** 0..1 mix between the ungraded picture and the LUT */
  intensity: number;
  /** stops */
  exposure: number;
  /** -1..1 */
  contrast: number;
  /** 0..2, 1 = unchanged */
  saturation: number;
  /** -1 (cool) .. 1 (warm) */
  temperature: number;
  /** -1 (green) .. 1 (magenta) */
  tint: number;
  /** 0..1, darkens the corners (applied after the LUT and curves) */
  vignette: number;
  curves: Curves;
}

/** a saved, still-editable grade (Resolve calls this a PowerGrade) */
export interface Look {
  id: string;
  name: string;
  grade: Grade;
  savedAt: string;
}

export interface Source {
  id: string;
  /** relative to the project folder, or absolute */
  file: string;
  label?: string;
}

export interface Shot {
  id: string;
  /** source id; null for generated shots (plates, flashes, title cards) */
  source: string | null;
  /** seconds in the source clip */
  in: number;
  out: number;
  speed: number;
  /** crop in source pixels after rotation: [w, h, x, y]; null = centre-fill the frame */
  crop?: [number, number, number, number] | null;
  /** extra clockwise rotation applied before the crop */
  rotate?: 0 | 90 | 180 | 270;
  label: string;
  /** why the editor (Claude) cut it this way */
  note?: string;
  /** generated shots: length in seconds and an optional still to show */
  duration?: number;
  image?: string;
  /** reviewer's comment (set in the Studio) */
  comment?: string;
  /** per-shot grade override (set in the Studio) */
  grade?: Grade | null;
}

export interface EditDoc {
  id: string;
  title: string;
  description?: string;
  width: number;
  height: number;
  fps: number;
  /** how this video is really built, for the hand-off prompt */
  build?: { script?: string; command?: string; notes?: string };
  sources: Source[];
  shots: Shot[];
  /** audio bed laid under the whole cut */
  audio?: { file: string } | null;
  rendersDir?: string;
  grade?: Grade;
}

/** a comment pinned to one moment of the film */
export interface Mark {
  id: string;
  /** seconds on the timeline when it was written */
  t: number;
  text: string;
  /** the shot under the playhead and the time inside its source clip, so the note survives re-cuts */
  shotId?: string;
  sourceT?: number;
}

export interface Review {
  shots: Shot[];
  marks?: Mark[];
  grade: Grade;
  /** overall comment for the next iteration */
  notes: string;
  gradeComment: string;
  /** why a shot was removed, keyed by shot id */
  removed?: Record<string, string>;
  preset: RenderPresetId;
  applyGrade: boolean;
  updatedAt: string;
}

export interface SourceInfo extends Source {
  abs: string;
  online: boolean;
  duration: number;
  /** display size, after the container rotation */
  width: number;
  height: number;
  fps: number;
}

export interface RenderFile {
  name: string;
  abs: string;
  size: number;
  mtime: number;
}

export interface ProjectPayload {
  dir: string;
  dirAbs: string;
  edit: EditDoc;
  review: Review | null;
  sources: SourceInfo[];
  renders: RenderFile[];
  audioAbs: string | null;
}

export interface LutMeta {
  id: string;
  name: string;
  file: string;
  size: number;
  group: "house" | "pack" | "web" | "upload" | "studio";
  origin?: string;
  look?: string;
  licence?: string;
  sourceUrl?: string;
  addedAt: string;
}

export type RenderPresetId = "preview" | "final" | "uhd" | "master";

export const RENDER_PRESETS: { id: RenderPresetId; name: string; detail: string }[] = [
  { id: "preview", name: "Preview", detail: "720p H.264, fast — for checking the cut" },
  { id: "final", name: "Final", detail: "project size, H.264 CRF 10 (export standard)" },
  { id: "uhd", name: "4K", detail: "2160 short side, H.264 CRF 10" },
  { id: "master", name: "Master", detail: "project size, ProRes 422 HQ 10-bit .mov" },
];
