/*
 * Fast AI Select - UXP entrypoints.
 *
 * The plugin has no panel and no other UI. Photoshop shows two menu items:
 *
 *   Плагины -> Fast AI Select -> Выделить человека
 *   Плагины -> Fast AI Select -> Удалить фон
 *
 * Both run the same pipeline (read pixels -> MODNet -> guided filter) and
 * differ only in what is done with the resulting mask. Errors are reported with
 * a Photoshop alert, because there is no panel to print them into.
 */
(function (global) {
  'use strict';

  var PS = global.FASPhotoshop;
  var Engine = global.FASEngine;
  var entrypoints = require('uxp').entrypoints;
  var app = require('photoshop').app;

  var VERSION = '1.1.5';

  /*
   * Long side of the network input. The image keeps its aspect ratio and is
   * centered on a padded canvas that is a multiple of 32.
   */
  var SEGMENT_SIZE = 512;

  /* Guided-filter settings. Contrast is applied to the float matte. */
  var MATTE_SHARPEN = 1.4;
  var REFINE_SUBSAMPLE = 4;

  /* Below this soft coverage the photograph is treated as "no person". */
  var MIN_COVERAGE = 0.002;

  /*
   * A pending host API must not disable the menu commands forever. These are
   * deliberately generous: normal 24 MP work finishes in seconds.
   */
  var READ_TIMEOUT_MS = 60000;
  var SEGMENT_TIMEOUT_MS = 180000;
  var WRITE_TIMEOUT_MS = 90000;
  var ALERT_TIMEOUT_MS = 15000;

  var busy = false;
  var busySince = 0;
  var operationId = 0;
  var operationStage = 'idle';
  var lastError = null;
  var disposed = false;

  function now() {
    if (typeof performance !== 'undefined' && performance && performance.now) return performance.now();
    return Date.now();
  }

  function fmtMs(value) {
    return value < 1000 ? Math.round(value) + ' мс' : (value / 1000).toFixed(2) + ' с';
  }

  function log(message) {
    console.log('Fast AI Select: ' + message);
  }

  function cancelledError() {
    var error = new Error('Операция отменена.');
    error.cancelled = true;
    return error;
  }

  async function report(error) {
    var message = (error && (error.message || String(error))) || 'Неизвестная ошибка';
    lastError = message;
    console.error('Fast AI Select: ' + message);
    try {
      await waitFor(
        Promise.resolve(app.showAlert('Fast AI Select\n\n' + message)),
        ALERT_TIMEOUT_MS,
        'окно ошибки',
        null
      );
    } catch (e) {
      /* No alert available (old host or alert is blocked); console has it. */
      console.error('Fast AI Select: alert failed: ' + String(e && (e.message || e)));
    }
  }

  /*
   * Promise.race-based watchdog. The underlying operation may not be
   * cancellable (notably ORT session.run), but the command, busy flag and
   * cached session are released; a late result is ignored by the operation id.
   */
  function waitFor(promise, timeoutMs, label, onTimeout) {
    var timer = 0;
    var timeoutError = new Error('Этап «' + label + '» не завершился за ' +
      fmtMs(timeoutMs) + '. Перезапустите Photoshop и повторите команду.');
    var timeout = new Promise(function (resolve, reject) {
      timer = setTimeout(function () {
        try {
          if (onTimeout) onTimeout(timeoutError);
        } catch (e) { /* timeout cleanup is best effort */ }
        reject(timeoutError);
      }, timeoutMs);
    });

    return Promise.race([Promise.resolve(promise), timeout]).then(
      function (value) {
        clearTimeout(timer);
        return value;
      },
      function (error) {
        clearTimeout(timer);
        throw error;
      }
    );
  }

  function beginOperation(name) {
    if (disposed) {
      log('плагин выгружен, команда пропущена');
      return null;
    }
    if (busy) {
      log('операция уже выполняется (' + operationStage + ', ' +
        fmtMs(now() - busySince) + ')');
      return null;
    }
    busy = true;
    busySince = now();
    operationStage = name;
    lastError = null;
    operationId++;
    return operationId;
  }

  function finishOperation(token) {
    if (token !== operationId) return;
    busy = false;
    busySince = 0;
    operationStage = 'idle';
  }

  function ensureCurrent(token) {
    if (disposed || token !== operationId) throw cancelledError();
  }

  function setStage(token, stage) {
    if (token !== operationId || disposed) return;
    operationStage = stage;
  }

  function progressLogger(token) {
    return function (progress) {
      if (!progress) return;
      if (progress.text) setStage(token, progress.stage || progress.text);
      if (progress.text) log(progress.text);
    };
  }

  function coverageStats(mask) {
    var hard = 0;
    var visible = 0;
    var sum = 0;
    for (var i = 0; i < mask.length; i++) {
      var value = mask[i];
      sum += value;
      if (value >= 64) visible++;
      if (value >= 128) hard++;
    }
    return {
      visible: mask.length ? visible / mask.length : 0,
      hard: mask.length ? hard / mask.length : 0,
      soft: mask.length ? sum / (mask.length * 255) : 0
    };
  }

  /*
   * Read the document, run the network and return a full-resolution mask.
   * The RGB buffer is released before Photoshop allocates its own image data.
   */
  async function buildMask(docId, token, options) {
    options = options || {};
    setStage(token, 'чтение пикселей');
    var pixels = await waitFor(
      PS.readPixels(docId, options.layerId),
      READ_TIMEOUT_MS,
      'чтение пикселей',
      null
    );
    ensureCurrent(token);

    var docWidth = pixels.docWidth;
    var docHeight = pixels.docHeight;

    setStage(token, 'нейросеть и уточнение краёв');
    var result = await waitFor(
      Engine.segment({
        rgb: pixels.data,
        width: pixels.width,
        height: pixels.height,
        components: pixels.components,
        targetLong: SEGMENT_SIZE,
        sharpen: MATTE_SHARPEN,
        subsample: REFINE_SUBSAMPLE,
        respectSourceAlpha: options.respectSourceAlpha !== false
      }, progressLogger(token)),
      SEGMENT_TIMEOUT_MS,
      'нейросеть и уточнение краёв',
      function (timeoutError) {
        /* Never leave a pending sessionPromise poisoning later commands. */
        if (Engine.invalidate) Engine.invalidate(timeoutError);
      }
    );
    ensureCurrent(token);

    var stats = coverageStats(result.mask);
    if (stats.visible < MIN_COVERAGE || stats.soft < MIN_COVERAGE) {
      throw new Error('Человек на фото не найден. Попробуйте другой кадр.');
    }

    setStage(token, 'подготовка маски');
    var mask = PS.padMask(
      result.mask,
      result.width,
      result.height,
      docWidth,
      docHeight,
      pixels.left,
      pixels.top
    );

    pixels.data = null;
    pixels = null;

    return {
      mask: mask,
      width: docWidth,
      height: docHeight,
      result: result,
      coverage: stats.soft,
      visibleCoverage: stats.visible,
      hardCoverage: stats.hard
    };
  }

  async function runSelect() {
    var token = beginOperation('Выделить человека');
    if (!token) return;
    var started = now();
    try {
      var doc = PS.documentInfo();
      if (!doc) throw new Error('Откройте документ в Photoshop.');

      log('документ ' + doc.width + '×' + doc.height + ', вход ' + SEGMENT_SIZE + ' px');
      var built = await buildMask(doc.id, token, { respectSourceAlpha: true });
      ensureCurrent(token);

      setStage(token, 'создание выделения');
      await waitFor(
        PS.applySelection(doc.id, built.mask, built.width, built.height),
        WRITE_TIMEOUT_MS,
        'создание выделения',
        null
      );
      ensureCurrent(token);
      log('выделение готово за ' + fmtMs(now() - started) +
        ' (покрытие ' + (built.coverage * 100).toFixed(1) + '%)');
    } catch (error) {
      if (!error || !error.cancelled) await report(error);
    } finally {
      finishOperation(token);
    }
  }

  async function runCut() {
    var token = beginOperation('Удалить фон');
    if (!token) return;
    var started = now();
    try {
      var doc = PS.documentInfo();
      if (!doc) throw new Error('Откройте документ в Photoshop.');

      /* Validate only; the Background layer is promoted after inference. */
      setStage(token, 'проверка слоя');
      var target = await waitFor(
        PS.prepareCut(doc.id),
        WRITE_TIMEOUT_MS,
        'проверка слоя',
        null
      );
      ensureCurrent(token);
      log('слой «' + target.name + '», вход ' + SEGMENT_SIZE + ' px');

      var built = await buildMask(doc.id, token, {
        layerId: target.layerId,
        respectSourceAlpha: false
      });
      ensureCurrent(token);

      setStage(token, 'запись маски слоя');
      var applied = await waitFor(
        PS.applyCut(doc.id, target.layerId, built.mask, built.width, built.height),
        WRITE_TIMEOUT_MS,
        'запись маски слоя',
        null
      );
      ensureCurrent(token);
      log('фон удалён за ' + fmtMs(now() - started) +
        ' (' + (applied && applied.method === 'pixels' ? 'пиксели очищены' : 'маска слоя') +
        ', покрытие ' + (built.coverage * 100).toFixed(1) + '%)');
    } catch (error) {
      if (!error || !error.cancelled) await report(error);
    } finally {
      finishOperation(token);
    }
  }

  global.FASApp = {
    version: VERSION,
    selectPerson: runSelect,
    removeBackground: runCut,
    getState: function () {
      return {
        busy: busy,
        busyForMs: busy ? now() - busySince : 0,
        stage: operationStage,
        lastError: lastError,
        segmentSize: SEGMENT_SIZE,
        sharpen: MATTE_SHARPEN,
        modelReady: Engine.isReady()
      };
    }
  };

  entrypoints.setup({
    plugin: {
      create: function () {
        disposed = false;
      },
      destroy: function () {
        disposed = true;
        operationId++;
        busy = false;
        busySince = 0;
        operationStage = 'destroyed';
        try {
          if (Engine.invalidate) Engine.invalidate(new Error('Плагин выгружен.'));
        } catch (e) { /* plugin is going away */ }
        log('плагин выгружен');
      }
    },
    commands: {
      selectPerson: function () { return runSelect(); },
      removeBackground: function () { return runCut(); }
    }
  });

  log('версия ' + VERSION + ', вход ' + SEGMENT_SIZE + ' px, sharpen ' + MATTE_SHARPEN);
})(typeof globalThis !== 'undefined' ? globalThis : window);
