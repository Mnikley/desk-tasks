// A small in-memory CalDAV server with Nextcloud's observable behaviour (ETag = md5 of the
// body, If-Match/If-None-Match, sync-collection with numbered tokens, MOVE), plus switches for
// the awkward cases a real server only produces sometimes. Tests drive the app against it.
import { createHash } from "node:crypto";

export const HOME = "/remote.php/dav/calendars/u/";
const PRINCIPAL = "/remote.php/dav/principals/users/u/";

interface Collection {
	name: string;
	components: string[];
	color: string;
	writable: boolean;
	objects: Map<string, string>;
	changes: { token: number; href: string }[];
}

const md5 = (s: string) => `"${createHash("md5").update(s).digest("hex")}"`;
const ms = (body: string, extra = "") =>
	new Response(
		`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:a="http://apple.com/ns/ical/">${body}${extra}</d:multistatus>`,
		{ status: 207, headers: { "content-type": "application/xml" } },
	);
const ok = (href: string, props: string) =>
	`<d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
const gone = (href: string) =>
	`<d:response><d:href>${href}</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>`;
const davError = (status: number, condition: string, message: string) =>
	new Response(
		`<?xml version="1.0"?><d:error xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns"><d:${condition}/><s:message>${message}</s:message></d:error>`,
		{ status },
	);

export class FakeCaldav {
	readonly collections = new Map<string, Collection>();
	private token = 1;
	/** Every request as "METHOD path". */
	readonly log: string[] = [];
	/** sync-collection answers 501 (servers without RFC 6578). */
	noSyncCollection = false;
	/** sync-collection reports nothing new (a pruned or reset token). */
	silentSync = false;
	/** sync-collection also reports these live hrefs as deleted (Nextcloud's MAX(operation) quirk). */
	misreportDeleted = new Set<string>();
	/** Runs before a request is handled; may answer instead. */
	before:
		| ((req: Request, path: string) => Promise<Response | undefined>)
		| null = null;
	private server: ReturnType<typeof Bun.serve>;
	readonly url: string;

	constructor() {
		this.server = Bun.serve({ port: 0, fetch: (req) => this.handle(req) });
		this.url = `http://localhost:${this.server.port}`;
	}

	stop(): void {
		this.server.stop(true);
	}

	addList(
		slug: string,
		name: string,
		components = ["VTODO"],
		writable = true,
	): string {
		const href = `${HOME}${slug}/`;
		this.collections.set(href, {
			name,
			components,
			color: "#0F8B8DFF",
			writable,
			objects: new Map(),
			changes: [],
		});
		return href;
	}

	private touch(list: Collection, href: string) {
		list.changes.push({ token: ++this.token, href });
	}

	private listOf(href: string): Collection | undefined {
		return this.collections.get(href.slice(0, href.lastIndexOf("/") + 1));
	}

	/** Another client writes (no preconditions). */
	put(href: string, text: string): string {
		const list = this.listOf(href);
		if (!list) throw new Error(`no list for ${href}`);
		list.objects.set(href, text);
		this.touch(list, href);
		return md5(text);
	}

	edit(href: string, f: (text: string) => string): void {
		const text = this.get(href);
		if (text === undefined) throw new Error(`no object ${href}`);
		this.put(href, f(text));
	}

	remove(href: string): void {
		const list = this.listOf(href);
		list?.objects.delete(href);
		if (list) this.touch(list, href);
	}

	get(href: string): string | undefined {
		return this.listOf(href)?.objects.get(href);
	}

	private async handle(req: Request): Promise<Response> {
		const url = new URL(req.url);
		const path = decodeURIComponent(url.pathname);
		this.log.push(`${req.method} ${path}`);
		const pre = await this.before?.(req, path);
		if (pre) return pre;
		if (path === "/status.php")
			return Response.json({ installed: true, versionstring: "35.0.2" });
		const body =
			req.method === "GET" || req.method === "DELETE" ? "" : await req.text();
		if (req.method === "PROPFIND")
			return this.propfind(path, req.headers.get("depth") ?? "0", body);
		if (req.method === "REPORT") return this.report(path, body);
		if (req.method === "MKCALENDAR") {
			if (this.collections.has(path))
				return davError(405, "resource-must-be-null", "exists");
			const tag = (t: string) =>
				new RegExp(`<${t}>(.*?)</${t}>`).exec(body)?.[1];
			this.collections.set(path, {
				name: tag("d:displayname") ?? "",
				components: [...body.matchAll(/<c:comp name="(\w+)"/g)].map(
					(m) => m[1] ?? "",
				),
				color: tag("a:calendar-color") ?? "#0F8B8DFF",
				writable: true,
				objects: new Map(),
				changes: [],
			});
			return new Response(null, { status: 201 });
		}
		if (req.method === "PROPPATCH") {
			const c = this.collections.get(path);
			if (!c) return new Response("not found", { status: 404 });
			if (!c.writable)
				return ms(
					`<d:response><d:href>${path}</d:href><d:propstat><d:prop><d:displayname/></d:prop><d:status>HTTP/1.1 403 Forbidden</d:status></d:propstat></d:response>`,
				);
			c.name = /<d:displayname>(.*?)<\/d:displayname>/.exec(body)?.[1] ?? "";
			return ms(ok(path, "<d:displayname/>"));
		}
		if (req.method === "DELETE" && this.collections.has(path)) {
			if (!this.collections.get(path)?.writable)
				return davError(403, "need-privileges", "Read-only");
			this.collections.delete(path);
			return new Response(null, { status: 204 });
		}
		const list = this.listOf(path);
		if (!list) return new Response("no such collection", { status: 404 });
		const current = list.objects.get(path);
		const ifMatch = req.headers.get("if-match");
		if (ifMatch && ifMatch !== (current === undefined ? null : md5(current)))
			return davError(
				412,
				"precondition-failed",
				"An If-Match header was specified, but none of the specified ETags matched.",
			);
		if (req.method === "GET") {
			if (current === undefined)
				return new Response("not found", { status: 404 });
			return new Response(current, { headers: { etag: md5(current) } });
		}
		if (!list.writable) return davError(403, "need-privileges", "Read-only");
		if (req.method === "PUT") {
			if (req.headers.get("if-none-match") === "*" && current !== undefined)
				return davError(412, "precondition-failed", "exists");
			list.objects.set(path, body);
			this.touch(list, path);
			return new Response(null, {
				status: current === undefined ? 201 : 204,
				headers: { etag: md5(body) },
			});
		}
		if (req.method === "DELETE") {
			if (current === undefined)
				return new Response("not found", { status: 404 });
			list.objects.delete(path);
			this.touch(list, path);
			return new Response(null, { status: 204 });
		}
		if (req.method === "MOVE") {
			if (current === undefined)
				return new Response("not found", { status: 404 });
			const dest = decodeURIComponent(
				new URL(req.headers.get("destination") ?? "").pathname,
			);
			const target = this.listOf(dest);
			if (!target) return new Response("no target", { status: 409 });
			if (target.objects.has(dest))
				return davError(412, "precondition-failed", "exists");
			list.objects.delete(path);
			target.objects.set(dest, current);
			this.touch(list, path);
			this.touch(target, dest);
			return new Response(null, { status: 201 });
		}
		return new Response("unsupported", { status: 405 });
	}

