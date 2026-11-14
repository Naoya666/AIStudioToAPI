Portions of the Playground tool, schema, file and grounding protocol handling
are adapted from Mag1cFall/AIStudio2API, revision bd6c40f.
https://github.com/Mag1cFall/AIStudio2API

MIT License

Copyright (c) 2026 Mag1cFall

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Build dual-channel additions (2026-11-02):

- yunx738/ais2api, revision 38f2355495466fa0534eead394b6b10e7d55de0c,
  https://github.com/yunx738/ais2api . Preset matching adapted in
  src/core/codeAssistant/Presets.js; direct RPC/context/lifecycle design reference.
  CC BY-NC 4.0; license copy: docs/licenses/ais2api-CC-BY-NC-4.0.txt.
  Changes preserve tool metadata and input text, remove overflow relocation, and
  use this project's protected management and atomic storage. No A/B workers or
  reference local quota/reset rules were copied.
- qiwu622/build-standalone, revision bd6f28cd0f89aa4aff898ef10ee9e6dae022bf86,
  https://github.com/qiwu622/build-standalone . Adapted SillyTavern parsing, attachment
  context and tool contracts in src/core/codeAssistant; bundled adapter 0.6.0 in
  integrations/sillytavern-build-adapter. MIT license reproduced below and in
  docs/licenses/build-standalone-MIT.txt. Changes add auto_fallback, shared native
  validation, conservative limits and preserve assistant continuation.
- Mag1cFall/AIStudio2API, revision 0451f26248b7ce263a4fdbf92b280897cb79d74f,
  https://github.com/Mag1cFall/AIStudio2API . Tool contract / validation and Code
  Assistant lifecycle design reference. MIT license reproduced above.

MIT License

Copyright (c) 2026 Build Standalone contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Local browserless backend (2026-11-04):

- Core source: Mag1cFall/AIStudio2API, exact revision
  `591c81f2d2ce4a7f1bf644c4a5e1fd7f0b860e2c`,
  https://github.com/Mag1cFall/AIStudio2API/tree/591c81f2d2ce4a7f1bf644c4a5e1fd7f0b860e2c .
  MIT, Copyright (c) 2026 Mag1cFall. Full license: `local-engine/LICENSE.MIT`.
  Adapted `internal/waa` (SpiderMonkey bridge, Firefox host and shape),
  account fingerprint generation, fixed-proxy Firefox HTTP/2 and HTTP/3
  transport, storage cookies, SAPISID authorization, page startup resources,
  dynamic headers, auth warmup and WAA challenge lifecycle into `local-engine`.
  Package imports and application glue changed; browser launching, API routing,
  account pools, quotas, schedulers and management pages are excluded.
  `support.go` extracts only transport/helper primitives; `session.go` and the
  private daemon are this project's integration. The host JS files retain the
  reference content and property order.
- Packaging/lifecycle design review only: DeconstructedCube/aistudio-api,
  `feat/browserless-waa-engine`, exact revision
  `43adc28cb0a469753c374ee52453f9f99f53003d`,
  https://github.com/DeconstructedCube/aistudio-api/tree/43adc28cb0a469753c374ee52453f9f99f53003d .
  No Cube Python service, management UI, scheduler, 403 recovery policy or mint
  API is included. The reviewed branch has no root LICENSE; no Cube-specific
  implementation is copied. Dependency names were verified independently
  against the Mag1cFall source and locked in `local-engine/go.mod` / `go.sum`.
- Native SpiderMonkey build: Mag1cFall/firefox
  `v152.0.4-aistudio2api.1`,
  https://github.com/Mag1cFall/firefox/releases/tag/v152.0.4-aistudio2api.1 .
  Mozilla/Firefox licensing applies to its components (MPL 2.0 and bundled
  third-party licenses). Root notice: `docs/licenses/firefox-LICENSE.txt`;
  bundled license text: `docs/licenses/firefox-license.html`.
  Corresponding tagged source revision: `e297ff009d3b9afee0e223c02ae3271ef24d51b6`,
  https://github.com/Mag1cFall/firefox/tree/e297ff009d3b9afee0e223c02ae3271ef24d51b6 .
  Preserve Mozilla and bundled component notices from that corresponding source.
  Our native shim adds final JS_ShutDown after all VMs close, so engine helper
  threads are joined before process exit (also verified under Go race checking).
  Runtime cancellation interrupts the owning interpreter under its lifecycle
  lock, waits for initialization cleanup and removes abandoned delivery jobs.
  Build archives are fixed and SHA-256 checked in `local-engine/build.sh`.
  Zig 0.15.2 is a build-time compiler, not a runtime signing service.

The engine build also collects LICENSE/COPYING/NOTICE files from the exact locked
Go module graph and native Zig/musl/libc++ components into
`local-engine/bin/third-party-licenses`; the Docker image retains these at
`/app/local-engine/third-party-licenses`.

Tool schema compatibility and thought-signature recovery (2026-11-14):

- Mag1cFall/AIStudio2API, revision ef6fbbce7eda4e00d27493e0df7915dbf2d8c896,
  https://github.com/Mag1cFall/AIStudio2API . Adapted tool-schema projection and
  process-local signature recovery from internal/aistudio/{tools,schema}.go and
  internal/api/thoughtsig.go in src/core/ToolSchema.js and
  src/core/ThoughtSignatureStore.js. MIT license reproduced above. The JavaScript
  adapters also cover Responses and Anthropic histories and delayed stream signatures.
