import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CACHE, bin, ensureDir, hash } from "./paths";

export function run(cmd: string, args: string[], opts: { fullStderr?: boolean } = {}): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    const out: Buffer[] = [];
    let err = "";
    p.stdout.on("data", (d) => out.push(d));
    p.stderr.on("data", (d) => (err = opts.fullStderr ? err + d : (err + d).slice(-6000)));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) resolve({ stdout: Buffer.concat(out), stderr: err });
      else reject(new Error(`${cmd} exited ${code}: ${err.slice(-1500)}`));
    });
  });
}

export interface Probe {
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
}

const probeCache = new Map<string, Probe>();

export async function probe(file: string): Promise<Probe> {
  const st = fs.statSync(file);
  const key = `${file}:${st.mtimeMs}:${st.size}`;
  const hit = probeCache.get(key);
  if (hit) return hit;
  const { stdout } = await run(bin("ffprobe"), ["-v", "error", "-show_streams", "-show_format", "-of", "json", file]);
  const j = JSON.parse(stdout.toString());
  const v = (j.streams ?? []).find((s: { codec_type: string }) => s.codec_type === "video");
  let width = v?.width ?? 0, height = v?.height ?? 0;
  const rot = Number((v?.side_data_list ?? []).find((s: { rotation?: number }) => s.rotation !== undefined)?.rotation ?? v?.tags?.rotate ?? 0);
  if (Math.abs(rot) % 180 === 90) [width, height] = [height, width];
  const [a, b] = String(v?.avg_frame_rate && v.avg_frame_rate !== "0/0" ? v.avg_frame_rate : v?.r_frame_rate ?? "30/1").split("/").map(Number);
  const res: Probe = {
    duration: Number(j.format?.duration ?? v?.duration ?? 0),
    width,
    height,
    fps: b ? a / b : a || 30,
    hasAudio: (j.streams ?? []).some((s: { codec_type: string }) => s.codec_type === "audio"),
  };
  probeCache.set(key, res);
  return res;
}

export const SPRITE_FRAMES = 24;

export function proxyPaths(file: string) {
  const st = fs.statSync(file);
  const id = hash(`${file}:${st.mtimeMs}:${st.size}`);
  const dir = ensureDir(path.join(CACHE, "proxies"));
  return { proxy: path.join(dir, `${id}.mp4`), sprite: path.join(dir, `${id}.jpg`) };
}

const inflight = new Map<string, Promise<{ proxy: string; sprite: string }>>();

/**
 * Small H.264 stand-in for scrubbing in the browser (camera originals are 4K HEVC): 720 px short
 * side, a keyframe every 6 frames so seeking is instant, plus a filmstrip for the source lanes.
 */
export function ensureProxy(file: string): Promise<{ proxy: string; sprite: string }> {
  const paths = proxyPaths(file);
  if (fs.existsSync(paths.proxy) && fs.existsSync(paths.sprite)) return Promise.resolve(paths);
  const running = inflight.get(paths.proxy);
  if (running) return running;
  const job = (async () => {
    const info = await probe(file);
    const tmp = paths.proxy + ".part.mp4";
    if (!fs.existsSync(paths.proxy)) {
      await run(bin("ffmpeg"), ["-v", "error", "-y", "-i", file,
        "-vf", "scale='if(gt(iw,ih),-2,720)':'if(gt(iw,ih),720,-2)':flags=bicubic:out_color_matrix=bt709,format=yuv420p",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-g", "6", "-bf", "0",
        "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
        "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", tmp]);
      fs.renameSync(tmp, paths.proxy);
    }
    const every = Math.max(info.duration / SPRITE_FRAMES, 0.01);
    await run(bin("ffmpeg"), ["-v", "error", "-y", "-i", paths.proxy,
      "-vf", `fps=1/${every.toFixed(5)},scale=-2:72,tile=${SPRITE_FRAMES}x1`, "-frames:v", "1", "-q:v", "4", paths.sprite]);
    return paths;
  })().finally(() => inflight.delete(paths.proxy));
  inflight.set(paths.proxy, job);
  return job;
}
