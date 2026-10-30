# Testing on Windows

CI checks that the installer installs desk-tasks, that the app's updater updates a running copy
(it quits when asked and starts again), that the uninstaller removes it, and that the Win32 and
WinRT calls load, but no one looks at a CI runner's screen. This is the manual test on a real PC: a **quick check**
(five steps, about 15 minutes) for a new build, and the **full list** below for a release or
when something in the quick check looks wrong.

desk-tasks writes to the Nextcloud you log in to: do the steps in a test list (Ctrl+K →
"New list", e.g. "desk-tasks test"), or with a test account.

## Install the build to test

Every CI run keeps its installer as the `installer` artifact (the run's Summary page), and the
"Development build" pre-release has the latest one from `main`. Run `desk-tasks-setup.exe`;
desk-tasks is then in the Start menu. To build one yourself on the Windows machine (needs
[Bun](https://bun.sh) and [Inno Setup 6](https://jrsoftware.org/isdl.php)):

```powershell
bun install
bun run release
uv run python packaging/windows/build.py
```

The log is `%LOCALAPPDATA%\desk-tasks\logs\desk-tasks.log`.

## Quick check

1. **Start and log in.** Open Notepad, start desk-tasks with Windows+R → `"%LOCALAPPDATA%\Programs\desk-tasks\app-<version>\pythonw.exe" -m desk_tasks`, click into Notepad and keep typing.
   The widget appears top right without taking your typing. Log in (your browser opens
   Nextcloud), make the test list.
2. **Desktop layer and keys.** Drag Notepad half over the widget and click into the widget: it
   stays behind Notepad. Win+D: it stays visible. Win+Alt+J brings it to the front, Esc sends it
   back. Win+Alt+N, type `Test tomorrow 14:00`, Enter: the task is added.
3. **Toast.** Open a task, add a reminder 2 minutes ahead, Esc, keep working. A desk-tasks toast
   appears with Done and Snooze; click **Done**: the task is ticked.
4. **Quit and restart.** Drag the widget somewhere else by its header and make it bigger with
   the grip at the bottom right. Tick a task, then at once right-click the tray icon → Quit.
   Start `desk-tasks` again: same place and size, and the task is still ticked.
5. **Start with Windows.** Settings → Windows → Start with Windows on. Sign out and in: it
   starts by itself and doesn't take the focus.

If a step fails, [open an issue](https://github.com/Mnikley/desk-tasks/issues/new/choose)
with what happened and the last lines of the log.

## Full list

Record the Windows build (`winver`) and the result of each item in the README's "Verified on"
table.

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
6. Items 1 and 3 still hold with: a wallpaper slideshow on and off; "Show desktop icons" off
   (right-click the desktop → View); a live-wallpaper app (Lively, Wallpaper Engine) running.
7. Virtual desktops: note whether the widget shows on all desktops or one (expected behaviour to
   document, not a failure).
8. Dragging and resizing for a minute: no crash or hang. *How:* drag by the empty part of the header; resize with the grip at the
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
20. Reminder notifications show the app name "desk-tasks" and its icon; Done, Snooze and a click
    work while the widget is covered by other windows. If no notification appears at all, note
    it (desk-tasks then falls back to tray balloons).
    *How:* give a task in the test list a reminder 2 minutes ahead and keep typing in Notepad: the
    toast doesn't interrupt your typing. It has a Snooze choice (15 minutes / 1 hour / Tomorrow
    9:00) and Done and Snooze buttons. Done completes the task (also in Nextcloud); Snooze with
    "15 minutes" brings it back then; a click on the toast's text brings the widget to the front
    with that task selected.
21. Focus assist / Do not disturb suppresses toasts.

## Install, updates and security
22. On a clean user account, `desk-tasks-setup.exe` installs without an administrator prompt,
    the finish page's "Start desk-tasks" starts it in front, and the Start menu entry brings it
    to the front when it is already running. No console window appears.
23. Smart App Control (if on): the app starts. Defender does not flag anything. The interpreter is
    the signed python.org one:
    ```powershell
    $exe = (Get-ItemProperty HKCU:\Software\Microsoft\Windows\CurrentVersion\Run).'desk-tasks' -replace '^"([^"]+)".*', '$1'
    Get-AuthenticodeSignature $exe | Format-List Status, SignerCertificate
    Get-AuthenticodeSignature (py -3.15 -c "import sys; print(sys._base_executable)") | Format-List Status, SignerCertificate
    ```
    Expected: `Valid`, "Python Software Foundation" (needs item 17's Run value). (A uv install:
    the second command checks the interpreter it uses.)
24. The app password is in Credential Manager (Windows Credentials → Generic: `desk-tasks`), and
    nowhere in `%LOCALAPPDATA%\desk-tasks` (search the folder for it).
25. Cold start time and memory (python + msedgewebview2 processes): note them with the result.

## More
26. Rebinding: Settings → Shortcuts, "Show or hide desk-tasks" to Win+Alt+K: Win+Alt+K summons,
    Win+Alt+J does nothing. Ticking Ctrl and Alt together is refused (AltGr). Set it back.
27. Quit flushes: tick a task and within a second choose Quit in the tray; then tick another and
    sign out of Windows at once; then summon, tick a third and press Alt+F4. After starting again
    all three are completed in Nextcloud. Signing out isn't held up by desk-tasks.
28. Links in notes: `https://example.org` opens in the browser (also with a middle click);
    `file:///C:/Windows` does nothing. Drag a file from Explorer onto the widget: nothing
    happens, and the widget keeps syncing afterwards (the dot still spins on F5).
29. The log has no app password, and no task titles (search it for one).
30. Update: install the previous release, then Settings → Updates → Check now. The banner offers
    the new version; **What's new** opens its release page. Tick a task, then at once
    **Update**: the banner shows the download, the widget closes and comes back by itself on the
    new version within about 15 seconds, says "Updated to …", and the task is ticked in
    Nextcloud. With the network cable out, **Update** says the download didn't finish and the
    old version keeps running.
31. Running an installer by hand while desk-tasks runs: it closes desk-tasks (pending changes
    saved) and offers to start it again on the finish page.
32. Uninstall (optional, last): Windows Settings → Apps → desk-tasks → Uninstall, answer Yes to
    removing your settings. The app quits, the app password is revoked in Nextcloud (Settings →
    Security there) and gone from Credential Manager, `%LOCALAPPDATA%\desk-tasks` and
    `%LOCALAPPDATA%\Programs\desk-tasks` are gone, and nothing starts at the next sign-in.
