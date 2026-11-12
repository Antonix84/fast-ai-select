/*
 * Fast AI Select - UXP integration with Photoshop.
 *
 * There is no panel: everything is driven by the two menu commands in
 * index.js and the Photoshop calls below. Pixel reads and writes happen inside
 * core.executeAsModal, so Photoshop's modal scope covers only the pixel
 * transfer, not the neural network.
 *
 * Notes on the Photoshop 2025 DOM (verified against the installed API):
 *   - Layer.kind is a NUMBER: 1 = pixel, 12 = background.
 *   - There is no Layer.clear() and no Document.selection object.
 *   - Selection operations are therefore plain batchPlay descriptors.
 */
(function (global) {
  'use strict';

  var photoshop = require('photoshop');
  var app = photoshop.app;
  var core = photoshop.core;
  var action = photoshop.action;
  var imaging = photoshop.imaging;

  /*
   * Layer.kind is not stable across Photoshop builds: the installed 26.11 API
   * may return a number (1 = pixel, 12 = background) or a string such as
   * "pixel"/"background", and some builds return nothing at all. Normalise all
   * of it to the numeric Action Manager values, and keep 0 for "unknown".
   */
  var KIND_PIXEL = 1;
  var KIND_BACKGROUND = 12;

  var KIND_BY_NAME = {
    pixel: 1,
    normal: 1,
    adjustment: 2,
    text: 3,
    vector: 4,
    smartobject: 5,
    video: 6,
    group: 7,
    threed: 8,
    gradient: 9,
    pattern: 10,
    solidcolor: 11,
    background: 12,
    groupend: 13
  };

  function kindCode(kind) {
    if (typeof kind === 'number' && isFinite(kind)) return kind;
    if (kind === null || kind === undefined) return 0;
    var text = String(kind).toLowerCase();
    if (KIND_BY_NAME[text] !== undefined) return KIND_BY_NAME[text];
    var numeric = parseInt(text, 10);
    return isNaN(numeric) ? 0 : numeric;
  }

  function isPixelKind(kind) {
    var code = kindCode(kind);
    return code === 0 || code === KIND_PIXEL;
  }

  function isBackgroundLayer(doc, layer) {
    if (!layer) return false;
    if (layer.id === 1) return true;
    if (kindCode(layer.kind) === KIND_BACKGROUND) return true;
    try {
      var background = doc.backgroundLayer;
      return !!(background && background.id === layer.id);
    } catch (e) {
      return false;
    }
  }

  var SELECTION_REF = { _ref: 'channel', _property: 'selection' };
  var PLAY_OPTIONS = { dialogOptions: 'dontDisplay' };

  function withModal(fn, commandName) {
    return core.executeAsModal(fn, {
      commandName: commandName || 'Fast AI Select',
      interactive: false
    });
  }

  function findDocument(docId) {
    if (docId === undefined || docId === null) {
      var active = app.activeDocument;
      if (!active) throw new Error('Откройте документ в Photoshop.');
      return active;
    }
    var docs = app.documents || [];
    for (var i = 0; i < docs.length; i++) {
      if (docs[i].id === docId) return docs[i];
    }
    throw new Error('Документ был закрыт во время обработки.');
  }

  function findLayer(layers, layerId) {
    for (var i = 0; i < (layers || []).length; i++) {
      var layer = layers[i];
      if (layer.id === layerId) return layer;
      if (layer.layers && layer.layers.length) {
        var nested = findLayer(layer.layers, layerId);
        if (nested) return nested;
      }
    }
    return null;
  }

  function activeLayer(doc) {
    var layers = doc.activeLayers || [];
    return layers.length ? layers[0] : null;
  }

  function isBackground(layer) {
    return layer.id === 1 || kindCode(layer.kind) === KIND_BACKGROUND;
  }

  function documentInfo() {
    var doc = app.activeDocument;
    if (!doc) return null;
    var info = {
      id: doc.id,
      name: doc.name,
      title: doc.title || doc.name,
      width: Math.round(doc.width),
      height: Math.round(doc.height),
      mode: String(doc.mode),
      bits: String(doc.bitsPerChannel),
      layerCount: (doc.layers || []).length,
      activeLayer: null
    };
    try {
      var layer = activeLayer(doc);
      if (layer) {
        info.activeLayer = {
          id: layer.id,
          name: layer.name,
          kind: kindCode(layer.kind),
          background: isBackground(layer),
          locked: !!layer.locked
        };
      }
    } catch (e) { /* ignore */ }
    return info;
  }

  /*
   * Read the composite document pixels as 8-bit chunky RGB (or RGBA when the
   * composite has alpha). Returns the actual region Photoshop produced.
   */
  async function readPixels(docId) {
    var doc = findDocument(docId);
    var result = null;
    var image = null;
    var data = null;
    var width = 0;
    var height = 0;
    var components = 0;

    await withModal(async function () {
      try {
        result = await imaging.getPixels({
          documentID: doc.id,
          applyAlpha: false,
          componentSize: 8,
          colorSpace: 'RGB'
        });
        image = result && result.imageData;
        if (!image) throw new Error('Photoshop не вернул пиксели документа.');

        width = image.width;
        height = image.height;
        components = image.components;
        data = await image.getData({ chunky: true });
      } finally {
        if (image && typeof image.dispose === 'function') {
          try { image.dispose(); } catch (e) { /* ignore */ }
        }
      }
    }, 'Fast AI Select: read pixels');

    if (!data || !width || !height) {
      throw new Error('Не удалось прочитать пиксели документа.');
    }
    if (data.length !== width * height * components) {
      throw new Error('Неожиданный размер буфера пикселей (' + data.length + ').');
    }

    var bounds = (result && result.sourceBounds) || { left: 0, top: 0 };
    return {
      docId: doc.id,
      docWidth: Math.round(doc.width),
      docHeight: Math.round(doc.height),
      width: width,
      height: height,
      left: Math.round(bounds.left || 0),
      top: Math.round(bounds.top || 0),
      components: components,
      data: data
    };
  }

  /* Pad a mask for a trimmed read back to the full document canvas. */
  function padMask(mask, width, height, docWidth, docHeight, left, top) {
    if (width === docWidth && height === docHeight && left === 0 && top === 0) {
      return mask;
    }
    var full = new Uint8Array(docWidth * docHeight);
    for (var y = 0; y < height; y++) {
      var dy = top + y;
      if (dy < 0 || dy >= docHeight) continue;
      var sx = left < 0 ? -left : 0;
      var dx = left + sx;
      if (dx >= docWidth) continue;
      var count = Math.min(width - sx, docWidth - dx);
      if (count > 0) {
        full.set(mask.subarray(y * width + sx, y * width + sx + count), dy * docWidth + dx);
      }
    }
    return full;
  }

  async function createMaskImageData(mask, width, height) {
    var options = {
      width: width,
      height: height,
      components: 1,
      chunky: true,
      colorSpace: 'Grayscale',
      colorProfile: 'Gray Gamma 2.2'
    };
    try {
      return await imaging.createImageDataFromBuffer(mask, options);
    } catch (e) {
      /* Some documents do not accept the explicit gray profile. */
      delete options.colorProfile;
      return await imaging.createImageDataFromBuffer(mask, options);
    }
  }

  async function applySelection(docId, mask, width, height) {
    return withModal(async function () {
      var image = await createMaskImageData(mask, width, height);
      try {
        await imaging.putSelection({
          documentID: docId,
          imageData: image,
          replace: true,
          commandName: 'Fast AI Select'
        });
      } finally {
        if (image && typeof image.dispose === 'function') {
          try { image.dispose(); } catch (e) { /* ignore */ }
        }
      }
    }, 'Fast AI Select: selection');
  }

  /*
   * Turn the Background layer into a normal layer, so that deleting pixels
   * produces transparency instead of filling them with the background color.
   * Setting an empty descriptor on a Background layer is what Photoshop itself
   * does when the layer is unlocked, and it returns a new layer id.
   */
  async function promoteBackground(doc, layer) {
    var promoted = null;

    try {
      await action.batchPlay([{
        _obj: 'set',
        _target: [{ _ref: 'layer', _id: layer.id }],
        to: {}
      }], PLAY_OPTIONS);
      promoted = activeLayer(doc);
    } catch (e) {
      /* Fall through to the explicit "make normal layer" command. */
      promoted = null;
    }

    if (!promoted || isBackgroundLayer(doc, promoted)) {
      await action.batchPlay([{
        _obj: 'make',
        _target: [{ _ref: 'layer', _id: (promoted || layer).id }],
        using: { _enum: 'layerType', _value: 'normal' }
      }], PLAY_OPTIONS);
      promoted = activeLayer(doc);
    }

    if (!promoted) throw new Error('Не удалось разблокировать фоновый слой.');
    return promoted;
  }

  /*
   * Validate the active layer before the slow part starts. Returns the layer id
   * to cut, after converting a Background layer to a normal one.
   */
  async function prepareCut(docId) {
    return withModal(async function () {
      var doc = findDocument(docId);
      var layer = activeLayer(doc);
      if (!layer) throw new Error('Выберите слой в панели «Слои».');
      console.log('Fast AI Select: layer "' + layer.name + '", id=' + layer.id +
        ', kind=' + String(layer.kind));

      if (isBackgroundLayer(doc, layer)) {
        layer = await promoteBackground(doc, layer);
        if (isBackgroundLayer(doc, layer)) {
          throw new Error(
            'Не удалось разблокировать фоновый слой. ' +
            'Выполните «Слой → Новый → Слой из фона» и повторите.'
          );
        }
      }

      /*
       * Only reject layers whose kind is known to be non-pixel. Unknown kind
       * (older builds may not expose it) is allowed: Photoshop itself refuses
       * the clear on a Smart Object, and the error is shown to the user.
       */
      if (!isPixelKind(layer.kind)) {
        throw new Error(
          'Удаление фона работает только с пиксельным слоем. ' +
          'Растрируйте слой (Слой → Растрировать) и повторите.'
        );
      }
      if (layer.locked) {
        throw new Error('Слой заблокирован. Снимите блокировку пикселей и повторите.');
      }

      return { layerId: layer.id, name: layer.name };
    }, 'Fast AI Select: prepare layer');
  }

  /*
   * Preferred cut: add a layer mask from the person mask. White keeps the
   * person, black hides the background. This uses the dedicated imaging API,
   * so it does not depend on the "Delete" menu command being available, and it
   * leaves the pixels intact (the mask can be applied later if needed).
   */
  async function putUserMask(layerId, image, docId) {
    return imaging.putLayerMask({
      documentID: docId,
      layerID: layerId,
      kind: 'user',
      imageData: image,
      replace: true,
      commandName: 'Fast AI Select'
    });
  }

  async function applyCutMask(docId, layerId, mask, width, height) {
    return withModal(async function () {
      var doc = findDocument(docId);
      var layer = findLayer(doc.layers, layerId);
      if (!layer) throw new Error('Активный слой был изменён во время обработки.');

      var image = await createMaskImageData(mask, width, height);
      try {
        try {
          await putUserMask(layerId, image, docId);
        } catch (firstError) {
          /* Some builds need an existing user mask before putLayerMask. */
          await action.batchPlay([{
            _obj: 'select',
            _target: [{ _ref: 'layer', _id: layerId }]
          }, {
            _obj: 'make',
            new: { _class: 'channel' },
            at: [{ _ref: 'channel', _enum: 'channel', _value: 'mask' }],
            using: { _enum: 'userMaskEnabled', _value: 'revealAll' }
          }], PLAY_OPTIONS);
          await putUserMask(layerId, image, docId);
        }
      } finally {
        if (image && typeof image.dispose === 'function') {
          try { image.dispose(); } catch (e) { /* ignore */ }
        }
      }
    }, 'Fast AI Select: layer mask');
  }

  /*
   * Fallback cut: apply the mask as a selection, invert it and clear the
   * selected pixels. The selection is created in its own modal scope, the same
   * way the working "select" command does it, and the pixels are filled with
   * transparency first because "Edit > Clear" is unavailable on some builds.
   */
  async function applyCutPixels(docId, layerId, mask, width, height) {
    await applySelection(docId, mask, width, height);

    return withModal(async function () {
      var doc = findDocument(docId);
      var layer = findLayer(doc.layers, layerId);
      if (!layer) throw new Error('Активный слой был изменён во время обработки.');

      /* Select > Inverse */
      await action.batchPlay([{
        _obj: 'inverse',
        _target: [SELECTION_REF]
      }], PLAY_OPTIONS);

      try {
        /* Edit > Clear */
        await action.batchPlay([{
          _obj: 'delete',
          _target: [SELECTION_REF],
          _options: { dialogOptions: 'dontDisplay' }
        }], PLAY_OPTIONS);
      } catch (clearError) {
        throw new Error(
          'Не удалось очистить фон: ' + (clearError && (clearError.message || clearError))
        );
      }

      /* Select > Deselect */
      await action.batchPlay([{
        _obj: 'set',
        _target: [SELECTION_REF],
        to: { _enum: 'ordinal', _value: 'none' }
      }], PLAY_OPTIONS);
    }, 'Fast AI Select: remove background');
  }

  async function applyCut(docId, layerId, mask, width, height) {
    try {
      await applyCutMask(docId, layerId, mask, width, height);
      return { method: 'mask' };
    } catch (maskError) {
      console.error('Fast AI Select: layer mask failed, trying pixel clear', maskError);
      try {
        await applyCutPixels(docId, layerId, mask, width, height);
        return { method: 'pixels' };
      } catch (pixelError) {
        throw new Error(
          (maskError && (maskError.message || maskError)) + ' / ' +
          (pixelError && (pixelError.message || pixelError))
        );
      }
    }
  }

  global.FASPhotoshop = {
    withModal: withModal,
    documentInfo: documentInfo,
    readPixels: readPixels,
    padMask: padMask,
    applySelection: applySelection,
    prepareCut: prepareCut,
    applyCut: applyCut,
    findLayer: findLayer
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
