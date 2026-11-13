/*
 * Pure-JS checks for Fast AI Select.
 *
 *   node tools/test-core.js
 *
 * Covers resizing/normalization, mask quantization and the fast guided filter,
 * including a 24 MP benchmark that mirrors a 4000x6000 photo.
 */
'use strict';

const path = require('path');
const core = require(path.join(__dirname, '..', 'plugin', 'js', 'core.js'));
const guided = require(path.join(__dirname, '..', 'plugin', 'guided_filter.js'));

let failures = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log('  ok   ' + name);
  } else {
    failures++;
    console.log('  FAIL ' + name + (detail ? ' — ' + detail : ''));
  }
}

function nearly(a, b, tolerance) {
  return Math.abs(a - b) <= (tolerance === undefined ? 1e-5 : tolerance);
}

function section(title) {
  console.log('\n' + title);
}

/* ------------------------------------------------------------------ */
section('computeInputSize');

{
  const a = core.computeInputSize(6000, 4000, 384, 32);
  check('landscape 6000x4000 -> 384x256', a.width === 384 && a.height === 256, JSON.stringify(a));

  const b = core.computeInputSize(4000, 6000, 384, 32);
  check('portrait 4000x6000 -> 256x384', b.width === 256 && b.height === 384, JSON.stringify(b));

  const c = core.computeInputSize(4000, 6000, 512, 32);
  // 341.3 px wide, centered on a 352 px wide multiple-of-32 canvas.
  check('portrait high -> 352x512 canvas',
    c.width === 352 && c.height === 512, JSON.stringify(c));
  check('portrait content keeps its aspect ratio',
    c.contentWidth === 341 && c.contentHeight === 512 &&
    c.offsetX === 5 && c.offsetY === 0, JSON.stringify(c));
  check('letterbox aspect distortion is below 0.5%',
    Math.abs((c.contentWidth / c.contentHeight) / (4000 / 6000) - 1) < 0.005,
    (c.contentWidth / c.contentHeight) + ' vs ' + (4000 / 6000));

  const wide = core.computeInputSize(10000, 1000, 512, 32);
  check('extreme wide image keeps aspect and is padded vertically',
    wide.width === 512 && wide.height === 64 &&
    wide.contentWidth === 512 && wide.contentHeight === 51 &&
    wide.offsetY === 6, JSON.stringify(wide));

  const d = core.computeInputSize(1000, 999, 384, 32);
  check('odd aspect stays multiple of 32',
    d.width % 32 === 0 && d.height % 32 === 0 && Math.max(d.width, d.height) === 384,
    JSON.stringify(d));

  const e = core.computeInputSize(10, 10, 384, 32);
  check('tiny image is upscaled to the network size',
    e.width === 384 && e.height === 384, JSON.stringify(e));
}

/* ------------------------------------------------------------------ */
section('makeRanges');

{
  const r = core.makeRanges(10, 4);
  let covered = 0;
  let contiguous = true;
  for (let i = 0; i < 4; i++) {
    covered += r.end[i] - r.start[i];
    if (i > 0 && r.start[i] !== r.end[i - 1]) contiguous = false;
  }
  check('all source pixels covered once', covered === 10, String(covered));
  check('ranges are contiguous', contiguous);
}

/* ------------------------------------------------------------------ */
section('rgbToTensorChw');

