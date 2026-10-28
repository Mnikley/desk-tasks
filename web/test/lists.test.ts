// Discovery of owned, shared, view-only and Deck lists, and the Tasks app's CLASS rule in lists
// shared with me.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { principalKey } from "../src/core/caldav.ts";
import { attempt } from "../src/core/ctx.ts";
import { createList } from "../src/core/lists.ts";
import { sync } from "../src/core/sync.ts";
import { listTasks } from "../src/core/tasks.ts";
import { updateTask } from "../src/core/write.ts";
import { FakeCaldav, HOME, vtodo } from "./fake-caldav.ts";
import { at, type TestCore, testCore } from "./helpers.ts";

let fake: FakeCaldav;
let core: TestCore;

beforeEach(() => {
	fake = new FakeCaldav();
	core = testCore({ url: fake.url, now: at("2026-10-28", "09:00") });
});
afterEach(() => fake.stop());

const INVITE =
	"<o:user><d:href>principal:principals/users/alice</d:href><o:common-name>Alice</o:common-name><o:invite-accepted/><o:access><o:read-write/></o:access></o:user>" +
	"<o:user><d:href>principal:principals/groups/team%20a</d:href><o:invite-accepted/><o:access><o:read/></o:access></o:user>";

test("own, shared (view only / can edit), Deck and event-only collections are told apart", async () => {
	const mine = fake.addList("work", "Work", ["VTODO"], true, {
		invite: INVITE,
	});
	const ro = fake.addList(
		"groceries_shared_by_bob",
		"Groceries (Bob)",
		["VTODO"],
		false,
		{
			owner: "principals/users/bob",
			ownerName: "Bob",
		},
	);
	const rw = fake.addList(
		"family_shared_by_bob",
		"Family (Bob)",
		["VTODO"],
		true,
		{
			owner: "principals/users/bob",
			ownerName: "Bob",
		},
	);
	const deck = fake.addList(
		"app-generated--deck--board-3",
		"Deck: Launch",
		["VTODO"],
		true,
	);
	fake.addList("personal", "Personal", ["VEVENT"]);
	await sync(core.ctx, { force: true });
	const lists = core.ctx.store.lists();
	expect(lists.map((l) => l.href).sort()).toEqual([deck, rw, ro, mine].sort());
	expect(core.ctx.store.list(mine)).toMatchObject({
		shared: false,
		writable: true,
		canShare: true,
		sharees: [
			{
				href: "principal:principals/users/alice",
				name: "Alice",
				kind: "user",
				access: "read-write",
			},
			{
				href: "principal:principals/groups/team%20a",
				name: "team a",
				kind: "group",
				access: "read",
			},
		],
	});
	expect(core.ctx.store.list(ro)).toMatchObject({
		shared: true,
		writable: false,
		ownerName: "Bob",
		canShare: false,
	});
	expect(core.ctx.store.list(rw)).toMatchObject({
		shared: true,
		writable: true,
	});
	// Deck boards are never writable, whatever the privilege set says.
	expect(core.ctx.store.list(deck)).toMatchObject({
		appGenerated: true,
		writable: false,
	});
});

test("oc:read-only decides only when there is no privilege set", async () => {
	const a = fake.addList("a_shared_by_bob", "A", ["VTODO"], false, {
		owner: "principals/users/bob",
		noPrivilegeSet: true,
	});
	const b = fake.addList("b_shared_by_bob", "B", ["VTODO"], true, {
		owner: "principals/users/bob",
		noPrivilegeSet: true,
	});
	await sync(core.ctx, { force: true });
	expect(core.ctx.store.list(a)?.writable).toBe(false);
	expect(core.ctx.store.list(b)?.writable).toBe(true);
});

test("in a list shared with me only public tasks can be changed; redacted ones are marked", async () => {
	const rw = fake.addList("family_shared_by_bob", "Family", ["VTODO"], true, {
		owner: "principals/users/bob",
		ownerName: "Bob",
	});
	const ro = fake.addList("ro_shared_by_bob", "Ro", ["VTODO"], false, {
		owner: "principals/users/bob",
		ownerName: "Bob",
	});
	fake.put(`${rw}pub.ics`, vtodo("pub"));
	fake.put(`${rw}conf.ics`, vtodo("conf", ["CLASS:CONFIDENTIAL"]));
	fake.put(`${rw}priv.ics`, vtodo("priv", ["CLASS:PRIVATE"]));
	fake.put(`${ro}busy.ics`, vtodo("busy", ["CLASS:CONFIDENTIAL"]));
	const own = fake.addList("mine", "Mine");
	fake.put(`${own}conf.ics`, vtodo("own-conf", ["CLASS:CONFIDENTIAL"]));
	await sync(core.ctx, { force: true });
	const by = (uid: string) => listTasks(core.ctx).find((t) => t.uid === uid);
	expect(by("pub")?.readOnly).toBeNull();
	expect(by("conf")?.readOnly).toBe("Bob marked this task as private.");
	expect(by("priv")?.readOnly).toBe("Bob marked this task as private.");
	expect(by("busy")?.redacted).toBe(true);
	expect(by("own-conf")?.readOnly).toBeNull(); // my own lists: any CLASS is mine to change
	const requests = core.log.length;
	const res = await attempt(() =>
		updateTask(core.ctx, by("conf")?.href ?? "", { summary: "x" }),
	);
	expect(!res.ok && res.error.message).toContain(
		"Bob marked this task as private.",
	);
	expect(core.log.length).toBe(requests);
});

test("principal keys compare owner-principal with my principal href", () => {
	expect(principalKey("/remote.php/dav/principals/users/u/")).toBe(
		"principals/users/u",
	);
	expect(principalKey("/nc/remote.php/dav/principals/users/bob/")).toBe(
		"principals/users/bob",
	);
	expect(principalKey("principals/users/bob")).toBe("principals/users/bob");
	expect(principalKey("principal:principals/groups/team")).toBe(
		"principals/groups/team",
	);
	expect(HOME).toContain("/calendars/u/");
});

test("Nextcloud's list limit and creation rate limit read as next steps", async () => {
	for (const [answer, message] of [
		[
			new Response(
				'<?xml version="1.0"?><d:error xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns"><s:message>Calendar limit reached</s:message></d:error>',
				{ status: 403 },
			),
			"You've reached Nextcloud's list limit (lists in the trash count too). Empty the trash or ask your admin.",
		],
		[
			new Response("slow down", { status: 429 }),
			"Nextcloud allows 10 new lists per hour. Try again later.",
		],
	] as const) {
		fake.before = async (req) =>
			req.method === "MKCALENDAR" ? answer.clone() : undefined;
		await sync(core.ctx, { force: true });
		const res = await attempt(() =>
			createList(core.ctx, { name: "More", color: "#112233" }),
		);
		expect(!res.ok && res.error.message).toBe(message);
	}
});
