/*
 * Fast AI Select - WebAssembly bootstrap for the UXP sandbox.
 *
 * Adobe Photoshop 2025 has a known problem with the native asynchronous
 * WebAssembly API: WebAssembly.instantiate()/compile() can crash the host when
 * called after the initial script tick (EXCEPTION_ACCESS_VIOLATION inside
 * V8/napi). Synchronous module compilation + instantiation is unaffected.
 *
 * onnxruntime-web 1.17 normally calls WebAssembly.instantiate(bytes, imports)
 * and loads ort-wasm-simd.wasm through fetch(). We solve both problems here:
 *
 *   - lib/ort.wasm.min.js is patched at build time: every
 *     `WebAssembly.instantiate` call is replaced with `__fasWasmInstantiate`,
 *     and `WebAssembly.instantiateStreaming` references are removed.
 *   - fetch() is wrapped so requests for the two ORT wasm files are answered
 *     from memory, without touching plugin:/ or the network.
 *   - the wasm module is compiled once (synchronously) and reused.
 */
(function (global) {
  'use strict';

  var NativeModule = global.WebAssembly && global.WebAssembly.Module;
  var NativeInstance = global.WebAssembly && global.WebAssembly.Instance;
  var originalFetch = typeof global.fetch === 'function' ? global.fetch.bind(global) : null;

  var buffers = Object.create(null);
  var precompiled = null;

  function fileNameOf(url) {
    var text = String(url || '');
    var query = text.indexOf('?');
    if (query >= 0) text = text.slice(0, query);
    var slash = text.lastIndexOf('/');
    if (slash >= 0) text = text.slice(slash + 1);
    return text;
  }

  function registerBinary(name, binary) {
    buffers[name] = binary;
  }

  /*
   * Compile synchronously and remember the module. When ORT later asks for
   * the same ArrayBuffer, instantiation reuses the already compiled module,
   * so the 10 MB wasm blob is compiled only once.
   */
  function precompile(name, binary) {
    if (!NativeModule || !NativeInstance) {
      throw new Error('WebAssembly is not available in this Photoshop build.');
    }
    registerBinary(name, binary);
    var module = new NativeModule(binary);
    precompiled = { name: name, binary: binary, module: module };
    return module;
  }

  /*
   * Synchronous replacement for WebAssembly.instantiate(bytes, imports).
   * Returns a Promise because that is what the emscripten glue expects.
   */
  function instantiate(source, imports) {
    try {
      var module;
      if (precompiled && source === precompiled.binary) {
        module = precompiled.module;
      } else if (source instanceof NativeModule) {
        module = source;
      } else {
        module = new NativeModule(source);
      }
      var instance = new NativeInstance(module, imports || {});
      return Promise.resolve({ module: module, instance: instance });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  function makeWasmResponse(buffer, url) {
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      url: url || '',
      headers: { get: function () { return null; } },
      arrayBuffer: function () { return Promise.resolve(buffer); },
      text: function () { return Promise.resolve(''); }
    };
  }

  function fetchShim(input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var name = fileNameOf(url);

    if (/\.wasm$/i.test(name)) {
      var buffer = buffers[name];
      if (!buffer) {
        return Promise.reject(new Error(
          'Fast AI Select: embedded WebAssembly file is missing: ' + name +
          '. Reinstall the plugin (lib/ is incomplete).'
        ));
      }
      return Promise.resolve(makeWasmResponse(buffer, url));
    }

    /* The plugin is intentionally offline. Other requests are delegated only
     * if the host provides fetch; the plugin itself never makes any. */
    if (originalFetch) return originalFetch(input, init);
    return Promise.reject(new Error('Fast AI Select works offline; network request blocked: ' + url));
  }

  global.fetch = fetchShim;
  global.__fasWasmInstantiate = instantiate;
  global.__fasWasmPrecompile = precompile;
  global.__fasWasmRegister = registerBinary;

  global.FASWasm = {
    precompile: precompile,
    register: registerBinary,
    instantiate: instantiate,
    hasBinary: function (name) { return !!buffers[name]; },
    binaryNames: function () { return Object.keys(buffers); }
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
