// UPFALL — a vintage travel poster for a place that isn't there.
// Draws one 768x1024 poster to /output/entry.png with Node stdlib only.
// Deterministic: fixed geometry, fixed palette, no randomness, no time, no network.
// The poster is rendered at 2x and downsampled for smooth edges.

import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

// ---------------------------------------------------------------------------
// PNG encoding (stdlib zlib + hand-rolled CRC32 / chunk writer)
// ---------------------------------------------------------------------------

const CRC_TABLE: number[] = (() => {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t.push(c >>> 0);
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(width: number, height: number, rgb: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type 2 = RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Canvas: an RGB buffer rendered at supersample SS, then box-downsampled.
// ---------------------------------------------------------------------------

type RGB = [number, number, number];

const SS = 2; // supersample factor
const W = 768;
const H = 1024;
const SW = W * SS;
const SH = H * SS;

class Canvas {
  buf: Uint8Array;
  constructor() {
    this.buf = new Uint8Array(SW * SH * 3);
  }
  // logical coordinates (poster space); internally scaled by SS
  set(x: number, y: number, c: RGB): void {
    const ix = Math.round(x * SS);
    const iy = Math.round(y * SS);
    if (ix < 0 || iy < 0 || ix >= SW || iy >= SH) return;
    const o = (iy * SW + ix) * 3;
    this.buf[o] = c[0];
    this.buf[o + 1] = c[1];
    this.buf[o + 2] = c[2];
  }
  // alpha-blended pixel, a in 0..1
  blend(x: number, y: number, c: RGB, a: number): void {
    const ix = Math.round(x * SS);
    const iy = Math.round(y * SS);
    if (ix < 0 || iy < 0 || ix >= SW || iy >= SH) return;
    const o = (iy * SW + ix) * 3;
    this.buf[o] = Math.round(this.buf[o] * (1 - a) + c[0] * a);
    this.buf[o + 1] = Math.round(this.buf[o + 1] * (1 - a) + c[1] * a);
    this.buf[o + 2] = Math.round(this.buf[o + 2] * (1 - a) + c[2] * a);
  }
  fillRect(x0: number, y0: number, x1: number, y1: number, c: RGB): void {
    const a = Math.max(0, Math.round(x0 * SS));
    const b = Math.min(SW, Math.round(x1 * SS));
    const d = Math.max(0, Math.round(y0 * SS));
    const e = Math.min(SH, Math.round(y1 * SS));
    for (let y = d; y < e; y++) {
      let o = (y * SW + a) * 3;
      for (let x = a; x < b; x++, o += 3) {
        this.buf[o] = c[0];
        this.buf[o + 1] = c[1];
        this.buf[o + 2] = c[2];
      }
    }
  }
  // vertical gradient between stops: [[y, color], ...] in logical coords
  vgrad(x0: number, y0: number, x1: number, y1: number, stops: [number, RGB][]): void {
    for (let y = Math.max(0, Math.round(y0 * SS)); y < Math.min(SH, Math.round(y1 * SS)); y++) {
      const ly = y / SS;
      let c: RGB = stops[stops.length - 1][1];
      for (let i = 0; i < stops.length - 1; i++) {
        const [ya, ca] = stops[i];
        const [yb, cb] = stops[i + 1];
        if (ly >= ya && ly <= yb) {
          const t = yb === ya ? 0 : (ly - ya) / (yb - ya);
          c = [
            Math.round(ca[0] + (cb[0] - ca[0]) * t),
            Math.round(ca[1] + (cb[1] - ca[1]) * t),
            Math.round(ca[2] + (cb[2] - ca[2]) * t),
          ];
          break;
        }
      }
      const a = Math.max(0, Math.round(x0 * SS));
      const b = Math.min(SW, Math.round(x1 * SS));
      let o = (y * SW + a) * 3;
      for (let x = a; x < b; x++, o += 3) {
        this.buf[o] = c[0];
        this.buf[o + 1] = c[1];
        this.buf[o + 2] = c[2];
      }
    }
  }
  fillCircle(cx: number, cy: number, r: number, c: RGB): void {
    const x0 = Math.max(0, Math.round((cx - r) * SS));
    const x1 = Math.min(SW - 1, Math.round((cx + r) * SS));
    const y0 = Math.max(0, Math.round((cy - r) * SS));
    const y1 = Math.min(SH - 1, Math.round((cy + r) * SS));
    const rr = r;
    for (let y = y0; y <= y1; y++) {
      const dy = (y + 0.5) / SS - cy;
      for (let x = x0; x <= x1; x++) {
        const dx = (x + 0.5) / SS - cx;
        if (dx * dx + dy * dy <= rr * rr) {
          const o = (y * SW + x) * 3;
          this.buf[o] = c[0];
          this.buf[o + 1] = c[1];
          this.buf[o + 2] = c[2];
        }
      }
    }
  }
  blendCircle(cx: number, cy: number, r: number, c: RGB, a: number): void {
    const x0 = Math.max(0, Math.round((cx - r) * SS));
    const x1 = Math.min(SW - 1, Math.round((cx + r) * SS));
    const y0 = Math.max(0, Math.round((cy - r) * SS));
    const y1 = Math.min(SH - 1, Math.round((cy + r) * SS));
    const rr = r;
    for (let y = y0; y <= y1; y++) {
      const dy = (y + 0.5) / SS - cy;
      for (let x = x0; x <= x1; x++) {
        const dx = (x + 0.5) / SS - cx;
        if (dx * dx + dy * dy <= rr * rr) {
          const o = (y * SW + x) * 3;
          this.buf[o] = Math.round(this.buf[o] * (1 - a) + c[0] * a);
          this.buf[o + 1] = Math.round(this.buf[o + 1] * (1 - a) + c[1] * a);
          this.buf[o + 2] = Math.round(this.buf[o + 2] * (1 - a) + c[2] * a);
        }
      }
    }
  }
  fillEllipse(cx: number, cy: number, rx: number, ry: number, c: RGB): void {
    const x0 = Math.max(0, Math.round((cx - rx) * SS));
    const x1 = Math.min(SW - 1, Math.round((cx + rx) * SS));
    const y0 = Math.max(0, Math.round((cy - ry) * SS));
    const y1 = Math.min(SH - 1, Math.round((cy + ry) * SS));
    for (let y = y0; y <= y1; y++) {
      const dy = ((y + 0.5) / SS - cy) / ry;
      for (let x = x0; x <= x1; x++) {
        const dx = ((x + 0.5) / SS - cx) / rx;
        if (dx * dx + dy * dy <= 1) {
          const o = (y * SW + x) * 3;
          this.buf[o] = c[0];
          this.buf[o + 1] = c[1];
          this.buf[o + 2] = c[2];
        }
      }
    }
  }
  // scanline polygon fill, points in logical coords
  fillPoly(pts: [number, number][], c: RGB): void {
    const n = pts.length;
    const ys = pts.map((p) => p[1] * SS);
    const yMin = Math.max(0, Math.floor(Math.min(...ys)));
    const yMax = Math.min(SH - 1, Math.ceil(Math.max(...ys)));
    for (let y = yMin; y <= yMax; y++) {
      const yc = y + 0.5;
      const xs: number[] = [];
      for (let i = 0; i < n; i++) {
        const [x1, y1] = pts[i];
        const [x2, y2] = pts[(i + 1) % n];
        const a = y1 * SS;
        const b = y2 * SS;
        if ((a <= yc && b > yc) || (b <= yc && a > yc)) {
          const t = (yc - a) / (b - a);
          xs.push((x1 + (x2 - x1) * t) * SS);
        }
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = Math.max(0, Math.ceil(xs[k]));
        const xb = Math.min(SW - 1, Math.floor(xs[k + 1]));
        for (let x = xa; x <= xb; x++) {
          const o = (y * SW + x) * 3;
          this.buf[o] = c[0];
          this.buf[o + 1] = c[1];
          this.buf[o + 2] = c[2];
        }
      }
    }
  }
  // thick line with round caps, width in logical px
  thickLine(x1: number, y1: number, x2: number, y2: number, w: number, c: RGB): void {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    const r = w / 2;
    if (len < 0.001) {
      this.fillCircle(x1, y1, r, c);
      return;
    }
    const nx = (-dy / len) * r;
    const ny = (dx / len) * r;
    this.fillPoly(
      [
        [x1 + nx, y1 + ny],
        [x2 + nx, y2 + ny],
        [x2 - nx, y2 - ny],
        [x1 - nx, y1 - ny],
      ],
      c,
    );
    this.fillCircle(x1, y1, r, c);
    this.fillCircle(x2, y2, r, c);
  }
  // box-downsample SSxSS -> 1x RGB buffer
  downsample(): Uint8Array {
    const out = new Uint8Array(W * H * 3);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let r = 0;
        let g = 0;
        let b = 0;
        for (let sy = 0; sy < SS; sy++) {
          for (let sx = 0; sx < SS; sx++) {
            const o = ((y * SS + sy) * SW + (x * SS + sx)) * 3;
            r += this.buf[o];
            g += this.buf[o + 1];
            b += this.buf[o + 2];
          }
        }
        const n = SS * SS;
        const o = (y * W + x) * 3;
        out[o] = Math.round(r / n);
        out[o + 1] = Math.round(g / n);
        out[o + 2] = Math.round(b / n);
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Vector stroke font: single-stroke letterforms on a 4-wide x 6-tall grid.
// Each glyph is a list of strokes; each stroke is a polyline of [x, y] points.
// Drawn with thick round-capped strokes, so letters stay crisp at poster size.
// ---------------------------------------------------------------------------

type Pt = [number, number];
type Glyph = Pt[][];

const FONT: Record<string, Glyph> = {
  A: [[[0, 6], [2, 0], [4, 6]], [[1, 4], [3, 4]]],
  B: [[[0, 0], [0, 6]], [[0, 0], [3, 0], [3.6, 0.8], [3, 1.8], [0, 1.8]], [[0, 1.8], [3, 1.8], [3.8, 2.6], [3.8, 4.6], [3, 6], [0, 6]]],
  C: [[[4, 1.2], [3, 0], [1, 0], [0, 1], [0, 5], [1, 6], [3, 6], [4, 4.8]]],
  D: [[[0, 0], [0, 6]], [[0, 0], [2.6, 0], [4, 1.4], [4, 4.6], [2.6, 6], [0, 6]]],
  E: [[[0, 0], [0, 6]], [[0, 0], [4, 0]], [[0, 3], [3, 3]], [[0, 6], [4, 6]]],
  F: [[[0, 0], [0, 6]], [[0, 0], [4, 0]], [[0, 3], [3, 3]]],
  G: [[[4, 1.2], [3, 0], [1, 0], [0, 1], [0, 5], [1, 6], [3, 6], [4, 4.8], [4, 3]], [[2.6, 3], [4, 3]]],
  H: [[[0, 0], [0, 6]], [[4, 0], [4, 6]], [[0, 3], [4, 3]]],
  I: [[[2, 0], [2, 6]], [[0, 0], [4, 0]], [[0, 6], [4, 6]]],
  J: [[[4, 0], [4, 4.6], [3, 6], [1, 6], [0, 4.8]]],
  K: [[[0, 0], [0, 6]], [[4, 0], [0, 3]], [[1.2, 3.8], [4, 6]]],
  L: [[[0, 0], [0, 6]], [[0, 6], [4, 6]]],
  M: [[[0, 6], [0, 0], [2, 3], [4, 0], [4, 6]]],
  N: [[[0, 6], [0, 0], [4, 6], [4, 0]]],
  O: [[[1, 0], [3, 0], [4, 1], [4, 5], [3, 6], [1, 6], [0, 5], [0, 1], [1, 0]]],
  P: [[[0, 6], [0, 0]], [[0, 0], [3, 0], [4, 1], [4, 2], [3, 3], [0, 3]]],
  Q: [[[1, 0], [3, 0], [4, 1], [4, 5], [3, 6], [1, 6], [0, 5], [0, 1], [1, 0]], [[2.4, 3.6], [4.4, 6]]],
  R: [[[0, 6], [0, 0]], [[0, 0], [3, 0], [4, 1], [4, 2], [3, 3], [0, 3]], [[2, 3], [4, 6]]],
  S: [[[4, 1.2], [3, 0], [1, 0], [0, 1], [0, 2], [1, 3], [3, 3], [4, 4], [4, 5], [3, 6], [1, 6], [0, 4.8]]],
  T: [[[0, 0], [4, 0]], [[2, 0], [2, 6]]],
  U: [[[0, 0], [0, 5], [1, 6], [3, 6], [4, 5], [4, 0]]],
  V: [[[0, 0], [2, 6], [4, 0]]],
  W: [[[0, 0], [1, 6], [2, 2.6], [3, 6], [4, 0]]],
  X: [[[0, 0], [4, 6]], [[4, 0], [0, 6]]],
  Y: [[[0, 0], [2, 3], [4, 0]], [[2, 3], [2, 6]]],
  Z: [[[0, 0], [4, 0], [0, 6], [4, 6]]],
  "0": [[[1, 0], [3, 0], [4, 1], [4, 5], [3, 6], [1, 6], [0, 5], [0, 1], [1, 0]], [[1.2, 2], [2.8, 4]]],
  "1": [[[2, 0], [2, 6]], [[1, 1], [2, 0]], [[0, 6], [4, 6]]],
  "2": [[[0, 1], [1, 0], [3, 0], [4, 1], [4, 2], [0, 6], [4, 6]]],
  "3": [[[0, 0], [3, 0], [4, 1], [4, 2], [2, 3]], [[2, 3], [4, 4], [4, 5], [3, 6], [0, 6]]],
  "4": [[[3, 0], [0, 4], [4, 4]], [[3, 0], [3, 6]]],
  "5": [[[4, 0], [0, 0], [0, 2], [3, 2], [4, 3], [4, 5], [3, 6], [0, 6]]],
  "6": [[[3, 0], [1, 0], [0, 2], [0, 5], [1, 6], [3, 6], [4, 5], [4, 3], [3, 2], [1, 2], [0, 3]]],
  "7": [[[0, 0], [4, 0], [2, 6]]],
  "8": [[[1, 0], [3, 0], [4, 1], [4, 2], [3, 3], [1, 3], [0, 2], [0, 1], [1, 0]], [[0, 4], [1, 3], [3, 3], [4, 4], [4, 5], [3, 6], [1, 6], [0, 5], [0, 4]]],
  "9": [[[4, 3], [3, 2], [1, 2], [0, 3], [0, 1], [1, 0], [3, 0], [4, 1], [4, 4], [3, 6], [1, 6]]],
  "-": [[[0, 3], [4, 3]]],
  ".": [[[2, 5.4], [2, 5.6]]],
  "'": [[[2, 0], [2, 1.6]]],
  "!": [[[2, 0], [2, 4]], [[2, 5.4], [2, 5.6]]],
  "·": [[[2, 3], [2, 3.2]]],
  " ": [],
};

const GLYPH_W = 4; // grid units wide
const GLYPH_H = 6; // grid units tall
const ADVANCE = 5; // grid units per character (incl. spacing)

function textWidth(text: string, size: number): number {
  // size = cap height in logical px; returns width in logical px
  const unit = size / GLYPH_H;
  let w = 0;
  for (const ch of text) {
    if (ch === " ") w += ADVANCE * 0.7 * unit;
    else w += ADVANCE * unit;
  }
  return w - unit; // no trailing advance
}

function drawText(cv: Canvas, text: string, cx: number, top: number, size: number, stroke: number, c: RGB): void {
  const unit = size / GLYPH_H;
  const w = textWidth(text, size);
  let x = cx - w / 2;
  for (const ch of text.toUpperCase()) {
    if (ch === " ") {
      x += ADVANCE * 0.7 * unit;
      continue;
    }
    const glyph = FONT[ch];
    if (glyph) {
      for (const s of glyph) {
        for (let i = 0; i + 1 < s.length; i++) {
          cv.thickLine(
            x + s[i][0] * unit,
            top + s[i][1] * unit,
            x + s[i + 1][0] * unit,
            top + s[i + 1][1] * unit,
            stroke,
            c,
          );
        }
      }
    }
    x += ADVANCE * unit;
  }
}

// ---------------------------------------------------------------------------
// Palette (vintage dusk, limited and purposeful)
// ---------------------------------------------------------------------------

const INK: RGB = [22, 50, 79]; // deep dusk blue — type, frame, boat
const TEAL: RGB = [47, 107, 122]; // mid sky / lake light
const LAKE_DARK: RGB = [18, 48, 62]; // lake depth
const LAKE: RGB = [30, 74, 88]; // lake surface
const APRICOT: RGB = [232, 135, 90]; // horizon warmth
const SUN: RGB = [247, 223, 160]; // low sun, cream
const PAPER: RGB = [243, 230, 200]; // poster paper, bottom band
const RUST: RGB = [180, 85, 45]; // tagline
const GREEN: RGB = [62, 107, 79]; // island tops
const ROCK: RGB = [74, 56, 40]; // island undersides
const ROCK_DARK: RGB = [52, 40, 30];
const WATER: RGB = [191, 232, 226]; // the rising water
const WATER_CORE: RGB = [234, 247, 244];
const LANTERN: RGB = [242, 166, 90];
const CLOUD: RGB = [247, 223, 160];
const MOUNT_FAR: RGB = [74, 107, 126];
const MOUNT_NEAR: RGB = [53, 86, 107];

// Quadratic bezier point
function qbez(p0: Pt, p1: Pt, p2: Pt, t: number): Pt {
  const u = 1 - t;
  return [
    u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
    u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
  ];
}

function drawPine(cv: Canvas, x: number, y: number, h: number, c: RGB): void {
  // a small stylised pine: three stacked triangles + trunk
  const w = h * 0.42;
  for (let i = 0; i < 3; i++) {
    const ty = y - h + (i * h) / 3;
    const tw = w * (0.55 + (i * 0.22));
    cv.fillPoly(
      [
        [x - tw, ty + h / 3],
        [x, ty],
        [x + tw, ty + h / 3],
      ],
      c,
    );
  }
  cv.fillRect(x - 1.5, y - 2, x + 1.5, y + 4, ROCK_DARK);
}

function drawLantern(cv: Canvas, x: number, y: number, s: number): void {
  cv.blendCircle(x, y, s * 2.1, LANTERN, 0.22);
  cv.fillRect(x - s / 2, y - s * 0.55, x + s / 2, y + s * 0.55, LANTERN);
  cv.fillRect(x - s / 2, y - s * 0.55, x + s / 2, y - s * 0.3, [214, 130, 62]);
  cv.fillRect(x - s / 2, y + s * 0.3, x + s / 2, y + s * 0.55, [214, 130, 62]);
  cv.thickLine(x, y + s * 0.55, x, y + s * 1.1, 1.5, [214, 130, 62]);
}

function drawBird(cv: Canvas, x: number, y: number, s: number): void {
  cv.thickLine(x - s, y, x, y + s * 0.45, 2.5, INK);
  cv.thickLine(x, y + s * 0.45, x + s, y, 2.5, INK);
}

// The rising waterfall: a curved band of water climbing from the lake
// to a floating island, with a bright core and scattered droplets.
function drawUpfall(cv: Canvas, p0: Pt, p1: Pt, p2: Pt, w0: number, w1: number): void {
  const N = 48;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const [x, y] = qbez(p0, p1, p2, t);
    const r = w0 + (w1 - w0) * t;
    cv.fillCircle(x, y, r, WATER);
  }
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const [x, y] = qbez(p0, p1, p2, t);
    const r = (w0 + (w1 - w0) * t) * 0.45;
    cv.fillCircle(x - 1.5, y, r, WATER_CORE);
  }
  // droplets flung off the rising stream (fixed positions, deterministic)
  const drops: [number, number, number][] = [
    [0.18, -16, 3], [0.34, 14, 2.5], [0.5, -13, 3], [0.62, 12, 2.5],
    [0.74, -11, 2.5], [0.86, 10, 2], [0.26, -22, 2], [0.58, 18, 2],
  ];
  for (const [t, off, r] of drops) {
    const [x, y] = qbez(p0, p1, p2, t);
    cv.fillCircle(x + off, y - 4, r, WATER_CORE);
  }
}

function drawScene(cv: Canvas): void {
  // --- sky: dusk gradient down to the apricot horizon ---
  cv.vgrad(0, 0, W, 648, [
    [0, [20, 38, 63]],
    [240, TEAL],
    [470, [196, 116, 84]],
    [648, APRICOT],
  ]);

  // --- low sun with a soft glow, right of centre ---
  cv.blendCircle(478, 512, 128, SUN, 0.1);
  cv.blendCircle(478, 512, 96, SUN, 0.14);
  cv.fillCircle(478, 512, 62, SUN);

  // --- flat stylised clouds ---
  cv.fillEllipse(190, 296, 118, 13, CLOUD);
  cv.fillEllipse(560, 238, 110, 11, CLOUD);
  cv.fillEllipse(684, 296, 62, 8, [240, 200, 150]);
  cv.fillEllipse(150, 420, 70, 8, [240, 200, 150]);

  // --- birds, high in the sky ---
  drawBird(cv, 168, 168, 11);
  drawBird(cv, 216, 146, 9);
  drawBird(cv, 648, 186, 10);

  // --- rain that falls UP: tiny rising streaks scattered in the sky ---
  const rain: [number, number][] = [
    [120, 180], [250, 120], [330, 210], [420, 150], [520, 120],
    [90, 320], [700, 150], [60, 460], [380, 90], [160, 250],
    [660, 330], [520, 480],
  ];
  for (const [x, y] of rain) {
    cv.thickLine(x, y + 6, x, y - 6, 2, WATER);
    cv.fillCircle(x, y - 8, 1.6, WATER_CORE);
  }

  // --- distant mountains, atmospheric perspective ---
  cv.fillPoly(
    [[0, 648], [0, 596], [90, 560], [170, 602], [260, 566], [350, 606], [450, 572], [540, 608], [640, 576], [730, 606], [768, 588], [768, 648]],
    MOUNT_FAR,
  );
  cv.fillPoly(
    [[0, 648], [0, 622], [120, 592], [230, 626], [360, 596], [500, 630], [620, 600], [768, 628], [768, 648]],
    MOUNT_NEAR,
  );

  // --- the lake ---
  cv.vgrad(0, 648, W, 840, [
    [648, LAKE],
    [840, LAKE_DARK],
  ]);
  // sun's reflection: a shimmering column under the sun, fading with depth
  const refl: [number, number, number, number][] = [
    [448, 656, 506, 4], [452, 674, 496, 4], [446, 694, 512, 3], [460, 714, 498, 3],
    [448, 734, 508, 3], [462, 754, 494, 3], [452, 776, 502, 2], [466, 798, 492, 2],
    [456, 818, 496, 2],
  ];
  for (const [x0, y, x1, h] of refl) {
    cv.fillRect(x0, y, x1, y + h, [217, 154, 85]);
  }

  // --- floating islands ---
  // right island (smaller, higher)
  cv.fillPoly([[540, 322], [662, 322], [640, 346], [562, 346]], GREEN);
  cv.fillPoly([[562, 346], [640, 346], [618, 396], [601, 428], [584, 396]], ROCK);
  cv.fillPoly([[584, 396], [618, 396], [601, 428]], ROCK_DARK);
  drawPine(cv, 566, 322, 26, [46, 84, 62]);
  drawPine(cv, 636, 322, 20, [46, 84, 62]);

  // main island (the hero, left of centre)
  cv.fillPoly([[192, 402], [412, 402], [384, 432], [220, 432]], GREEN);
  cv.fillPoly([[220, 432], [384, 432], [352, 496], [302, 556], [252, 496]], ROCK);
  cv.fillPoly([[252, 496], [352, 496], [302, 556]], ROCK_DARK);
  cv.thickLine(240, 470, 360, 470, 2, ROCK_DARK);
  cv.thickLine(262, 500, 342, 500, 2, ROCK_DARK);
  // a tiny cottage with a lit window on the island
  cv.fillRect(286, 378, 322, 402, PAPER);
  cv.fillPoly([[282, 378], [304, 360], [326, 378]], RUST);
  cv.fillRect(300, 388, 308, 402, [247, 200, 90]);
  drawPine(cv, 232, 402, 34, [46, 84, 62]);
  drawPine(cv, 372, 402, 28, [46, 84, 62]);
  drawPine(cv, 396, 402, 22, [46, 84, 62]);

  // --- THE UPFALL: the waterfall that climbs from the lake to the island ---
  // each stream starts just below the waterline so it rises out of the lake
  drawUpfall(cv, [384, 674], [296, 540], [302, 404], 15, 6);
  drawUpfall(cv, [548, 668], [566, 480], [600, 324], 9, 4);
  // splash rings where the rising water leaves the lake
  cv.fillEllipse(384, 652, 20, 5, WATER_CORE);
  cv.fillEllipse(548, 650, 13, 4, WATER_CORE);

  // --- paper lanterns drifting upward ---
  const lanterns: [number, number, number][] = [
    [120, 240, 9], [240, 180, 7], [420, 220, 8], [660, 260, 9],
    [90, 540, 8], [700, 500, 7], [500, 340, 6], [180, 620, 7],
    [620, 580, 6], [330, 130, 6], [560, 140, 7],
  ];
  for (const [x, y, s] of lanterns) drawLantern(cv, x, y, s);

  // --- a small sailboat on the lake, heading for the falls ---
  cv.fillPoly([[140, 730], [212, 730], [196, 748], [156, 748]], INK);
  cv.thickLine(176, 730, 176, 686, 3, INK);
  cv.fillPoly([[176, 688], [176, 728], [206, 728]], PAPER);
  cv.fillPoly([[174, 700], [174, 728], [152, 728]], [232, 135, 90]);
  cv.fillRect(150, 758, 202, 761, [120, 160, 168]);
  cv.fillRect(162, 768, 190, 771, [120, 160, 168]);

  // --- bottom band: paper, with the name set into it ---
  cv.fillRect(0, 840, W, H, PAPER);
  cv.fillRect(0, 840, W, 846, RUST);
  cv.fillRect(0, 852, W, 854, INK);
  drawText(cv, "UPFALL", W / 2, 862, 88, 10.5, INK);
  drawText(cv, "WHERE THE RAIN FALLS UP", W / 2, 962, 26, 3.2, RUST);

  // --- vintage double-rule frame around the whole poster ---
  cv.fillRect(14, 14, W - 14, 19, INK);
  cv.fillRect(14, H - 19, W - 14, H - 14, INK);
  cv.fillRect(14, 14, 19, H - 14, INK);
  cv.fillRect(W - 19, 14, W - 14, H - 14, INK);
  cv.fillRect(26, 26, W - 26, 28, INK);
  cv.fillRect(26, H - 28, W - 26, H - 26, INK);
  cv.fillRect(26, 26, 28, H - 26, INK);
  cv.fillRect(W - 28, 26, W - 26, H - 26, INK);
}

function main(): void {
  const cv = new Canvas();
  drawScene(cv);
  const rgb = cv.downsample();
  const png = encodePNG(W, H, rgb);
  const outDir = "/output";
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "entry.png");
  fs.writeFileSync(outPath, png);
  console.log(`wrote ${outPath}: ${W}x${H}, ${png.length} bytes`);
}

main();
