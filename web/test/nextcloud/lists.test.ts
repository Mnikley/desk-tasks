// List management and the trash on a real Nextcloud: make (VTODO only), rename, recolour,
// reorder, delete → trash → restore, delete for good, a task through the trash, and leaving /
// renaming a list someone shared with me. The list-limit 403 is tested against the fake server
// (web/test/lists.test.ts): an app config changed with occ during a run isn't seen reliably by
// the web server (its "fast cache"), so the limit can't be switched on for one case here.
import { beforeAll, describe, expect, test } from "bun:test";
import { attempt } from "../../src/core/ctx.ts";
import type { Failure } from "../../src/core/errors.ts";
import {
	changeList,
	createList,
	deleteList,
	deleteListForever,
	leaveList,
	loadTrash,
	reorderLists,
	restoreList,
	restoreTask,
} from "../../src/core/lists.ts";
import { sync } from "../../src/core/sync.ts";
import { listTasks } from "../../src/core/tasks.ts";
import { createTask, deleteTask } from "../../src/core/write.ts";
import { type TestCore, testCore } from "../helpers.ts";
import {
	BOB,
	CAL_HOME,
	davAs,
	mkcalendarAs,
	shareAs,
	USER,
} from "./harness.ts";

const URL_ = process.env.NEXTCLOUD_TEST_URL ?? "";
const APP_PASSWORD = process.env.NEXTCLOUD_APP_PASSWORD ?? "";
const enabled = URL_ !== "" && APP_PASSWORD !== "";
const suffix = Date.now().toString(36);

