// CalDAV client for Nextcloud: discovery, change listing and guarded object writes.
// Requests go through the transport seam (`Send`); hrefs from the server are checked against the
// configured origin and DAV root before anything is sent to them (the bridge checks again).
import {
	type DavMethod,
	type DavResult,
	lossyText,
	type Send,
} from "./transport.ts";
import {
	APPLE,
	CALDAV,
	CS,
	DAV,
	esc,
	kid,
	kids,
	NC,
	OC,
	parseXml,
	type XmlElement,
} from "./xml.ts";

/** Nextcloud answered with an HTTP error. `condition` is the DAV precondition element, if any. */
export class CaldavError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly condition: string | null = null,
	) {
		super(message);
	}
}

/**
 * No answer (network, timeout, gateway). `kind` "connect" means nothing was sent; anything else
 * means a write may or may not have been applied.
 */
export class CaldavUnreachable extends Error {
	constructor(
		message: string,
		readonly kind: "connect" | "network" | "timeout" | "gateway",
	) {
		super(message);
	}
}

/** Someone a list is shared with (from `oc:invite`). */
export interface Sharee {
	/** Exactly as Nextcloud names it, e.g. "principal:principals/users/alice". */
	href: string;
	name: string;
	kind: "user" | "group" | "circle" | "other";
	access: "read" | "read-write";
}

export interface Collection {
	href: string;
	name: string;
	/** "#rrggbb" or null when the server has none. */
	color: string | null;
	order: number;
	ctag: string | null;
	components: string[];
	/** The user may write tasks here (privilege set; `oc:read-only` only as a fallback). */
	writable: boolean;
	/** `oc:owner-principal`, e.g. "principals/users/bob" (null when not reported). */
	owner: string | null;
	/** `nc:owner-displayname`. */
	ownerName: string | null;
	/** Sharees (`oc:invite`); always empty for lists shared with me. */
	sharees: Sharee[];
	/** `cs:allowed-sharing-modes` says the user may share it (owners only). */
	canShare: boolean;
	/** `d:sync-token` (null: the list has none, e.g. a Deck board). */
	syncToken: string | null;
	/** A Deck board or another app-generated list: never writable. */
	appGenerated: boolean;
}

export interface Listed {
	href: string;
	etag: string;
}

export interface Fetched {
	text: string;
	etag: string;
	/** The body isn't valid UTF-8, so it can't be edited without changing bytes. */
	binary: boolean;
}

/** "#RRGGBBAA" (Apple), "#RRGGBB" or anything else → "#rrggbb" or null. */
export function normaliseColor(c: string | null | undefined): string | null {
	const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec((c ?? "").trim());
	return m ? `#${(m[1] ?? "").toLowerCase()}` : null;
}

const PROPFIND_COLLECTIONS = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="${CALDAV}" xmlns:cs="${CS}" xmlns:a="${APPLE}" xmlns:oc="${OC}" xmlns:nc="${NC}">
<d:prop><d:resourcetype/><d:displayname/><c:supported-calendar-component-set/>
<a:calendar-color/><a:calendar-order/><cs:getctag/><d:current-user-privilege-set/>
<oc:owner-principal/><nc:owner-displayname/><oc:read-only/><oc:invite/>
<cs:allowed-sharing-modes/><d:sync-token/><nc:deleted-at/></d:prop>
</d:propfind>`;

const PROPFIND_ETAGS = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:resourcetype/></d:prop></d:propfind>`;

export interface DavResponse {
	href: string;
	/** Status of the response itself (sync-collection deletions), else null. */
	status: number | null;
	/** Properties from 2xx propstats. */
	props: Map<string, XmlElement>;
}

/** An answer; `truncated` when its body was over the cap and isn't there. */
type Answer = Extract<DavResult, { ok: true }> & { truncated?: boolean };

const TOO_LARGE =
	"Nextcloud's answer is larger than expected; it was not read.";

const statusCode = (s: string | undefined) =>
	Number(/HTTP\/[\d.]+\s+(\d{3})/.exec(s ?? "")?.[1] ?? 0) || null;

