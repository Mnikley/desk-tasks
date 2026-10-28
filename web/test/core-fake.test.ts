// The core's decisions against an in-memory CalDAV server: the 412 merge table, sync recovery
// paths, undo refusals, lists. The Docker suite (test/nextcloud) proves the same machinery
// against the real server; these run in milliseconds and cover every branch.
// Ported from timesheet's nextcloud-fake.test.ts, re-targeted from the HTTP API at the core.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { attempt } from "../src/core/ctx.ts";
import { addJournal } from "../src/core/journal.ts";
import {
	createList,
	deleteList,
	renameList,
	storeTask,
	sync,
} from "../src/core/sync.ts";
import { listTasks, type TaskView } from "../src/core/tasks.ts";
import {
	type Change,
	createTask,
	undo,
	updateTask,
} from "../src/core/write.ts";
import { FakeCaldav, HOME, vtodo } from "./fake-caldav.ts";
import { at, type TestCore, testCore } from "./helpers.ts";

let fake: FakeCaldav;
let core: TestCore;
let list = "";

const tasks = () => listTasks(core.ctx);
const task = (uid: string): TaskView => {
	const t = tasks().find((x) => x.uid === uid);
	if (!t) throw new Error(`no task ${uid}`);
	return t;
};
const forced = () => sync(core.ctx, { force: true });
const patch = (uid: string, change: Change) =>
	attempt(() => updateTask(core.ctx, task(uid).href, change));
const journal = () => core.ctx.store.journal();

beforeEach(async () => {
	fake = new FakeCaldav();
	list = fake.addList("errands", "Errands");
	fake.put(
		`${list}a.ics`,
		vtodo("a", [
			"PRIORITY:5",
			"CATEGORIES:home",
			"DUE;VALUE=DATE:20261023",
			"STATUS:NEEDS-ACTION",
		]),
	);
	core = testCore({ url: fake.url, now: at("2026-10-20", "09:00") });
	await forced();
});
afterEach(() => fake.stop());