{
  // 4x2 RGB image, resized to 2x1. Each output pixel averages a 2x2 block.
  const rgb = new Uint8Array([
    255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255,
    0, 0, 0, 255, 255, 255, 128, 128, 128, 255, 0, 255,
  ]);
  const t = core.rgbToTensorChw(rgb, 4, 2, 3, 2, 1);
  check('tensor length', t.data.length === 6, String(t.data.length));

  // Block 1: ((255+0+0+255)/4, (0+255+0+255)/4, (0+0+0+255)/4)
  // = (127.5, 127.5, 63.75)
  const expected = [
    (127.5 * 2) / 255 - 1,
    (127.5 * 2) / 255 - 1,
    (63.75 * 2) / 255 - 1,
  ];
  check('channel R of first block', nearly(t.data[0], expected[0], 1e-6),
    t.data[0] + ' vs ' + expected[0]);
  check('channel G of first block', nearly(t.data[2], expected[1], 1e-6),
    t.data[2] + ' vs ' + expected[1]);
  check('channel B of first block', nearly(t.data[4], expected[2], 1e-6),
    t.data[4] + ' vs ' + expected[2]);

  // Normalization maps 0 -> -1 and 255 -> +1.
  const flat = new Uint8Array(32 * 32 * 3);
  for (let i = 0; i < flat.length; i++) flat[i] = i % 3 === 0 ? 255 : 0;
  const t2 = core.rgbToTensorChw(flat, 32, 32, 3, 32, 32);
  check('white maps to +1', nearly(t2.data[0], 1));
  check('black maps to -1', nearly(t2.data[32 * 32], -1));

  // RGBA input keeps the same component stride.
  const rgba = new Uint8Array(4 * 4 * 4);
  for (let i = 0; i < 16; i++) {
    rgba[i * 4] = 200;
    rgba[i * 4 + 1] = 100;
    rgba[i * 4 + 2] = 50;
    rgba[i * 4 + 3] = 0; // alpha must not influence the tensor
  }
  const t3 = core.rgbToTensorChw(rgba, 4, 4, 4, 4, 4);
  check('RGBA stride respected', nearly(t3.data[0], (200 * 2) / 255 - 1, 1e-6));

  // Upscaling must interpolate, not repeat source pixels (nearest-neighbour).
  const small = new Uint8Array([
    0, 0, 0, 100, 100, 100,
    200, 200, 200, 255, 255, 255,
  ]);
  const up = core.rgbToTensorChw(small, 2, 2, 3, 4, 4);
  check('bilinear upscale interpolates horizontally',
    nearly(up.data[1], (25 * 2) / 255 - 1, 1e-6),
    String(up.data[1]));

  const constant = new Uint8Array(2 * 2 * 3).fill(50);
  const upConstant = core.rgbToTensorChw(constant, 2, 2, 3, 7, 5);
  let constantOk = true;
  for (let i = 0; i < upConstant.data.length; i++) {
    if (!nearly(upConstant.data[i], (50 * 2) / 255 - 1, 1e-6)) constantOk = false;
  }
  check('bilinear upscale preserves a constant field', constantOk);

  // Letterbox padding must not leave black/zero bands in the tensor.
  const red = new Uint8Array(4 * 2 * 3);
  for (let i = 0; i < 4 * 2; i++) red[i * 3] = 255;
  const padded = core.rgbToTensorChw(red, 4, 2, 3, 8, 8, null, {
    offsetX: 2, offsetY: 3, contentWidth: 4, contentHeight: 2,
  });
  let paddedOk = true;
  const plane = 8 * 8;
  for (let channel = 0; channel < 3; channel++) {
    const expected = channel === 0 ? 1 : -1;
    for (let i = 0; i < plane; i++) {
      if (!nearly(padded.data[channel * plane + i], expected, 1e-6)) paddedOk = false;
    }
  }
  check('letterbox padding replicates the edge', paddedOk);

  const fractional = new Uint8Array([
    0, 0, 0, 50, 50, 50, 100, 100, 100, 150, 150, 150, 200, 200, 200,
  ]);
  const fractionalDown = core.rgbToTensorChw(fractional, 5, 1, 3, 2, 1);
  check('fractional downscale uses partial edge weights',
    nearly(fractionalDown.data[0], (40 * 2) / 255 - 1, 1e-6),
    String(fractionalDown.data[0]));
}

/* ------------------------------------------------------------------ */
section('resizeAlphaBilinear');

