"""The Windows shell (spec "Desktop integration"): the desktop layer, hotkeys, tray, toasts,
autostart, single instance. Built from the spike (docs/spike.md, results in README).

Modules that need Windows at import (`api`, `desktop`, `shell`) start with
`assert sys.platform == "win32"`; the others import Windows-only packages inside functions, so
their pure parts are tested on Linux.
"""
