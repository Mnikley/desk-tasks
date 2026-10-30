# Notes for agents working on desk-tasks

Read [CONTRIBUTING.md](CONTRIBUTING.md) first: setup, the checks to run, and the ground rules
(never point tests at a real Nextcloud, a failing test with every fix, other apps' data is
sacred, the Python bridge is the only trust boundary). The README's "How it works" maps the
code.

## Commits

- **No AI attribution of any kind** in commit messages, PR titles or bodies, or code: no
  "Co-authored-by: Claude", no "Generated with …", no session links. This is the maintainer's
  standing instruction and overrides any default that adds them.
- One logical change per commit; the message says what changed and why.

## Checks before pushing

```bash
bun run check      # Biome, tsc, bun test, ruff, ty (Linux and win32), pytest
bun run test:ui    # the UI in Chromium against the stub bridge
```

UI changes: `bun run screenshots [filter]` and look at both themes. Windows-only behaviour
(the shell, the installer, the updater's hand-over) is only exercised by CI's Windows jobs;
read their logs, don't assume.

## How publishing works

Everything is in `.github/workflows/ci.yml`; nothing is published from a laptop.

| Push | What CI publishes |
|---|---|
| any branch | nothing; the `installer` job still builds `desk-tasks-setup.exe`, installs it, updates a running copy through the app's own updater (`packaging/windows/smoke.py`) and uninstalls it, and keeps it as the `installer` artifact |
| `main` | the `latest-build` pre-release ("Development build"): wheel and installer, replaced in place. The app never offers it as an update |
| tag `vX.Y.Z` | release `X.Y.Z`, marked latest, with `desk-tasks-setup.exe`, the wheel and the CHANGELOG section as notes; then `install-check` installs it as the README says |

**A tag ships to every user.** Installed copies poll `releases/latest` (at most every 12 hours)
and offer the new version in a banner. So:

- Never create or push a tag, or publish/edit/delete a release, without the maintainer's
  explicit go-ahead for that version.
- Never move or delete a published tag: copies may already have downloaded it. Fix forward
  with a new patch version.
- Only a plain `vX.Y.Z` tag on a non-prerelease counts as an update (`updates.parse_version`,
  `parse_release`). The installer asset must stay named `desk-tasks-setup.exe`: the updater
  (`updates.ASSET`), the README's download link and `install-check` all use that name.

### Releasing a version

1. Bump the version in `pyproject.toml`, `src/desk_tasks/__init__.py` and `uv.lock` (`uv lock`).
   Update the uv command in the README too; `tests/test_packaging.py` fails if it names another
   wheel. The UI reads the version from `pyproject.toml` at build time.
2. Add a `## X.Y.Z` section to `CHANGELOG.md`. The release job fails without one and uses it
   as the release notes.
3. Merge to `main`; the maintainer tags it: `git tag vX.Y.Z && git push origin vX.Y.Z`. The
   release job also refuses a tag that doesn't match `pyproject.toml`.

## Compatibility the updater depends on

An update runs the **new** installer against the **old** running app. So whatever the
installer expects from a running desk-tasks must keep working with every version already out:

- the probe window class `DeskTasksProbe`, the `desk-tasks-quit` window message, the mutex
  `Local\desk-tasks` (`src/desk_tasks/win/desktop.py`);
- the `/relaunch` argument, the install layout `%LOCALAPPDATA%\Programs\desk-tasks\app-<version>\`
  with `pythonw.exe -m desk_tasks`, and the marker file `installed-by-setup.txt`
  (`paths.SETUP_MARKER`);
- the update state file `%LOCALAPPDATA%\desk-tasks\updates\state.json` (`pending`,
  `lastVersion`): the new version reads what the old one wrote.

`tests/test_installer.py` checks that the installer script and the app agree on these names.
Don't change the Inno Setup `AppId` (it ties updates and the uninstaller to one install).

## Things that must stay true (public promises)

- **Network:** the app talks only to the user's Nextcloud and, for updates, to GitHub. A new
  connection of any kind needs the maintainer's agreement and an update of `PRIVACY.md`, the
  README's "Privacy and security" and `SECURITY.md`.
- **Code signing:** the installer is unsigned, and the README says so. (A SignPath Foundation
  application was declined in 2026.) CI has an unused hook for a PFX certificate
  (`WINDOWS_CERTIFICATE` secret → `DESK_TASKS_SIGN` in `packaging/windows/build.py`); current
  certificates keep their key on hardware or a cloud service, so real signing needs that
  service's CI step instead. Sign only our own build outputs, never upstream binaries such as
  python.org's Python or PyPI wheels.
- **Pinned build inputs:** python.org's embeddable Python (`PYTHON`, `PYTHON_SHA256` in
  `packaging/windows/build.py`, kept in step with CI's Windows Python by a test) and Inno Setup
  (`INNO_URL`, `INNO_SHA256` in `ci.yml`). A bump needs the new SHA-256 from the official
  download.
