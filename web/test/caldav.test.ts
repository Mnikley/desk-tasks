// The CalDAV client against a hostile fake server: requests never leave the configured origin,
// listings can't smuggle in foreign objects, and oversized answers aren't read.
// The https-only rule is the bridge's (tests/test_bridge.py).
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
	CaldavClient,
	CaldavError,
	CaldavUnreachable,
	normaliseColor,
} from "../src/core/caldav.ts";
import { fetchTransport } from "./transport.ts";

const MS = (body: string) =>
	new Response(
		`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${body}</d:multistatus>`,
		{
			status: 207,
			headers: { "content-type": "application/xml" },
		},
	);
const etagged = (href: string, etag = '"e"') =>
	`<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:getetag>${etag}</d:getetag><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;

let principal = "/remote.php/dav/principals/users/u/";
let listing = "";
const seenAuth: string[] = [];
let other: ReturnType<typeof Bun.serve>;
let server: ReturnType<typeof Bun.serve>;
let dc: CaldavClient;

beforeAll(() => {
	other = Bun.serve({
		port: 0,
		fetch(req) {
			seenAuth.push(req.headers.get("authorization") ?? "");
			return new Response("nope", { status: 404 });
		},
	});
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			const path = new URL(req.url).pathname;
			if (path === "/remote.php/dav/")
				return MS(
					`<d:response><d:href>/remote.php/dav/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>${principal}</d:href></d:current-user-principal></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
				);
			if (path === "/remote.php/dav/calendars/u/big/")
				return new Response(
					new ReadableStream({
						pull(c) {
							c.enqueue(new Uint8Array(1024 * 1024).fill(32));
						},
					}),
					{ status: 207 },
				);
			if (path === "/remote.php/dav/calendars/u/list/latin1.ics")
				return new Response(new Uint8Array([0x42, 0xe4, 0x0d, 0x0a]), {
					headers: { etag: '"x"' },
				});
			return MS(listing);
		},
	});
	dc = new CaldavClient(
		`http://localhost:${server.port}`,
		fetchTransport({ user: "u", password: "secret-password" }),
	);
});
afterAll(() => {
	server.stop(true);
	other.stop(true);
});

test("a principal on another host is refused before any request goes there", async () => {
	principal = `http://localhost:${other.port}/remote.php/dav/principals/users/u/`;
	await expect(dc.discover()).rejects.toBeInstanceOf(CaldavError);
	await Bun.sleep(50);
	expect(seenAuth).toEqual([]);
	principal = "/remote.php/dav/principals/users/u/";
});

test("a listing can't include objects outside the collection", async () => {
	listing =
		etagged("/remote.php/dav/calendars/u/list/a.ics") +
		etagged("/remote.php/dav/calendars/u/other/b.ics");
	await expect(dc.list("/remote.php/dav/calendars/u/list/")).rejects.toThrow(
		"refusing it",
	);
	listing = etagged("/remote.php/dav/calendars/u/list/a.ics");
	expect(await dc.list("/remote.php/dav/calendars/u/list/")).toEqual([
		{ href: "/remote.php/dav/calendars/u/list/a.ics", etag: '"e"' },
	]);
});

test("an object without an ETag is an error, not skipped", async () => {
	listing = etagged("/remote.php/dav/calendars/u/list/a.ics", "");
	await expect(dc.list("/remote.php/dav/calendars/u/list/")).rejects.toThrow(
		"without an ETag",
	);
});

test("a malformed %-escape in an href doesn't break the listing", async () => {
	listing = etagged("/remote.php/dav/calendars/u/list/50%.ics");
	expect((await dc.list("/remote.php/dav/calendars/u/list/"))[0]?.href).toBe(
		"/remote.php/dav/calendars/u/list/50%.ics",
	);
});

test("an endless answer is cut off instead of filling memory", async () => {
	await expect(dc.list("/remote.php/dav/calendars/u/big/")).rejects.toThrow(
		"larger than expected",
	);
});

test("a body that isn't UTF-8 comes back flagged, never as editable text", async () => {
	const got = await dc.get("/remote.php/dav/calendars/u/list/latin1.ics");
	expect(got?.binary).toBe(true);
	expect(got?.text).toBe("B�\r\n");
});

test("a refused port is a connect failure: nothing was sent", async () => {
	const dead = Bun.serve({ port: 0, fetch: () => new Response() });
	const port = dead.port;
	dead.stop(true);
	const c = new CaldavClient(
		`http://localhost:${port}`,
		fetchTransport({ user: "u", password: "p" }),
	);
	const err = await c.get("/remote.php/dav/x.ics").catch((e: unknown) => e);
	expect(err).toBeInstanceOf(CaldavUnreachable);
	expect((err as CaldavUnreachable).kind).toBe("connect");
});

test("calendar colours: Apple's #RRGGBBAA and #RRGGBB, nothing else", () => {
	expect(normaliseColor("#FF7A00FF")).toBe("#ff7a00");
	expect(normaliseColor(" #0082c9 ")).toBe("#0082c9");
	expect(normaliseColor("red")).toBeNull();
	expect(normaliseColor(null)).toBeNull();
});
