# Privacy policy

desk-tasks is a desktop app with no servers of its own and no telemetry. This page lists every
network connection it makes and everything it keeps on your PC.

## What goes over the network

- **Your Nextcloud.** desk-tasks reads and writes your task lists on the Nextcloud you connect,
  and nowhere else: logging in (Login Flow v2 or an app password), syncing, sharing a list with
  other users of that Nextcloud, and logging out (which asks Nextcloud to revoke the app
  password). What your Nextcloud does with that data is up to its operator.
- **GitHub, for updates.** Twice a day desk-tasks asks `api.github.com` for the latest release of
  desk-tasks. The request carries no cookies, no account and nothing about you or your tasks;
  GitHub sees your IP address and the app's version (in the `User-Agent` header), as with any
  web request. When you click **Update**, the installer is downloaded from GitHub. Settings →
  Updates → "Check for updates automatically" turns the check off. GitHub's privacy statement:
  <https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement>.
- **Links you open.** Links in task notes and "What's new" open in your browser, on your
  request.

Nothing else: no analytics, no crash reports, no other servers.

desk-tasks draws its window with Microsoft Edge WebView2, which is part of Windows. WebView2
sends Microsoft diagnostic data according to your Windows settings (Settings → Privacy &
security → Diagnostics & feedback), as it does for every app that uses it; desk-tasks doesn't
add anything to it.

## What stays on your PC

- The app password in Windows Credential Manager (`desk-tasks`), readable only by your Windows
  account.
- In `%LOCALAPPDATA%\desk-tasks`: `settings.json` (server address, user name, your settings; no
  password), a local copy of your tasks (for offline use), and logs. The logs (at most
  6 × 1 MB) contain no password and no task titles or notes; they do name your server, user name
  and lists, as part of task addresses. Nothing in this folder is sent anywhere.
- The program itself in `%LOCALAPPDATA%\Programs\desk-tasks`.

## Removing it

Uninstall desk-tasks in Windows Settings → Apps and answer **Yes** to removing your settings: it
logs out (Nextcloud is asked to revoke the app password), and deletes the password from
Credential Manager and the folder above. Your tasks in Nextcloud are not touched.

## Contact

Questions or concerns: open an issue at <https://github.com/Mnikley/desk-tasks/issues>, or
report a security problem privately as [SECURITY.md](SECURITY.md) describes.