export function multistatus(xml: string): {
	responses: DavResponse[];
	syncToken: string | null;
} {
	const root = parseXml(xml);
	if (root.ns !== DAV || root.name !== "multistatus")
		throw new CaldavError(
			502,
			"Nextcloud sent an unexpected answer (no multistatus).",
		);
	const responses = kids(root, DAV, "response").map((r) => {
		const props = new Map<string, XmlElement>();
		for (const ps of kids(r, DAV, "propstat")) {
			const code = statusCode(kid(ps, DAV, "status")?.text);
			if (code === null || code < 200 || code > 299) continue;
			for (const p of kid(ps, DAV, "prop")?.children ?? [])
				props.set(`${p.ns}|${p.name}`, p);
		}
		return {
			href: (kid(r, DAV, "href")?.text ?? "").trim(),
			status: statusCode(kid(r, DAV, "status")?.text),
			props,
		};
	});
	const token = kid(root, DAV, "sync-token")?.text.trim() || null;
	return { responses, syncToken: token };
}

export const prop = (r: DavResponse, ns: string, name: string) =>
	r.props.get(`${ns}|${name}`);

/** Decodes an href's path for comparisons; a malformed %-escape is compared as written. */
export function decodedPath(href: string): string {
	const path = new URL(href, "http://x").pathname.replace(/\/+$/, "");
	try {
		return decodeURIComponent(path);
	} catch {
		return path;
	}
}

export class CaldavClient {
	readonly origin: string;
	/** Path of the DAV root, e.g. "/remote.php/dav/" or "/nextcloud/remote.php/dav/". */
	readonly root: string;

	/** `baseUrl` is the Nextcloud address, e.g. https://cloud.example.com or …/nextcloud. */
	constructor(
		baseUrl: string,
		private readonly transport: Send,
	) {
		const u = new URL(baseUrl);
		this.origin = u.origin;
		this.root = `${u.pathname.replace(/\/+$/, "")}/remote.php/dav/`;
	}

	/** Resolves an href from the server; anything off the configured origin or DAV root is refused. */
	url(href: string): string {
		const u = new URL(href, this.origin);
		if (u.origin !== this.origin || !u.pathname.startsWith(this.root))
			throw new CaldavError(
				400,
				`Nextcloud pointed at a location outside its DAV root (${u.pathname}); refusing to follow it.`,
			);
		return u.toString();
	}

	/** Sends to an href the server gave us (checked against the DAV root first). */
	send(
		method: DavMethod,
		href: string,
		opts: { headers?: Record<string, string>; body?: string } = {},
	): Promise<Answer> {
		return this.sendTo(method, this.url(href), opts);
	}

	/** Only ever called with URLs on the configured origin; the transport adds the credentials. */
	private async sendTo(
		method: DavMethod,
		url: string,
		opts: { headers?: Record<string, string>; body?: string } = {},
	): Promise<Answer> {
		if (new URL(url).origin !== this.origin)
			throw new Error(
				"Broken invariant: a Nextcloud request to another origin.",
			);
		const res = await this.transport({
			method,
			url,
			headers: opts.headers ?? {},
			...(opts.body === undefined ? {} : { body: opts.body }),
		});
		if (res.ok) return res;
		// The status is known; only the body is missing (callers that need it check `truncated`).
		if (res.kind === "too-large")
			return {
				ok: true,
				status: res.status,
				headers: res.headers,
				body: "",
				notUtf8: false,
				truncated: true,
			};
		if (res.kind === "refused")
			throw new CaldavError(
				400,
				`desk-tasks refused to send this request (${res.message}).`,
			);
		throw new CaldavUnreachable(
			`Couldn't reach Nextcloud at ${this.origin} (${res.message}).`,
			res.kind,
		);
	}

