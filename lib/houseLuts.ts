// Looks generated from maths, so the library always has licence-free defaults.
import { curveTable, identityLut, type Lut3D } from "./color";
import type { CurvePoint } from "./types";

type RGB = [number, number, number];
const clamp = (x: number) => Math.min(Math.max(x, 0), 1);
const luma = (c: RGB) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

function tone(points: CurvePoint[]) {
  const t = curveTable(points, 1024);
  return (x: number) => t[Math.round(clamp(x) * 1023)];
}
const sat = (c: RGB, s: number): RGB => {
  const y = luma(c);
  return [y + (c[0] - y) * s, y + (c[1] - y) * s, y + (c[2] - y) * s];
};
/** push shadows towards one tint and highlights towards another, keeping mid-greys neutral */
const split = (c: RGB, shadow: RGB, high: RGB, amount: number): RGB => {
  const y = luma(c), ws = (1 - smooth(0, 0.55, y)) * amount, wh = smooth(0.45, 1, y) * amount;
  return [c[0] + shadow[0] * ws + high[0] * wh, c[1] + shadow[1] * ws + high[1] * wh, c[2] + shadow[2] * ws + high[2] * wh];
};

export interface HouseLook {
  id: string;
  name: string;
  look: string;
  fn: (c: RGB) => RGB;
}

const sCurve = tone([[0, 0], [0.25, 0.2], [0.5, 0.5], [0.75, 0.82], [1, 1]]);
const hardCurve = tone([[0, 0], [0.2, 0.1], [0.5, 0.5], [0.8, 0.92], [1, 1]]);
const fadeCurve = tone([[0, 0.06], [0.25, 0.24], [0.6, 0.62], [1, 0.95]]);
const nightCurve = tone([[0, 0], [0.1, 0.02], [0.3, 0.24], [0.65, 0.74], [1, 1]]);
const printCurve = tone([[0, 0.015], [0.18, 0.13], [0.5, 0.52], [0.8, 0.86], [1, 0.975]]);

export const HOUSE_LOOKS: HouseLook[] = [
  {
    id: "house-teal-orange",
    name: "Teal & Orange",
    look: "blockbuster split: teal shadows, orange highlights and skin, gentle S-curve",
    fn: (c) => {
      let o: RGB = [sCurve(c[0]), sCurve(c[1]), sCurve(c[2])];
      o = split(o, [-0.045, 0.012, 0.05], [0.05, 0.012, -0.055], 1);
      return sat(o, 1.12);
    },
  },
  {
    id: "house-print-film",
    name: "Print Film Warm",
    look: "print-stock feel: dense blacks with a slight lift, warm highlights, greens and blues pulled in",
    fn: (c) => {
      let o: RGB = [printCurve(c[0]), printCurve(c[1]), printCurve(c[2])];
      o = split(o, [-0.012, 0.004, 0.022], [0.035, 0.012, -0.045], 1);
      const y = luma(o), blueish = clamp((o[2] - Math.max(o[0], o[1])) * 3), greenish = clamp((o[1] - Math.max(o[0], o[2])) * 3);
      const s = 1.05 - 0.3 * blueish - 0.25 * greenish;
      return [y + (o[0] - y) * s, y + (o[1] - y) * s, y + (o[2] - y) * s];
    },
  },
  {
    id: "house-bleach-bypass",
    name: "Bleach Bypass",
    look: "silver-retained look: half the colour, hard contrast, slightly cool",
    fn: (c) => {
      const o = sat([hardCurve(c[0]), hardCurve(c[1]), hardCurve(c[2])], 0.5);
      return [o[0] - 0.008, o[1] + 0.002, o[2] + 0.012];
    },
  },
  {
    id: "house-night-amber",
    name: "Night Amber",
    look: "crushed blacks, cold shadows, amber highlights (the cigarette film look)",
    fn: (c) => {
      let o: RGB = [nightCurve(c[0]), nightCurve(c[1]), nightCurve(c[2])];
      o = split(o, [-0.04, 0, 0.05], [0.065, 0.012, -0.075], 1);
      return sat(o, 1.2);
    },
  },
  {
    id: "house-warm-fade",
    name: "Warm Fade",
    look: "lifted matte blacks, soft highlights, warm and a little desaturated",
    fn: (c) => {
      const o = sat([fadeCurve(c[0]), fadeCurve(c[1]), fadeCurve(c[2])], 0.86);
      return [o[0] + 0.025, o[1] + 0.008, o[2] - 0.03];
    },
  },
];

export function buildHouseLut(look: HouseLook, size = 33): Lut3D {
  const lut = identityLut(size);
  for (let i = 0; i < lut.data.length; i += 3) {
    const o = look.fn([lut.data[i], lut.data[i + 1], lut.data[i + 2]]);
    lut.data[i] = clamp(o[0]);
    lut.data[i + 1] = clamp(o[1]);
    lut.data[i + 2] = clamp(o[2]);
  }
  return lut;
}
