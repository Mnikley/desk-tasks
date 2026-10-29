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

## Installed alongside (Python packages, not bundled)

| Component | Licence | Source |
|---|---|---|
| pywebview | BSD-3-Clause | <https://github.com/r0x0r/pywebview> |
| pythonnet, clr-loader (Windows, via pywebview) | MIT | <https://github.com/pythonnet/pythonnet> |
| bottle, proxy-tools (via pywebview) | MIT | <https://github.com/bottlepy/bottle>, <https://github.com/jtushman/proxy_tools> |
| keyring | MIT | <https://github.com/jaraco/keyring> |
| pystray | LGPL-3.0 | <https://github.com/moses-palmer/pystray> |
| Pillow (via pystray) | MIT-CMU | <https://github.com/python-pillow/Pillow> |
| PyWinRT (`winrt-*`, Windows) | MIT | <https://github.com/pywinrt/pywinrt> |

pystray is used as an unmodified, separately installed library, as the LGPL allows.

Development tools (Bun, TypeScript, Biome, Playwright, axe-core, uv, ruff, ty, pytest) are not
distributed with desk-tasks.