	/** Turns an error answer into a CaldavError with Nextcloud's own message. */
	fail(res: Answer, what: string): never {
		if (res.status >= 300 && res.status < 400)
			throw new CaldavError(
				res.status,
				`Nextcloud redirected the ${what} to ${res.headers.location ?? "another address"}. Use the address you open Nextcloud with.`,
			);
		if (res.status === 502 || res.status === 503 || res.status === 504)
			throw new CaldavUnreachable(
				`Nextcloud (or a proxy in front of it) answered ${res.status} during the ${what}.`,
				"gateway",
			);
		let message = "";
		let condition: string | null = null;
		try {
			const root = parseXml(res.body);
			message =
				root.children.find((c) => c.name === "message")?.text.trim() ?? "";
			condition =
				root.children.find((c) => c.ns === DAV || c.ns === CALDAV)?.name ??
				null;
		} catch {
			// Not an XML error body (e.g. an HTML page from a proxy).
		}
		throw new CaldavError(
			res.status,
			message || `Nextcloud answered ${res.status} during the ${what}.`,
			condition,
		);
	}

	async xml(
		method: DavMethod,
		href: string,
		body: string,
		depth: "0" | "1",
		what: string,
	) {
		const res = await this.send(method, href, {
			headers: {
				"Content-Type": "application/xml; charset=utf-8",
				Depth: depth,
			},
			body,
		});
		if (res.status !== 207) return this.fail(res, what);
		if (res.truncated) throw new CaldavError(502, TOO_LARGE);
		return multistatus(res.body);
	}

	/** Nextcloud's version string from the public status endpoint, or null if it isn't there. */
	async version(): Promise<string | null> {
		const base = this.root.slice(0, -"remote.php/dav/".length);
		try {
			const res = await this.sendTo("GET", `${this.origin}${base}status.php`);
			if (res.status < 200 || res.status > 299 || res.truncated) return null;
			const s = JSON.parse(res.body) as { versionstring?: unknown };
			return typeof s.versionstring === "string" ? s.versionstring : null;
		} catch {
			// The version is shown for information only; the DAV calls decide whether we can work.
			return null;
		}
	}

	/** The signed-in user's principal href. */
	async principal(): Promise<string> {
		const p = await this.xml(
			"PROPFIND",
			this.root,
			`<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`,
			"0",
			"sign-in",
		);
		const principal = kid(
			prop(
				p.responses[0] ?? { href: "", status: null, props: new Map() },
				DAV,
				"current-user-principal",
			),
			DAV,
			"href",
		)?.text.trim();
		if (!principal)
			throw new CaldavError(
				502,
				"Nextcloud didn't name the signed-in user. Use the address you open Nextcloud with.",
			);
		this.url(principal);
		return principal;
	}

	/** principal → calendar home → collections that are calendars. */
	async discover(): Promise<{
		principal: string;
		home: string;
		collections: Collection[];
	}> {
		const principal = await this.principal();
		const h = await this.xml(
			"PROPFIND",
			principal,
			`<d:propfind xmlns:d="DAV:" xmlns:c="${CALDAV}"><d:prop><c:calendar-home-set/></d:prop></d:propfind>`,
			"0",
			"calendar lookup",
		);
		const home = kid(
			prop(
				h.responses[0] ?? { href: "", status: null, props: new Map() },
				CALDAV,
				"calendar-home-set",
			),
			DAV,
			"href",
		)?.text.trim();
		if (!home)
			throw new CaldavError(
				502,
				"This Nextcloud account has no calendar home.",
			);
		this.url(home);
		return { principal, home, collections: await this.collections(home) };
	}

