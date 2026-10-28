// Drives a throwaway Nextcloud (web/test/nextcloud/compose.yaml): creates the test users, an app
// password and calendars, and plays "another client" editing tasks. Only ever pointed at the
// local test container (never at a real server).

export const NEXTCLOUD_URL =
	process.env.NEXTCLOUD_URL ?? "http://127.0.0.1:18012";
const CONTAINER =
	process.env.NEXTCLOUD_CONTAINER ?? "desk-tasks-nextcloud-test-nextcloud-1";
export const USER = { name: "tester", password: "tester-password-123" };
/** Other users for sharing; tester and alice are in the group "team". */
export const ALICE = { name: "alice", password: "alice-password-123" };
export const BOB = { name: "bob", password: "bob-password-1234" };
export const GROUP = "team";

function occ(...args: string[]): string {
	return occWith(USER.password, ...args);
}

function occWith(password: string, ...args: string[]): string {
	const p = Bun.spawnSync([
		"docker",
		"exec",
		"-u",
		"www-data",
		"-e",
		`OC_PASS=${password}`,
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
	occ(
		"config:app:set",
		"dav",
		"rateLimitShareAddressbookOrCalendar",
		"--value=10000",
		"--type=integer",
	);
	for (const [u, display] of [
		[USER, "Tester"],
		[ALICE, "Alice"],
		[BOB, "Bob"],
	] as const) {
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
				u.name,
			]).exitCode === 0;
		if (!exists)
			occWith(
				u.password,
				"user:add",
				"--password-from-env",
				"--display-name",
				display,
				u.name,
			);
	}
	const groups = occ("group:list", "--output=json");
	if (!groups.includes(`"${GROUP}"`)) occ("group:add", GROUP);
	occ("group:adduser", GROUP, ALICE.name);
	occ("group:adduser", GROUP, USER.name);
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

const basic = (password: string, user = USER.name) =>
	`Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

export type TestUser = { name: string; password: string };

/** Raw DAV request as another user (account password). */
export function davAs(
	who: TestUser,
	method: string,
	path: string,
	opts: { body?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
	return fetch(`${NEXTCLOUD_URL}${path}`, {
		method,
		body: opts.body,
		headers: { Authorization: basic(who.password, who.name), ...opts.headers },
	});
}

/** A VTODO list owned by `who`; returns its href. */
export async function mkcalendarAs(
	who: TestUser,
	slug: string,
	name: string,
): Promise<string> {
	const href = `/remote.php/dav/calendars/${who.name}/${slug}/`;
	const res = await davAs(who, "MKCALENDAR", href, {
		headers: { "content-type": "application/xml" },
		body: `<c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:set><d:prop><d:displayname>${name}</d:displayname><c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set></d:prop></d:set></c:mkcalendar>`,
	});
	if (res.status !== 201)
		throw new Error(`MKCALENDAR ${slug}: ${res.status} ${await res.text()}`);
	return href;
}

/** Shares `href` (owned by `who`) over DAV: `<o:share>` with set/remove elements. */
export async function shareAs(
	who: TestUser,
	href: string,
	sets: { principal: string; readWrite?: boolean }[],
	removes: string[] = [],
): Promise<void> {
	const body = `<o:share xmlns:d="DAV:" xmlns:o="http://owncloud.org/ns">${sets
		.map(
			(s) =>
				`<o:set><d:href>principal:${s.principal}</d:href>${s.readWrite ? "<o:read-write/>" : ""}</o:set>`,
		)
		.join("")}${removes
		.map((r) => `<o:remove><d:href>principal:${r}</d:href></o:remove>`)
		.join("")}</o:share>`;
	const res = await davAs(who, "POST", href, {
		headers: { "content-type": "application/xml" },
		body,
	});
	if (res.status !== 200)
		throw new Error(`share ${href}: ${res.status} ${await res.text()}`);
}

/** PUT as another user (If-None-Match: *). */
export async function putAs(
	who: TestUser,
	href: string,
	text: string,
): Promise<void> {
	const res = await davAs(who, "PUT", href, {
		body: text,
		headers: { "content-type": "text/calendar", "If-None-Match": "*" },
	});
	if (res.status !== 201)
		throw new Error(`PUT ${href}: ${res.status} ${await res.text()}`);
}

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
