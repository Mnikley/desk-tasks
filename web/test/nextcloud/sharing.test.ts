// Lists shared with the user on a real Nextcloud: bob shares over DAV (view only, can edit, and
// through the group "team"); the core sees owner and access, refuses writes to view-only lists
// before any request, never sees bob's PRIVATE tasks and marks his CONFIDENTIAL ones redacted.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { attempt } from "../../src/core/ctx.ts";
import { createList } from "../../src/core/lists.ts";
import {
	searchSharees,
	setAccess,
	share,
	skippedText,
	unshare,
} from "../../src/core/sharing.ts";
import { sync } from "../../src/core/sync.ts";
import { listTasks } from "../../src/core/tasks.ts";
import { createTask, updateTask } from "../../src/core/write.ts";
import { type TestCore, testCore } from "../helpers.ts";
import {
	ALICE,
	BOB,
	CAL_HOME,
	davAs,
	GROUP,
	mkcalendarAs,
	putAs,
	shareAs,
	USER,
} from "./harness.ts";
import { startProxy, type TestProxy } from "./proxy.ts";

const URL_ = process.env.NEXTCLOUD_TEST_URL ?? "";
const APP_PASSWORD = process.env.NEXTCLOUD_APP_PASSWORD ?? "";
const enabled = URL_ !== "" && APP_PASSWORD !== "";
const suffix = Date.now().toString(36);

const todo = (uid: string, summary: string, extra: string[] = []) =>
	[
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//test//EN",
		"BEGIN:VTODO",
		`UID:${uid}`,
		"DTSTAMP:20261028T080000Z",
		`SUMMARY:${summary}`,
		"DUE;VALUE=DATE:20261030",
		...extra,
		"BEGIN:VALARM",
		"ACTION:DISPLAY",
		"DESCRIPTION:x",
		"TRIGGER;RELATED=END:-PT15M",
		"END:VALARM",
		"END:VTODO",
		"END:VCALENDAR",
		"",
	].join("\r\n");

describe.skipIf(!enabled)("lists shared with me (real Nextcloud)", () => {
	let proxy: TestProxy;
	let core: TestCore;
	/** The tester's hrefs of bob's lists. */
	const mine = { ro: "", rw: "", grp: "" };

	beforeAll(async () => {
		const ro = await mkcalendarAs(BOB, `ro-${suffix}`, `Groceries ${suffix}`);
		const rw = await mkcalendarAs(BOB, `rw-${suffix}`, `Family ${suffix}`);
		const grp = await mkcalendarAs(BOB, `grp-${suffix}`, `Team ${suffix}`);
		await shareAs(BOB, ro, [{ principal: `principals/users/${USER.name}` }]);
		await shareAs(BOB, rw, [
			{ principal: `principals/users/${USER.name}`, readWrite: true },
		]);
		await shareAs(BOB, grp, [{ principal: `principals/groups/${GROUP}` }]);
		// A list of my own, so the test doesn't depend on another file having made one.
		await mkcalendarAs(USER, `own-${suffix}`, `Own ${suffix}`);
		await putAs(BOB, `${ro}pub.ics`, todo(`pub-${suffix}`, "Milk"));
		await putAs(
			BOB,
			`${ro}conf.ics`,
			todo(`conf-${suffix}`, "Gift for Tester", ["CLASS:CONFIDENTIAL"]),
		);
		await putAs(
			BOB,
			`${ro}priv.ics`,
			todo(`priv-${suffix}`, "Secret", ["CLASS:PRIVATE"]),
		);
		await putAs(BOB, `${rw}pub.ics`, todo(`rwpub-${suffix}`, "Dishes"));
		await putAs(
			BOB,
			`${rw}conf.ics`,
			todo(`rwconf-${suffix}`, "Surprise", ["CLASS:CONFIDENTIAL"]),
		);
		mine.ro = `${CAL_HOME}ro-${suffix}_shared_by_${BOB.name}/`;
		mine.rw = `${CAL_HOME}rw-${suffix}_shared_by_${BOB.name}/`;
		mine.grp = `${CAL_HOME}grp-${suffix}_shared_by_${BOB.name}/`;
		proxy = startProxy(URL_);
		core = testCore({
			url: proxy.url,
			now: Date.now(),
			user: USER.name,
			password: APP_PASSWORD,
		});
		core.ctx.now = () => Date.now();
		await sync(core.ctx, { force: true });
	});
	afterAll(() => proxy?.stop());

	const byUid = (uid: string) =>
		listTasks(core.ctx).find((t) => t.uid === `${uid}-${suffix}`);

	test("user shares (view only, can edit) and a group share are detected with owner and access", () => {
		expect(core.ctx.store.list(mine.ro)).toMatchObject({
			shared: true,
			writable: false,
			ownerName: "Bob",
			owner: `principals/users/${BOB.name}`,
			canShare: false,
			sharees: [],
		});
		expect(core.ctx.store.list(mine.rw)).toMatchObject({
			shared: true,
			writable: true,
			ownerName: "Bob",
		});
		expect(core.ctx.store.list(mine.grp)).toMatchObject({
			shared: true,
			writable: false,
		});
		// My own lists are not "shared" (Nextcloud reports me as their owner).
		const own = core.ctx.store
			.lists()
			.filter((l) => !l.href.includes("_shared_by_"));
		expect(own.length).toBeGreaterThan(0);
		expect(own.every((l) => !l.shared)).toBe(true);
	});

	test("a PRIVATE task is invisible; a CONFIDENTIAL one is redacted and locked; view-only gets no alarms", () => {
		expect(byUid("priv")).toBeUndefined();
		const conf = byUid("conf");
		expect(conf?.redacted).toBe(true);
		expect(conf?.summary).not.toBe("Gift for Tester");
		expect(conf?.readOnly).toBeTruthy();
		const pub = byUid("pub");
		expect(pub?.summary).toBe("Milk");
		expect(core.ctx.store.task(pub?.href ?? "")?.ics).not.toContain(
			"BEGIN:VALARM",
		);
		// In a list I can edit, a CONFIDENTIAL task is complete but still not mine to change.
		const rwconf = byUid("rwconf");
		expect(rwconf?.summary).toBe("Surprise");
		expect(rwconf?.redacted).toBe(false);
		expect(rwconf?.readOnly).toBe("Bob marked this task as private.");
		expect(byUid("rwpub")?.readOnly).toBeNull();
	});

	test("writes to a view-only list are refused here, before any request", async () => {
		const n = proxy.writes().length;
		const edit = await attempt(() =>
			updateTask(core.ctx, byUid("pub")?.href ?? "", { summary: "Oat milk" }),
		);
		expect(!edit.ok && edit.error.message).toContain("view only");
		const add = await attempt(() =>
			createTask(core.ctx, { list: mine.ro, summary: "Bread" }),
		);
		expect(!add.ok && add.error.message).toContain("view only");
		expect(proxy.writes().length).toBe(n);
	});

	test("a public task in a list I can edit is written normally", async () => {
		const res = await attempt(() =>
			updateTask(core.ctx, byUid("rwpub")?.href ?? "", { priority: "high" }),
		);
		expect(res.ok).toBe(true);
	});

	test("making a task private in a list shared with me saves it, and it leaves my view without pausing", async () => {
		const t = byUid("rwpub");
		const res = await attempt(() =>
			updateTask(core.ctx, t?.href ?? "", { klass: "PRIVATE" }),
		);
		expect(res.ok && res.value).toBeNull();
		expect(core.ctx.store.settings.paused).toBeNull();
		expect(byUid("rwpub")).toBeUndefined();
		// Bob, the owner, has it with CLASS:PRIVATE.
		const owner = await davAs(
			BOB,
			"GET",
			`/remote.php/dav/calendars/${BOB.name}/rw-${suffix}/pub.ics`,
		);
		expect(await owner.text()).toContain("CLASS:PRIVATE\r\n");
	});
});