	async collections(home: string): Promise<Collection[]> {
		const ms = await this.xml(
			"PROPFIND",
			home,
			PROPFIND_COLLECTIONS,
			"1",
			"calendar listing",
		);
		const out: Collection[] = [];
		for (const r of ms.responses) {
			const types = prop(r, DAV, "resourcetype")?.children ?? [];
			// Inbox, outbox, the trash bin, subscriptions and trashed lists aren't calendars.
			if (!types.some((t) => t.ns === CALDAV && t.name === "calendar"))
				continue;
			this.url(r.href);
			const privilegeSet = prop(r, DAV, "current-user-privilege-set");
			const privileges = (privilegeSet?.children ?? [])
				.flatMap((p) => p.children)
				.map((p) => `${p.ns}|${p.name}`);
			const components = kids(
				prop(r, CALDAV, "supported-calendar-component-set"),
				CALDAV,
				"comp",
			)
				.map((c) => attrName(c))
				.filter(Boolean);
			const appGenerated =
				decodedPath(r.href).split("/").pop()?.startsWith("app-generated--") ===
				true;
			const readOnlyFlag = prop(r, OC, "read-only")?.text.trim();
			const writable =
				!appGenerated &&
				(privilegeSet
					? privileges.includes(`${DAV}|write`) ||
						privileges.includes(`${DAV}|write-content`) ||
						privileges.includes(`${DAV}|all`)
					: !(readOnlyFlag === "1" || readOnlyFlag === "true"));
			out.push({
				href: r.href,
				name:
					prop(r, DAV, "displayname")?.text.trim() ||
					decodedPath(r.href).split("/").pop() ||
					"Calendar",
				color: normaliseColor(prop(r, APPLE, "calendar-color")?.text),
				order: Number(prop(r, APPLE, "calendar-order")?.text.trim()) || 0,
				ctag: prop(r, CS, "getctag")?.text.trim() || null,
				// RFC 4791: no component set means every component type.
				components: components.length
					? components
					: ["VEVENT", "VTODO", "VJOURNAL"],
				writable,
				owner:
					principalKey(
						kid(prop(r, OC, "owner-principal"), DAV, "href")?.text ??
							prop(r, OC, "owner-principal")?.text,
					) || null,
				ownerName: prop(r, NC, "owner-displayname")?.text.trim() || null,
				sharees: kids(prop(r, OC, "invite"), OC, "user").map(sharee),
				canShare:
					kids(prop(r, CS, "allowed-sharing-modes"), CS, "can-be-shared")
						.length > 0,
				syncToken: prop(r, DAV, "sync-token")?.text.trim() || null,
				appGenerated,
			});
		}
		return out;
	}

	/** Makes a task list at `href` (RFC 4791 MKCALENDAR, VTODO only). */
	async createList(
		href: string,
		name: string,
		color: string,
		order?: number,
	): Promise<void> {
		const res = await this.send("MKCALENDAR", href, {
			headers: { "Content-Type": "application/xml; charset=utf-8" },
			body: `<?xml version="1.0" encoding="utf-8"?><c:mkcalendar xmlns:d="DAV:" xmlns:c="${CALDAV}" xmlns:a="${APPLE}"><d:set><d:prop><d:displayname>${esc(name)}</d:displayname><a:calendar-color>${esc(color)}</a:calendar-color>${order === undefined ? "" : `<a:calendar-order>${order}</a:calendar-order>`}<c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set></d:prop></d:set></c:mkcalendar>`,
		});
		if (res.status !== 201) this.fail(res, "list creation");
	}

	/** Renames a collection (PROPPATCH of its display name). */
	rename(href: string, name: string): Promise<void> {
		return this.proppatch(href, { name });
	}

	/**
	 * Sets list properties (name, colour, order) with one PROPPATCH. A 207 can still refuse a
	 * property (a 403 propstat): every one must come back in a 2xx propstat.
	 */
	async proppatch(
		href: string,
		p: { name?: string; color?: string; order?: number },
	): Promise<void> {
		const props: [string, string, string][] = [];
		if (p.name !== undefined)
			props.push([
				DAV,
				"displayname",
				`<d:displayname>${esc(p.name)}</d:displayname>`,
			]);
		if (p.color !== undefined)
			props.push([
				APPLE,
				"calendar-color",
				`<a:calendar-color>${esc(p.color)}</a:calendar-color>`,
			]);
		if (p.order !== undefined)
			props.push([
				APPLE,
				"calendar-order",
				`<a:calendar-order>${p.order}</a:calendar-order>`,
			]);
		if (!props.length) return;
		const ms = await this.xml(
			"PROPPATCH",
			href,
			`<?xml version="1.0" encoding="utf-8"?><d:propertyupdate xmlns:d="DAV:" xmlns:a="${APPLE}"><d:set><d:prop>${props.map((x) => x[2]).join("")}</d:prop></d:set></d:propertyupdate>`,
			"0",
			"list change",
		);
		for (const [ns, name] of props)
			if (!ms.responses.some((r) => prop(r, ns, name)))
				throw new CaldavError(
					403,
					"Nextcloud didn't accept the change to this list.",
				);
	}

