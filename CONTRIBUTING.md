# Contributing

Thanks for helping. Bug reports with the log attached are the most useful contribution;
pull requests are welcome too.

## Setup

You need [Bun](https://bun.sh) 1.4, [uv](https://docs.astral.sh/uv/), Python 3.11+ and, for the
real-server suite, Docker.

```bash
bun install
uv sync
bun run build
```

## Before you push

```bash
bun run check      # Biome, tsc, bun test, ruff, ty (Linux and win32), pytest
bun run test:ui    # the UI in Chromium (needs: bunx playwright-core install chromium)
```

If you touched sync, writes, lists, sharing, order, recurrence or reminders, also run
`bun run test:nextcloud` (Docker). CI runs all of these on every push (pull requests skip the
Docker suite), plus Python 3.11 and a Windows job on Python 3.15.

## Ground rules

- **Never point tests at a real Nextcloud.** Use the fake server (`web/test/fake-caldav.ts`) or
  the Docker one (`web/test/nextcloud/`).
- **Every bug fix comes with a test that fails without it.** UI fixes go in `web/test/ui/`.
- **Other apps' data is sacred:** edits to a task change only the properties the user changed;
  `web/test/integrity.test.ts` and the fixtures in `test/fixtures/tasks/` guard that. Don't
  normalise line endings in `*.ics` fixtures (`.gitattributes` keeps them as they are).
- **The Python bridge is the only trust boundary.** A new bridge call needs argument validation
  and a test in `tests/test_bridge.py`.
- Windows-only code lives in `src/desk_tasks/win/`; keep the logic that can be pure (band
  transitions, hotkey parsing, toast XML) in pure functions with tests that run on Linux.
- UI text is short, plain English, and says what to do next. Match the surrounding code's
  style and comment density.
- UI changes: run `bun run screenshots` and look at the result in both themes.

## The installer and updates

`packaging/windows/build.py` builds `dist/desk-tasks-setup.exe` (Windows, Inno Setup 6; CI
does it on every push and installs, updates and uninstalls it with
`packaging/windows/smoke.py`). It pins python.org's embeddable Python by version and SHA-256:
when the Windows CI Python moves to a new minor version, move `PYTHON` and `PYTHON_SHA256`
with it (`tests/test_installer.py` checks they agree). The names the installer shares with the
app (the probe window, the quit message, the mutex, the marker file) are checked there too.

## Releasing

1. Move the version in `pyproject.toml`, `src/desk_tasks/__init__.py`, `uv.lock` (`uv lock`)
   and the README's uv command, and give it a section in `CHANGELOG.md`.
2. Merge to `main`, then tag it: `git tag v0.2.0 && git push origin v0.2.0`.
3. CI tests the tag, builds the wheel and the installer, and publishes release 0.2.0 with the
   changelog section as notes; then it installs the release as the README says. Installed
   copies offer the update within 12 hours.

Pushes to `main` publish a "Development build" pre-release; the app never offers those.

## Commits and pull requests

One logical change per commit, with a message that says what changed and why. Pull requests
target `main`; CI must be green.
