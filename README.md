# desk-tasks

Your Nextcloud task lists on the Windows desktop. A small widget sits on the desktop layer,
always visible, never in the way. Win+Alt+J brings it to the front with full keyboard
control; Esc sends it back. It reads and writes your lists over CalDAV, next to tasks.org,
Planify and the Nextcloud Tasks app, and changes only what you changed.

> **Status:** the Windows shell (desktop layer, hotkeys, tray, toasts) is waiting on the
> Windows spike (`docs/spike.md`). The UI, the task core and the Python bridge are built and
> tested on Linux. See `PROGRESS.md` for what's done and what's next.

## Install (Windows)

1. Install uv and Python 3.13 from python.org:

   ```
   winget install astral-sh.uv
   ```

   Then get Python 3.13 from <https://www.python.org/downloads/windows/> (the signed
   python.org build; desk-tasks runs on it so Smart App Control and SmartScreen stay quiet).

2. Install the wheel:

   ```
   uv tool install --python-preference only-system --python 3.13 C:\path\desk_tasks-0.1.0-py3-none-any.whl
   ```

   No uv? `py -m pip install --user C:\path\desk_tasks-0.1.0-py3-none-any.whl` works the
   same way.

3. Start it once with `desk-tasks`. The first-run sheet connects your Nextcloud
   (**Log in in your browser**; or **Use an app password instead**: in Nextcloud, Settings →
   Security → Devices & sessions → Create new app password), asks which lists Today shows,
   and offers **Start with Windows**.

**Update:** the same `uv tool install … --force` with the new wheel.

**Uninstall:** turn off "Start with Windows" in Settings, then
`uv tool uninstall desk-tasks`. To remove everything, also delete
`%LOCALAPPDATA%\desk-tasks` (settings, logs, the local copy of your tasks) and the
`desk-tasks` entry in Windows Credential Manager (Windows credentials). Revoke the app
password in Nextcloud (Settings → Security) if you didn't log out first.

## Using it

- **Win+Alt+J** shows or hides desk-tasks, **Win+Alt+N** shows it ready to add a task.
  Both can be changed in Settings.
- **Quick add** understands `tomorrow 14:00`, `#tag`, `!1`–`!4`, `/list`, `>fri` (start
  date), `every monday`, and ` // notes`, in English and German (`morgen`, `nächste Woche`,
  `jeden Montag`). Esc on a highlighted word makes it plain text again.
- **Keys** (while the widget is focused, outside text fields): `j`/`k` move, `Space` or `e`
  completes, `Enter` opens, `d` due date, `1`–`4` priority, `+`/`-` due a day later or
  earlier, `x` selects, `z` undoes, `Ctrl+K` finds any view, list or command, `?` shows them
  all. Single-key shortcuts can be turned off in Settings.
- **Undo** is there for every change, for the whole session (`z` or Ctrl+Z).
- If a change can't be confirmed (the connection dropped mid-save), saving pauses and a banner
  explains it. Nothing is retried behind your back.

Logs: `%LOCALAPPDATA%\desk-tasks\logs\desk-tasks.log` (rotating, 5 × 1 MB; no passwords or
task text at info level).

## Development (Linux)

```
bun install          # or: npm install (behind a proxy)
uv sync
bun run build        # the UI bundle into src/desk_tasks/web/
```

The fastest loop is the browser: `bun run screenshots` renders every view and state into
`.screenshots/` (light and dark, 360 and 480 px) against a seeded fake CalDAV server, and
`bun run test:ui` drives the built bundle in Chromium through a stub bridge
(`web/test/stub-bridge.ts`). The real window on Linux is a plain pywebview window (GTK):
`uv venv --system-site-packages && uv sync`, then `uv run desk-tasks` (it uses pywebview's
own server on Linux; the Windows build maps a virtual host instead).

| Command | What it runs |
|---|---|
| `bun run check` | Biome, `tsc`, `bun test`, ruff, ty, pytest (a red suite blocks completion) |
| `bun run test:ui` | the UI in Chromium against the fake server (Playwright, axe-core scan) |
| `bun run test:nextcloud` | the core and the Python login flow against Nextcloud in Docker (`--image nextcloud:34-apache`, `--keep`) |
| `bun run screenshots [filter]` | every state, light/dark, 360/480 px, into `.screenshots/` |
| `bun run release` | the bundle, then `uv build` → `dist/desk_tasks-<version>-py3-none-any.whl` |

Tests never talk to a real Nextcloud: only the fake server (`web/test/fake-caldav.ts`) and the
Docker container (`web/test/nextcloud/`).

## How it works

- **TypeScript** (`web/`): the Preact UI and the task core, ported from timesheet: an
  in-place iCalendar editor (other apps' properties survive byte for byte), the CalDAV client,
  sync (sync-collection with confirmed deletions, full reconcile every 30 minutes), verified
  writes (If-Match, byte-exact read-back), the journal and undo. The local copy lives in
  IndexedDB.
- **Python** (`src/desk_tasks/`): the only trust boundary. `dav()` sends one request to your
  Nextcloud's calendars with the app password from Credential Manager; the page never sees the
  password and can't reach anything else (`connect-src 'none'`). Login Flow v2, settings,
  shell events.
- **Windows shell** (after the spike): the desktop layer (Rainmeter's technique), global
  hotkeys, tray, toasts, autostart.

## Open questions and the defaults chosen

- **uv on Windows:** assumed via winget; `py -m pip install --user` documented as the
  alternative.
- **Windows version:** Windows 10 22H2 and Windows 11 23H2–25H2 are the targets; the checklist
  (`docs/windows-checklist.md`) runs on what you have.
- **Toasts with a registry-only AppUserModelID:** unverified until the checklist; if they
  don't show, desk-tasks uses tray balloons (the specified fallback).
- **Planify** regenerates tasks and drops start dates, unknown properties, "in progress",
  relative alarms and desk-tasks' "repeat from completion". desk-tasks can't prevent that; the
  task sheet's footer says "Modified … in Planify" so you can tell why something changed.
  Planify keeps only absolute future alarms, so a Planify save drops relative reminders.
- **tasks.org moves** delete and re-create a task with a new UID: fired reminders, snoozes and
  folds are keyed by href + UID and reset after such a move.
- **Accent colour:** a fixed blue (contrast-checked in both themes), not the Windows accent.
- **All-day reminders** count from 09:00 on the due day.
- More defaults taken where the spec left room are listed in `PROGRESS.md`
  ("Open questions / defaults chosen").

## Verified on

| Windows build | Spike | Checklist | Notes |
|---|---|---|---|
| (waiting for your results) | | | |