{
  const src = new Float32Array([0, 1, 1, 0]);
  const out = core.resizeAlphaBilinear(src, 2, 2, 4, 4);
  check('output size', out.length === 16, String(out.length));
  check('corners kept', out[0] === 0 && out[3] >= 0 && out[12] >= 0 && out[15] === 0,
    JSON.stringify(Array.from(out)));

  const constant = new Float32Array(81).fill(0.42);
  const up = core.resizeAlphaBilinear(constant, 9, 9, 17, 11);
  let same = true;
  for (let i = 0; i < up.length; i++) if (!nearly(up[i], 0.42, 1e-6)) same = false;
  check('constant field preserved', same);

  const down = core.resizeAlphaBilinear(constant, 9, 9, 2, 3);
  same = true;
  for (let i = 0; i < down.length; i++) if (!nearly(down[i], 0.42, 1e-6)) same = false;
  check('constant field preserved when downscaling', same);

  // A one-pixel hair must contribute to the downscaled matte instead of being
  // skipped by point sampling.
  const thin = new Float32Array(8 * 8);
  thin[3 * 8 + 3] = 1;
  const thinDown = core.resizeAlphaBilinear(thin, 8, 8, 2, 2);
  const expectedThin = 1 / 16;
  check('alpha downscale preserves thin details',
    nearly(thinDown[0], expectedThin, 1e-5), String(thinDown[0]));
}

/* ------------------------------------------------------------------ */
section('alphaToUint8');

{
  const mask = core.alphaToUint8(new Float32Array([-0.5, 0, 0.5, 1, 2]), 5, 1);
  check('clamping and rounding',
    Array.from(mask).join(',') === '0,0,128,255,255',
    Array.from(mask).join(','));
}

/* ------------------------------------------------------------------ */
section('guided filter');

{
  // Constant matte over a constant guide: q must equal p.
  const w = 64;
  const h = 48;
  const rgb = new Uint8Array(w * h * 3).fill(128);
  const alpha = new Float32Array(32 * 24).fill(0.5);
  const refined = guided.refine({
    rgb, width: w, height: h, components: 3,
    alpha, alphaW: 32, alphaH: 24,
    subsample: 4, radius: 8, eps: 1e-4, sharpen: 1,
  });
  check('mask size', refined.mask.length === w * h, String(refined.mask.length));
  let min = 255;
  let max = 0;
  for (let i = 0; i < refined.mask.length; i++) {
    if (refined.mask[i] < min) min = refined.mask[i];
    if (refined.mask[i] > max) max = refined.mask[i];
  }
  check('flat matte stays flat (127..128)', min >= 127 && max <= 128, min + '..' + max);

  // Pixels outside the matte stay fully transparent.
  const alphaZero = new Float32Array(32 * 24);
  const zero = guided.refine({
    rgb, width: w, height: h, components: 3,
    alpha: alphaZero, alphaW: 32, alphaH: 24,
  });
  let allZero = true;
  for (let i = 0; i < zero.mask.length; i++) if (zero.mask[i] !== 0) allZero = false;
  check('zero matte stays zero', allZero);

  // RGBA transparent pixels are multiplied out.
  const rgba = new Uint8Array(w * h * 4).fill(255);
  for (let i = 0; i < w * h; i++) rgba[i * 4 + 3] = 0;
  const cleared = guided.refine({
    rgb: rgba, width: w, height: h, components: 4,
    alpha: new Float32Array(32 * 24).fill(1), alphaW: 32, alphaH: 24,
  });
  let clearedAll = true;
  for (let i = 0; i < cleared.mask.length; i++) if (cleared.mask[i] !== 0) clearedAll = false;
  check('transparent RGBA pixels are masked out', clearedAll);

  const halfRgba = new Uint8Array(w * h * 4).fill(255);
  for (let i = 0; i < w * h; i++) halfRgba[i * 4 + 3] = 128;
  const half = guided.refine({
    rgb: halfRgba, width: w, height: h, components: 4,
    alpha: new Float32Array(32 * 24).fill(0.5), alphaW: 32, alphaH: 24,
  });
  check('sharpening happens before source alpha',
    half.mask[w * h / 2 + w / 2] >= 63 && half.mask[w * h / 2 + w / 2] <= 65,
    String(half.mask[w * h / 2 + w / 2]));

  const cutMask = guided.refine({
    rgb: halfRgba, width: w, height: h, components: 4,
    alpha: new Float32Array(32 * 24).fill(0.5), alphaW: 32, alphaH: 24,
    respectSourceAlpha: false,
  });
  check('layer-mask mode does not apply source alpha twice',
    cutMask.mask[w * h / 2 + w / 2] === 128,
    String(cutMask.mask[w * h / 2 + w / 2]));

  const softAlpha = guided.refine({
    rgb, width: w, height: h, components: 3,
    alpha: new Float32Array(32 * 24).fill(0.3), alphaW: 32, alphaH: 24,
  });
  check('default contrast preserves weak semi-transparent hair',
    softAlpha.mask[0] >= 55 && softAlpha.mask[0] <= 57,
    String(softAlpha.mask[0]));
}

