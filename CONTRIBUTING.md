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
`bun run test:nextcloud` (Docker). CI runs all of these, plus a Windows job on Python 3.15.

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

## Commits and pull requests

One logical change per commit, with a message that says what changed and why. Pull requests
target `main`; CI must be green.
