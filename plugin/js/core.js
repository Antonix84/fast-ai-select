/*
 * Fast AI Select - pure JavaScript image helpers.
 *
 * No DOM, no UXP and no network code lives here, so this file can be loaded
 * both by the panel and by the Node.js test harness.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.FASCore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function clamp(value, min, max) {
    return value < min ? min : (value > max ? max : value);
  }

  /*
   * MODNet accepts any H/W, but both dimensions are rounded to a multiple of
   * 32 so the encoder/decoder skips are aligned. The long side of the source
   * becomes `targetLong` (384 or 512).
   */
  function computeInputSize(width, height, targetLong, multiple) {
    width = Math.max(1, Math.round(width || 1));
    height = Math.max(1, Math.round(height || 1));
    multiple = multiple || 32;
    var longSide = Math.max(width, height);
    var scale = (targetLong || 384) / longSide;
    var outW = Math.max(multiple, Math.round(width * scale / multiple) * multiple);
    var outH = Math.max(multiple, Math.round(height * scale / multiple) * multiple);
    return { width: outW, height: outH, scale: scale };
  }

  /* Integer source ranges for a box resize. Every source pixel is covered. */
  function makeRanges(srcSize, dstSize) {
    var start = new Int32Array(dstSize);
    var end = new Int32Array(dstSize);
    for (var i = 0; i < dstSize; i++) {
      var s = Math.floor(i * srcSize / dstSize);
      var e = Math.floor((i + 1) * srcSize / dstSize);
      if (e <= s) e = s + 1;
      if (e > srcSize) e = srcSize;
      start[i] = s;
      end[i] = e;
    }
    return { start: start, end: end };
  }

  /*
   * RGB(A) chunky Uint8Array -> normalized NCHW Float32 tensor.
   * Normalization used by MODNet: (value / 255 - 0.5) / 0.5.
   * The resize is an area-average (box) filter, which gives clean input even
   * for a 6000x4000 photo.
   */
  function rgbToTensorChw(rgb, width, height, components, outW, outH, out) {
    components = components || 3;
    var plane = outW * outH;
    var data = out || new Float32Array(plane * 3);
    var xr = makeRanges(width, outW);
    var yr = makeRanges(height, outH);

    for (var ty = 0; ty < outH; ty++) {
      var y0 = yr.start[ty];
      var y1 = yr.end[ty];
      var rowBase = ty * outW;
      var areaY = y1 - y0;
      for (var tx = 0; tx < outW; tx++) {
        var x0 = xr.start[tx];
        var x1 = xr.end[tx];
        var sr = 0;
        var sg = 0;
        var sb = 0;
        for (var sy = y0; sy < y1; sy++) {
          var idx = (sy * width + x0) * components;
          for (var sx = x0; sx < x1; sx++) {
            sr += rgb[idx];
            sg += rgb[idx + 1];
            sb += rgb[idx + 2];
            idx += components;
          }
        }
        var scale = 2 / ((x1 - x0) * areaY * 255);
        data[rowBase + tx] = sr * scale - 1;
        data[plane + rowBase + tx] = sg * scale - 1;
        data[2 * plane + rowBase + tx] = sb * scale - 1;
      }
    }
    return { data: data, width: outW, height: outH };
  }

  /* Bilinear resize for a single-channel Float32 mask. */
  function resizeAlphaBilinear(alpha, inW, inH, outW, outH, out) {
    var dst = out || new Float32Array(outW * outH);
    var x0a = new Int32Array(outW);
    var x1a = new Int32Array(outW);
    var xfa = new Float32Array(outW);
    var x, sx, ix0, ix1, fx;

    for (x = 0; x < outW; x++) {
      sx = (x + 0.5) * inW / outW - 0.5;
      if (sx < 0) sx = 0;
      if (sx > inW - 1) sx = inW - 1;
      ix0 = Math.floor(sx);
      fx = sx - ix0;
      ix1 = ix0 + 1;
      if (ix1 >= inW) ix1 = inW - 1;
      x0a[x] = ix0;
      x1a[x] = ix1;
      xfa[x] = fx;
    }

    var sy, iy0, iy1, fy, row0, row1, w0, w1;
    for (var y = 0; y < outH; y++) {
      sy = (y + 0.5) * inH / outH - 0.5;
      if (sy < 0) sy = 0;
      if (sy > inH - 1) sy = inH - 1;
      iy0 = Math.floor(sy);
      fy = sy - iy0;
      iy1 = iy0 + 1;
      if (iy1 >= inH) iy1 = inH - 1;
      row0 = iy0 * inW;
      row1 = iy1 * inW;
      w0 = 1 - fy;
      w1 = fy;
      var outRow = y * outW;
      for (x = 0; x < outW; x++) {
        ix0 = x0a[x];
        ix1 = x1a[x];
        fx = xfa[x];
        var a = alpha[row0 + ix0] * (1 - fx) + alpha[row0 + ix1] * fx;
        var b = alpha[row1 + ix0] * (1 - fx) + alpha[row1 + ix1] * fx;
        dst[outRow + x] = a * w0 + b * w1;
      }
    }
    return dst;
  }

  function alphaToUint8(alpha, width, height) {
    var count = width * height;
    var out = new Uint8Array(count);
    for (var i = 0; i < count; i++) {
      var v = alpha[i];
      if (v <= 0) {
        out[i] = 0;
      } else if (v >= 1) {
        out[i] = 255;
      } else {
        out[i] = (v * 255 + 0.5) | 0;
      }
    }
    return out;
  }

  return {
    clamp: clamp,
    computeInputSize: computeInputSize,
    makeRanges: makeRanges,
    rgbToTensorChw: rgbToTensorChw,
    resizeAlphaBilinear: resizeAlphaBilinear,
    alphaToUint8: alphaToUint8
  };
});