	/**
	 * Deletes a whole collection. Nextcloud moves an owner's list to the trash; for a list shared
	 * with me it ends my share ("leave"). `forever` skips the trash.
	 */
	async deleteList(
		href: string,
		opts: { forever?: boolean } = {},
	): Promise<void> {
		const res = await this.send("DELETE", href, {
			headers: opts.forever ? { "X-NC-CalDAV-No-Trashbin": "1" } : {},
		});
		if (res.status < 200 || res.status > 299) this.fail(res, "list deletion");
	}

	// ---------- trash bin ----------

	/** How long Nextcloud keeps deleted items, in seconds (null if it doesn't say). */
	async trashRetention(home: string): Promise<number | null> {
		const ms = await this.xml(
			"PROPFIND",
			`${home.replace(/\/*$/, "/")}trashbin/`,
			`<d:propfind xmlns:d="DAV:" xmlns:nc="${NC}"><d:prop><nc:trash-bin-retention-duration/></d:prop></d:propfind>`,
			"0",
			"trash listing",
		);
		const v = Number(
			prop(
				ms.responses[0] ?? { href: "", status: null, props: new Map() },
				NC,
				"trash-bin-retention-duration",
			)?.text.trim(),
		);
		return Number.isFinite(v) && v > 0 ? v : null;
	}

	/** Lists in the trash (they stay in the home, typed nc:deleted-calendar). */
	async deletedLists(home: string): Promise<
		{
			href: string;
			name: string;
			color: string | null;
			deletedAt: string | null;
		}[]
	> {
		const ms = await this.xml(
			"PROPFIND",
			home,
			`<d:propfind xmlns:d="DAV:" xmlns:nc="${NC}" xmlns:a="${APPLE}" xmlns:c="${CALDAV}"><d:prop><d:resourcetype/><d:displayname/><a:calendar-color/><nc:deleted-at/><c:supported-calendar-component-set/></d:prop></d:propfind>`,
			"1",
			"trash listing",
		);
		return ms.responses.flatMap((r) => {
			const types = prop(r, DAV, "resourcetype")?.children ?? [];
			if (!types.some((t) => t.ns === NC && t.name === "deleted-calendar"))
				return [];
			const comps = kids(
				prop(r, CALDAV, "supported-calendar-component-set"),
				CALDAV,
				"comp",
			).map(attrName);
			if (comps.length && !comps.includes("VTODO")) return [];
			this.url(r.href);
			return [
				{
					href: r.href,
					name:
						prop(r, DAV, "displayname")?.text.trim() ||
						decodedPath(r.href).split("/").pop() ||
						"List",
					color: normaliseColor(prop(r, APPLE, "calendar-color")?.text),
					deletedAt: prop(r, NC, "deleted-at")?.text.trim() || null,
				},
			];
		});
	}

	/**
	 * Tasks in the trash. Their text comes from REPORT calendar-data, which loses "\r": it is only
	 * shown, never written (restoring is a MOVE of the stored object).
	 */
	async deletedTasks(home: string): Promise<
		{
			href: string;
			text: string;
			deletedAt: string | null;
			calendarUri: string | null;
		}[]
	> {
		const objects = `${home.replace(/\/*$/, "/")}trashbin/objects/`;
		const ms = await this.xml(
			"REPORT",
			objects,
			`<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="${CALDAV}" xmlns:nc="${NC}"><d:prop><d:getetag/><c:calendar-data/><nc:deleted-at/><nc:calendar-uri/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VTODO"/></c:comp-filter></c:filter></c:calendar-query>`,
			"1",
			"trash listing",
		);
		return ms.responses.flatMap((r) => {
			if (sameHref(r.href, objects)) return [];
			this.member(objects, r.href);
			return [
				{
					href: r.href,
					text: prop(r, CALDAV, "calendar-data")?.text ?? "",
					deletedAt: prop(r, NC, "deleted-at")?.text.trim() || null,
					calendarUri: prop(r, NC, "calendar-uri")?.text.trim() || null,
				},
			];
		});
	}

