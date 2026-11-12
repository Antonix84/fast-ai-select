# Third-party notices

Fast AI Select (the plugin source code, scripts and documentation) is released
under the MIT License — see [LICENSE](LICENSE).

The distribution also contains the following third-party components. They are
not covered by the MIT License and remain under their own terms.

## ONNX Runtime Web 1.17.3

- Files: `plugin/lib/ort.wasm.min.js`, `plugin/lib/ort-wasm-simd.wasm`,
  `plugin/lib/ort-wasm.wasm`
- License: MIT
- Copyright (c) Microsoft Corporation. All rights reserved.
- Source: https://github.com/microsoft/onnxruntime
- Package: https://www.npmjs.com/package/onnxruntime-web/v/1.17.3
- Full text: `plugin/lib/licenses/ORT-LICENSE.txt`

The JavaScript bundle is redistributed with a local patch that replaces
asynchronous WebAssembly instantiation with a synchronous one, because
Photoshop 2025 (UXP) crashes on `WebAssembly.instantiate` after an async tick.
The patch does not change the library API or behaviour. It can be reproduced
with `tools/patch-ort.js`.

## MODNet — photographic portrait matting model

- File: `plugin/models/modnet.onnx`
- Model: `modnet_photographic_portrait_matting.onnx`
- License: Apache License 2.0
- Copyright (c) 2020 ZHKKKe (Ke Zhang)
- Source: https://github.com/ZHKKKe/MODNet
- Weights: https://github.com/ZHKKKe/MODNet#model-zoo
- Full text: `plugin/models/licenses/MODNET-LICENSE.txt`
- Attribution: `plugin/models/licenses/MODNET-NOTICE.txt`

The model file is redistributed unmodified. It is used here for on-device,
CPU-only portrait matting.

## Adobe Photoshop UXP API

The plugin uses the Adobe Photoshop UXP API (`photoshop`, `uxp`) at runtime.
Those libraries are provided by the host application, are not redistributed
here, and are subject to Adobe's terms.
