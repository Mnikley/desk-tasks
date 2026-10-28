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

export interface Collection {
	href: string;
	name: string;
	/** "#rrggbb" or null when the server has none. */
	color: string | null;
	order: number;
	ctag: string | null;
	components: string[];
	writable: boolean;
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
<d:propfind xmlns:d="DAV:" xmlns:c="${CALDAV}" xmlns:cs="${CS}" xmlns:a="${APPLE}">
<d:prop><d:resourcetype/><d:displayname/><c:supported-calendar-component-set/>
<a:calendar-color/><a:calendar-order/><cs:getctag/><d:current-user-privilege-set/></d:prop>
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

type Answer = Extract<DavResult, { ok: true }>;

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
				502,
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
		if (res.kind === "too-large")
			throw new CaldavError(
				413,
				"Nextcloud's answer is larger than expected; it was not read.",
			);
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
		return multistatus(res.body);
	}

	/** Nextcloud's version string from the public status endpoint, or null if it isn't there. */
	async version(): Promise<string | null> {
		const base = this.root.slice(0, -"remote.php/dav/".length);
		const res = await this.sendTo("GET", `${this.origin}${base}status.php`);
		if (res.status < 200 || res.status > 299) return null;
		try {
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
			if (!types.some((t) => t.ns === CALDAV && t.name === "calendar"))
				continue;
			this.url(r.href);
			const privileges = (
				prop(r, DAV, "current-user-privilege-set")?.children ?? []
			)
				.flatMap((p) => p.children)
				.map((p) => `${p.ns}|${p.name}`);
			const components = kids(
				prop(r, CALDAV, "supported-calendar-component-set"),
				CALDAV,
				"comp",
			)
				.map((c) => attrName(c))
				.filter(Boolean);
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
				writable:
					privileges.includes(`${DAV}|write`) ||
					privileges.includes(`${DAV}|write-content`) ||
					privileges.includes(`${DAV}|all`),
			});
		}
		return out;
	}

	/** Makes a task list at `href` (RFC 4791 MKCALENDAR, VTODO only). */
	async createList(href: string, name: string, color: string): Promise<void> {
		const res = await this.send("MKCALENDAR", href, {
			headers: { "Content-Type": "application/xml; charset=utf-8" },
			body: `<?xml version="1.0" encoding="utf-8"?><c:mkcalendar xmlns:d="DAV:" xmlns:c="${CALDAV}" xmlns:a="${APPLE}"><d:set><d:prop><d:displayname>${esc(name)}</d:displayname><a:calendar-color>${esc(color)}</a:calendar-color><c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set></d:prop></d:set></c:mkcalendar>`,
		});
		if (res.status !== 201) this.fail(res, "list creation");
	}

	/** Renames a collection (PROPPATCH of its display name). */
	async rename(href: string, name: string): Promise<void> {
		const ms = await this.xml(
			"PROPPATCH",
			href,
			`<?xml version="1.0" encoding="utf-8"?><d:propertyupdate xmlns:d="DAV:"><d:set><d:prop><d:displayname>${esc(name)}</d:displayname></d:prop></d:set></d:propertyupdate>`,
			"0",
			"rename",
		);
		// A 207 can still refuse the property itself (a 403 propstat).
		if (!ms.responses.some((r) => prop(r, DAV, "displayname")))
			throw new CaldavError(403, "Nextcloud didn't accept the new name.");
	}

	/** Deletes a whole collection with everything in it. */
	async deleteList(href: string): Promise<void> {
		const res = await this.send("DELETE", href);
		if (res.status < 200 || res.status > 299) this.fail(res, "list deletion");
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
	private member(collection: string, href: string): void {
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

export const sameHref = (a: string, b: string) =>
	decodedPath(a) === decodedPath(b);

/** A member must live directly in the collection it was listed for. */
function memberOf(collection: string, href: string): boolean {
	const dir = decodedPath(collection);
	const p = decodedPath(href);
	return p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes("/");
}
