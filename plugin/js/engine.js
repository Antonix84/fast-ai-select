/*
 * Fast AI Select - ONNX Runtime WebAssembly engine.
 *
 * Everything runs in the UXP JavaScript engine on the CPU. The model and the
 * wasm binary are read from the plugin folder, never from the network.
 */
(function (global) {
  'use strict';

  var uxpStorage = null;
  try {
    uxpStorage = require('uxp').storage;
  } catch (e) {
    uxpStorage = null;
  }

  var sessionInfo = null;
  var sessionPromise = null;
  var lastError = null;
  var generation = 0;

  /* Same 50-byte SIMD probe that onnxruntime-web uses internally. */
  var SIMD_PROBE = new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 30,
    1, 28, 0, 65, 0, 253, 15, 253, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 253, 186, 1, 26, 11
  ]);

  function now() {
    if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') {
      return performance.now();
    }
    return Date.now();
  }

  function yieldUI() {
    return new Promise(function (resolve) {
      if (typeof setTimeout === 'function') setTimeout(resolve, 0);
      else resolve();
    });
  }

  function detectSimd() {
    try {
      return !!global.WebAssembly && global.WebAssembly.validate(SIMD_PROBE);
    } catch (e) {
      return false;
    }
  }

  async function readPluginFile(relativePath) {
    if (!uxpStorage) throw new Error('UXP storage is not available.');
    var fs = uxpStorage.localFileSystem;
    var formats = uxpStorage.formats;
    var folder = await fs.getPluginFolder();
    var parts = String(relativePath).split('/');
    var entry = folder;
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      entry = await entry.getEntry(parts[i]);
    }
    if (formats && formats.binary) {
      return entry.read({ format: formats.binary });
    }
    return entry.read();
  }

  function getOrt() {
    var ort = global.ort || (typeof window !== 'undefined' ? window.ort : null);
    if (!ort || !ort.InferenceSession || !ort.Tensor) {
      throw new Error(
        'Не удалось загрузить onnxruntime-web. Проверьте файл lib/ort.wasm.min.js ' +
        'и переустановите плагин.'
      );
    }
    return ort;
  }

  async function warmup(ort, info) {
    try {
      var n = 384 * 384;
      var tensor = new ort.Tensor('float32', new Float32Array(n * 3), [1, 3, 384, 384]);
      var input = {};
      input[info.inputName] = tensor;
      await info.session.run(input);
      info.warmedUp = true;
    } catch (e) {
      /* Warmup is an optimization; never fail the plugin because of it. */
      info.warmupError = e && (e.message || String(e));
    }
  }

  async function loadSession(onProgress) {
    var ort = getOrt();
    if (!global.FASWasm || typeof global.FASWasm.precompile !== 'function') {
      throw new Error('Не загружен модуль js/wasm-env.js.');
    }

    onProgress = onProgress || function () {};

    ort.env.logLevel = 'error';
    ort.env.wasm.numThreads = 1;   /* UXP has no Worker/SharedArrayBuffer */
    ort.env.wasm.proxy = false;
    ort.env.wasm.trace = false;
    ort.env.wasm.initTimeout = 0;
    ort.env.wasm.wasmPaths = 'plugin:/lib/';

    var simd = detectSimd();
    ort.env.wasm.simd = simd;
    var wasmName = simd ? 'ort-wasm-simd.wasm' : 'ort-wasm.wasm';

    onProgress({ stage: 'wasm-read', text: 'Чтение WebAssembly…' });
    await yieldUI();
    var wasmBuffer = await readPluginFile('lib/' + wasmName);

    onProgress({ stage: 'wasm-compile', text: 'Компиляция WebAssembly (один раз)…' });
    await yieldUI();
    global.FASWasm.precompile(wasmName, wasmBuffer);

    onProgress({ stage: 'model-read', text: 'Чтение модели MODNet (25 МБ)…' });
    await yieldUI();
    var modelBuffer = await readPluginFile('models/modnet.onnx');
    var modelBytes = new Uint8Array(modelBuffer);
    if (modelBytes.length < 1000000) {
      throw new Error('Файл models/modnet.onnx повреждён или отсутствует.');
    }

    onProgress({ stage: 'session', text: 'Инициализация нейросети…' });
    await yieldUI();
    var session = await ort.InferenceSession.create(modelBytes, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
      logSeverityLevel: 3,
      enableCpuMemArena: true,
      enableMemPattern: true
    });

    var info = {
      session: session,
      inputName: session.inputNames[0],
      outputName: session.outputNames[0],
      simd: simd,
      wasmName: wasmName,
      wasmBytes: wasmBuffer.byteLength,
      modelBytes: modelBytes.length,
      warmedUp: false
    };

    onProgress({ stage: 'warmup', text: 'Прогрев модели…' });
    await yieldUI();
    await warmup(ort, info);

    return info;
  }

  function ensureSession(onProgress) {
    if (sessionInfo) return Promise.resolve(sessionInfo);
    if (sessionPromise) return sessionPromise;

    var expectedGeneration = generation;
    var promise = loadSession(onProgress).then(
      function (info) {
        if (expectedGeneration !== generation) {
          throw new Error('Инициализация нейросети была отменена.');
        }
        sessionInfo = info;
        if (sessionPromise === promise) sessionPromise = null;
        lastError = null;
        return info;
      },
      function (error) {
        if (sessionPromise === promise) sessionPromise = null;
        if (expectedGeneration === generation) lastError = error;
        throw error;
      }
    );
    sessionPromise = promise;
    return promise;
  }

  /*
   * Drop the cached session after a timeout or plugin reload. A cache entry
   * that never settles must not poison every subsequent command. The previous
   * session is intentionally left for GC: an ORT run may still reference it.
   */
  function invalidateSession(reason) {
    generation++;
    sessionInfo = null;
    sessionPromise = null;
    lastError = reason || new Error('Сессия нейросети сброшена.');
  }

  function cropAlphaToContent(alpha, alphaW, alphaH, size) {
    if (size.offsetX === 0 && size.offsetY === 0 &&
        size.contentWidth === size.width && size.contentHeight === size.height) {
      return { data: alpha, width: alphaW, height: alphaH };
    }

    var scaleX = alphaW / size.width;
    var scaleY = alphaH / size.height;
    var x0 = Math.max(0, Math.round(size.offsetX * scaleX));
    var y0 = Math.max(0, Math.round(size.offsetY * scaleY));
    var w = Math.max(1, Math.round(size.contentWidth * scaleX));
    var h = Math.max(1, Math.round(size.contentHeight * scaleY));
    if (x0 + w > alphaW) w = alphaW - x0;
    if (y0 + h > alphaH) h = alphaH - y0;
    if (w <= 0 || h <= 0) {
      throw new Error('Нейросеть вернула некорректный размер мата.');
    }

    var cropped = new Float32Array(w * h);
    for (var y = 0; y < h; y++) {
      var src = (y0 + y) * alphaW + x0;
      cropped.set(alpha.subarray(src, src + w), y * w);
    }
    return { data: cropped, width: w, height: h };
  }

  /*
   * Run MODNet + guided filter.
   *
   * opts: { rgb, width, height, components, targetLong }
   * Returns { mask: Uint8Array, ... , timings }
   */
  async function segment(opts, onProgress) {
    if (!opts || !opts.rgb || !opts.width || !opts.height) {
      throw new Error('Нет пикселей документа для обработки.');
    }
    onProgress = onProgress || function () {};

    var started = now();
    var expectedGeneration = generation;
    var info = await ensureSession(onProgress);
    if (expectedGeneration !== generation) {
      throw new Error('Расчёт был отменён до запуска нейросети.');
    }
    var ort = getOrt();

    var targetLong = Number(opts.targetLong || 512);
    if (targetLong !== 384 && targetLong !== 512 && targetLong !== 768) {
      throw new Error('Недопустимый размер входа нейросети: ' + targetLong +
        '. Используйте 384, 512 или 768.');
    }
    var size = global.FASCore.computeInputSize(opts.width, opts.height, targetLong, 32);

    onProgress({
      stage: 'preprocess',
      text: 'Подготовка ' + size.contentWidth + '×' + size.contentHeight +
        ' (вход ' + size.width + '×' + size.height + ')…'
    });
    await yieldUI();

    var preprocessStart = now();
    var input = global.FASCore.rgbToTensorChw(
      opts.rgb,
      opts.width,
      opts.height,
      opts.components || 3,
      size.width,
      size.height,
      null,
      size
    );
    var tensor = new ort.Tensor('float32', input.data, [1, 3, size.height, size.width]);
    var preprocessEnd = now();

    onProgress({
      stage: 'inference',
      text: 'Нейросеть MODNet: ' + size.width + '×' + size.height + '…'
    });
    await yieldUI();

    var inputs = {};
    inputs[info.inputName] = tensor;
    var results = await info.session.run(inputs);
    var output = results[info.outputName];
    if (!output || !output.data) {
      throw new Error('Нейросеть вернула пустой результат.');
    }
    if (expectedGeneration !== generation) {
      throw new Error('Расчёт нейросети был отменён.');
    }

    var dims = output.dims || [];
    var alphaW = dims.length >= 2 ? dims[dims.length - 1] : size.width;
    var alphaH = dims.length >= 2 ? dims[dims.length - 2] : size.height;
    var alpha = new Float32Array(output.data);
    var croppedAlpha = cropAlphaToContent(alpha, alphaW, alphaH, size);
    var inferenceEnd = now();

    onProgress({ stage: 'refine', text: 'Уточнение краёв (guided filter)…' });
    await yieldUI();

    var pixelScale = Math.max(
      opts.width / croppedAlpha.width,
      opts.height / croppedAlpha.height
    );
    var adaptiveRadius = Math.max(4, Math.min(16, Math.round(pixelScale)));
    var radius = typeof opts.radius === 'number' ? opts.radius : adaptiveRadius;
    var refineSubsample = typeof opts.subsample === 'number' ? opts.subsample : 4;
    var refineSharpen = typeof opts.sharpen === 'number' ? opts.sharpen : 1.4;

    var refined = global.FASGuidedFilter.refine({
      rgb: opts.rgb,
      width: opts.width,
      height: opts.height,
      components: opts.components || 3,
      alpha: croppedAlpha.data,
      alphaW: croppedAlpha.width,
      alphaH: croppedAlpha.height,
      subsample: refineSubsample,
      radius: radius,
      eps: 1e-4,
      sharpen: refineSharpen,
      respectSourceAlpha: opts.respectSourceAlpha !== false
    });
    var refineEnd = now();

    return {
      mask: refined.mask,
      width: refined.width,
      height: refined.height,
      inputWidth: size.width,
      inputHeight: size.height,
      contentWidth: size.contentWidth,
      contentHeight: size.contentHeight,
      alphaWidth: croppedAlpha.width,
      alphaHeight: croppedAlpha.height,
      radius: refined.radiusFull,
      sharpen: refined.sharpen,
      simd: info.simd,
      timings: {
        preprocess: preprocessEnd - preprocessStart,
        inference: inferenceEnd - preprocessEnd,
        refine: refineEnd - inferenceEnd,
        pipeline: refineEnd - started
      }
    };
  }

  function isReady() {
    return !!sessionInfo;
  }

  function getInfo() {
    if (!sessionInfo) return null;
    return {
      ready: true,
      simd: sessionInfo.simd,
      wasmName: sessionInfo.wasmName,
      wasmBytes: sessionInfo.wasmBytes,
      modelBytes: sessionInfo.modelBytes,
      warmedUp: sessionInfo.warmedUp,
      warmupError: sessionInfo.warmupError || null,
      inputName: sessionInfo.inputName,
      outputName: sessionInfo.outputName
    };
  }

  global.FASEngine = {
    ensureSession: ensureSession,
    invalidate: invalidateSession,
    segment: segment,
    isReady: isReady,
    getInfo: getInfo,
    getLastError: function () { return lastError; },
    readPluginFile: readPluginFile,
    detectSimd: detectSimd,
    now: now
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
