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
