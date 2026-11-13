/*
 * Fast AI Select - pure JavaScript image helpers.
 *
 * No DOM, no UXP and no network code lives here, so this file can be loaded
 * both by the plugin and by the Node.js test harness.
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
   * MODNet requires H/W to be multiples of 32. Keep the source aspect ratio:
   * the image is uniformly scaled to `targetLong`, then centered on a padded
   * canvas whose dimensions are multiples of 32. The returned content rectangle
   * is used both when building the tensor and when cropping the network matte.
   */
  function computeInputSize(width, height, targetLong, multiple) {
    width = Math.max(1, Math.round(width || 1));
    height = Math.max(1, Math.round(height || 1));
    multiple = multiple || 32;
    targetLong = targetLong || 384;

    var longSide = Math.max(width, height);
    var scale = targetLong / longSide;
    var contentWidth = Math.max(1, Math.round(width * scale));
    var contentHeight = Math.max(1, Math.round(height * scale));
    var outW = Math.max(multiple, Math.ceil(contentWidth / multiple) * multiple);
    var outH = Math.max(multiple, Math.ceil(contentHeight / multiple) * multiple);

    return {
      width: outW,
      height: outH,
      contentWidth: contentWidth,
      contentHeight: contentHeight,
      offsetX: Math.floor((outW - contentWidth) / 2),
      offsetY: Math.floor((outH - contentHeight) / 2),
      scale: scale
    };
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
   * Fractional area-average ranges. Unlike makeRanges() this accounts for the
   * partial source pixels at both ends of a destination cell, so arbitrary
   * downscale factors do not shift or alias edges.
   */
  function makeWeightedRanges(srcSize, dstSize) {
    var start = new Int32Array(dstSize);
    var end = new Int32Array(dstSize);
    var maxCount = Math.ceil(srcSize / dstSize) + 2;
    var weights = new Float32Array(dstSize * maxCount);

    for (var i = 0; i < dstSize; i++) {
      var from = i * srcSize / dstSize;
      var to = (i + 1) * srcSize / dstSize;
      var s = Math.floor(from);
      var e = Math.ceil(to);
      if (e <= s) e = s + 1;
      if (s < 0) s = 0;
      if (e > srcSize) e = srcSize;
      start[i] = s;
      end[i] = e;

      var total = 0;
      var base = i * maxCount;
      for (var j = s; j < e; j++) {
        var overlap = Math.min(to, j + 1) - Math.max(from, j);
        if (overlap < 0) overlap = 0;
        weights[base + j - s] = overlap;
        total += overlap;
      }
      if (total > 0) {
        var inv = 1 / total;
        for (j = 0; j < e - s; j++) weights[base + j] *= inv;
      }
    }

    return { start: start, end: end, weights: weights, maxCount: maxCount };
  }

  function writePaddedTensorEdges(data, plane, outW, outH, layout) {
    var x0 = layout.offsetX;
    var y0 = layout.offsetY;
    var cw = layout.contentWidth;
    var ch = layout.contentHeight;
    if (x0 === 0 && y0 === 0 && cw === outW && ch === outH) return;

    var x, y, channel, src, dst;
    for (y = y0; y < y0 + ch; y++) {
      var row = y * outW;
      src = row + x0;
      for (x = 0; x < x0; x++) {
        for (channel = 0; channel < 3; channel++) {
          dst = channel * plane + row + x;
          data[dst] = data[channel * plane + src];
        }
      }
      src = row + x0 + cw - 1;
      for (x = x0 + cw; x < outW; x++) {
        for (channel = 0; channel < 3; channel++) {
          dst = channel * plane + row + x;
          data[dst] = data[channel * plane + src];
        }
      }
    }

    for (y = 0; y < y0; y++) {
      var srcRow = y0 * outW;
      var dstRow = y * outW;
      for (x = 0; x < outW; x++) {
        for (channel = 0; channel < 3; channel++) {
          data[channel * plane + dstRow + x] = data[channel * plane + srcRow + x];
        }
      }
    }

    var lastRow = (y0 + ch - 1) * outW;
    for (y = y0 + ch; y < outH; y++) {
      dstRow = y * outW;
      for (x = 0; x < outW; x++) {
        for (channel = 0; channel < 3; channel++) {
          data[channel * plane + dstRow + x] = data[channel * plane + lastRow + x];
        }
      }
    }
  }

  /*
   * RGB(A) chunky Uint8Array -> normalized NCHW Float32 tensor.
   * Normalization used by MODNet: (value / 255 - 0.5) / 0.5.
   *
   * Downscaling uses fractional area averaging. Upscaling uses bilinear
   * interpolation. The optional layout object places the image on a larger
   * padded canvas while preserving its aspect ratio.
   */
  function rgbToTensorChw(rgb, width, height, components, outW, outH, out, layout) {
    components = components || 3;
    var plane = outW * outH;
    var data = out || new Float32Array(plane * 3);
    var content = layout || {
      offsetX: 0,
      offsetY: 0,
      contentWidth: outW,
      contentHeight: outH
    };
    var contentW = content.contentWidth;
    var contentH = content.contentHeight;
    var x0 = content.offsetX;
    var y0 = content.offsetY;
    var x, y, tx, ty, sx, sy, idx, dst;

    if (contentW >= width && contentH >= height) {
      /* Bilinear upscale. Centers match the alpha resampler. */
      for (ty = 0; ty < contentH; ty++) {
        sy = (ty + 0.5) * height / contentH - 0.5;
        if (sy < 0) sy = 0;
        if (sy > height - 1) sy = height - 1;
        var iy0 = Math.floor(sy);
        var fy = sy - iy0;
        var iy1 = iy0 + 1 < height ? iy0 + 1 : height - 1;

        for (tx = 0; tx < contentW; tx++) {
          sx = (tx + 0.5) * width / contentW - 0.5;
          if (sx < 0) sx = 0;
          if (sx > width - 1) sx = width - 1;
          var ix0 = Math.floor(sx);
          var fx = sx - ix0;
          var ix1 = ix0 + 1 < width ? ix0 + 1 : width - 1;

          var i00 = (iy0 * width + ix0) * components;
          var i10 = (iy0 * width + ix1) * components;
          var i01 = (iy1 * width + ix0) * components;
          var i11 = (iy1 * width + ix1) * components;
          var dstIdx = (y0 + ty) * outW + x0 + tx;
          var w00 = (1 - fx) * (1 - fy);
          var w10 = fx * (1 - fy);
          var w01 = (1 - fx) * fy;
          var w11 = fx * fy;

          for (var channel = 0; channel < 3; channel++) {
            var value = rgb[i00 + channel] * w00 + rgb[i10 + channel] * w10 +
              rgb[i01 + channel] * w01 + rgb[i11 + channel] * w11;
            data[channel * plane + dstIdx] = value * (2 / 255) - 1;
          }
        }
      }
    } else {
      var xr = makeWeightedRanges(width, contentW);
      var yr = makeWeightedRanges(height, contentH);
      for (ty = 0; ty < contentH; ty++) {
        var yStart = yr.start[ty];
        var yEnd = yr.end[ty];
        var yBase = ty * yr.maxCount;
        for (tx = 0; tx < contentW; tx++) {
          var sr = 0;
          var sg = 0;
          var sb = 0;
          var xStart = xr.start[tx];
          var xEnd = xr.end[tx];
          var xBase = tx * xr.maxCount;

          for (sy = yStart; sy < yEnd; sy++) {
            var wy = yr.weights[yBase + sy - yStart];
            if (wy === 0) continue;
            idx = (sy * width + xStart) * components;
            for (sx = xStart; sx < xEnd; sx++) {
              var wx = xr.weights[xBase + sx - xStart];
              if (wx !== 0) {
                var w = wx * wy;
                sr += rgb[idx] * w;
                sg += rgb[idx + 1] * w;
                sb += rgb[idx + 2] * w;
              }
              idx += components;
            }
          }

          dst = (y0 + ty) * outW + x0 + tx;
          data[dst] = sr * (2 / 255) - 1;
          data[plane + dst] = sg * (2 / 255) - 1;
          data[2 * plane + dst] = sb * (2 / 255) - 1;
        }
      }
    }

    writePaddedTensorEdges(data, plane, outW, outH, content);
    return { data: data, width: outW, height: outH, layout: content };
  }

  /*
   * Area-average resize for a float mask. This is used when the network matte
   * is larger than the guided-filter grid; plain bilinear sampling would drop
   * thin hair pixels.
   */
  function resizeAlphaArea(alpha, inW, inH, outW, outH, out) {
    var dst = out || new Float32Array(outW * outH);
    var xr = makeWeightedRanges(inW, outW);
    var yr = makeWeightedRanges(inH, outH);
    for (var y = 0; y < outH; y++) {
      var yStart = yr.start[y];
      var yEnd = yr.end[y];
      var yBase = y * yr.maxCount;
      var outRow = y * outW;
      for (var x = 0; x < outW; x++) {
        var xStart = xr.start[x];
        var xEnd = xr.end[x];
        var xBase = x * xr.maxCount;
        var sum = 0;
        for (var sy = yStart; sy < yEnd; sy++) {
          var wy = yr.weights[yBase + sy - yStart];
          if (wy === 0) continue;
          var row = sy * inW;
          for (var sx = xStart; sx < xEnd; sx++) {
            var wx = xr.weights[xBase + sx - xStart];
            if (wx !== 0) sum += alpha[row + sx] * wx * wy;
          }
        }
        dst[outRow + x] = sum;
      }
    }
    return dst;
  }

  /*
   * Resize a single-channel Float32 mask. Upscaling is bilinear; downscaling
   * is area-averaged and therefore anti-aliased.
   */
  function resizeAlphaBilinear(alpha, inW, inH, outW, outH, out) {
    if (outW < inW || outH < inH) {
      return resizeAlphaArea(alpha, inW, inH, outW, outH, out);
    }

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
    makeWeightedRanges: makeWeightedRanges,
    rgbToTensorChw: rgbToTensorChw,
    resizeAlphaArea: resizeAlphaArea,
    resizeAlphaBilinear: resizeAlphaBilinear,
    alphaToUint8: alphaToUint8
  };
});
