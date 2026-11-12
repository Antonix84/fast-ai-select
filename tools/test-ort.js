/*
 * End-to-end engine check without Photoshop.
 *
 *   node tools/test-ort.js
 *
 * Loads the real patched onnxruntime-web bundle, the real wasm binaries and
 * the real MODNet model inside a VM that mimics the UXP sandbox. Verifies that
 * the synchronous wasm bootstrap is used, the session is cached, and the
 * segment pipeline returns a full-resolution mask.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PLUGIN = path.join(__dirname, '..', 'plugin');
const WASM_SIMD = path.join(PLUGIN, 'lib', 'ort-wasm-simd.wasm');
const MODEL = path.join(PLUGIN, 'models', 'modnet.onnx');

let failures = 0;

function check(name, condition, detail) {
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

for (const file of [WASM_SIMD, MODEL, path.join(PLUGIN, 'lib', 'ort.wasm.min.js')]) {
  if (!fs.existsSync(file)) {
    console.log('missing dependency: ' + file);
    console.log('run tools/fetch-deps.ps1 first');
    process.exit(1);
  }
}

/* ------------------------------------------------------------------ */
/* UXP storage mock                                                    */
/* ------------------------------------------------------------------ */

function readArrayBuffer(filePath) {
  const buffer = fs.readFileSync(filePath);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function makeEntry(absPath) {
  const stat = fs.statSync(absPath);
  if (stat.isDirectory()) {
    return {
      isFolder: true,
      isFile: false,
      name: path.basename(absPath),
      getEntry: async (name) => makeEntry(path.join(absPath, name)),
    };
  }
  return {
    isFolder: false,
    isFile: true,
    name: path.basename(absPath),
    read: async () => readArrayBuffer(absPath),
  };
}

const pluginFolderEntry = makeEntry(PLUGIN);

const sandbox = {
  console,
  WebAssembly,
  Promise,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  performance,
  Date,
  URL,
  Blob,
  TextEncoder,
  TextDecoder,
  navigator: { hardwareConcurrency: 4 },
  location: { href: 'plugin://com.fastaiselect.panel/' },
  require: function (name) {
    if (name === 'uxp') {
      return {
        storage: {
          formats: { binary: 'binary' },
          localFileSystem: {
            getPluginFolder: async () => pluginFolderEntry,
          },
        },
        entrypoints: { setup() {} },
      };
    }
    throw new Error('unexpected require: ' + name);
  },
};

sandbox.window = sandbox;
sandbox.self = sandbox;

const context = vm.createContext(sandbox);

function load(relative) {
  const file = path.join(PLUGIN, relative);
  const code = fs.readFileSync(file, 'utf8');
  vm.runInContext(code, context, { filename: file, displayErrors: true });
}

/* ------------------------------------------------------------------ */
section('load plugin scripts');

load(path.join('js', 'wasm-env.js'));
load(path.join('lib', 'ort.wasm.min.js'));
load(path.join('js', 'core.js'));
load('guided_filter.js');
load(path.join('js', 'engine.js'));

check('FASWasm is global', !!sandbox.FASWasm);
check('FASCore is global', !!sandbox.FASCore);
check('FASGuidedFilter is global', !!sandbox.FASGuidedFilter);
check('FASEngine is global', !!sandbox.FASEngine);
check('ort namespace is global', !!sandbox.ort && !!sandbox.ort.InferenceSession,
  sandbox.ort ? 'no InferenceSession' : 'no ort');

/* Count synchronous wasm instantiations; async APIs must not be used. */
let instantiateCalls = 0;
const nativeInstantiate = sandbox.__fasWasmInstantiate;
sandbox.__fasWasmInstantiate = function (source, imports) {
  instantiateCalls++;
  return nativeInstantiate(source, imports);
};

/* ------------------------------------------------------------------ */
async function main() {
  section('session bootstrap');

  const loadStart = process.hrtime.bigint();
  const info = await sandbox.FASEngine.ensureSession((progress) => {
    if (progress && progress.stage) process.stdout.write('  … ' + progress.stage + '\r');
  });
  const loadMs = Number(process.hrtime.bigint() - loadStart) / 1e6;

  check('session created', !!info.session);
  check('input is named', typeof info.inputName === 'string' && info.inputName.length > 0,
    String(info.inputName));
  check('output is named', typeof info.outputName === 'string' && info.outputName.length > 0,
    String(info.outputName));
  const simdSupported = sandbox.FASEngine.detectSimd();
  check('SIMD probe is valid',
    simdSupported === WebAssembly.validate(new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 30,
      1, 28, 0, 65, 0, 253, 15, 253, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 253, 186, 1, 26, 11,
    ])),
    'probe mismatch');
  check('wasm file selected by SIMD probe',
    info.wasmName === (simdSupported ? 'ort-wasm-simd.wasm' : 'ort-wasm.wasm'),
    info.wasmName);
  check('SIMD is used on this CPU', !simdSupported || info.wasmName === 'ort-wasm-simd.wasm');
  check('sync instantiate used (not async WebAssembly.instantiate)',
    instantiateCalls >= 1, String(instantiateCalls));
  check('warmup ran', info.warmedUp === true, info.warmupError || 'no error');
  check('session is cached', sandbox.FASEngine.isReady());

  const again = await sandbox.FASEngine.ensureSession();
  check('second ensureSession returns the same session', again.session === info.session);
  console.log('  info model ' + (info.modelBytes / 1048576).toFixed(1) + ' MB, wasm ' +
    (info.wasmBytes / 1048576).toFixed(1) + ' MB, load ' + loadMs.toFixed(0) + ' ms');

  section('segment pipeline');

  // A simple synthetic portrait-ish frame: a light oval on a dark background.
  const width = 640;
  const height = 480;
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = (x - width / 2) / (width * 0.28);
      const dy = (y - height / 2) / (height * 0.42);
      const inside = dx * dx + dy * dy < 1;
      const i = (y * width + x) * 3;
      rgb[i] = inside ? 220 : 30;
      rgb[i + 1] = inside ? 180 : 40;
      rgb[i + 2] = inside ? 150 : 60;
    }
  }

  const segStart = process.hrtime.bigint();
  const result = await sandbox.FASEngine.segment({
    rgb,
    width,
    height,
    components: 3,
    targetLong: 384,
  });
  const segMs = Number(process.hrtime.bigint() - segStart) / 1e6;

  check('mask has full resolution', result.mask.length === width * height,
    String(result.mask.length));
  check('mask is Uint8Array',
    Object.prototype.toString.call(result.mask) === '[object Uint8Array]',
    Object.prototype.toString.call(result.mask));
  check('input size is a multiple of 32',
    result.inputWidth % 32 === 0 && result.inputHeight % 32 === 0,
    result.inputWidth + 'x' + result.inputHeight);

  let min = 255;
  let max = 0;
  let sum = 0;
  for (let i = 0; i < result.mask.length; i++) {
    const v = result.mask[i];
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  check('mask spans the full 0..255 range', min === 0 && max === 255, min + '..' + max);
  check('mask is not empty', sum > 0);
  check('timings reported', result.timings.inference > 0 && result.timings.pipeline > 0);

  console.log('  info input ' + result.inputWidth + 'x' + result.inputHeight +
    ', inference ' + result.timings.inference.toFixed(0) + ' ms' +
    ', refine ' + result.timings.refine.toFixed(0) + ' ms' +
    ', segment ' + segMs.toFixed(0) + ' ms');

  const warm = await sandbox.FASEngine.segment({
    rgb,
    width,
    height,
    components: 3,
    targetLong: 384,
  });
  console.log('  info repeat inference ' + warm.timings.inference.toFixed(0) +
    ' ms, refine ' + warm.timings.refine.toFixed(0) + ' ms');

  section('session reuse on a second image');

  const result2 = await sandbox.FASEngine.segment({
    rgb: rgb.subarray(0, 320 * 240 * 3),
    width: 320,
    height: 240,
    components: 3,
    targetLong: 512,
  });
  check('second segment works', result2.mask.length === 320 * 240, String(result2.mask.length));
  check('high mode uses 512', result2.inputHeight === 512 || result2.inputWidth === 512,
    result2.inputWidth + 'x' + result2.inputHeight);
  check('no extra session was created', instantiateCalls === 1, String(instantiateCalls));
  console.log('  info 512 mode inference ' + result2.timings.inference.toFixed(0) + ' ms');

  console.log('');
  if (failures) {
    console.log(failures + ' check(s) failed');
    process.exit(1);
  }
  console.log('all ORT engine checks passed');
}

main().catch((error) => {
  console.error('\nORT engine test failed:');
  console.error(error && (error.stack || error.message || error));
  process.exit(1);
});