describe("412: a change made elsewhere meanwhile", () => {
	// [what changed in Nextcloud, what the user changes, merged?]
	const cases: [string, (t: string) => string, Change, boolean][] = [
		[
			"title elsewhere, priority here",
			(t) => t.replace("SUMMARY:a", "SUMMARY:a (renamed)"),
			{ priority: "high" },
			true,
		],
		[
			"notes elsewhere, tags here",
			(t) => t.replace("STATUS", "DESCRIPTION:note\r\nSTATUS"),
			{ tags: ["x"] },
			true,
		],
		[
			"priority elsewhere, priority here",
			(t) => t.replace("PRIORITY:5", "PRIORITY:9"),
			{ priority: "high" },
			false,
		],
		[
			"progress elsewhere, status here",
			(t) =>
				t.replace(
					"STATUS:NEEDS-ACTION",
					"STATUS:IN-PROCESS\r\nPERCENT-COMPLETE:50",
				),
			{ status: "COMPLETED" },
			false,
		],
		[
			"due elsewhere, drag to a day here",
			(t) => t.replace("DUE;VALUE=DATE:20261023", "DUE;VALUE=DATE:20261025"),
			{ dueDate: "2026-10-28" },
			false,
		],
		[
			"due elsewhere, due edited here",
			(t) => t.replace("DUE;VALUE=DATE:20261023", "DUE;VALUE=DATE:20261025"),
			{ due: { date: "2026-10-28", minutes: 600 } },
			false,
		],
		[
			"tags elsewhere, tags here",
			(t) => t.replace("CATEGORIES:home", "CATEGORIES:home,work"),
			{ tags: ["errand"] },
			false,
		],
	];
	for (const [name, remote, change, merges] of cases) {
		test(name, async () => {
			task("a"); // the core holds the old version
			fake.edit(`${list}a.ics`, remote);
			const theirs = fake.get(`${list}a.ics`);
			const res = await patch("a", change);
			if (merges) {
				expect(res.ok).toBe(true);
				const now = fake.get(`${list}a.ics`) ?? "";
				// Their change is still there, and ours is on top.
				for (const line of (theirs ?? "")
					.split("\r\n")
					.filter((l) => !/^(DTSTAMP|PRIORITY|CATEGORIES)/.test(l)))
					expect(now).toContain(line);
				expect(journal()[0]?.message).toContain("merged");
			} else {
				expect(res.ok).toBe(false);
				if (!res.ok) {
					expect(res.error.kind).toBe("conflict");
					expect(res.error.conflict?.theirs).not.toBeNull();
				}
				expect(fake.get(`${list}a.ics`)).toBe(theirs);
			}
		});
	}

	test("the same result reached elsewhere is not a conflict", async () => {
		task("a");
		fake.edit(`${list}a.ics`, (t) => t.replace("PRIORITY:5", "PRIORITY:1"));
		const theirs = fake.get(`${list}a.ics`);
		const res = await patch("a", { priority: "high" });
		expect(res.ok && res.value?.priority).toBe("high");
		expect(fake.get(`${list}a.ics`)).toBe(theirs); // nothing written
	});

	test("changed again during the merge: conflict, the newest version stays", async () => {
		task("a");
		fake.edit(`${list}a.ics`, (t) => t.replace("SUMMARY:a", "SUMMARY:b"));
		let puts = 0;
		fake.before = async (req, path) => {
			if (req.method === "PUT" && ++puts === 2)
				fake.edit(path, (t) => t.replace("SUMMARY:b", "SUMMARY:c"));
			return undefined;
		};
		const res = await patch("a", { priority: "high" });
		expect(!res.ok && res.error.kind).toBe("conflict");
		expect(!res.ok && res.error.message).toContain("right now");
		expect(fake.get(`${list}a.ics`)).toContain("SUMMARY:c");
	});

	test("deleted elsewhere: conflict, and the task leaves the app", async () => {
		task("a");
		fake.remove(`${list}a.ics`);
		const res = await patch("a", { priority: "high" });
		expect(!res.ok && res.error.kind).toBe("conflict");
		expect(!res.ok && res.error.conflict?.theirs).toBeNull();
		expect(tasks()).toEqual([]);
	});

	test("given occurrence overrides elsewhere: refused, the task is read-only now", async () => {
		task("a");
		fake.edit(`${list}a.ics`, (t) =>
			t.replace(
				"END:VCALENDAR",
				"BEGIN:VTODO\r\nUID:a\r\nRECURRENCE-ID:20261021T100000Z\r\nSUMMARY:a once\r\nEND:VTODO\r\nEND:VCALENDAR",
			),
		);
		const theirs = fake.get(`${list}a.ics`);
		const res = await patch("a", { summary: "x" });
		expect(!res.ok && res.error.message).toContain("changed in another app");
		expect(fake.get(`${list}a.ics`)).toBe(theirs);
	});
});

