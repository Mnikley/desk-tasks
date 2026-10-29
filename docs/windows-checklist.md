# Windows checklist (manual, before v1 is done)

Everything here can only be verified on a real Windows PC. Record the Windows build
(`winver`) and the result of each item in the README's "Verified on" table. Background for each
item: `docs/research/windows-desktop.md`.

desk-tasks writes to the Nextcloud you log in to: use a test list for the items that create, tick
or delete tasks (Ctrl+K → "New list", e.g. "desk-tasks test"). It takes about an hour. Write down
OK or what happened for each numbered item and send the list back (see the end).

## Build and install (once)

You have uv, git and Python 3.15 from the spike. Add bun, which builds the UI bundle:

```powershell
winget install Oven-sh.Bun
```

Open a new PowerShell window, then:

```powershell
cd desk-tasks
git pull
bun install
bun run build
uv build --wheel
uv tool install --force --python-preference only-system --python 3.15 (Get-ChildItem dist\desk_tasks-*.whl | Select-Object -Last 1)
```

To update later: `git pull`, then the last three lines again. Start it with `desk-tasks` (no
console window opens). The log is `%LOCALAPPDATA%\desk-tasks\logs\desk-tasks.log`. Log in when
it asks (your browser opens Nextcloud's "Connect to your account" page).

## Spike (build order step 0; everything else waits for it)
- The page loads from `https://app.desk-tasks.example/` (virtual host mapping), under the spec's
  CSP; a `js_api` call returns; `next_event` delivers an event from Python.
- IndexedDB data is still there after quitting and starting again.
- Autostart launch doesn't take focus from the app you're typing in.

Passed on Windows 10 21H2 (README, "Verified on"). With the real app: quit from the tray and start
again; the lists show at once, before the first sync finishes (that's IndexedDB).

## Desktop layer
1. The widget stays below normal windows after clicking it, typing in it, and Alt-Tab.
   *How:* drag Notepad over half of the widget, click into the widget's visible part and type
   into quick add. Alt-Tab: desk-tasks is not in the list. F5 syncs (the dot spins) instead of
   reloading; Ctrl+R and right-click do nothing browser-like.
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
   WinForms form). *How:* drag by the empty part of the header; resize with the grip at the
   bottom right. Quit and start again: same place, same size.

## Look and DPI
9. Rounded corners and no border on Windows 11; square on Windows 10.
10. Mixed-scale monitors: sharp text on both, move between them, size stays right.
11. Saved position on a monitor that is later disconnected: the widget reappears top right of the
    primary screen.
12. Switching Windows between light and dark updates the widget live; high contrast mode is legible.
    *How:* Settings → Personalization → Colors; high contrast with Left Alt + Left Shift +
    Print Screen (same keys turn it off).

## Shell
13. Win+Alt+J and Win+Alt+N work with Xbox Game Bar enabled; registering a combination another app
    holds (e.g. Game Bar's Win+Alt+T) shows the message in the widget.
    *How:* Win+Alt+J brings it to the front with a row highlighted; Esc. Open the test list,
    Esc, then Win+Alt+N: quick add is focused; type `Test task tomorrow 14:00`, Enter: the task
    appears there, also in Nextcloud. Settings → Shortcuts → "Show and add a task": key T (Win+Alt+T): "Win+Alt+T is
    used by another app. Choose another shortcut in Settings." Set it back to N.
14. Summon → Esc → back on the desktop; drafts survive. *How:* type half a task into quick add,
    Esc twice: the app you were in has the keyboard again; summon: the draft is still there.
    Summon, then click another window: it goes back too.
15. Tray menu items all work; tooltip count is right. *How:* Show, Quick add, Sync now, Pause
    notifications 1 h (Settings → Notifications then says "Paused until …"; Resume), Settings,
    Quit last. A red dot on the icon while something is due today.
16. A second start summons the running instance and exits. *How:* run `desk-tasks` again.
17. Start with Windows: no console flash; listed in Task Manager → Startup apps; can be disabled there.
    *How:* Settings → Windows → Start with Windows, then
    `reg query HKCU\Software\Microsoft\Windows\CurrentVersion\Run /v desk-tasks` shows
    `"...\Scripts\pythonw.exe" -m desk_tasks`. Sign out and in.
18. Sleep and resume (and Modern Standby if the PC has it): a sync runs after resume; missed
    reminders arrive as one summary toast.
19. Pull the network: offline banner within a minute; reconnect: sync resumes on its own (within a
    few seconds: the network-change hint, not the next minute).

## Notifications
20. Reminder toast shows the app name "desk-tasks" and icon; Done, Snooze and click work while the
    widget is covered by other windows. If the registry-only AppUserModelID shows nothing, switch to
    the tray-balloon fallback and note it.
    *How:* give a task in the test list a reminder 2 minutes ahead and keep typing in Notepad: the
    toast doesn't interrupt your typing. It has a Snooze choice (15 minutes / 1 hour / Tomorrow
    9:00) and Done and Snooze buttons. Done completes the task (also in Nextcloud); Snooze with
    "15 minutes" brings it back then; a click on the toast's text brings the widget to the front
    with that task selected.
21. Focus assist / Do not disturb suppresses toasts.

## Install and security
22. `uv tool install` of the wheel works on a clean user account; `desk-tasks` starts without a console.
23. Smart App Control (if on): the app starts. Defender does not flag anything. The interpreter is
    the signed python.org one:
    ```powershell
    $exe = (Get-ItemProperty HKCU:\Software\Microsoft\Windows\CurrentVersion\Run).'desk-tasks' -replace '^"([^"]+)".*', '$1'
    Get-AuthenticodeSignature $exe | Format-List Status, SignerCertificate
    Get-AuthenticodeSignature (py -3.15 -c "import sys; print(sys._base_executable)") | Format-List Status, SignerCertificate
    ```
    Expected: `Valid`, "Python Software Foundation" (needs item 17's Run value). Paste the output.
24. The app password is in Credential Manager (Windows Credentials → Generic: `desk-tasks`), and
    nowhere in `%LOCALAPPDATA%\desk-tasks` (search the folder for it).
25. Cold start time and memory (python + msedgewebview2 processes) noted in the README.

## Added with the shell
26. Rebinding: Settings → Shortcuts, "Show or hide desk-tasks" to Win+Alt+K: Win+Alt+K summons,
    Win+Alt+J does nothing. Ticking Ctrl and Alt together is refused (AltGr). Set it back.
27. Quit flushes: tick a task and within a second choose Quit in the tray; then tick another and
    sign out of Windows at once; then summon, tick a third and press Alt+F4. After starting again
    all three are completed in Nextcloud. Signing out isn't held up by desk-tasks.
28. Links in notes: `https://example.org` opens in the browser (also with a middle click);
    `file:///C:/Windows` does nothing. Drag a file from Explorer onto the widget: nothing
    happens, and the widget keeps syncing afterwards (the dot still spins on F5).
29. The log has no app password, and no task titles (search it for one).
30. Uninstall (optional, last): Start with Windows off, Settings → Log out (revokes the app
    password), Quit, `uv tool uninstall desk-tasks`, delete `%LOCALAPPDATA%\desk-tasks`.

## Send me
- `winver` if it changed since the spike.
- For each numbered item: OK, or what happened instead. Screenshots welcome.
- The output of item 23.
- If anything fails or crashes: the last 100 lines of the log.
