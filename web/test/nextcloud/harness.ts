// Drives a throwaway Nextcloud (web/test/nextcloud/compose.yaml): creates the test users, an app
// password and calendars, and plays "another client" editing tasks. Only ever pointed at the
// local test container (never at a real server).

export const NEXTCLOUD_URL =
	process.env.NEXTCLOUD_URL ?? "http://127.0.0.1:18012";
const CONTAINER =
	process.env.NEXTCLOUD_CONTAINER ?? "desk-tasks-nextcloud-test-nextcloud-1";
export const USER = { name: "tester", password: "tester-password-123" };

function occ(...args: string[]): string {
	const p = Bun.spawnSync([
		"docker",
		"exec",
		"-u",
		"www-data",
		"-e",
		`OC_PASS=${USER.password}`,
		CONTAINER,
		"php",
		"occ",
		...args,
	]);
	if (p.exitCode !== 0)
		throw new Error(
			`occ ${args.join(" ")} failed: ${p.stderr.toString()}${p.stdout.toString()}`,
		);
	return p.stdout.toString();
}

async function waitForNextcloud(timeoutMs = 300_000): Promise<string> {
	const until = Date.now() + timeoutMs;
	while (Date.now() < until) {
		try {
			const res = await fetch(`${NEXTCLOUD_URL}/status.php`);
			const s = (await res.json()) as {
				installed?: boolean;
				versionstring?: string;
			};
			if (s.installed) return s.versionstring ?? "?";
		} catch {
			// not up yet
		}
		await Bun.sleep(2000);
	}
	throw new Error(`Nextcloud at ${NEXTCLOUD_URL} did not finish installing`);
}

export interface NextcloudEnv {
	url: string;
	version: string;
	appPassword: string;
}

export async function prepare(): Promise<NextcloudEnv> {
	const version = await waitForNextcloud();
	occ(
		"config:system:set",
		"auth.bruteforce.protection.enabled",
		"--value=false",
		"--type=boolean",
	);
	occ(
		"config:app:set",
		"dav",
		"rateLimitCalendarCreation",
		"--value=1000",
		"--type=integer",
	);
	occ(
		"config:app:set",
		"dav",
		"maximumCalendarsSubscriptions",
		"--value=-1",
		"--type=integer",
	);
	const exists =
		Bun.spawnSync([
			"docker",
			"exec",
			"-u",
			"www-data",
			CONTAINER,
			"php",
			"occ",
			"user:info",
			USER.name,
		]).exitCode === 0;
	if (!exists) occ("user:add", "--password-from-env", USER.name);
	const res = await fetch(
		`${NEXTCLOUD_URL}/ocs/v2.php/core/getapppassword?format=json`,
		{
			headers: {
				Authorization: basic(USER.password),
				"OCS-APIRequest": "true",
			},
		},
	);
	const body = (await res.json()) as {
		ocs?: { data?: { apppassword?: string } };
	};
	const appPassword = body.ocs?.data?.apppassword;
	if (!appPassword) throw new Error(`No app password: HTTP ${res.status}`);
	return { url: NEXTCLOUD_URL, version, appPassword };
}

const basic = (password: string) =>
	`Basic ${Buffer.from(`${USER.name}:${password}`).toString("base64")}`;

export const CAL_HOME = `/remote.php/dav/calendars/${USER.name}/`;

/** Raw DAV request as the test user (with the account password: "another device"). */
export async function dav(
	method: string,
	path: string,
	opts: { body?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
	return fetch(`${NEXTCLOUD_URL}${path}`, {
		method,
		body: opts.body,
		headers: { Authorization: basic(USER.password), ...opts.headers },
	});
}

export async function mkcalendar(
	slug: string,
	name: string,
	components: string[],
	color = "#0082C9",
): Promise<string> {
	const href = `${CAL_HOME}${slug}/`;
	const res = await dav("MKCALENDAR", href, {
		headers: { "content-type": "application/xml" },
		body: `<c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/"><d:set><d:prop><d:displayname>${name}</d:displayname><a:calendar-color>${color}FF</a:calendar-color><c:supported-calendar-component-set>${components.map((c) => `<c:comp name="${c}"/>`).join("")}</c:supported-calendar-component-set></d:prop></d:set></c:mkcalendar>`,
	});
	if (res.status !== 201)
		throw new Error(`MKCALENDAR ${slug}: ${res.status} ${await res.text()}`);
	return href;
}

/** PUT as another client; returns the new ETag. */
export async function putObject(
	href: string,
	text: string,
	ifMatch?: string,
): Promise<string> {
	const res = await dav("PUT", href, {
		body: text,
		headers: {
			"content-type": "text/calendar",
			...(ifMatch ? { "If-Match": ifMatch } : { "If-None-Match": "*" }),
		},
	});
	if (res.status !== 201 && res.status !== 204)
		throw new Error(`PUT ${href}: ${res.status} ${await res.text()}`);
	return res.headers.get("etag") ?? "";
}

/** Exact stored bytes and ETag, or null. */
export async function getObject(
	href: string,
): Promise<{ text: string; etag: string } | null> {
	const res = await dav("GET", href);
	if (res.status === 404) return null;
	if (!res.ok) throw new Error(`GET ${href}: ${res.status}`);
	return { text: await res.text(), etag: res.headers.get("etag") ?? "" };
}

export async function deleteObject(href: string): Promise<void> {
	const res = await dav("DELETE", href);
	if (res.status !== 204) throw new Error(`DELETE ${href}: ${res.status}`);
}