describe("sync recovery", () => {
	test("an unknown sync token restarts from a full listing", async () => {
		core.ctx.store.patchList(list, { syncToken: "garbage" });
		fake.put(`${list}b.ics`, vtodo("b"));
		await forced();
		expect(
			tasks()
				.map((t) => t.uid)
				.sort(),
		).toEqual(["a", "b"]);
		expect(core.ctx.store.list(list)?.syncToken).toStartWith(
			"http://fake/sync/",
		);
	});

	test("without sync-collection the ETag listing finds changes and deletions", async () => {
		fake.noSyncCollection = true;
		fake.put(`${list}b.ics`, vtodo("b"));
		fake.remove(`${list}a.ics`);
		await forced();
		expect(tasks().map((t) => t.uid)).toEqual(["b"]);
	});

	test("the periodic reconcile catches deletions a silent token hides", async () => {
		fake.silentSync = true;
		fake.remove(`${list}a.ics`);
		await forced();
		expect(tasks().map((t) => t.uid)).toEqual(["a"]); // not seen yet
		core.clock.now += 31 * 60_000;
		await forced();
		expect(tasks()).toEqual([]);
	});

	test("a live task misreported as deleted is re-fetched, not forgotten", async () => {
		fake.edit(`${list}a.ics`, (t) => t.replace("SUMMARY:a", "SUMMARY:a v2"));
		fake.misreportDeleted.add(`${list}a.ics`);
		await forced();
		expect(task("a").summary).toBe("a v2");
	});

	test("a list that disappears takes its tasks along and says so", async () => {
		fake.collections.delete(list);
		const outcome = await forced();
		expect(tasks()).toEqual([]);
		expect(outcome.gone).toEqual([list]);
		expect(core.ctx.store.list(list)?.error?.kind).toBe("gone");
	});

	test("forced syncs arriving during a run share one follow-up run", async () => {
		let release = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		let homeListings = 0;
		fake.before = async (req, path) => {
			if (req.method === "PROPFIND" && path.endsWith("/calendars/u/")) {
				homeListings++;
				if (homeListings === 1) await gate;
			}
			return undefined;
		};
		core.clock.now += 60_000; // past the coalescing window of the setup sync
		const runs = [forced(), forced(), forced(), forced()];
		await Bun.sleep(20);
		release();
		await Promise.all(runs);
		expect(homeListings).toBe(2);
	});

	test("a sync never overwrites a copy stored by a write that happened meanwhile", () => {
		const t = task("a");
		const row = core.ctx.store.task(t.href);
		if (!row) throw new Error("no row");
		const stale = vtodo("a", ["DESCRIPTION:stale copy from a slow sync"]);
		// The sync began before the row was last stored: its copy is older and must lose.
		storeTask(
			core.ctx,
			t.list,
			row.href,
			{ text: stale, etag: '"old"' },
			row.syncedAt - 1,
		);
		expect(task("a").description).toBe("");
		// A sync that began after it may store its copy.
		storeTask(
			core.ctx,
			t.list,
			row.href,
			{ text: stale, etag: '"new"' },
			row.syncedAt,
		);
		expect(task("a").description).toBe("stale copy from a slow sync");
	});

	test("a failing list is reported, and the sync doesn't count as synced when all fail", async () => {
		const before = core.ctx.store.meta.lastSync;
		core.clock.now += 60_000;
		fake.before = async (req) =>
			req.method === "REPORT"
				? new Response("boom", { status: 500 })
				: undefined;
		const outcome = await forced();
		expect(outcome.failed).toEqual([list]);
		expect(core.ctx.store.list(list)?.error?.kind).toBe("unreachable");
		expect(core.ctx.store.meta.error).toContain("Errands");
		expect(core.ctx.store.meta.lastSync).toBe(before);
	});
});

describe("undo", () => {
	test("an undone change can't be undone twice; a refused one can't be undone", async () => {
		expect((await patch("a", { summary: "first" })).ok).toBe(true);
		const [entry] = journal();
		const id = entry?.id ?? 0;
		expect((await attempt(() => undo(core.ctx, id))).ok).toBe(true);
		const twice = await attempt(() => undo(core.ctx, id));
		expect(!twice.ok && twice.error.message).toContain("already undone");
		fake.before = async (req) =>
			req.method === "PUT" ? new Response("no", { status: 403 }) : undefined;
		expect((await patch("a", { summary: "refused" })).ok).toBe(false);
		fake.before = null;
		const [refused] = journal();
		expect(refused?.status).toBe("failed");
		const again = await attempt(() => undo(core.ctx, refused?.id ?? 0));
		expect(!again.ok && again.error.message).toContain("Only successful");
	});

	test("undo is marked by its own entry, not by the newest one", () => {
		const add = (op: "update" | "create", undoOf?: number) =>
			addJournal(core.ctx, {
				op,
				target: "x",
				before: null,
				after: null,
				status: "ok",
				...(undoOf === undefined ? {} : { undoOf }),
			});
		const original = add("update");
		const undoRow = add("update", original);
		add("create"); // another write lands before the undo is marked
		core.ctx.store.markUndone(original);
		expect(core.ctx.store.journalEntry(original)?.undoneBy).toBe(undoRow);
	});
});

