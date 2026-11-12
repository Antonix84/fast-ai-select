/*
 * Fast AI Select - command wiring test.
 *
 *   node tools/test-command.js
 *
 * Runs the real index.js and js/ps.js against a mock Photoshop DOM. It does not
 * load ONNX Runtime: the engine is replaced with a stub that returns a known
 * mask, so the test is fast and focuses on the Photoshop side:
 *
 *   - both menu commands are registered,
 *   - "Выделить человека" puts a selection,
 *   - "Удалить фон" promotes a Background layer, inverts the selection,
 *     clears the pixels and deselects,
 *   - locked / non-pixel layers and an empty mask produce a visible alert and
 *     change nothing.
 *
 * The mocks follow the real Photoshop 2025 API: Layer.kind is a number
 * (1 = pixel, 12 = background), there is no Document.selection and no
 * Layer.clear.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PLUGIN = path.join(__dirname, '..', 'plugin');

const KIND_PIXEL = 1;
const KIND_SMART_OBJECT = 5;
const KIND_BACKGROUND = 12;

let failures = 0;
let checks = 0;

function check(name, condition, detail) {
  checks++;
  if (condition) {
    console.log('  ok   ' + name);
  } else {
    failures++;
    console.log('  FAIL ' + name + (detail ? ' — ' + detail : ''));
  }
}

function section(title) {
  console.log('\n' + title);
}

function makeLayer(id, kind, extra) {
  return Object.assign({
    id,
    name: kind === KIND_BACKGROUND ? 'Background' : 'Layer ' + id,
    kind,
    locked: false,
  }, extra || {});
}

/* ------------------------------------------------------------------ */
/* Photoshop mock                                                      */
/* ------------------------------------------------------------------ */

