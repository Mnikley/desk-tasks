# Changelog

## 0.2.0

- **Installer:** `desk-tasks-setup.exe` installs desk-tasks for your Windows account in one
  step, with no administrator rights and nothing else to install first (it brings python.org's
  signed Python with it). Start menu entry; uninstall from Windows Settings → Apps, optionally
  with your settings and a log-out.
- **Updates in the app:** desk-tasks checks GitHub for a new release twice a day (Settings →
  Updates turns that off). A new version shows as a banner: **Update** downloads it, checks
  it, restarts desk-tasks into it and says "Updated to …". Changes waiting to be saved are
  saved first; an update that fails leaves the old version running and says so.
- Started from the Start menu, desk-tasks comes to the front; started with Windows, it stays on
  the desktop as before.

## 0.1.0 (the first "latest build")

First version.

- Widget on the Windows desktop layer: visible on Show desktop, no taskbar button; Win+Alt+J to
  summon, Win+Alt+N for quick add (both configurable).
- Nextcloud tasks over CalDAV: Login Flow v2 or app password; sync with confirmed deletions and
  a periodic full reconcile; verified writes; in-place iCalendar edits that keep other apps'
  properties.
- Views Today, Upcoming, All, lists and Trash; subtasks, manual order with drag and drop,
  repeating tasks, reminders as Windows notifications with Done and Snooze, list sharing.
- Quick add grammar in English and German; keyboard map with a command palette; Undo for every
  change.
- Light, dark and high-contrast themes; screen-reader support.
