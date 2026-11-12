/*
 * Redirect onnxruntime-web's WebAssembly instantiation through js/wasm-env.js.
 *
 * Photoshop 2025 can crash in the native asynchronous WebAssembly API after
 * the first script tick, so the plugin uses synchronous
 * `new WebAssembly.Module` + `new WebAssembly.Instance`. onnxruntime-web calls
 * WebAssembly.instantiate itself, so the vendor bundle is patched:
 *
 *   WebAssembly.instantiateStreaming -> undefined   (dead branch)
 *   WebAssembly.instantiate          -> __fasWasmInstantiate
 *
 * Run as part of tools/fetch-deps.ps1:
 *
 *   node tools/patch-ort.js plugin/lib/ort.wasm.min.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const file = path.resolve(process.argv[2] || path.join(__dirname, '..', 'plugin', 'lib', 'ort.wasm.min.js'));

if (!fs.existsSync(file)) {
  console.error('patch-ort: file not found: ' + file);
  process.exit(1);
}

const source = fs.readFileSync(file, 'utf8');

if (source.includes('__fasWasmInstantiate') && !/WebAssembly\.instantiate/.test(source)) {
  console.log('patch-ort: already patched: ' + file);
  process.exit(0);
}

const streaming = (source.match(/WebAssembly\.instantiateStreaming/g) || []).length;
const instantiate = (source.match(/WebAssembly\.instantiate/g) || []).length;

if (streaming !== 8) {
  console.error('patch-ort: expected 8 WebAssembly.instantiateStreaming references, found ' + streaming);
  console.error('patch-ort: onnxruntime-web version changed; review js/wasm-env.js before patching.');
  process.exit(1);
}
if (instantiate !== 12) {
  console.error('patch-ort: expected 12 WebAssembly.instantiate references, found ' + instantiate);
  process.exit(1);
}

let patched = source.replace(/WebAssembly\.instantiateStreaming/g, 'undefined');
const remaining = (patched.match(/WebAssembly\.instantiate/g) || []).length;
if (remaining !== 4) {
  console.error('patch-ort: expected 4 non-streaming references after step 1, found ' + remaining);
  process.exit(1);
}
patched = patched.replace(/WebAssembly\.instantiate/g, '__fasWasmInstantiate');

if (/WebAssembly\.instantiate/.test(patched)) {
  console.error('patch-ort: patch did not remove all WebAssembly.instantiate calls');
  process.exit(1);
}
if ((patched.match(/__fasWasmInstantiate/g) || []).length !== 4) {
  console.error('patch-ort: unexpected __fasWasmInstantiate count');
  process.exit(1);
}

fs.writeFileSync(file, patched, 'utf8');
console.log('patch-ort: patched 4 instantiate calls and 8 streaming references');
console.log('patch-ort: ' + file + ' (' + patched.length + ' bytes)');
