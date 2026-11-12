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

  var VERSION = '1.1.4';

  /*
   * Long side of the network input, a multiple of 32.
   * 512 = default (finer hair and edges), 384 = faster, 768 = maximum detail.
   */
  var SEGMENT_SIZE = 512;

  /* Below this fraction of selected pixels the photo is treated as "no person". */
  var MIN_COVERAGE = 0.002;

  var busy = false;

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

  function report(error) {
    var message = (error && (error.message || String(error))) || 'Неизвестная ошибка';
    console.error('Fast AI Select: ' + message);
    try {
      app.showAlert('Fast AI Select\n\n' + message);
    } catch (e) {
      /* No alert available (very old host); the console line is all we have. */
    }
  }

  function progressLogger(progress) {
    if (progress && progress.text) log(progress.text);
  }

  function coverage(mask) {
    var hit = 0;
    for (var i = 0; i < mask.length; i++) {
      if (mask[i] >= 128) hit++;
    }
    return mask.length ? hit / mask.length : 0;
  }

  /*
   * Read the document, run the network and return a full-resolution mask.
   * The RGB buffer is released before Photoshop allocates its own image data.
   */
  async function buildMask(docId) {
    var pixels = await PS.readPixels(docId);
    var docWidth = pixels.docWidth;
    var docHeight = pixels.docHeight;

    var result = await Engine.segment({
      rgb: pixels.data,
      width: pixels.width,
      height: pixels.height,
      components: pixels.components,
      targetLong: SEGMENT_SIZE
    }, progressLogger);

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

    var ratio = coverage(mask);
    if (ratio < MIN_COVERAGE) {
      throw new Error('Человек на фото не найден. Попробуйте другой кадр.');
    }

    return {
      mask: mask,
      width: docWidth,
      height: docHeight,
      result: result,
      coverage: ratio
    };
  }

  async function runSelect() {
    if (busy) { log('операция уже выполняется'); return; }
    busy = true;
    var started = now();
    try {
      var doc = PS.documentInfo();
      if (!doc) throw new Error('Откройте документ в Photoshop.');

      log('документ ' + doc.width + '×' + doc.height + ', вход ' + SEGMENT_SIZE + ' px');
      var built = await buildMask(doc.id);

      await PS.applySelection(doc.id, built.mask, built.width, built.height);
      log('выделение готово за ' + fmtMs(now() - started) +
        ' (покрытие ' + (built.coverage * 100).toFixed(1) + '%)');
    } catch (error) {
      report(error);
    } finally {
      busy = false;
    }
  }

  async function runCut() {
    if (busy) { log('операция уже выполняется'); return; }
    busy = true;
    var started = now();
    try {
      var doc = PS.documentInfo();
      if (!doc) throw new Error('Откройте документ в Photoshop.');

      /* Validate the layer and convert Background to a normal layer up front. */
      var target = await PS.prepareCut(doc.id);
      log('слой «' + target.name + '», вход ' + SEGMENT_SIZE + ' px');

      var built = await buildMask(doc.id);

      var applied = await PS.applyCut(doc.id, target.layerId, built.mask, built.width, built.height);
      log('фон удалён за ' + fmtMs(now() - started) +
        ' (' + (applied && applied.method === 'pixels' ? 'пиксели очищены' : 'маска слоя') +
        ', покрытие ' + (built.coverage * 100).toFixed(1) + '%)');
    } catch (error) {
      report(error);
    } finally {
      busy = false;
    }
  }

  global.FASApp = {
    version: VERSION,
    selectPerson: runSelect,
    removeBackground: runCut,
    getState: function () {
      return { busy: busy, segmentSize: SEGMENT_SIZE, modelReady: Engine.isReady() };
    }
  };

  entrypoints.setup({
    plugin: {
      create: function () {},
      destroy: function () {}
    },
    commands: {
      selectPerson: function () { return runSelect(); },
      removeBackground: function () { return runCut(); }
    }
  });

  log('версия ' + VERSION + ', вход ' + SEGMENT_SIZE + ' px');
})(typeof globalThis !== 'undefined' ? globalThis : window);
