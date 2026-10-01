// WebGL2 monitor: one textured quad, the baked grade as a 3D texture, optional before/after wipe.
import type { Lut3D } from "./color";
import { vignetteAngle } from "./color";

const VS = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uFrame;
uniform sampler3D uLut;
uniform float uSize;
uniform mat3 uM;
uniform float uSplit;
uniform float uOn;
uniform float uVig;
uniform vec2 uRes;
void main() {
  vec2 s = (uM * vec3(vUv, 1.0)).xy;
  vec3 c = texture(uFrame, s).rgb;
  vec3 g = c;
  if (uOn > 0.5 && vUv.x >= uSplit) {
    g = texture(uLut, c * ((uSize - 1.0) / uSize) + 0.5 / uSize).rgb;
    if (uVig > 0.0) {
      // same falloff as ffmpeg's vignette filter: cos(angle * d)^4, d = distance / half-diagonal
      float d = length((vUv - 0.5) * uRes) / (0.5 * length(uRes));
      float f = cos(uVig * d);
      g *= f * f * f * f;
    }
  }
  outColor = vec4(g, 1.0);
}`;

export type UV = [number, number, number, number, number, number]; // rows: [a b c] [d e f]
export const IDENTITY_UV: UV = [1, 0, 0, 0, 1, 0];

export interface DrawOpts {
  uv: UV;
  gradeOn: boolean;
  /** 0..1: left of this x stays ungraded (before/after wipe) */
  split: number;
  vignette: number;
}

export class GradeRenderer {
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private frame: WebGLTexture;
  private lut: WebGLTexture;
  private lutSize = 2;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private hasFrame = false;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error("WebGL2 is not available in this browser");
    this.gl = gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader error");
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? "link error");
    this.prog = prog;
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    for (const n of ["uFrame", "uLut", "uSize", "uM", "uSplit", "uOn", "uVig", "uRes"]) this.u[n] = gl.getUniformLocation(prog, n);

    this.frame = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.frame);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));

    this.lut = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, this.lut);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE]] as const)
      gl.texParameteri(gl.TEXTURE_3D, k, v);
    gl.uniform1i(this.u.uFrame, 0);
    gl.uniform1i(this.u.uLut, 1);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  }

  private current: Lut3D | null = null;

  setLut(lut: Lut3D) {
    if (lut === this.current) return;
    this.current = lut;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, this.lut);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, lut.size, lut.size, lut.size, 0, gl.RGB, gl.FLOAT, lut.data);
    this.lutSize = lut.size;
  }

  /** Upload a new picture (video frame or image). Returns false when the element has nothing decoded yet. */
  upload(src: HTMLVideoElement | HTMLImageElement | null): boolean {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.frame);
    if (!src) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
      this.hasFrame = true;
      return true;
    }
    if (src instanceof HTMLVideoElement ? src.readyState < 2 || !src.videoWidth : !src.complete || !src.naturalWidth) return false;
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      this.hasFrame = true;
      return true;
    } catch {
      return false;
    }
  }

  draw(o: DrawOpts) {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    if (!this.hasFrame) {
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }
    const [a, b, c, d, e, f] = o.uv;
    gl.uniformMatrix3fv(this.u.uM, false, [a, d, 0, b, e, 0, c, f, 1]);
    gl.uniform1f(this.u.uSize, this.lutSize);
    gl.uniform1f(this.u.uSplit, o.split);
    gl.uniform1f(this.u.uOn, o.gradeOn && this.current ? 1 : 0);
    gl.uniform1f(this.u.uVig, vignetteAngle(o.vignette));
    gl.uniform2f(this.u.uRes, this.canvas.width, this.canvas.height);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** The current picture WITHOUT the grade, scaled down — feeds LUT thumbnails and the histogram. */
  snapshot(o: DrawOpts, maxSide = 112): ImageData | null {
    if (!this.hasFrame) return null;
    this.draw({ ...o, gradeOn: false, split: 0 });
    const k = maxSide / Math.max(this.canvas.width, this.canvas.height);
    const w = Math.max(2, Math.round(this.canvas.width * k)), h = Math.max(2, Math.round(this.canvas.height * k));
    const c2 = document.createElement("canvas");
    c2.width = w;
    c2.height = h;
    const ctx = c2.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(this.canvas, 0, 0, w, h);
    this.draw(o);
    return ctx.getImageData(0, 0, w, h);
  }
}