test("a task created as in progress starts in progress", async () => {
	const res = await attempt(() =>
		createTask(core.ctx, {
			list,
			summary: "started",
			status: "IN-PROCESS",
		}),
	);
	if (!res.ok) throw new Error(res.error.message);
	expect(res.value.status).toBe("IN-PROCESS");
	expect(fake.get(`${list}${res.value.uid}.ics`)).toContain(
		"STATUS:IN-PROCESS",
	);
});

test("a list made here is made in Nextcloud for tasks; a rename goes there too and survives a sync", async () => {
	const made = await attempt(() =>
		createList(core.ctx, { name: "Garden & yard", color: "#7f9a1a" }),
	);
	if (!made.ok) throw new Error(made.error.message);
	expect(core.ctx.store.list(made.value)).toMatchObject({
		name: "Garden & yard",
		color: "#7f9a1a",
		components: ["VTODO"],
		writable: true,
	});
	expect(core.log).toContainEqual(expect.stringMatching(/^MKCALENDAR /));
	const there = [...fake.collections.values()].find((c) =>
		c.name.startsWith("Garden"),
	);
	expect(there?.components).toEqual(["VTODO"]);

	expect(
		(await attempt(() => renameList(core.ctx, made.value, "Garden"))).ok,
	).toBe(true);
	expect(there?.name).toBe("Garden");
	await forced();
	expect(core.ctx.store.list(made.value)?.name).toBe("Garden");

	// Read-only mode stops it before Nextcloud is asked.
	core.ctx.store.patchSettings({ readOnly: true });
	const requests = core.log.length;
	const refused = await attempt(() =>
		createList(core.ctx, { name: "No", color: "#7f9a1a" }),
	);
	expect(!refused.ok && refused.error.kind).toBe("paused");
	expect(core.log.length).toBe(requests);
});

test("a list made but not read back says so, and appears with the next sync", async () => {
	fake.before = async (req, path) =>
		req.method === "PROPFIND" &&
		path === HOME &&
		fake.log.some((l) => l.startsWith("MKCALENDAR "))
			? new Response("busy", { status: 503 })
			: undefined;
	const err = await attempt(() =>
		createList(core.ctx, { name: "Garden", color: "#7f9a1a" }),
	);
	expect(!err.ok && err.error.message).toContain("don't add it again");
	fake.before = null;
	await forced();
	expect(
		core.ctx.store.lists().filter((c) => c.name === "Garden"),
	).toHaveLength(1);
});

test("a list shared read-only isn't renamed, and Nextcloud isn't asked", async () => {
	const shared = fake.addList("shared", "Shared", ["VTODO"], false);
	await forced();
	const err = await attempt(() => renameList(core.ctx, shared, "Mine"));
	expect(!err.ok && err.error.kind).toBe("refused");
	expect(fake.log.some((l) => l.startsWith("PROPPATCH "))).toBe(false);
});

test("deleting a list deletes it in Nextcloud with its tasks; one that also holds events isn't", async () => {
	const personal = fake.addList("personal", "Personal", ["VEVENT", "VTODO"]);
	await forced();
	const err = await attempt(() => deleteList(core.ctx, personal));
	expect(!err.ok && err.error.message).toContain("also holds calendar events");
	expect(fake.collections.has(`${HOME}personal/`)).toBe(true);

	expect((await attempt(() => deleteList(core.ctx, list))).ok).toBe(true);
	expect(fake.collections.has(list)).toBe(false);
	expect(tasks()).toEqual([]);
	await forced();
	expect(core.ctx.store.lists().some((c) => c.name === "Errands")).toBe(false);
});
