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

  var SRGB_PROFILE = 'sRGB IEC61966-2.1';
  var SELECTION_REF = { _ref: 'channel', _property: 'selection' };
  var PLAY_OPTIONS = { dialogOptions: 'dontDisplay' };

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

  function isBackground(layer) {
    return layer.id === 1 || kindCode(layer.kind) === KIND_BACKGROUND;
  }

  /*
   * The modal callback re-checks that the original document is still active.
   * executeAsModal has no per-document target option, and batchPlay layer IDs
   * are resolved inside the active document. Aborting is safer than writing a
   * mask into a document the user switched to while inference was running.
   */
  function withModal(fn, commandName) {
    return core.executeAsModal(fn, {
      commandName: commandName || 'Fast AI Select',
      interactive: false
    });
  }

  function assertActiveDocument(doc) {
    var active = app.activeDocument;
    if (!active || active.id !== doc.id) {
      throw new Error('Активный документ был изменён во время обработки. ' +
        'Вернитесь в исходный документ и повторите команду.');
    }
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

  function assertDocumentSize(doc, width, height) {
    if (Math.round(doc.width) !== width || Math.round(doc.height) !== height) {
      throw new Error('Размер документа изменился во время обработки. Повторите команду.');
    }
  }

  function assertCutLayer(doc, layer) {
    if (!layer) throw new Error('Активный слой был изменён во время обработки.');
    var background = isBackgroundLayer(doc, layer);
    if (!background && !isPixelKind(layer.kind)) {
      throw new Error(
        'Удаление фона работает только с пиксельным слоем. ' +
        'Растрируйте слой (Слой → Растрировать) и повторите.'
      );
    }
    /* Background is inherently locked; promotion is handled separately. */
    if (!background && layer.locked) {
      throw new Error('Слой заблокирован. Снимите блокировку пикселей и повторите.');
    }
  }

  /*
   * Read document pixels as 8-bit chunky RGB/RGBA. When layerId is supplied,
   * read that layer instead of the flattened composite. `colorProfile` forces
   * the same sRGB values for MODNet and the guided filter regardless of the
   * document's working profile. Older builds that reject the profile fall back
   * to their default RGB conversion.
   */
  async function readPixels(docId, layerId) {
    var doc = findDocument(docId);
    var result = null;
    var image = null;
    var data = null;
    var width = 0;
    var height = 0;
    var components = 0;

    await withModal(async function () {
      try {
        assertActiveDocument(doc);
        var request = {
          documentID: doc.id,
          applyAlpha: false,
          componentSize: 8,
          colorSpace: 'RGB'
        };
        if (layerId !== undefined && layerId !== null) request.layerID = layerId;

        try {
          result = await imaging.getPixels(Object.assign({}, request, {
            colorProfile: SRGB_PROFILE
          }));
        } catch (profileError) {
          var profileMessage = String(profileError && (profileError.message || profileError));
          console.warn('Fast AI Select: sRGB pixel read failed, retrying without profile: ' +
            profileMessage);
          result = await imaging.getPixels(request);
        }

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
      layerId: layerId,
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
    width = Math.round(width);
    height = Math.round(height);
    if (!mask || mask.length < width * height) {
      throw new Error('Некорректный буфер маски.');
    }
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
      var doc = findDocument(docId);
      assertActiveDocument(doc);
      assertDocumentSize(doc, width, height);
      var image = await createMaskImageData(mask, width, height);
      try {
        await imaging.putSelection({
          documentID: doc.id,
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
        _obj: 'select',
        _target: [{ _ref: 'layer', _id: layer.id }]
      }, {
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
        _obj: 'select',
        _target: [{ _ref: 'layer', _id: (promoted || layer).id }]
      }, {
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
   * Validate the active layer before the slow part starts. This deliberately
   * does not modify the document: a missing person or an inference failure
   * must leave a Background layer untouched.
   */
  async function prepareCut(docId) {
    return withModal(async function () {
      var doc = findDocument(docId);
      assertActiveDocument(doc);
      var layer = activeLayer(doc);
      if (!layer) throw new Error('Выберите слой в панели «Слои».');
      console.log('Fast AI Select: layer "' + layer.name + '", id=' + layer.id +
        ', kind=' + String(layer.kind));

      assertCutLayer(doc, layer);
      return {
        layerId: layer.id,
        name: layer.name,
        background: isBackgroundLayer(doc, layer)
      };
    }, 'Fast AI Select: prepare layer');
  }

  /*
   * Re-check the target after the slow inference and promote a Background only
   * now. The user may have changed the active layer or document meanwhile.
   */
  async function ensureCutTarget(docId, layerId) {
    return withModal(async function () {
      var doc = findDocument(docId);
      assertActiveDocument(doc);
      var layer = findLayer(doc.layers, layerId);
      assertCutLayer(doc, layer);

      if (isBackgroundLayer(doc, layer)) {
        layer = await promoteBackground(doc, layer);
        assertCutLayer(doc, layer);
      }

      return {
        layerId: layer.id,
        name: layer.name,
        background: false
      };
    }, 'Fast AI Select: finalize layer');
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

  async function createUserMask(layerId) {
    await action.batchPlay([{
      _obj: 'select',
      _target: [{ _ref: 'layer', _id: layerId }]
    }, {
      _obj: 'make',
      new: { _class: 'channel' },
      at: [{ _ref: 'channel', _enum: 'channel', _value: 'mask' }],
      using: { _enum: 'userMaskEnabled', _value: 'revealAll' }
    }], PLAY_OPTIONS);
  }

  async function removeUserMask(layerId) {
    try {
      await action.batchPlay([{
        _obj: 'select',
        _target: [{ _ref: 'layer', _id: layerId }]
      }, {
        _obj: 'delete',
        _target: [{ _ref: 'channel', _enum: 'channel', _value: 'mask' }]
      }], PLAY_OPTIONS);
    } catch (e) {
      console.warn('Fast AI Select: could not remove the temporary layer mask: ' +
        String(e && (e.message || e)));
    }
  }

  async function applyCutMask(docId, layerId, mask, width, height) {
    return withModal(async function () {
      var doc = findDocument(docId);
      assertActiveDocument(doc);
      assertDocumentSize(doc, width, height);
      var layer = findLayer(doc.layers, layerId);
      assertCutLayer(doc, layer);

      var image = await createMaskImageData(mask, width, height);
      try {
        try {
          await putUserMask(layerId, image, doc.id);
        } catch (firstError) {
          /* Some builds need an existing user mask before putLayerMask. */
          await createUserMask(layerId);
          try {
            await putUserMask(layerId, image, doc.id);
          } catch (secondError) {
            await removeUserMask(layerId);
            throw secondError;
          }
        }
      } finally {
        if (image && typeof image.dispose === 'function') {
          try { image.dispose(); } catch (e) { /* ignore */ }
        }
      }
      return { method: 'mask', layerId: layerId };
    }, 'Fast AI Select: layer mask');
  }

  /*
   * Fallback cut: apply the mask as a selection, invert it and clear the
   * selected pixels. The target layer is explicitly selected first because
   * `delete` acts on the active layer, and that may have changed while the
   * network was running. Deselection is in finally so an error cannot leave an
   * inverted selection behind.
   */
  async function applyCutPixels(docId, layerId, mask, width, height) {
    await applySelection(docId, mask, width, height);

    return withModal(async function () {
      var doc = findDocument(docId);
      assertActiveDocument(doc);
      assertDocumentSize(doc, width, height);
      var layer = findLayer(doc.layers, layerId);
      assertCutLayer(doc, layer);

      try {
        await action.batchPlay([{
          _obj: 'select',
          _target: [{ _ref: 'layer', _id: layerId }]
        }], PLAY_OPTIONS);

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
      } finally {
        try {
          /* Select > Deselect, even if inverse/delete failed. */
          await action.batchPlay([{
            _obj: 'set',
            _target: [SELECTION_REF],
            to: { _enum: 'ordinal', _value: 'none' }
          }], PLAY_OPTIONS);
        } catch (deselectError) {
          console.warn('Fast AI Select: could not deselect after fallback: ' +
            String(deselectError && (deselectError.message || deselectError)));
        }
      }

      return { method: 'pixels', layerId: layerId };
    }, 'Fast AI Select: remove background');
  }

  function isFatalTargetError(error) {
    var message = String(error && (error.message || error));
    return /документ был закрыт|document.*closed|no such document|active layer.*changed|активный слой был изменён|размер документа изменился|отмен/i
      .test(message);
  }

  async function applyCut(docId, layerId, mask, width, height) {
    var target = await ensureCutTarget(docId, layerId);

    try {
      var masked = await applyCutMask(docId, target.layerId, mask, width, height);
      masked.name = target.name;
      return masked;
    } catch (maskError) {
      if (isFatalTargetError(maskError)) throw maskError;
      console.error('Fast AI Select: layer mask failed, trying pixel clear', maskError);
      try {
        var cleared = await applyCutPixels(docId, target.layerId, mask, width, height);
        cleared.name = target.name;
        return cleared;
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
    ensureCutTarget: ensureCutTarget,
    applyCut: applyCut,
    findLayer: findLayer
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
