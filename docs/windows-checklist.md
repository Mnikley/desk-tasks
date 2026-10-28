# Windows checklist (manual, before v1 is done)

Everything here can only be verified on a real Windows PC. Record the Windows build
(`winver`) and the result of each item in the README's "Verified on" table. Background for each
item: `docs/research/windows-desktop.md`.

## Spike (build order step 0; everything else waits for it)
- The page loads from `https://app.desk-tasks.example/` (virtual host mapping), under the spec's
  CSP; a `js_api` call returns; `next_event` delivers an event from Python.
- IndexedDB data is still there after quitting and starting again.
- Autostart launch doesn't take focus from the app you're typing in.

## Desktop layer
1. The widget stays below normal windows after clicking it, typing in it, and Alt-Tab.
2. Clicks, text input, IME, Tab and arrow keys work while it rests on the desktop.
3. Win+D, the taskbar "Show desktop" corner and `(New-Object -ComObject Shell.Application).ToggleDesktop()`:
   the widget stays visible, is usable, and returns to the bottom afterwards.
4. Win+M, Win+Home and Aero Peek: the widget stays visible.
5. `taskkill /f /im explorer.exe`, then start Explorer: the widget survives, the tray icon comes
   back, Win+D still works.
6. Desktop-host lookup with: wallpaper slideshow on/off; "Show desktop icons" off; Lively or
   Wallpaper Engine running.
7. Virtual desktops: note whether the widget shows on all desktops or one (expected behaviour to
   document, not a failure).
8. Dragging and resizing for a minute: no crash or hang (the `WM_WINDOWPOSCHANGING` subclass on the
   WinForms form).

## Look and DPI
9. Rounded corners and no border on Windows 11; square on Windows 10.
10. Mixed-scale monitors: sharp text on both, move between them, size stays right.
11. Saved position on a monitor that is later disconnected: the widget reappears top right of the
    primary screen.
12. Switching Windows between light and dark updates the widget live; high contrast mode is legible.

## Shell
13. Win+Alt+J and Win+Alt+N work with Xbox Game Bar enabled; registering a combination another app
    holds (e.g. Game Bar's Win+Alt+T) shows the message in the widget.
14. Summon → Esc → back on the desktop; drafts survive.
15. Tray menu items all work; tooltip count is right.
16. A second start summons the running instance and exits.
17. Start with Windows: no console flash; listed in Task Manager → Startup apps; can be disabled there.
18. Sleep and resume (and Modern Standby if the PC has it): a sync runs after resume; missed
    reminders arrive as one summary toast.
19. Pull the network: offline banner within a minute; reconnect: sync resumes on its own.

## Notifications
20. Reminder toast shows the app name "desk-tasks" and icon; Done, Snooze and click work while the
    widget is covered by other windows. If the registry-only AppUserModelID shows nothing, switch to
    the tray-balloon fallback and note it.
21. Focus assist / Do not disturb suppresses toasts.

## Install and security
22. `uv tool install` of the wheel works on a clean user account; `desk-tasks` starts without a console.
23. Smart App Control (if on): the app starts. Defender does not flag anything.
24. The app password is in Credential Manager (Windows Credentials → Generic: `desk-tasks`), and
    nowhere in `%LOCALAPPDATA%\desk-tasks` (search the folder for it).
25. Cold start time and memory (python + msedgewebview2 processes) noted in the README.
