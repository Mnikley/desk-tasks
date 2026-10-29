"""The Windows shell: the desktop layer, hotkeys, tray, toasts, autostart, single instance.
The techniques were first proven in a throwaway spike on Windows 10 (README, "Verified on").

Modules that need Windows at import (`api`, `desktop`, `shell`) start with
`assert sys.platform == "win32"`; the others import Windows-only packages inside functions, so
their pure parts are tested on Linux.
"""