	private propfind(path: string, depth: string, body: string): Response {
		if (path === "/remote.php/dav/")
			return ms(
				ok(
					path,
					`<d:current-user-principal><d:href>${PRINCIPAL}</d:href></d:current-user-principal>`,
				),
			);
		if (path === PRINCIPAL)
			return ms(
				ok(
					path,
					`<cal:calendar-home-set><d:href>${HOME}</d:href></cal:calendar-home-set>`,
				),
			);
		if (path === HOME) {
			const rows = [...this.collections].map(([href, c]) =>
				ok(
					href,
					`<d:resourcetype><d:collection/><cal:calendar/></d:resourcetype><d:displayname>${c.name}</d:displayname><cal:supported-calendar-component-set>${c.components.map((x) => `<cal:comp name="${x}"/>`).join("")}</cal:supported-calendar-component-set><a:calendar-color>${c.color}</a:calendar-color><cs:getctag>http://fake/sync/${this.token}</cs:getctag><d:current-user-privilege-set><d:privilege><d:read/></d:privilege>${c.writable ? "<d:privilege><d:write/></d:privilege>" : ""}</d:current-user-privilege-set>`,
				),
			);
			return ms(
				ok(HOME, "<d:resourcetype><d:collection/></d:resourcetype>") +
					rows.join(""),
			);
		}
		const list = this.collections.get(path);
		if (list) {
			const rows =
				depth === "1"
					? [...list.objects].map(([href, text]) =>
							ok(href, `<d:getetag>${md5(text)}</d:getetag><d:resourcetype/>`),
						)
					: [];
			return ms(
				ok(
					path,
					"<d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>",
				) + rows.join(""),
			);
		}
		void body;
		const text = this.get(path);
		if (text === undefined) return new Response("not found", { status: 404 });
		return ms(ok(path, `<d:getetag>${md5(text)}</d:getetag><d:resourcetype/>`));
	}

	private report(path: string, body: string): Response {
		const list = this.collections.get(path);
		if (!list) return new Response("not found", { status: 404 });
		if (this.noSyncCollection)
			return new Response("not implemented", { status: 501 });
		const raw = /<d:sync-token>(.*?)<\/d:sync-token>/.exec(body)?.[1] ?? "";
		const now = `http://fake/sync/${this.token}`;
		let hrefs: string[];
		if (raw === "") hrefs = [...list.objects.keys()];
		else {
			const n = /^http:\/\/fake\/sync\/(\d+)$/.exec(raw)?.[1];
			if (!n)
				return davError(
					403,
					"valid-sync-token",
					"Invalid or unknown sync token",
				);
			hrefs = this.silentSync
				? []
				: [
						...new Set(
							list.changes
								.filter((c) => c.token > Number(n))
								.map((c) => c.href),
						),
					];
		}
		const rows = hrefs.map((h) => {
			const text = list.objects.get(h);
			return text === undefined || this.misreportDeleted.has(h)
				? gone(h)
				: ok(h, `<d:getetag>${md5(text)}</d:getetag>`);
		});
		return ms(rows.join(""), `<d:sync-token>${now}</d:sync-token>`);
	}
}

/** A minimal VTODO resource as another client would write it. */
export const vtodo = (uid: string, lines: string[] = []) =>
	[
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//test//EN",
		"BEGIN:VTODO",
		`UID:${uid}`,
		"DTSTAMP:20261001T000000Z",
		`SUMMARY:${uid}`,
		...lines,
		"END:VTODO",
		"END:VCALENDAR",
		"",
	].join("\r\n");
