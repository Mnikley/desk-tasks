# Security

## Reporting a vulnerability

Please report security problems privately through GitHub: the repository's **Security** tab →
**Report a vulnerability**. Don't open a public issue for them. You'll get an answer within a
week. Fixes go into the next build on `main`; there are no older release lines to patch.

Useful in a report: what an attacker needs (a malicious Nextcloud server, a malicious task or
list shared with you, local access, …), what they get, and steps to reproduce.

## Design

desk-tasks keeps one secret, the Nextcloud app password. It talks to your Nextcloud, and to
GitHub for updates.

- **The password never reaches the web view.** It is stored in Windows Credential Manager
  (service `desk-tasks`) and read only by the Python bridge, which adds it to each request.
  `settings.json` holds the server address and user name, no secrets.
- **One door to the network.** The UI (HTML/JS in WebView2) can't open connections itself:
  its Content-Security-Policy has `connect-src 'none'` and allows no inline scripts. (It does
  allow `'unsafe-eval'`: pywebview builds the page's bridge functions with `new Function`.) It asks the Python
  function `dav()` instead, which refuses before any socket opens unless the request is
  - an allowed WebDAV/CalDAV method on the configured server's origin, under
    `<base>/remote.php/dav/` (plus `GET /status.php`), `Destination` headers included;
  - https (plain http only for loopback addresses, used by the tests);
  - within size limits (12 MB per task, 16 MB per listing).
  It follows no redirects, drops `Authorization`/`Cookie` headers coming from the UI, and times
  out after 30 seconds.
- **Login Flow v2** opens the login page and polls only on the origin you entered; a server that
  answers with other hosts is refused. Logging out asks Nextcloud to revoke the app password
  and says so if it couldn't (the local copy is deleted either way).
- **The window shows only the bundled app.** The UI is loaded from a WebView2 virtual host
  mapped to the installed files; navigation anywhere else is cancelled, `window.open` never
  opens a window, and links from task notes open in your browser only for `https:`, `http:` and
  `mailto:`. Only the bridge calls the UI needs are exposed to it.
- **Updates come only from this repository's releases.** Python (never the web view) asks
  `api.github.com` for the latest release, at most twice a day and only while "Check for
  updates" is on; the request carries no cookies, no credentials and nothing about your tasks.
  A release is offered only with a plain `vX.Y.Z` tag and pages and download links under
  `github.com/Mnikley/desk-tasks/releases/`; the download may be redirected only to GitHub's
  own hosts, and the installer runs only if its size and SHA-256 match what GitHub lists for
  it. Copies not installed by the installer are only told about a new version.
- **The installer** installs per user without administrator rights. It carries python.org's
  signed embeddable Python and the dependencies pinned with hashes in `uv.lock`; the build
  pins the Python package and Inno Setup by SHA-256. The installer itself isn't code-signed
  (CI signs it when a certificate is configured).
- **Task text is untrusted input.** It comes from your server and from anyone who shares a list
  with you. It is rendered as text (never as HTML), and iCalendar edits are made in place on
  the parsed structure.
- **Logs** never contain the password, the `Authorization` header, or task titles and notes at
  the default level. They do contain the server address and task and list addresses (which
  include the user name and list names).

## Out of scope

- Someone with access to your Windows account: they can read Credential Manager, like any app
  running as you.
- The security of your Nextcloud server and of the other apps that edit the same tasks.