describe.skipIf(!enabled)("lists and the trash (real Nextcloud)", () => {
	let core: TestCore;
	const ok = async <T>(
		p: Promise<{ ok: true; value: T } | { ok: false; error: Failure }>,
	) => {
		const r = await p;
		if (!r.ok) throw new Error(`${r.error.kind}: ${r.error.message}`);
		return r.value;
	};
	const props = async (href: string) =>
		(
			await davAs(USER, "PROPFIND", href, {
				headers: { Depth: "0", "content-type": "application/xml" },
				body: '<d:propfind xmlns:d="DAV:" xmlns:a="http://apple.com/ns/ical/" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:displayname/><a:calendar-color/><a:calendar-order/><c:supported-calendar-component-set/></d:prop></d:propfind>',
			})
		).text();

	beforeAll(async () => {
		core = testCore({
			url: URL_,
			now: Date.now(),
			user: USER.name,
			password: APP_PASSWORD,
		});
		core.ctx.now = () => Date.now();
		await sync(core.ctx, { force: true });
	});

	test("a new list holds tasks only, comes last, with name and colour; rename and recolour go there", async () => {
		const href = await ok(
			attempt(() =>
				createList(core.ctx, { name: `Garden ${suffix}`, color: "#7f9a1a" }),
			),
		);
		expect(href).toMatch(
			new RegExp(`${CAL_HOME}garden-${suffix}-[a-z0-9]{6}/$`),
		);
		const orders = core.ctx.store.lists().map((l) => l.order);
		expect(core.ctx.store.list(href)?.order).toBe(Math.max(...orders));
		let p = await props(href);
		expect(p).toContain(`Garden ${suffix}`);
		expect(p).toContain('<cal:comp name="VTODO"/>');
		expect(p).not.toContain("VEVENT");
		await ok(
			attempt(() =>
				changeList(core.ctx, href, {
					name: `Yard ${suffix}`,
					color: "#d0476a",
				}),
			),
		);
		p = await props(href);
		expect(p).toContain(`Yard ${suffix}`);
		expect(p.toLowerCase()).toContain("#d0476a");
	});

	test("reordering lists writes calendar-order with the Tasks app's rule", async () => {
		const a = await ok(
			attempt(() =>
				createList(core.ctx, { name: `A ${suffix}`, color: "#3a5bd9" }),
			),
		);
		const b = await ok(
			attempt(() =>
				createList(core.ctx, { name: `B ${suffix}`, color: "#3a5bd9" }),
			),
		);
		const lists = core.ctx.store.lists();
		const at = lists.findIndex((l) => l.href === a);
		await ok(attempt(() => reorderLists(core.ctx, b, at)));
		await sync(core.ctx, { force: true });
		const after = core.ctx.store.lists().map((l) => l.href);
		expect(after.indexOf(b)).toBeLessThan(after.indexOf(a));
	});

	test("delete → in the trash → restore brings the list and its tasks back; delete forever ends it", async () => {
		const href = await ok(
			attempt(() =>
				createList(core.ctx, { name: `Errands ${suffix}`, color: "#0e9484" }),
			),
		);
		await ok(
			attempt(() =>
				createTask(core.ctx, { list: href, summary: "Post office" }),
			),
		);
		await ok(attempt(() => deleteList(core.ctx, href)));
		expect(core.ctx.store.list(href)).toBeUndefined();
		await sync(core.ctx, { force: true });
		expect(core.ctx.store.list(href)).toBeUndefined(); // a trashed list is not a list
		const trash = await ok(attempt(() => loadTrash(core.ctx)));
		expect(trash.retentionDays).toBe(30);
		expect(
			trash.lists.some(
				(l) => l.href === href && l.name === `Errands ${suffix}`,
			),
		).toBe(true);
		await ok(attempt(() => restoreList(core.ctx, href)));
		expect(core.ctx.store.list(href)?.name).toBe(`Errands ${suffix}`);
		expect(
			listTasks(core.ctx).some(
				(t) => t.list === href && t.summary === "Post office",
			),
		).toBe(true);
		await ok(attempt(() => deleteList(core.ctx, href)));
		await ok(attempt(() => deleteListForever(core.ctx, href)));
		const again = await ok(attempt(() => loadTrash(core.ctx)));
		expect(again.lists.some((l) => l.href === href)).toBe(false);
	});

	test("a deleted task with its subtask is in the trash and comes back together", async () => {
		const href = await ok(
			attempt(() =>
				createList(core.ctx, { name: `Trash ${suffix}`, color: "#0e9484" }),
			),
		);
		const parent = await ok(
			attempt(() =>
				createTask(core.ctx, { list: href, summary: "Paint fence" }),
			),
		);
		await ok(
			attempt(() =>
				createTask(core.ctx, { parent: parent.href, summary: "Buy brushes" }),
			),
		);
		await ok(attempt(() => deleteTask(core.ctx, parent.href)));
		const trash = await ok(attempt(() => loadTrash(core.ctx)));
		const mine = trash.tasks.filter((t) => t.list === href);
		expect(mine.map((t) => t.summary).sort()).toEqual([
			"Buy brushes",
			"Paint fence",
		]);
		const sub = mine.find((t) => t.summary === "Buy brushes");
		// Restoring the subtask brings its parent along.
		expect(
			await ok(attempt(() => restoreTask(core.ctx, trash, sub?.href ?? ""))),
		).toBe(2);
		const back = listTasks(core.ctx).filter((t) => t.list === href);
		expect(back.map((t) => t.summary).sort()).toEqual([
			"Buy brushes",
			"Paint fence",
		]);
		expect(back.find((t) => t.summary === "Buy brushes")?.parentUid).toBe(
			parent.uid,
		);
	});

	test("a list shared with me: renamed for me only, and left (also view only) while the owner keeps it", async () => {
		const owned = await mkcalendarAs(
			BOB,
			`lv-${suffix}`,
			`Groceries ${suffix}`,
		);
		await shareAs(BOB, owned, [{ principal: `principals/users/${USER.name}` }]);
		await sync(core.ctx, { force: true });
		const mine = `${CAL_HOME}lv-${suffix}_shared_by_${BOB.name}/`;
		expect(core.ctx.store.list(mine)).toMatchObject({
			shared: true,
			writable: false,
		});
		await ok(
			attempt(() =>
				changeList(core.ctx, mine, { name: `My groceries ${suffix}` }),
			),
		);
		await sync(core.ctx, { force: true });
		expect(core.ctx.store.list(mine)?.name).toBe(`My groceries ${suffix}`);
		const bobs = await davAs(BOB, "PROPFIND", owned, {
			headers: { Depth: "0" },
			body: '<d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>',
		});
		expect(await bobs.text()).toContain(
			`<d:displayname>Groceries ${suffix}</d:displayname>`,
		);
		await ok(attempt(() => leaveList(core.ctx, mine)));
		await sync(core.ctx, { force: true });
		expect(core.ctx.store.list(mine)).toBeUndefined();
		expect(
			(await davAs(BOB, "PROPFIND", owned, { headers: { Depth: "0" } })).status,
		).toBe(207);
	});
});
