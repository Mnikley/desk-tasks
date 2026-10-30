# desk-tasks

Your Nextcloud task lists as a small widget on the Windows desktop. It sits on the desktop
layer, always visible and never in the way. **Win+Alt+J** brings it to the front with full
keyboard control; **Esc** sends it back. It reads and writes your lists over CalDAV, next to
the Nextcloud Tasks app, tasks.org and Planify, and changes only what you changed.

![desk-tasks: Today in light and dark, and a task's details](docs/images/desk-tasks.png)

> **Status:** early (0.2). The task core and UI are tested end to end against Nextcloud 35 in
> CI. The Windows techniques were proven on Windows 10 21H2 in a throwaway prototype (see
> [Verified on](#verified-on)); the app itself is new on Windows, so bug reports are welcome.

## Features

- **On the desktop, not in the way:** stays below your windows, stays visible on Show desktop
  (Win+D), no taskbar button. Win+Alt+J summons it, Win+Alt+N opens quick add; both can be
  changed.
- **Quick add** with a small grammar: `Call Bob tomorrow 14:00 #work !1 /Errands every monday
  // notes` (`#` tag, `!` priority, `/` list, `//` notes), in English and German (`morgen`,
  `nächste Woche`, `jeden Montag`).
- **Keyboard first:** `j`/`k`, `Space` to complete, `d` due date, `1`–`4` priority, `x` to
  select, `Ctrl+K` for everything, `?` for the full list. Single-key shortcuts can be turned off.
- **Views:** Today, Upcoming, All, each list, Trash; subtasks, your own order (drag and drop),
  repeating tasks, reminders as Windows notifications (Done / Snooze), sharing lists with other
  Nextcloud users.
- **Undo for every change**, for the whole session (`z` or Ctrl+Z).
- **Careful with your data:** edits are made in place in the task's iCalendar text, so
  properties other apps wrote survive byte for byte; every write is checked against what
  Nextcloud stored. If a change can't be confirmed, saving pauses and says why instead of
  retrying behind your back.
- Light and dark (follows Windows), high-contrast mode, screen-reader labels.

## Requirements

- Windows 10 (version 2004 or later) or Windows 11, 64-bit, with the Microsoft Edge WebView2
  runtime (built in on current Windows; the installer says so if it's missing).
- A Nextcloud with the Tasks app or any CalDAV task lists (tested with Nextcloud 35).

## Install

**[Download desk-tasks-setup.exe](https://github.com/Mnikley/desk-tasks/releases/latest/download/desk-tasks-setup.exe)**
and run it. It installs for your Windows account only, needs no administrator rights and
nothing else first (it brings its own copy of python.org's signed Python), and puts desk-tasks
in the Start menu.

The installer isn't code-signed yet (see the [code signing policy](#code-signing-policy)), so
Windows may show "Windows protected your PC": click **More info → Run anyway**. Each release lists the installer's SHA-256 if you want to check
your download (`Get-FileHash desk-tasks-setup.exe`).

The first start connects your Nextcloud: **Log in in your browser** (Nextcloud's Login Flow),
or **Use an app password instead** (Nextcloud → Settings → Security → Devices & sessions →
Create new app password). It then asks which lists Today shows and offers **Start with
Windows**.

**Updates:** desk-tasks checks for a new release twice a day and shows a banner when there is
one. **Update** downloads it, restarts desk-tasks into it (changes waiting to be saved are
saved first) and tells you what changed. Settings → Updates has **Check now** and turns the
automatic check off. Running a newer `desk-tasks-setup.exe` by hand works too.

**Uninstall:** Windows Settings → Apps → desk-tasks → Uninstall. It asks whether to remove your
settings too; yes logs out first (Nextcloud is asked to revoke the app password) and deletes
`%LOCALAPPDATA%\desk-tasks` (settings, logs, the local copy of your tasks). Your tasks in
Nextcloud stay as they are.

<details>
<summary>Install with uv instead (for Python users)</summary>

You need Python 3.11 or later from python.org (3.15 recommended) and
[uv](https://docs.astral.sh/uv/). In PowerShell:

```powershell
uv tool install --python-preference only-system --python 3.15 https://github.com/Mnikley/desk-tasks/releases/latest/download/desk_tasks-0.2.0-py3-none-any.whl
```

Start it with `desk-tasks` (if PowerShell doesn't find it, run `uv tool update-shell` and open a
new window). This copy tells you about new versions but doesn't update itself: quit it from the
tray and run the install command of the new release with `--force` added. Uninstall: turn off
"Start with Windows" and log out in Settings, quit from the tray, then `uv tool uninstall
desk-tasks`. Moving to the installer: uninstall this way first (your settings stay).

</details>

## Privacy and security

- desk-tasks talks to the Nextcloud you connect, and to GitHub for updates: twice a day it asks
  api.github.com for the latest release (an anonymous request; nothing about you or your tasks
  goes with it), and it downloads an installer from GitHub when you click **Update**. Settings
  → Updates turns the check off. No telemetry, no other servers.
- The app password is stored in Windows Credential Manager (`desk-tasks`), never in a file and
  never in the web view. One small Python function sends each request to your server's
  calendars; the page can't reach anything else (Content-Security-Policy `connect-src 'none'`).
- Logs (`%LOCALAPPDATA%\desk-tasks\logs`, at most 6 × 1 MB) contain no passwords and no task
  titles or notes. They do name your server, user name and lists (in task addresses).

[PRIVACY.md](PRIVACY.md) is the full privacy policy. See [SECURITY.md](SECURITY.md) for the design
and how to report a vulnerability.

## Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by
[SignPath Foundation](https://signpath.org/). (Applied for; until it is in place, the installer
is unsigned.)

- Only `desk-tasks-setup.exe` and its uninstaller are signed, built by GitHub Actions from this
  repository for a tagged release (see [CONTRIBUTING.md](CONTRIBUTING.md#releasing)). The
  Python interpreter it carries is python.org's, already signed by the Python Software
  Foundation; the Python packages are unmodified PyPI wheels, included as they are.
- Committers and reviewers: [Mnikley](https://github.com/Mnikley). Changes from anyone else
  come as pull requests and are reviewed before they are merged.
- Approvers (each signing request is approved by hand): [Mnikley](https://github.com/Mnikley).
- Privacy: desk-tasks talks only to the Nextcloud you connect and, for updates, to GitHub; the
  update check can be turned off. Details in [PRIVACY.md](PRIVACY.md).

## Troubleshooting

- **A shortcut doesn't work:** desk-tasks says when another app holds it ("Win+Alt+J is used by
  another app"). Pick another one in Settings → Shortcuts. Ctrl+Alt combinations aren't offered
  (that's AltGr on many European keyboards).
- **No notifications:** check Windows Settings → System → Notifications (and Do not disturb).
  If Windows refuses a notification, desk-tasks shows a tray balloon instead.
- **"Saving is paused":** a change couldn't be confirmed (for example the connection dropped
  mid-save). Check the task in Nextcloud, then press Resume.
- **An update didn't finish:** desk-tasks says so and keeps running the version you had. The
  installer's log is `%LOCALAPPDATA%\desk-tasks\logs\update.log`; **Try again**, or run the
  new `desk-tasks-setup.exe` from the release page by hand.
- **Anything else:** the log is `%LOCALAPPDATA%\desk-tasks\logs\desk-tasks.log`. Please attach
  its last lines to a [bug report](https://github.com/Mnikley/desk-tasks/issues/new/choose).

## Works with other apps

- **Nextcloud Tasks, tasks.org (DAVx⁵), Thunderbird:** shared fields are read and written the
  way they write them; unknown properties are kept.
- **Planify** regenerates tasks when it saves and drops start dates, unknown properties,
  "in progress", relative reminders and desk-tasks' "repeat from completion". desk-tasks can't
  prevent that; the task's footer says "Modified … in Planify" so you can tell why something
  changed.
- **tasks.org moves** delete and re-create a task with a new UID, so its fired reminders,
  snoozes and folds start fresh after such a move.
- All-day reminders count from 09:00 on the due day.

## How it works

- **TypeScript** (`web/`): the Preact UI and the task core: an in-place iCalendar editor, the
  CalDAV client, sync (sync-collection with confirmed deletions and a full reconcile every 30
  minutes), verified writes (If-Match, byte-exact read-back), the journal behind Undo. The local
  copy lives in IndexedDB.
- **Python** (`src/desk_tasks/`): the only trust boundary. `dav()` sends one request to your
  Nextcloud's calendars with the stored app password; Login Flow v2; settings; the event queue
  for the UI.
- **Windows shell** (`src/desk_tasks/win/`): a pywebview (WebView2) window on the desktop
  layer, global hotkeys, tray icon, notifications through WinRT, Start with Windows.
- **Installer and updates** (`packaging/windows/`, `src/desk_tasks/updates.py`): Inno Setup
  packs python.org's embeddable Python with the locked dependencies into a per-user installer,
  one folder per version. The app downloads a new release's installer, checks its size and
  the SHA-256 GitHub lists for it, and runs it silently; the installer asks desk-tasks to quit
  (it saves first), installs, and starts it again, also after a failure.

## Development

Development happens on Linux (the UI and core run in Chromium and against fake or Docker
servers); the Windows shell needs a Windows machine or CI's Windows runner.

```bash
bun install
uv sync
bun run build
```

| Command | What it runs |
|---|---|
| `bun run check` | Biome, `tsc`, `bun test`, ruff, ty (Linux and Windows), pytest |
| `bun run test:ui` | the built UI in Chromium against a fake CalDAV server (Playwright, axe-core) |
| `bun run test:nextcloud` | the core and the login flow against Nextcloud in Docker (`--image nextcloud:34-apache`, `--keep`) |
| `bun run screenshots [filter]` | every view and state, light and dark, 360 and 480 px, into `.screenshots/` |
| `bun run release` | the UI bundle, then `uv build` → `dist/desk_tasks-<version>-py3-none-any.whl` |
| `uv run python packaging/windows/build.py` | after `release`, on Windows with Inno Setup 6: `dist/desk-tasks-setup.exe` (`--stage-only` works on Linux) |

On Linux, `uv venv --system-site-packages && uv sync`, then `uv run desk-tasks` opens a plain
pywebview (GTK) window for trying things out. Tests never talk to a real Nextcloud: only to the
fake server (`web/test/fake-caldav.ts`) and the Docker container (`web/test/nextcloud/`).
[docs/windows-checklist.md](docs/windows-checklist.md) is the manual test on Windows.

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## Verified on

| Windows | Result | Notes |
|---|---|---|
| Windows 10 21H2 (19044.7807), Python 3.15.2, WebView2 156 | Prototype (not in this repository): desktop layer, Win+D, hotkeys, notifications, start without stealing focus, drag and resize, live theme, Explorer restart, IndexedDB across restarts | Rounded corners are Windows 11 only; square on Windows 10. |
| windows-latest (CI), Python 3.15 | pytest; the installer installs, the app starts, the app's updater updates it while it runs (it quits when asked and starts again), the uninstaller removes it | No one looks at the screen: no visual checks. |

## License

[MIT](LICENSE). Third-party components and their licences:
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