/* ------------------------------------------------------------------ */
section('refine matches a brute-force reference');

{
  const w = 128;
  const h = 96;
  const s = 4;
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const edge = x < w / 2 ? 1 : 0;
      rgb[i] = 40 + 180 * edge + (y % 7);
      rgb[i + 1] = 30 + 120 * edge + (x % 5);
      rgb[i + 2] = 20 + 60 * edge;
    }
  }

  const aw = 32;
  const ah = 24;
  const alpha = new Float32Array(aw * ah);
  for (let y = 0; y < ah; y++) {
    for (let x = 0; x < aw; x++) {
      const d = (x - 16) / 8;
      alpha[y * aw + x] = Math.max(0, Math.min(1, 1 - d * d * 0.5));
    }
  }

  const outW = Math.ceil(w / s);
  const outH = Math.ceil(h / s);
  const xAxis = guided.makeAxisInterpolation(w, outW, s);
  const yAxis = guided.makeAxisInterpolation(h, outH, s);
  const guide = guided.downsampleGuideLuma(rgb, w, h, 3, outW, outH, s);
  const p = core.resizeAlphaBilinear(alpha, aw, ah, outW, outH);
  const coarseRadius = Math.max(1, Math.round(8 / s));
  const coeff = guided.guidedFilterCoefficients(guide, p, outW, outH, coarseRadius, 1e-4);

  const reference = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const iy0 = yAxis.lo[y];
    const iy1 = yAxis.hi[y];
    const fy = yAxis.weight[y];
    for (let x = 0; x < w; x++) {
      const ix0 = xAxis.lo[x];
      const ix1 = xAxis.hi[x];
      const fx = xAxis.weight[x];
      const b00 = coeff.a[iy0 * outW + ix0];
      const b01 = coeff.a[iy0 * outW + ix1];
      const b10 = coeff.a[iy1 * outW + ix0];
      const b11 = coeff.a[iy1 * outW + ix1];
      const a = (b00 + (b01 - b00) * fx) * (1 - fy) + (b10 + (b11 - b10) * fx) * fy;
      const c00 = coeff.b[iy0 * outW + ix0];
      const c01 = coeff.b[iy0 * outW + ix1];
      const c10 = coeff.b[iy1 * outW + ix0];
      const c11 = coeff.b[iy1 * outW + ix1];
      const b = (c00 + (c01 - c00) * fx) * (1 - fy) + (c10 + (c11 - c10) * fx) * fy;
      const i = (y * w + x) * 3;
      const luma = (77 * rgb[i] + 150 * rgb[i + 1] + 29 * rgb[i + 2] + 128) >> 8;
      const q = a * (luma / 255) + b;
      reference[y * w + x] = q <= 0 ? 0 : (q >= 1 ? 255 : (q * 255 + 0.5) | 0);
    }
  }

  const fast = guided.refine({
    rgb, width: w, height: h, components: 3,
    alpha, alphaW: aw, alphaH: ah,
    radius: 8, sharpen: 1,
  });

  let maxDiff = 0;
  let diffCount = 0;
  for (let i = 0; i < reference.length; i++) {
    const d = Math.abs(reference[i] - fast.mask[i]);
    if (d > maxDiff) maxDiff = d;
    if (d > 1) diffCount++;
  }
  check('fast refine matches full evaluation (<= 1 level)', diffCount === 0,
    'max diff ' + maxDiff + ', pixels > 1: ' + diffCount);
}