function createWorld(options) {
  const opts = options || {};
  const world = {
    doc: null,
    active: null,
    actions: [],
    putSelections: [],
    layerMasks: [],
    alerts: [],
    modals: [],
    disposed: 0,
    failMask: !!opts.failMask,
  };

  world.doc = {
    id: 42,
    name: 'portrait.psd',
    title: 'portrait.psd',
    width: 800,
    height: 600,
    mode: 'RGB',
    bitsPerChannel: 8,
    layers: [],
    get activeLayers() {
      return world.active ? [world.active] : [];
    },
  };

  world.setLayer = function (layer) {
    world.active = layer;
    world.doc.layers = [layer];
  };

  const imageData = () => ({
    width: 64,
    height: 48,
    components: 3,
    getData: async () => new Uint8Array(64 * 48 * 3),
    dispose() {
      world.disposed++;
    },
  });

  const photoshop = {
    app: {
      get activeDocument() {
        return world.doc;
      },
      get documents() {
        return world.doc ? [world.doc] : [];
      },
      async showAlert(message) {
        world.alerts.push(String(message));
      },
    },
    core: {
      async executeAsModal(fn, info) {
        world.modals.push((info && info.commandName) || 'modal');
        return fn();
      },
    },
    action: {
      async batchPlay(commands) {
        const list = Array.isArray(commands) ? commands : [commands];
        for (const command of list) {
          world.actions.push(command);

          /* Photoshop returns a new layer id when a Background is promoted. */
          if (command._obj === 'set' && command.to &&
              Object.keys(command.to).length === 0) {
            const promoted = makeLayer(world.active.id + 100, 'pixel');
            world.setLayer(promoted);
            return [{ layerID: promoted.id }];
          }
        }
        return list.map(() => ({}));
      },
    },
    imaging: {
      async getPixels() {
        return {
          imageData: imageData(),
          sourceBounds: { left: 0, top: 0 },
        };
      },
      async createImageDataFromBuffer(buffer, options) {
        return {
          width: options.width,
          height: options.height,
          dispose() {
            world.disposed++;
          },
        };
      },
      async putSelection(info) {
        world.putSelections.push(info);
      },
      async putLayerMask(info) {
        if (world.failMask) throw new Error('putLayerMask is not available');
        world.layerMasks.push(info);
      },
    },
  };

  /* Engine stub: a bright person-shaped rectangle in an 800x600 frame. */
  const maskWidth = 800;
  const maskHeight = 600;
  const mask = new Uint8Array(maskWidth * maskHeight);
  if (opts.emptyMask) {
    /* all zeroes */
  } else {
    for (let y = 120; y < 480; y++) {
      for (let x = 280; x < 520; x++) mask[y * maskWidth + x] = 255;
    }
  }

  const engine = {
    isReady: () => true,
    ensureSession: async () => ({ simd: true }),
    segment: async () => ({
      mask,
      width: maskWidth,
      height: maskHeight,
      inputWidth: 384,
      inputHeight: 288,
      simd: true,
      timings: { preprocess: 1, inference: 2, refine: 3, pipeline: 6 },
    }),
  };

  const setup = { commands: {} };
  const uxp = {
    entrypoints: {
      setup(config) {
        Object.assign(setup.commands, (config && config.commands) || {});
        setup.plugin = config && config.plugin;
      },
    },
    storage: {
      formats: { binary: 'binary' },
      localFileSystem: {
        getPluginFolder: async () => {
          throw new Error('not used in this test');
        },
      },
    },
  };

  const sandbox = {
    console: {
      log() {},
      error() {},
      warn() {},
    },
    Promise,
    setTimeout,
    clearTimeout,
    performance,
    Date,
    Uint8Array,
    require(name) {
      if (name === 'photoshop') return photoshop;
      if (name === 'uxp') return uxp;
      throw new Error('unexpected require: ' + name);
    },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;

  world.sandbox = sandbox;
  world.context = vm.createContext(sandbox);
  world.setup = setup;

  const load = (relative) => {
    const file = path.join(PLUGIN, relative);
    vm.runInContext(fs.readFileSync(file, 'utf8'), world.context, {
      filename: file,
      displayErrors: true,
    });
  };

  load(path.join('js', 'ps.js'));
  sandbox.FASEngine = engine;
  load('index.js');

  return world;
}

async function main() {
  section('command registration');

  let world = createWorld();
  check('two commands registered', Object.keys(world.setup.commands).length === 2,
    Object.keys(world.setup.commands).join(', '));
  check('selectPerson command', typeof world.setup.commands.selectPerson === 'function');
  check('removeBackground command', typeof world.setup.commands.removeBackground === 'function');
  check('no panel registered', world.setup.plugin && !world.setup.panel);

  section('select person');

  world = createWorld();
  world.setLayer(makeLayer(7, 'pixel'));
  await world.setup.commands.selectPerson();

  check('selection was applied', world.putSelections.length === 1);
  check('selection covers the whole document',
    world.putSelections[0] && world.putSelections[0].documentID === 42);
  check('mask image is document-sized',
    world.putSelections[0] && world.putSelections[0].imageData.width === 800 &&
    world.putSelections[0].imageData.height === 600);
  check('image data disposed', world.disposed >= 2, String(world.disposed));
  check('no alert on success', world.alerts.length === 0, world.alerts.join(' | '));

  section('remove background on a Background layer');

  world = createWorld();
  world.setLayer(makeLayer(1, 'background'));
  await world.setup.commands.removeBackground();

  const kinds = world.actions.map((a) => a._obj);
  check('background promoted to a normal layer', kinds.includes('set') &&
    world.active.kind === 'pixel', 'kind ' + world.active.kind);
  check('layer mask applied', world.layerMasks.length === 1);
  check('mask targets the promoted layer',
    world.layerMasks[0] && world.layerMasks[0].layerID === world.active.id,
    world.layerMasks[0] && String(world.layerMasks[0].layerID));
  check('mask is grayscale and document-sized',
    world.layerMasks[0] && world.layerMasks[0].kind === 'user' &&
    world.layerMasks[0].imageData.width === 800 &&
    world.layerMasks[0].imageData.height === 600);
  check('no selection needed for the mask path', world.putSelections.length === 0);
  check('no alert on success', world.alerts.length === 0, world.alerts.join(' | '));

  section('remove background on an ordinary pixel layer');

  world = createWorld();
  world.setLayer(makeLayer(9, KIND_PIXEL));
  await world.setup.commands.removeBackground();
  check('no background promotion needed',
    !world.actions.some((a) => a._obj === 'set' && a.to && Object.keys(a.to).length === 0));
  check('layer mask applied', world.layerMasks.length === 1);

  section('pixel fallback when the mask API fails');

  world = createWorld({ failMask: true });
  world.setLayer(makeLayer(10, 'pixel'));
  await world.setup.commands.removeBackground();
  const fallbackKinds = world.actions.map((a) => a._obj);
  check('mask failure noticed', world.layerMasks.length === 0);
  check('selection created in its own modal', world.putSelections.length === 1);
  check('selection inverted', fallbackKinds.includes('inverse'));
  check('pixels cleared', fallbackKinds.includes('delete'));
  check('selection removed', fallbackKinds.includes('set') &&
    world.actions.some((a) => a._obj === 'set' && a.to && a.to._value === 'none'));
  check('no alert when the fallback works', world.alerts.length === 0,
    world.alerts.join(' | '));

  section('guarded failures (alert, no changes)');

  world = createWorld();
  world.setLayer(makeLayer(11, 'pixel', { locked: true }));
  await world.setup.commands.removeBackground();
  check('locked layer reported', world.alerts.some((m) => /заблокирован/.test(m)),
    world.alerts.join(' | '));
  check('nothing applied for a locked layer', world.putSelections.length === 0);

  world = createWorld();
  world.setLayer(makeLayer(12, 'smartObject'));
  await world.setup.commands.removeBackground();
  check('smart object reported', world.alerts.some((m) => /пиксельным слоем/.test(m)),
    world.alerts.join(' | '));
  check('nothing applied for a smart object', world.putSelections.length === 0);

  world = createWorld();
  world.setLayer(makeLayer(14, KIND_SMART_OBJECT));
  await world.setup.commands.removeBackground();
  check('numeric smart object reported',
    world.alerts.some((m) => /пиксельным слоем/.test(m)), world.alerts.join(' | '));

  world = createWorld();
  world.setLayer(makeLayer(15, undefined));
  await world.setup.commands.removeBackground();
  check('unknown layer kind does not block the cut',
    world.alerts.length === 0 && world.layerMasks.length === 1,
    world.alerts.join(' | '));

  world = createWorld();
  world.setLayer(makeLayer(16, 'normal'));
  await world.setup.commands.removeBackground();
  check('string kind "normal" accepted', world.alerts.length === 0,
    world.alerts.join(' | '));

  world = createWorld({ emptyMask: true });
  world.setLayer(makeLayer(13, 'pixel'));
  await world.setup.commands.removeBackground();
  check('empty mask reported', world.alerts.some((m) => /не найден/.test(m)),
    world.alerts.join(' | '));
  check('nothing applied for an empty mask', world.putSelections.length === 0);

  world = createWorld();
  world.doc = null;
  world.active = null;
  await world.setup.commands.selectPerson();
  check('missing document reported', world.alerts.some((m) => /Откройте документ/.test(m)),
    world.alerts.join(' | '));

  console.log('');
  if (failures) {
    console.log(failures + ' of ' + checks + ' check(s) failed');
    process.exit(1);
  }
  console.log('all ' + checks + ' command checks passed');
}

main().catch((error) => {
  console.error('\nCommand test failed:');
  console.error(error && (error.stack || error.message || error));
  process.exit(1);
});