	/** Restores a list or task from the trash (MOVE to trashbin/restore/…, as the Tasks app does). */
	async restore(href: string, home: string): Promise<void> {
		const res = await this.send("MOVE", href, {
			headers: {
				Destination: this.url(
					`${home.replace(/\/*$/, "/")}trashbin/restore/file`,
				),
			},
		});
		if (res.status < 200 || res.status > 299) this.fail(res, "restore");
	}

	/** Deletes a trashed task for good. */
	async deleteForever(href: string): Promise<void> {
		const res = await this.send("DELETE", href, {
			headers: { "X-NC-CalDAV-No-Trashbin": "1" },
		});
		if (res.status < 200 || res.status > 299) this.fail(res, "delete");
	}

	/**
	 * RFC 6578 changes since `token` (null = everything). Throws CaldavError with condition
	 * "valid-sync-token" when the server no longer knows the token. Never sends <d:limit>.
	 */
	async changes(
		collection: string,
		token: string | null,
	): Promise<{ token: string | null; changed: Listed[]; deleted: string[] }> {
		const ms = await this.xml(
			"REPORT",
			collection,
			`<?xml version="1.0" encoding="utf-8"?><d:sync-collection xmlns:d="DAV:"><d:sync-token>${esc(token ?? "")}</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>`,
			"1",
			"change listing",
		);
		const changed: Listed[] = [];
		const deleted: string[] = [];
		for (const r of ms.responses) {
			if (r.href === "" || sameHref(r.href, collection)) continue;
			this.member(collection, r.href);
			if (r.status === 404) deleted.push(r.href);
			else changed.push({ href: r.href, etag: this.etagOf(r) });
		}
		return { token: ms.syncToken, changed, deleted };
	}

	/** Every member with its ETag (Depth:1 PROPFIND): the reconcile and the fallback listing. */
	async list(collection: string): Promise<Listed[]> {
		const ms = await this.xml(
			"PROPFIND",
			collection,
			PROPFIND_ETAGS,
			"1",
			"task listing",
		);
		const out: Listed[] = [];
		for (const r of ms.responses) {
			if (sameHref(r.href, collection)) continue;
			const isCollection =
				(prop(r, DAV, "resourcetype")?.children ?? []).length > 0;
			if (isCollection) continue;
			this.member(collection, r.href);
			out.push({ href: r.href, etag: this.etagOf(r) });
		}
		return out;
	}

	/** The ETag of one object, or null if it doesn't exist. */
	async etag(href: string): Promise<string | null> {
		const res = await this.send("PROPFIND", href, {
			headers: { "Content-Type": "application/xml; charset=utf-8", Depth: "0" },
			body: PROPFIND_ETAGS,
		});
		if (res.status === 404) return null;
		if (res.status !== 207) this.fail(res, "check");
		if (res.truncated) throw new CaldavError(502, TOO_LARGE);
		const r = multistatus(res.body).responses[0];
		if (!r) throw new CaldavError(502, `Nextcloud gave no answer for ${href}.`);
		return this.etagOf(r);
	}

	/** Every object has an ETag; without one nothing could be written safely. */
	private etagOf(r: DavResponse): string {
		const etag = prop(r, DAV, "getetag")?.text.trim();
		if (!etag)
			throw new CaldavError(
				502,
				`Nextcloud listed ${r.href} without an ETag, so it can't be synced safely.`,
			);
		return etag;
	}