/* ------------------------------------------------------------------ */
section('refine is exact on irregular sizes, RGBA and strong contrast');

{
  function referenceRefine(opts) {
    const width = opts.width;
    const height = opts.height;
    const s = opts.subsample || 4;
    const outW = Math.ceil(width / s);
    const outH = Math.ceil(height / s);
    const xAxis = guided.makeAxisInterpolation(width, outW, s);
    const yAxis = guided.makeAxisInterpolation(height, outH, s);
    const guide = guided.downsampleGuideLuma(
      opts.rgb, width, height, opts.components, outW, outH, s);
    const p = core.resizeAlphaBilinear(
      opts.alpha, opts.alphaW, opts.alphaH, outW, outH);
    const coeff = guided.guidedFilterCoefficients(
      guide, p, outW, outH, Math.max(1, Math.round((opts.radius || 8) / s)),
      opts.eps === undefined ? 1e-4 : opts.eps);
    const sharpen = opts.sharpen === undefined ? 1.4 : opts.sharpen;
    const respectAlpha = opts.respectSourceAlpha !== false;
    const out = new Uint8Array(width * height);

    for (let y = 0; y < height; y++) {
      const iy0 = yAxis.lo[y];
      const iy1 = yAxis.hi[y];
      const fy = yAxis.weight[y];
      for (let x = 0; x < width; x++) {
        const ix0 = xAxis.lo[x];
        const ix1 = xAxis.hi[x];
        const fx = xAxis.weight[x];
        const pa = [
          coeff.a[iy0 * outW + ix0], coeff.a[iy0 * outW + ix1],
          coeff.a[iy1 * outW + ix0], coeff.a[iy1 * outW + ix1],
        ];
        const pb = [
          coeff.b[iy0 * outW + ix0], coeff.b[iy0 * outW + ix1],
          coeff.b[iy1 * outW + ix0], coeff.b[iy1 * outW + ix1],
        ];
        const av = (pa[0] + (pa[1] - pa[0]) * fx) * (1 - fy) +
          (pa[2] + (pa[3] - pa[2]) * fx) * fy;
        const bv = (pb[0] + (pb[1] - pb[0]) * fx) * (1 - fy) +
          (pb[2] + (pb[3] - pb[2]) * fx) * fy;
        const i = (y * width + x) * opts.components;
        const luma = (77 * opts.rgb[i] + 150 * opts.rgb[i + 1] +
          29 * opts.rgb[i + 2] + 128) >> 8;
        let q = av * (luma / 255) + bv;
        q = 0.5 + (q - 0.5) * sharpen;
        if (q < 0) q = 0;
        if (q > 1) q = 1;
        if (respectAlpha && opts.components === 4) q *= opts.rgb[i + 3] / 255;
        out[y * width + x] = (q * 255 + 0.5) | 0;
      }
    }
    return out;
  }

  let seed = 1234567;
  function random() {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  }

  const width = 61;
  const height = 47;
  const aw = 17;
  const ah = 13;
  const alpha = new Float32Array(aw * ah);
  for (let i = 0; i < alpha.length; i++) alpha[i] = random();

  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    rgb[i * 3] = (random() * 255) | 0;
    rgb[i * 3 + 1] = (random() * 255) | 0;
    rgb[i * 3 + 2] = (random() * 255) | 0;
  }

  const opts = {
    rgb, width, height, components: 3,
    alpha, alphaW: aw, alphaH: ah,
    subsample: 4, radius: 8, sharpen: 1.4,
  };
  const expected = referenceRefine(opts);
  const actual = guided.refine(opts);
  let bad = 0;
  let maxDiff = 0;
  for (let i = 0; i < expected.length; i++) {
    const d = Math.abs(expected[i] - actual.mask[i]);
    if (d > maxDiff) maxDiff = d;
    if (d > 1) bad++;
  }
  check('random irregular RGB/RGBA matte matches full evaluation',
    bad === 0, 'max diff ' + maxDiff + ', pixels > 1: ' + bad);

  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = (random() * 255) | 0;
    rgba[i * 4 + 1] = (random() * 255) | 0;
    rgba[i * 4 + 2] = (random() * 255) | 0;
    rgba[i * 4 + 3] = (random() * 256) | 0;
  }
  const rgbaOpts = {
    rgb: rgba, width, height, components: 4,
    alpha, alphaW: aw, alphaH: ah,
    subsample: 4, radius: 12, sharpen: 2,
  };
  const rgbaExpected = referenceRefine(rgbaOpts);
  const rgbaActual = guided.refine(rgbaOpts);
  bad = 0;
  maxDiff = 0;
  for (let i = 0; i < rgbaExpected.length; i++) {
    const d = Math.abs(rgbaExpected[i] - rgbaActual.mask[i]);
    if (d > maxDiff) maxDiff = d;
    if (d > 1) bad++;
  }
  check('RGBA with partial alpha and sharpen=2 matches full evaluation',
    bad === 0, 'max diff ' + maxDiff + ', pixels > 1: ' + bad);
}

