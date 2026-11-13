/*
 * Fast AI Select - fast guided filter for matte edge refinement.
 *
 * The neural matte is produced at 384/512/768 px and is therefore soft. This
 * implementation follows the "fast guided filter" idea:
 *
 *   1. downsample the guide (luma) and the matte by `subsample`,
 *   2. compute the linear coefficients a/b on the small grid using box
 *      filters backed by integral images (O(1) per pixel),
 *   3. bilinearly upsample a/b and evaluate q = a * I + b at full resolution.
 *
 * That is equivalent to running the guided filter on the upsampled matte, but
 * it never allocates a full-resolution float matte. Every full-resolution
 * pixel is evaluated: classifying whole 4x4 cells from the block-average
 * texture and then filling them with 0/255 is not mathematically safe and can
 * delete thin hair or create hard artefacts.
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
   * Bilinear lookup from full-resolution pixels to coarse-cell centers. The
   * final cell can be partial, so its true center is not always at
   * (i + 0.5) * subsample - 0.5. Using the actual centers avoids a 1.5 px edge
   * shift on images whose size is not a multiple of the subsample factor.
   */
  function makeAxisInterpolation(fullSize, cellCount, subsample) {
    var centers = new Float32Array(cellCount);
    for (var i = 0; i < cellCount; i++) {
      var from = i * subsample;
      var to = Math.min(fullSize, from + subsample);
      centers[i] = (from + to - 1) / 2;
    }

    var lo = new Int32Array(fullSize);
    var hi = new Int32Array(fullSize);
    var weight = new Float32Array(fullSize);
    var cell = 0;
    for (var x = 0; x < fullSize; x++) {
      while (cell < cellCount - 1 && centers[cell] < x) cell++;
      if (x <= centers[0]) {
        lo[x] = 0;
        hi[x] = 0;
        weight[x] = 0;
      } else if (x >= centers[cellCount - 1]) {
        lo[x] = cellCount - 1;
        hi[x] = cellCount - 1;
        weight[x] = 0;
      } else {
        hi[x] = cell;
        lo[x] = cell - 1;
        var span = centers[cell] - centers[cell - 1];
        weight[x] = span > 0 ? (x - centers[cell - 1]) / span : 0;
      }
    }
    return { centers: centers, lo: lo, hi: hi, weight: weight };
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
   *   sharpen = 1.4,   // matte contrast; 1 = keep the soft guided-filter ramp
   *   respectSourceAlpha = true
   * }
   *
   * respectSourceAlpha must be false when the result is used as a layer mask:
   * Photoshop applies the layer's existing alpha itself, so multiplying here
   * would make semi-transparent pixels transparent twice.
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
    var sharpen = typeof opts.sharpen === 'number' && opts.sharpen > 0 ? opts.sharpen : 1.4;
    var respectSourceAlpha = opts.respectSourceAlpha !== false;

    var outW = Math.max(1, Math.ceil(width / subsample));
    var outH = Math.max(1, Math.ceil(height / subsample));

    var guide = downsampleGuideLuma(opts.rgb, width, height, components, outW, outH, subsample);
    var p = core.resizeAlphaBilinear(opts.alpha, opts.alphaW, opts.alphaH, outW, outH);
    var coeff = guidedFilterCoefficients(guide, p, outW, outH, radius, eps);
    var meanA = coeff.a;
    var meanB = coeff.b;

    var out = new Uint8Array(width * height);
    var xAxis = makeAxisInterpolation(width, outW, subsample);
    var yAxis = makeAxisInterpolation(height, outH, subsample);
    var x0a = xAxis.lo;
    var x1a = xAxis.hi;
    var xfa = xAxis.weight;
    var x;

    /* Coefficients interpolated vertically once per output row. */
    var aRow = new Float32Array(outW);
    var bRow = new Float32Array(outW);
    var alphaMul = respectSourceAlpha && components === 4 ? 1 / 255 : 0;
    var byteScale = 255;
    var sharpenOffset = 0.5 - 0.5 * sharpen;
    var sharpenScale = sharpen;

    for (var y = 0; y < height; y++) {
      var iy0 = yAxis.lo[y];
      var iy1 = yAxis.hi[y];
      var fy = yAxis.weight[y];

      var r0 = iy0 * outW;
      var r1 = iy1 * outW;
      for (var c = 0; c < outW; c++) {
        aRow[c] = meanA[r0 + c] + (meanA[r1 + c] - meanA[r0 + c]) * fy;
        bRow[c] = meanB[r0 + c] + (meanB[r1 + c] - meanB[r0 + c]) * fy;
      }

      var rowOut = y * width;
      var rowPixel = rowOut * components;
      for (x = 0; x < width; x++) {
        var ci = x0a[x];
        var cj = x1a[x];
        var wx = xfa[x];
        var av = aRow[ci] + (aRow[cj] - aRow[ci]) * wx;
        var bv = bRow[ci] + (bRow[cj] - bRow[ci]) * wx;

        var off = rowPixel + x * components;
        var luma = (77 * rgb[off] + 150 * rgb[off + 1] + 29 * rgb[off + 2] + 128) >> 8;
        var q = av * (luma / 255) + bv;

        /*
         * Contrast is applied to the floating-point matte before quantization.
         * q' = 0.5 + (q - 0.5) * sharpen, clamped to [0, 1].
         */
        q = q * sharpenScale + sharpenOffset;
        if (q <= 0) {
          q = 0;
        } else if (q >= 1) {
          q = 1;
        }

        if (alphaMul && rgb[off + 3] !== 255) {
          q *= rgb[off + 3] * alphaMul;
        }

        out[rowOut + x] = (q * byteScale + 0.5) | 0;
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
      sharpen: sharpen,
      respectSourceAlpha: respectSourceAlpha
    };
  }

  return {
    integralImage: integralImage,
    boxMean: boxMean,
    boxMeanFromIntegral: boxMeanFromIntegral,
    guidedFilterCoefficients: guidedFilterCoefficients,
    downsampleGuideLuma: downsampleGuideLuma,
    makeAxisInterpolation: makeAxisInterpolation,
    refine: refine
  };
});
