# Third-party notices

desk-tasks is MIT-licensed (see [LICENSE](LICENSE)). It builds on the following projects.

## Bundled into the UI (`desk_tasks/web/app.js` in the wheel)

| Component | Version | Licence | Source |
|---|---|---|---|
| Preact | 11.1.0 | MIT | <https://github.com/preactjs/preact> |
| ical.js | 2.2.1 | MPL-2.0 | <https://github.com/kewisch/ical.js> |
| Zod | 4.6.7 | MIT | <https://github.com/colinhacks/zod> |

ical.js is used unmodified under the Mozilla Public License 2.0
(<https://mozilla.org/MPL/2.0/>); its source is available at the link above.

## Python packages (installed by uv, or carried by the Windows installer)

| Component | Licence | Source |
|---|---|---|
| pywebview | BSD-3-Clause | <https://github.com/r0x0r/pywebview> |
| pythonnet, clr-loader (Windows, via pywebview) | MIT | <https://github.com/pythonnet/pythonnet> |
| bottle, proxy-tools (via pywebview) | MIT | <https://github.com/bottlepy/bottle>, <https://github.com/jtushman/proxy_tools> |
| keyring | MIT | <https://github.com/jaraco/keyring> |
| pystray | LGPL-3.0 | <https://github.com/moses-palmer/pystray> |
| Pillow (via pystray) | MIT-CMU | <https://github.com/python-pillow/Pillow> |
| PyWinRT (`winrt-*`, Windows) | MIT | <https://github.com/pywinrt/pywinrt> |

pystray is used as an unmodified library in its own files (`Lib\site-packages\pystray` in the
installed folder), which can be replaced, as the LGPL allows.

## In the Windows installer

| Component | Licence | Source |
|---|---|---|
| Python (python.org's embeddable package, unmodified) | PSF-2.0 | <https://www.python.org> |
| cffi, pycparser, jaraco.classes/context/functools, more-itertools, pywin32-ctypes, six, typing-extensions (dependencies of the above) | MIT, BSD, PSF-2.0 | their PyPI pages |

Each package's licence file is installed with it (`*.dist-info`), Python's as `LICENSE.txt`.
The installer is made with Inno Setup (<https://jrsoftware.org/isinfo.php>), whose licence
allows distributing installers made with it.

Development tools (Bun, TypeScript, Biome, Playwright, axe-core, uv, ruff, ty, pytest) are not
distributed with desk-tasks.

## Licence texts of the bundled MIT components

### Preact

```
The MIT License (MIT)

Copyright (c) 2015-present Jason Miller

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
```

### Zod

```
MIT License

Copyright (c) 2025 Colin McDonnell

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
```