/* ------------------------------------------------------------------ */
section('coarse-cell interpolation');

{
  const axis = guided.makeAxisInterpolation(10, 3, 4);
  check('last partial cell uses its real center',
    axis.centers[2] === 8.5, String(axis.centers[2]));
  check('right border clamps to the last cell',
    axis.lo[9] === 2 && axis.hi[9] === 2 && axis.weight[9] === 0,
    axis.lo[9] + '/' + axis.hi[9] + '/' + axis.weight[9]);
}

/* ------------------------------------------------------------------ */
section('matte sharpening');

{
  const w = 400;
  const h = 200;
  const edge = Math.round(w / 2);
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = x < edge ? 20 : 235;
      const i = (y * w + x) * 3;
      rgb[i] = v;
      rgb[i + 1] = v;
      rgb[i + 2] = v;
    }
  }

  const aw = 100;
  const ah = 50;
  const alpha = new Float32Array(aw * ah);
  const aEdge = Math.round(aw / 2);
  for (let y = 0; y < ah; y++) {
    for (let x = 0; x < aw; x++) {
      alpha[y * aw + x] = Math.min(1, Math.max(0, (x - (aEdge - 3)) / 6));
    }
  }

  function measure(mask) {
    const y = Math.floor(h / 2);
    let first = -1;
    let last = -1;
    let mid = -1;
    for (let x = edge - 60; x < edge + 60; x++) {
      const v = mask[y * w + x];
      if (v > 8 && v < 247) {
        if (first < 0) first = x;
        last = x;
      }
      if (mid < 0 && v >= 128) mid = x;
    }
    return { width: first < 0 ? 0 : last - first + 1, mid };
  }

  const soft = guided.refine({
    rgb, width: w, height: h, components: 3,
    alpha, alphaW: aw, alphaH: ah, radius: 8, sharpen: 1,
  });
  const sharp = guided.refine({
    rgb, width: w, height: h, components: 3,
    alpha, alphaW: aw, alphaH: ah, radius: 8,
  });

  const a = measure(soft.mask);
  const b = measure(sharp.mask);
  check('soft ramp is wide without sharpening', a.width >= 12, String(a.width));
  check('sharpening at least halves the halo', b.width <= a.width * 0.5,
    a.width + ' -> ' + b.width);
  check('sharpening keeps the boundary position', Math.abs(a.mid - b.mid) <= 2,
    a.mid + ' vs ' + b.mid);
  check('radius is converted to the coarse grid',
    sharp.radius === 2 && sharp.radiusFull === 8,
    sharp.radius + '/' + sharp.radiusFull);
}

/* ------------------------------------------------------------------ */
section('integral image');