describe.skipIf(!enabled)(
	"sharing a list from desk-tasks (real Nextcloud)",
	() => {
		let core: TestCore;
		let list = "";
		beforeAll(async () => {
			core = testCore({
				url: URL_,
				now: Date.now(),
				user: USER.name,
				password: APP_PASSWORD,
			});
			core.ctx.now = () => Date.now();
			await sync(core.ctx, { force: true });
			const made = await attempt(() =>
				createList(core.ctx, {
					name: `Shared out ${suffix}`,
					color: "#3a5bd9",
				}),
			);
			if (!made.ok) throw new Error(made.error.message);
			list = made.value;
		});
		const value = <T>(
			r: { ok: true; value: T } | { ok: false; error: { message: string } },
		) => {
			if (!r.ok) throw new Error(r.error.message);
			return r.value;
		};

		test("people search finds users and groups; the share href is principal:…", async () => {
			const found = value(
				await attempt(() => searchSharees(core.ctx, list, "Ali")),
			);
			expect(found).toContainEqual({
				href: "principal:principals/users/alice",
				name: "Alice",
				kind: "user",
			});
			const groups = value(
				await attempt(() => searchSharees(core.ctx, list, GROUP)),
			);
			expect(
				groups.some(
					(g) =>
						g.kind === "group" &&
						g.href === `principal:principals/groups/${GROUP}`,
				),
			).toBe(true);
			expect(
				value(await attempt(() => searchSharees(core.ctx, list, "a"))),
			).toEqual([]);
		});

		test("share view only, switch to can edit, add the group, remove; alice sees each step", async () => {
			const alice = { href: "principal:principals/users/alice", name: "Alice" };
			let res = value(await attempt(() => share(core.ctx, list, [alice])));
			expect(res.skipped).toEqual([]);
			expect(res.sharees).toEqual([
				expect.objectContaining({
					href: alice.href,
					access: "read",
					kind: "user",
				}),
			]);
			const aliceView = async () =>
				(
					await davAs(ALICE, "PROPFIND", `/remote.php/dav/calendars/alice/`, {
						headers: { Depth: "1" },
						body: '<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-privilege-set/></d:prop></d:propfind>',
					})
				).text();
			expect(await aliceView()).toContain(`_shared_by_${USER.name}`);
			const s = res.sharees[0];
			if (!s) throw new Error("no sharee");
			res = value(await attempt(() => setAccess(core.ctx, list, s, true)));
			expect(res.sharees[0]?.access).toBe("read-write");
			res = value(
				await attempt(() =>
					share(core.ctx, list, [
						{ href: `principal:principals/groups/${GROUP}`, name: GROUP },
					]),
				),
			);
			expect(res.sharees.map((x) => x.kind).sort()).toEqual(["group", "user"]);
			res = value(await attempt(() => unshare(core.ctx, list, s)));
			expect(res.sharees.map((x) => x.kind)).toEqual(["group"]);
			expect(core.ctx.store.list(list)?.sharees).toEqual(res.sharees);
		});

		test("a share with someone who doesn't exist answers 200 and is reported as skipped", async () => {
			const res = value(
				await attempt(() =>
					share(core.ctx, list, [
						{ href: "principal:principals/users/nobody-here", name: "Carol" },
					]),
				),
			);
			expect(res.skipped).toEqual(["Carol"]);
			expect(skippedText("Carol")).toBe(
				"Couldn't share with Carol. Your Nextcloud's sharing settings may not allow it.",
			);
		});
	},
);