	/** Refuses members that aren't directly inside the collection they were listed for. */
	member(collection: string, href: string): void {
		this.url(href);
		if (!memberOf(collection, href))
			throw new CaldavError(
				502,
				`Nextcloud listed ${href} as part of ${collection}; refusing it.`,
			);
	}

	/** Exact bytes of an object (GET; REPORT bodies lose "\r"). null when it doesn't exist. */
	async get(href: string): Promise<Fetched | null> {
		const res = await this.send("GET", href, {
			headers: { Accept: "text/calendar" },
		});
		if (res.status === 404 || res.status === 410) return null;
		if (res.status < 200 || res.status > 299) this.fail(res, "download");
		if (res.truncated)
			throw new CaldavError(
				413,
				"A task in Nextcloud is larger than 12 MB; it is skipped.",
			);
		const etag = res.headers.etag;
		if (!etag)
			throw new CaldavError(502, "Nextcloud sent a task without an ETag.");
		// The bridge decodes strict UTF-8 and keeps a byte-order mark, so writing it back keeps
		// every byte; anything else comes as base64 and the task stays read-only.
		return res.notUtf8
			? { text: lossyText(res.body), etag, binary: true }
			: { text: res.body, etag, binary: false };
	}

	/** Creates (`ifNoneMatch`) or replaces (`ifMatch`) an object. Returns the new ETag if sent. */
	async put(
		href: string,
		text: string,
		cond: { ifMatch: string } | { ifNoneMatch: "*" },
	): Promise<string | null> {
		const res = await this.send("PUT", href, {
			headers: {
				"Content-Type": "text/calendar; charset=utf-8",
				...("ifMatch" in cond
					? { "If-Match": cond.ifMatch }
					: { "If-None-Match": "*" }),
			},
			body: text,
		});
		if (res.status < 200 || res.status > 299) this.fail(res, "save");
		return res.headers.etag ?? null;
	}

	async delete(href: string, ifMatch: string): Promise<void> {
		const res = await this.send("DELETE", href, {
			headers: { "If-Match": ifMatch },
		});
		if (res.status < 200 || res.status > 299) this.fail(res, "delete");
	}

	/** Moves an object to `destination` (same server) without overwriting anything there. */
	async move(
		href: string,
		destination: string,
		ifMatch: string,
	): Promise<void> {
		const res = await this.send("MOVE", href, {
			headers: {
				Destination: this.url(destination),
				Overwrite: "F",
				"If-Match": ifMatch,
			},
		});
		if (res.status < 200 || res.status > 299) this.fail(res, "move");
	}
}

const attrName = (el: XmlElement) => (el.attrs.name ?? "").toUpperCase();

/**
 * A principal in the form Nextcloud's `oc:owner-principal` uses ("principals/users/bob"), from
 * either that or a principal href ("/remote.php/dav/principals/users/bob/").
 */
export function principalKey(p: string | null | undefined): string {
	const path = (p ?? "").trim().replace(/^principal:/, "");
	const at = path.indexOf("principals/");
	return (at === -1 ? path : path.slice(at)).replace(/\/+$/, "");
}

function sharee(el: XmlElement): Sharee {
	const href = kid(el, DAV, "href")?.text.trim() ?? "";
	const key = principalKey(href);
	const kind = key.startsWith("principals/users/")
		? "user"
		: key.startsWith("principals/groups/")
			? "group"
			: key.startsWith("principals/circles/")
				? "circle"
				: "other";
	const access = kid(kid(el, OC, "access"), OC, "read-write")
		? "read-write"
		: "read";
	let fallback = key.split("/").pop() ?? href;
	try {
		fallback = decodeURIComponent(fallback);
	} catch {
		// A malformed %-escape: show it as written.
	}
	return {
		href,
		name: kid(el, OC, "common-name")?.text.trim() || fallback,
		kind,
		access,
	};
}

export const sameHref = (a: string, b: string) =>
	decodedPath(a) === decodedPath(b);

/** A member must live directly in the collection it was listed for. */
function memberOf(collection: string, href: string): boolean {
	const dir = decodedPath(collection);
	const p = decodedPath(href);
	return p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes("/");
}