{
  const values = new Float32Array([1, 2, 3, 4, 5, 6]);
  const sum = guided.integralImage(values, 3, 2);
  check('width+1 stride', sum.length === 4 * 3, String(sum.length));
  check('total sum', nearly(sum[sum.length - 1], 21));

  const mean = guided.boxMean(values, 3, 2, 100);
  let all = true;
  for (let i = 0; i < mean.length; i++) if (!nearly(mean[i], 21 / 6)) all = false;
  check('full-image box mean clamps radius', all);
}

/* ------------------------------------------------------------------ */
section('24 MP benchmark (4000x6000)');

{
  const w = 4000;
  const h = 6000;
  const rgb = new Uint8Array(w * h * 3);
  // Vertical gradient plus a soft person-shaped blob.
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = (row + x) * 3;
      const base = ((x * 255 / w) * 0.3 + (y * 255 / h) * 0.3) | 0;
      rgb[i] = base;
      rgb[i + 1] = Math.min(255, base + 40);
      rgb[i + 2] = Math.min(255, base + 80);
    }
  }
  // Realistic matte: solid interior, narrow soft edge (like MODNet output).
  const alpha = new Float32Array(256 * 384);
  for (let y = 0; y < 384; y++) {
    for (let x = 0; x < 256; x++) {
      const dx = (x - 128) / 70;
      const dy = (y - 195) / 135;
      const d = dx * dx + dy * dy;
      alpha[y * 256 + x] = d <= 0.92 ? 1 : (d >= 1.08 ? 0 : (1.08 - d) / 0.16);
    }
  }

  const t0 = process.hrtime.bigint();
  const out = guided.refine({
    rgb, width: w, height: h, components: 3,
    alpha, alphaW: 256, alphaH: 384,
    subsample: 4, radius: 8, eps: 1e-4,
  });
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1e6;

  check('mask size 24 MP', out.mask.length === w * h, String(out.mask.length));
  let outside = 0;
  for (let i = 0; i < out.mask.length; i++) if (out.mask[i] > 8) outside++;
  const outsideRatio = outside / out.mask.length;
  check('most of the frame is empty', outsideRatio < 0.8, (outsideRatio * 100).toFixed(1) + '%');
  console.log('  info guided filter on 4000x6000: ' + ms.toFixed(0) + ' ms');
  check('within 500 ms on Node', ms < 500, ms.toFixed(0) + ' ms');
}

/* ------------------------------------------------------------------ */
section('12 MP benchmark (3000x4000)');

{
  const w = 3000;
  const h = 4000;
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = (row + x) * 3;
      const base = ((x * 255 / w) * 0.4 + (y * 255 / h) * 0.4) | 0;
      rgb[i] = base;
      rgb[i + 1] = Math.min(255, base + 30);
      rgb[i + 2] = Math.min(255, base + 60);
    }
  }
  const aw = 192;
  const ah = 288;
  const alpha = new Float32Array(aw * ah);
  for (let y = 0; y < ah; y++) {
    for (let x = 0; x < aw; x++) {
      const dx = (x - 96) / 55;
      const dy = (y - 150) / 105;
      const d = dx * dx + dy * dy;
      alpha[y * aw + x] = d <= 0.92 ? 1 : (d >= 1.08 ? 0 : (1.08 - d) / 0.16);
    }
  }

  const t0 = process.hrtime.bigint();
  const out = guided.refine({
    rgb, width: w, height: h, components: 3,
    alpha, alphaW: aw, alphaH: ah,
    subsample: 4, radius: 8, eps: 1e-4,
  });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  check('mask size 12 MP', out.mask.length === w * h, String(out.mask.length));
  console.log('  info guided filter on 3000x4000: ' + ms.toFixed(0) + ' ms');
  check('near the 80-120 ms target on a 12 MP photo', ms < 300, ms.toFixed(0) + ' ms');
}

/* ------------------------------------------------------------------ */
console.log('');
if (failures) {
  console.log(failures + ' check(s) failed');
  process.exit(1);
}
console.log('all core checks passed');
