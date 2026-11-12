/*
 * Fast AI Select - fast guided filter for matte edge refinement.
 *
 * The neural matte is produced at 384/512 px and is therefore soft. This
 * implementation follows the "fast guided filter" idea:
 *
 *   1. downsample the guide (luma) and the matte by `subsample`,
 *   2. compute the linear coefficients a/b on the small grid using box
 *      filters backed by integral images (O(1) per pixel),
 *   3. bilinearly upsample a/b and evaluate q = a * I + b at full resolution.
 *
 * That is equivalent to running the guided filter on the upsampled matte, but
 * it never allocates a full-resolution float matte. For a 24 MP photo the
 * full-resolution pass only needs the RGB bytes, two row buffers and the
 * output mask.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./js/core.js'));
    return;
  }
  root.FASGuidedFilter = factory(root.FASCore);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core) {
  'use strict';

  if (!core) throw new Error('Fast AI Select: js/core.js must be loaded first.');

  /* Integral image of a single-channel Float32 array. */
  function integralImage(values, width, height) {
    var stride = width + 1;
    var integral = new Float64Array(stride * (height + 1));
    for (var y = 0; y < height; y++) {
      var rowSum = 0;
      var srcRow = y * width;
      var dstRow = (y + 1) * stride;
      var prevRow = y * stride;
      for (var x = 0; x < width; x++) {
        rowSum += values[srcRow + x];
        integral[dstRow + x + 1] = integral[prevRow + x + 1] + rowSum;
      }
    }
    return integral;
  }

  /* Box mean with radius r from an integral image, O(1) per pixel. */
  function boxMeanFromIntegral(integral, width, height, radius, out) {
    var stride = width + 1;
    var result = out || new Float32Array(width * height);
    var r = Math.max(0, Math.round(radius));

    for (var y = 0; y < height; y++) {
      var y0 = y - r;
      if (y0 < 0) y0 = 0;
      var y1 = y + r;
      if (y1 > height - 1) y1 = height - 1;
      var top = y0 * stride;
      var bottom = (y1 + 1) * stride;
      var invAreaY = 1 / (y1 - y0 + 1);
      var outRow = y * width;

      for (var x = 0; x < width; x++) {
        var x0 = x - r;
        if (x0 < 0) x0 = 0;
        var x1 = x + r;
        if (x1 > width - 1) x1 = width - 1;
        var sum = integral[bottom + x1 + 1] - integral[top + x1 + 1] -
          integral[bottom + x0] + integral[top + x0];
        result[outRow + x] = sum * invAreaY / (x1 - x0 + 1);
      }
    }
    return result;
  }

  function boxMean(values, width, height, radius) {
    return boxMeanFromIntegral(integralImage(values, width, height), width, height, radius);
  }

  /* Reusable integral image. The buffer must be zeroed on its borders. */
  function integralInto(values, width, height, out) {
    var stride = width + 1;
    var row;
    for (var x = 0; x < stride; x++) out[x] = 0;
    for (var y = 0; y < height; y++) {
      var rowSum = 0;
      var srcRow = y * width;
      var dstRow = (y + 1) * stride;
      var prevRow = y * stride;
      out[dstRow] = 0;
      for (x = 0; x < width; x++) {
        rowSum += values[srcRow + x];
        out[dstRow + x + 1] = out[prevRow + x + 1] + rowSum;
      }
    }
    return out;
  }

  /* Precomputed horizontal box spans, so the hot loop has no branches. */
  function makeSpans(width, radius) {
    var x0 = new Int32Array(width);
    var x1 = new Int32Array(width);
    var inv = new Float32Array(width);
    var r = Math.max(0, Math.round(radius));
    for (var x = 0; x < width; x++) {
      var a = x - r;
      if (a < 0) a = 0;
      var b = x + r;
      if (b > width - 1) b = width - 1;
      x0[x] = a;
      x1[x] = b;
      inv[x] = 1 / (b - a + 1);
    }
    return { x0: x0, x1: x1, inv: inv };
  }

  function boxMeanPrepared(integral, width, height, radius, spans, out) {
    var stride = width + 1;
    var r = Math.max(0, Math.round(radius));
    var x0 = spans.x0;
    var x1 = spans.x1;
    var inv = spans.inv;
    for (var y = 0; y < height; y++) {
      var top = (y - r < 0 ? 0 : y - r) * stride;
      var bottom = ((y + r > height - 1 ? height - 1 : y + r) + 1) * stride;
      var invAreaY = 1 / ((y + r > height - 1 ? height - 1 : y + r) -
        (y - r < 0 ? 0 : y - r) + 1);
      var outRow = y * width;
      for (var x = 0; x < width; x++) {
        var lo = x0[x];
        var hi = x1[x];
        out[outRow + x] = (integral[bottom + hi + 1] - integral[top + hi + 1] -
          integral[bottom + lo] + integral[top + lo]) * invAreaY * inv[x];
      }
    }
    return out;
  }

  /* Returns the averaged a/b coefficients on the small grid. */
  function guidedFilterCoefficients(guide, p, width, height, radius, eps) {
    var count = width * height;
    var guide2 = new Float32Array(count);
    var guideP = new Float32Array(count);
    var i;
    for (i = 0; i < count; i++) {
      guide2[i] = guide[i] * guide[i];
      guideP[i] = guide[i] * p[i];
    }

    var stride = width + 1;
    var integral = new Float64Array(stride * (height + 1));
    var spans = makeSpans(width, radius);
    var meanI = new Float32Array(count);
    var meanP = new Float32Array(count);
    var meanII = new Float32Array(count);
    var meanIP = new Float32Array(count);

    integralInto(guide, width, height, integral);
    boxMeanPrepared(integral, width, height, radius, spans, meanI);
    integralInto(p, width, height, integral);
    boxMeanPrepared(integral, width, height, radius, spans, meanP);
    integralInto(guide2, width, height, integral);
    boxMeanPrepared(integral, width, height, radius, spans, meanII);
    integralInto(guideP, width, height, integral);
    boxMeanPrepared(integral, width, height, radius, spans, meanIP);

    var a = new Float32Array(count);
    var b = new Float32Array(count);
    for (i = 0; i < count; i++) {
      var mean = meanI[i];
      var varI = meanII[i] - mean * mean;
      if (varI < 0) varI = 0;
      var covIP = meanIP[i] - mean * meanP[i];
      var ai = covIP / (varI + eps);
      a[i] = ai;
      b[i] = meanP[i] - ai * mean;
    }

    integralInto(b, width, height, integral);
    boxMeanPrepared(integral, width, height, radius, spans, b);
    integralInto(a, width, height, integral);
    boxMeanPrepared(integral, width, height, radius, spans, a);

    return { a: a, b: b };
  }

  function downsampleGuideLuma(rgb, width, height, components, outW, outH, subsample) {
    var guide = new Float32Array(outW * outH);
    for (var gy = 0; gy < outH; gy++) {
      var y0 = gy * subsample;
      var y1 = y0 + subsample;
      if (y1 > height) y1 = height;
      for (var gx = 0; gx < outW; gx++) {
        var x0 = gx * subsample;
        var x1 = x0 + subsample;
        if (x1 > width) x1 = width;
        var sum = 0;
        for (var y = y0; y < y1; y++) {
          var idx = (y * width + x0) * components;
          for (var x = x0; x < x1; x++) {
            /* Integer Rec.601 luma: (77 + 150 + 29) / 256 = 1. */
            sum += (77 * rgb[idx] + 150 * rgb[idx + 1] + 29 * rgb[idx + 2] + 128) >> 8;
            idx += components;
          }
        }
        var area = (x1 - x0) * (y1 - y0);
        guide[gy * outW + gx] = sum / (area * 255);
      }
    }
    return guide;
  }

  /*
   * Refine the low-resolution alpha matte against the full-resolution RGB
   * image and return a full-resolution Uint8 mask.
   *
   * opts = {
   *   rgb, width, height, components,   // Photoshop pixels (chunky RGB/RGBA)
   *   alpha, alphaW, alphaH,            // network output in [0..1]
   *   subsample = 4,
   *   radius = 8,      // in FULL-resolution pixels, not coarse cells
   *   eps = 1e-4,
   *   sharpen = 2      // matte contrast; 1 = keep the soft guided-filter ramp
   * }
   */
  function refine(opts) {
    var width = Math.max(1, Math.round(opts.width));
    var height = Math.max(1, Math.round(opts.height));
    var components = opts.components || 3;
    var rgb = opts.rgb;
    var subsample = Math.max(1, Math.round(opts.subsample || 4));
    var radiusFull = Math.max(1, Math.round(opts.radius || 8));
    /*
     * The coefficients live on the 1/subsample grid, so a full-resolution
     * radius must be divided by the subsample factor. Otherwise r=8 becomes a
     * 32 px blur at 4x downsampling, which shows up as a wide feathered halo
     * around clothes instead of a crisp edge.
     */
    var radius = Math.max(1, Math.round(radiusFull / subsample));
    var eps = typeof opts.eps === 'number' ? opts.eps : 1e-4;
    var sharpen = typeof opts.sharpen === 'number' ? opts.sharpen : 2;

    var outW = Math.max(1, Math.ceil(width / subsample));
    var outH = Math.max(1, Math.ceil(height / subsample));

    var guide = downsampleGuideLuma(opts.rgb, width, height, components, outW, outH, subsample);
    var p = core.resizeAlphaBilinear(opts.alpha, opts.alphaW, opts.alphaH, outW, outH);
    var coeff = guidedFilterCoefficients(guide, p, outW, outH, radius, eps);
    var meanA = coeff.a;
    var meanB = coeff.b;

    /*
     * The coefficients a/b are smooth, so most 4x4 cells are either fully
     * inside or fully outside the matte. We classify the coarse grid once and
     * only evaluate q = a*I + b at full resolution on the narrow boundary
     * band. That turns a 24 MP per-pixel pass into a few million operations.
     */
    var LOW = 0.002;
    var HIGH = 0.998;

    var smallCount = outW * outH;
    var qSmall = new Float32Array(smallCount);
    var rowMin = new Float32Array(outH);
    var rowMax = new Float32Array(outH);
    var i;
    for (i = 0; i < smallCount; i++) {
      qSmall[i] = meanA[i] * guide[i] + meanB[i];
    }
    for (var ry = 0; ry < outH; ry++) {
      var base = ry * outW;
      var lo = qSmall[base];
      var hi = qSmall[base];
      for (var rx = 1; rx < outW; rx++) {
        var qv = qSmall[base + rx];
        if (qv < lo) lo = qv;
        if (qv > hi) hi = qv;
      }
      rowMin[ry] = lo;
      rowMax[ry] = hi;
    }

    var out = new Uint8Array(width * height);
    var x0a = new Int32Array(width);
    var x1a = new Int32Array(width);
    var xfa = new Float32Array(width);
    var x;

    for (x = 0; x < width; x++) {
      var sx = (x + 0.5) / subsample - 0.5;
      if (sx < 0) sx = 0;
      if (sx > outW - 1) sx = outW - 1;
      var ix0 = Math.floor(sx);
      var fx = sx - ix0;
      var ix1 = ix0 + 1;
      if (ix1 >= outW) ix1 = outW - 1;
      x0a[x] = ix0;
      x1a[x] = ix1;
      xfa[x] = fx;
    }

    /*
     * x ranges that blend the coarse columns k and k+1. Pixels before
     * start[0] use column 0 alone, pixels after start[outW-1] use the last
     * column alone (both clamp at the borders).
     */
    var start = new Int32Array(outW);
    for (var k = 0; k < outW; k++) {
      start[k] = Math.ceil(subsample * k + subsample * 0.5 - 0.5);
      if (start[k] < 0) start[k] = 0;
      if (start[k] > width) start[k] = width;
    }

    function writeRange(xFrom, xTo, rowA, rowB, wy0, fy, rowPixel, rowOut) {
      for (var px = xFrom; px < xTo; px++) {
        var ci = x0a[px];
        var cj = x1a[px];
        var wx = xfa[px];

        var a00 = meanA[rowA + ci];
        var a01 = meanA[rowA + cj];
        var a10 = meanA[rowB + ci];
        var a11 = meanA[rowB + cj];
        var av = ((a00 + (a01 - a00) * wx) * wy0 +
          (a10 + (a11 - a10) * wx) * fy) * (1 / 255);

        var b00 = meanB[rowA + ci];
        var b01 = meanB[rowA + cj];
        var b10 = meanB[rowB + ci];
        var b11 = meanB[rowB + cj];
        var bv = (b00 + (b01 - b00) * wx) * wy0 +
          (b10 + (b11 - b10) * wx) * fy;

        var off = rowPixel + px * components;
        var luma = (77 * rgb[off] + 150 * rgb[off + 1] + 29 * rgb[off + 2] + 128) >> 8;
        var q = av * luma + bv;
        if (q <= 0) {
          out[rowOut + px] = 0;
        } else if (q >= 1) {
          out[rowOut + px] = 255;
        } else {
          out[rowOut + px] = (q * 255 + 0.5) | 0;
        }
      }
    }

    var pairInside = new Uint8Array(outW);
    var pairOutside = new Uint8Array(outW);
    var lastIy = -1;

    for (var y = 0; y < height; y++) {
      var sy = (y + 0.5) / subsample - 0.5;
      if (sy < 0) sy = 0;
      if (sy > outH - 1) sy = outH - 1;
      var iy0 = Math.floor(sy);
      var fy = sy - iy0;
      var iy1 = iy0 + 1;
      if (iy1 >= outH) iy1 = outH - 1;

      var rowOut = y * width;
      if (rowMax[iy0] <= LOW && rowMax[iy1] <= LOW) continue;
      if (rowMin[iy0] >= HIGH && rowMin[iy1] >= HIGH) {
        out.fill(255, rowOut, rowOut + width);
        continue;
      }

      if (iy0 !== lastIy) {
        var r0 = iy0 * outW;
        var r1 = iy1 * outW;
        for (var c = 0; c < outW; c++) {
          var q0 = qSmall[r0 + c];
          var q1 = qSmall[r1 + c];
          pairInside[c] = q0 >= HIGH && q1 >= HIGH ? 1 : 0;
          pairOutside[c] = q0 <= LOW && q1 <= LOW ? 1 : 0;
        }
        lastIy = iy0;
      }

      var rowA = iy0 * outW;
      var rowB = iy1 * outW;
      var wy0 = 1 - fy;
      var rowPixel = rowOut * components;

      var headEnd = start[0] < width ? start[0] : width;
      if (headEnd > 0) {
        if (pairInside[0]) {
          out.fill(255, rowOut, rowOut + headEnd);
        } else if (!pairOutside[0]) {
          writeRange(0, headEnd, rowA, rowB, wy0, fy, rowPixel, rowOut);
        }
      }

      for (var col = 0; col < outW - 1; col++) {
        var cx0 = start[col];
        var cx1 = start[col + 1] < width ? start[col + 1] : width;
        if (cx1 <= cx0) continue;
        if (pairInside[col] && pairInside[col + 1]) {
          out.fill(255, rowOut + cx0, rowOut + cx1);
        } else if (!(pairOutside[col] && pairOutside[col + 1])) {
          writeRange(cx0, cx1, rowA, rowB, wy0, fy, rowPixel, rowOut);
        }
      }

      var tailStart = start[outW - 1] < width ? start[outW - 1] : width;
      if (tailStart < width) {
        if (pairInside[outW - 1]) {
          out.fill(255, rowOut + tailStart, rowOut + width);
        } else if (!pairOutside[outW - 1]) {
          writeRange(tailStart, width, rowA, rowB, wy0, fy, rowPixel, rowOut);
        }
      }
    }

    /* Transparent source pixels must stay transparent (RGBA documents). */
    if (components === 4) {
      for (i = 0, x = 3; i < out.length; i++, x += 4) {
        var alphaByte = rgb[x];
        if (alphaByte !== 255) out[i] = ((out[i] * alphaByte + 127) / 255) | 0;
      }
    }

    /*
     * The guided filter ramp is smooth by construction. A moderate contrast
     * stretch keeps hair semi-transparent while turning the wide halo around
     * clothes into a crisp edge. Values are stretched around 0.5, so the
     * boundary position does not move.
     */
    if (sharpen !== 1) {
      for (i = 0; i < out.length; i++) {
        var q = 0.5 + (out[i] / 255 - 0.5) * sharpen;
        out[i] = q <= 0 ? 0 : (q >= 1 ? 255 : (q * 255 + 0.5) | 0);
      }
    }

    return {
      mask: out,
      width: width,
      height: height,
      guideWidth: outW,
      guideHeight: outH,
      subsample: subsample,
      radius: radius,
      radiusFull: radiusFull,
      sharpen: sharpen
    };
  }

  return {
    integralImage: integralImage,
    boxMean: boxMean,
    boxMeanFromIntegral: boxMeanFromIntegral,
    guidedFilterCoefficients: guidedFilterCoefficients,
    downsampleGuideLuma: downsampleGuideLuma,
    refine: refine
  };
});


