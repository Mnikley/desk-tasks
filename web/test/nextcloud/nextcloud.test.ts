// The core against a real, throwaway Nextcloud (run with `bun run test:nextcloud`).
// Ported from timesheet: the "adapter via the app API" cases now drive the core's functions,
// through a transparent proxy that counts requests and injects the faults a server can't be
// asked for (a differing read-back, a lost answer).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CaldavClient, CaldavError } from "../../src/core/caldav.ts";
import { moveToList } from "../../src/core/cascade.ts";
import { attempt } from "../../src/core/ctx.ts";
import type { Failure } from "../../src/core/errors.ts";
import {
	applyOrder,
	compareManual,
	reorderPlan,
} from "../../src/core/order.ts";
import { sync } from "../../src/core/sync.ts";
import { listTasks, type TaskView } from "../../src/core/tasks.ts";
import { journaled, undoSteps } from "../../src/core/undo.ts";
import {
	type Change,
	createTask,
	deleteTask,
	moveTask,
	undo,
	updateTask,
} from "../../src/core/write.ts";
import { diff, fixture, type TestCore, testCore } from "../helpers.ts";
import { fetchTransport } from "../transport.ts";
import {
	CAL_HOME,
	deleteObject,
	getObject,
	mkcalendar,
	putObject,
	USER,
} from "./harness.ts";
import { startProxy, type TestProxy } from "./proxy.ts";

const URL_ = process.env.NEXTCLOUD_TEST_URL ?? "";
const APP_PASSWORD = process.env.NEXTCLOUD_APP_PASSWORD ?? "";
const enabled = URL_ !== "" && APP_PASSWORD !== "";
const suffix = Date.now().toString(36);

const client = () =>
	new CaldavClient(
		URL_,
		fetchTransport({ user: USER.name, password: APP_PASSWORD }),
	);

describe.skipIf(!enabled)("CalDAV client (real Nextcloud)", () => {
	let dc: CaldavClient;
	let work: string;
	let events: string;
	beforeAll(async () => {
		dc = client();
		work = await mkcalendar(`work-${suffix}`, "Work", ["VTODO"], "#FF7A00");
		events = await mkcalendar(`events-${suffix}`, "Meetings", ["VEVENT"]);
	});

	test("discovery finds task lists with colour, components and write access", async () => {
		const { home, collections } = await dc.discover();
		expect(home).toBe(CAL_HOME);
		const w = collections.find((c) => c.href === work);
		expect(w).toMatchObject({
			name: "Work",
			color: "#ff7a00",
			components: ["VTODO"],
			writable: true,
		});
		expect(collections.find((c) => c.href === events)?.components).toEqual([
			"VEVENT",
		]);
		// Inbox, outbox and trash bin are not calendars.
		expect(collections.some((c) => /inbox|outbox|trashbin/.test(c.href))).toBe(
			false,
		);
		expect(await dc.version()).toBe(process.env.NEXTCLOUD_VERSION ?? null);
	});

	test("GET returns the stored bytes, mixed line endings included", async () => {
		const text = await fixture("planify-task.ics");
		const href = `${work}planify-${suffix}.ics`;
		const etag = await putObject(href, text);
		const got = await dc.get(href);
		expect(got?.text).toBe(text);
		expect(got?.etag).toBe(etag);
		expect(got?.binary).toBe(false);
	});

	test("sync-collection reports changes and deletions", async () => {
		const first = await dc.changes(work, null);
		const href = `${work}sync-${suffix}.ics`;
		await putObject(href, await fixture("tasksorg-allday.ics"));
		const second = await dc.changes(work, first.token);
		expect(second.changed.map((c) => c.href)).toEqual([href]);
		await deleteObject(href);
		const third = await dc.changes(work, second.token);
		expect(third.deleted).toContain(href);
		expect(third.changed).toEqual([]);
		expect(await dc.etag(href)).toBeNull();
	});

	test("a malformed sync token is refused with valid-sync-token", async () => {
		const err = await dc.changes(work, "bogus").catch((e: unknown) => e);
		expect(err).toBeInstanceOf(CaldavError);
		expect((err as CaldavError).condition).toBe("valid-sync-token");
	});

	test("If-Match protects PUT, DELETE and MOVE", async () => {
		const href = `${work}guard-${suffix}.ics`;
		const etag = await putObject(href, await fixture("tasksorg-completed.ics"));
		for (const op of [
			() =>
				dc.put(href, "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", {
					ifMatch: '"stale"',
				}),
			() => dc.delete(href, '"stale"'),
			() => dc.move(href, `${work}moved-${suffix}.ics`, '"stale"'),
		]) {
			const err = await op().catch((e: unknown) => e);
			expect((err as CaldavError).status).toBe(412);
		}
		expect((await getObject(href))?.etag).toBe(etag);
	});

	test("MOVE keeps every byte and the ETag", async () => {
		const other = await mkcalendar(`home-${suffix}`, "Home", ["VTODO"]);
		const text = await fixture("kitchen-sink.ics");
		const href = `${work}move-${suffix}.ics`;
		const etag = await putObject(href, text);
		const dest = `${other}move-${suffix}-2.ics`;
		await dc.move(href, dest, etag);
		expect(await getObject(href)).toBeNull();
		expect(await getObject(dest)).toEqual({ text, etag });
		expect((await dc.list(other)).map((l) => l.href)).toEqual([dest]);
	});

	test("hrefs outside the DAV root are refused", () => {
		expect(() => dc.url("https://evil.example/remote.php/dav/x")).toThrow(
			CaldavError,
		);
		expect(() => dc.url("/index.php/apps/files")).toThrow(CaldavError);
	});

	test("a list made by MKCALENDAR holds tasks only, with its name and colour; PROPPATCH renames it", async () => {
		const href = `${CAL_HOME}made-${suffix}/`;
		await dc.createList(href, "Garden & yard", "#7f9a1a");
		const listed = async () =>
			(await dc.collections(CAL_HOME)).find((c) => c.href === href);
		expect(await listed()).toMatchObject({
			name: "Garden & yard",
			color: "#7f9a1a",
			components: ["VTODO"],
			writable: true,
		});
		await dc.rename(href, "Garden");
		expect((await listed())?.name).toBe("Garden");
	});
});

describe.skipIf(!enabled)("the core (real Nextcloud)", () => {
	let proxy: TestProxy;
	let core: TestCore;
	let list: string;
	let other: string;
	const hrefs: Record<string, string> = {};
	const uids: Record<string, string> = {};

	const tasks = () => listTasks(core.ctx);
	const task = (name: string): TaskView => {
		const t = tasks().find((x) => x.uid === uids[name] && x.list === list);
		if (!t) throw new Error(`task ${name} not found`);
		return t;
	};
	const remote = async (name: string) => {
		const o = await getObject(hrefs[name] ?? "");
		if (!o) throw new Error(`${name} missing in Nextcloud`);
		return o;
	};
	const forced = () => sync(core.ctx, { force: true });
	const patch = (name: string, change: Change) =>
		attempt(() => updateTask(core.ctx, task(name).href, change));
	const ok = async <T>(
		p: Promise<{ ok: true; value: T } | { ok: false; error: Failure }>,
	) => {
		const r = await p;
		if (!r.ok) throw new Error(`${r.error.kind}: ${r.error.message}`);
		return r.value;
	};
	const failed = async (p: Promise<{ ok: boolean; error?: Failure }>) => {
		const r = await p;
		if (r.ok || !r.error) throw new Error("expected a failure");
		return r.error;
	};
	const resume = () => core.ctx.store.patchSettings({ paused: null });

	beforeAll(async () => {
		proxy = startProxy(URL_);
		list = await mkcalendar(
			`app-${suffix}`,
			`Errands ${suffix}`,
			["VTODO"],
			"#3A5BD9",
		);
		other = await mkcalendar(`app2-${suffix}`, `Someday ${suffix}`, ["VTODO"]);
		await mkcalendar(`appev-${suffix}`, `Team ${suffix}`, ["VEVENT"]);
		for (const name of [
			"tasksorg-subtask.ics",
			"tasksorg-completed.ics",
			"tasksorg-allday.ics",
			"planify-task.ics",
			"planify-completed.ics",
			"planify-allday.ics",
			"planify-section.ics",
			"kitchen-sink.ics",
		]) {
			hrefs[name] = `${list}${name}`;
			const text = await fixture(name);
			uids[name] = /\nUID:([^\r\n]+)/.exec(text)?.[1] ?? "";
			await putObject(hrefs[name], text);
		}
		core = testCore({
			url: proxy.url,
			now: Date.now(),
			user: USER.name,
			password: APP_PASSWORD,
		});
		// A real clock: the core's journal, merge and reconcile timing see real time.
		core.ctx.now = () => Date.now();
		await forced();
	});
	afterAll(() => proxy?.stop());

	test("connecting discovers lists with colours, the version and every task", () => {
		expect(core.ctx.store.meta.version).toBe(
			process.env.NEXTCLOUD_VERSION ?? "",
		);
		expect(core.ctx.store.list(list)).toMatchObject({
			color: "#3a5bd9",
			writable: true,
			components: ["VTODO"],
		});
		// Event-only calendars aren't task lists.
		expect(
			core.ctx.store.lists().some((l) => l.name === `Team ${suffix}`),
		).toBe(false);
		// Seven tasks plus Planify's section, which is not a task.
		expect(tasks().filter((t) => t.list === list)).toHaveLength(7);
	});

	test("fields are read the way tasks.org and Planify write them", () => {
		expect(task("tasksorg-subtask.ics")).toMatchObject({
			summary: "Prepare quarterly report",
			priority: "high",
			status: "NEEDS-ACTION",
			tags: ["work", "finance"],
			due: { date: "2026-10-22", minutes: 14 * 60 + 30, zone: "Europe/Berlin" },
		});
		expect(task("planify-task.ics")).toMatchObject({
			priority: "high",
			section: "Errands",
			parentUid: null,
			due: { zone: null },
		});
		expect(task("planify-allday.ics").priority).toBe("low");
		expect(task("planify-completed.ics").status).toBe("COMPLETED");
		expect(task("kitchen-sink.ics").status).toBe("IN-PROCESS");
	});

	test("an edit changes only the touched property; everything else stays byte-identical", async () => {
		for (const name of [
			"kitchen-sink.ics",
			"planify-task.ics",
			"tasksorg-subtask.ics",
		]) {
			const before = (await remote(name)).text;
			await ok(patch(name, { summary: `Renamed ${name}` }));
			const d = diff(before, (await remote(name)).text);
			const props = (lines: string[]) =>
				lines.map((l) => l.split(/[;:]/)[0]).sort();
			const bookkeeping = before.includes("LAST-MODIFIED")
				? ["DTSTAMP", "LAST-MODIFIED", "SUMMARY"]
				: ["DTSTAMP", "SUMMARY"];
			expect(props(d.removed)).toEqual(bookkeeping);
			expect(props(d.added)).toEqual(bookkeeping);
		}
		// Planify's mixed line endings and LF VALARM survive.
		const p = (await remote("planify-task.ics")).text;
		expect(p.startsWith("BEGIN:VCALENDAR\nVERSION:2.0\n")).toBe(true);
		expect(p).toContain(
			"BEGIN:VALARM\nTRIGGER;VALUE=DATE-TIME:20261021T123000Z\nACTION:DISPLAY\n",
		);
	});

	test("completing and re-opening write what all three clients read", async () => {
		await ok(patch("tasksorg-allday.ics", { status: "COMPLETED" }));
		let text = (await remote("tasksorg-allday.ics")).text;
		expect(text).toContain("STATUS:COMPLETED\r\n");
		expect(text).toContain("PERCENT-COMPLETE:100\r\n");
		expect(text).toMatch(/\r\nCOMPLETED:\d{8}T\d{6}Z\r\n/);
		await ok(patch("tasksorg-allday.ics", { status: "NEEDS-ACTION" }));
		text = (await remote("tasksorg-allday.ics")).text;
		expect(text).toContain("STATUS:NEEDS-ACTION\r\n");
		expect(text).not.toMatch(/\r\n(COMPLETED|PERCENT-COMPLETE):/);
		// Alarm and start date untouched.
		expect(text).toContain("DTSTART;VALUE=DATE:20261023\r\n");
		expect(text).toContain("TRIGGER;RELATED=END:PT0S\r\n");
	});

	test("start, pin, privacy, location, link and progress write only their own lines", async () => {
		const before = (await remote("tasksorg-subtask.ics")).text;
		await ok(
			patch("tasksorg-subtask.ics", {
				start: { date: "2026-10-20", minutes: 8 * 60 },
				pinned: true,
				klass: "CONFIDENTIAL",
				location: "Office",
				url: "https://example.com/q4",
				progress: 30,
			}),
		);
		const d = diff(before, (await remote("tasksorg-subtask.ics")).text);
		const props = (lines: string[]) =>
			[...new Set(lines.map((l) => l.split(/[;:]/)[0]))].sort();
		expect(props(d.added)).toEqual(
			[
				"CLASS",
				"DTSTAMP",
				"DTSTART",
				"LAST-MODIFIED",
				"LOCATION",
				"PERCENT-COMPLETE",
				"STATUS",
				"URL",
				"X-PINNED",
			].filter(
				(p) => before.includes("LAST-MODIFIED") || p !== "LAST-MODIFIED",
			),
		);
		// A new timed start floats; the due keeps its zone.
		expect(d.added).toContain("DTSTART:20261020T080000\r\n");
		expect(task("tasksorg-subtask.ics")).toMatchObject({
			pinned: true,
			klass: "CONFIDENTIAL",
			location: "Office",
			status: "IN-PROCESS",
		});
	});

	test("reminders: a relative and an absolute VALARM are added, one removed; nothing else changes", async () => {
		const before = (await remote("planify-task.ics")).text;
		await ok(
			patch("planify-task.ics", {
				reminders: {
					add: [
						{ kind: "relative", related: "END", seconds: -3600 },
						{ kind: "absolute", at: Date.UTC(2026, 9, 21, 9, 0) },
					],
				},
			}),
		);
		const added = (await remote("planify-task.ics")).text;
		const d = diff(before, added);
		expect(d.removed.map((l) => l.split(":")[0])).toEqual(["DTSTAMP"]);
		expect(d.added.filter((l) => !l.startsWith("DTSTAMP")).join("")).toBe(
			"BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Renamed planify-task.ics\r\nTRIGGER;RELATED=END:-PT1H\r\nEND:VALARM\r\n" +
				"BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Renamed planify-task.ics\r\nTRIGGER;VALUE=DATE-TIME:20261021T090000Z\r\nEND:VALARM\r\n",
		);
		// Planify's own LF alarm is still there, byte for byte.
		expect(added).toContain(
			"BEGIN:VALARM\nTRIGGER;VALUE=DATE-TIME:20261021T123000Z\nACTION:DISPLAY\n",
		);
		const hour = task("planify-task.ics").reminders.find(
			(r) => r.label === "1 hour before",
		);
		await ok(
			patch("planify-task.ics", { reminders: { remove: [hour?.key ?? ""] } }),
		);
		const after = (await remote("planify-task.ics")).text;
		expect(after).not.toContain("TRIGGER;RELATED=END:-PT1H");
		expect(after).toContain("TRIGGER;VALUE=DATE-TIME:20261021T090000Z");
		expect(task("planify-task.ics").reminders).toHaveLength(2);
	});

	test("all-day, time-zone and floating due dates round-trip unchanged through other edits", async () => {
		const dueLine = (t: string) => /\r?\nDUE[^\r\n]*/.exec(t)?.[0];
		for (const name of [
			"tasksorg-allday.ics",
			"tasksorg-subtask.ics",
			"planify-task.ics",
			"kitchen-sink.ics",
		]) {
			const before = dueLine((await remote(name)).text);
			await ok(patch(name, { priority: "medium" }));
			expect(dueLine((await remote(name)).text)).toBe(before);
		}
	});

	test("dragging to another day changes only the due date, keeping zone and time across DST", async () => {
		const before = (await remote("tasksorg-subtask.ics")).text;
		const t = await ok(
			patch("tasksorg-subtask.ics", { dueDate: "2026-10-26" }),
		);
		expect(t?.due).toMatchObject({
			date: "2026-10-26",
			minutes: 14 * 60 + 30,
			zone: "Europe/Berlin",
		});
		expect(t?.due?.at).toBe(Date.UTC(2026, 9, 26, 13, 30, 1)); // CET after the switch
		const d = diff(before, (await remote("tasksorg-subtask.ics")).text);
		expect(d.added.filter((l) => l.startsWith("DUE"))).toEqual([
			"DUE;TZID=Europe/Berlin:20261026T143001\r\n",
		]);
		await ok(patch("tasksorg-allday.ics", { dueDate: "2026-10-30" }));
		expect((await remote("tasksorg-allday.ics")).text).toContain(
			"DUE;VALUE=DATE:20261030\r\n",
		);
	});

	test("a due date before the task's start is refused without a request", async () => {
		const n = proxy.writes().length;
		const err = await failed(
			patch("tasksorg-allday.ics", { dueDate: "2026-10-20" }),
		);
		expect(err.kind).toBe("invalid");
		expect(err.message).toContain("starts on 23.10.2026");
		expect(proxy.writes().length).toBe(n);
	});

	test("412 with a remote change to other fields merges automatically", async () => {
		const r = await remote("planify-allday.ics");
		await putObject(
			hrefs["planify-allday.ics"] ?? "",
			r.text.replace(
				"SUMMARY:Water the plants",
				"SUMMARY:Water the plants (balcony)",
			),
			r.etag,
		);
		const t = await ok(patch("planify-allday.ics", { priority: "high" }));
		expect(t).toMatchObject({
			summary: "Water the plants (balcony)",
			priority: "high",
		});
		const text = (await remote("planify-allday.ics")).text;
		expect(text).toContain("SUMMARY:Water the plants (balcony)");
		expect(text).toContain("PRIORITY:1\r\n");
		expect(core.ctx.store.journal()[0]?.message).toContain("merged");
	});

	test("412 with an overlapping remote change raises a conflict and writes nothing", async () => {
		const r = await remote("planify-allday.ics");
		const theirs = r.text.replace("PRIORITY:1", "PRIORITY:9");
		await putObject(hrefs["planify-allday.ics"] ?? "", theirs, r.etag);
		const err = await failed(
			patch("planify-allday.ics", { priority: "medium" }),
		);
		expect(err.kind).toBe("conflict");
		expect(err.conflict).toMatchObject({
			mine: { priority: "medium" },
			theirs: { priority: "low" },
		});
		expect((await remote("planify-allday.ics")).text).toBe(theirs);
		// The core now shows their version.
		expect(task("planify-allday.ics").priority).toBe("low");
	});

	test("undo restores the exact bytes, and is refused after a later remote edit", async () => {
		const before = (await remote("tasksorg-completed.ics")).text;
		await ok(patch("tasksorg-completed.ics", { tags: ["errand"] }));
		let id = core.ctx.store.journal()[0]?.id ?? 0;
		await ok(attempt(() => undo(core.ctx, id)));
		expect((await remote("tasksorg-completed.ics")).text).toBe(before);

		await ok(
			patch("tasksorg-completed.ics", { summary: "Renew passport soon" }),
		);
		id = core.ctx.store.journal()[0]?.id ?? 0;
		const r = await remote("tasksorg-completed.ics");
		const theirs = r.text.replace("SEQUENCE:2", "SEQUENCE:3");
		await putObject(hrefs["tasksorg-completed.ics"] ?? "", theirs, r.etag);
		const err = await failed(attempt(() => undo(core.ctx, id)));
		expect(err.kind).toBe("conflict");
		expect((await remote("tasksorg-completed.ics")).text).toBe(theirs);
	});

	test("deletes are detected via sync-collection; a re-created href is not lost", async () => {
		const href = `${list}gone-${suffix}.ics`;
		const text = (await fixture("tasksorg-allday.ics")).replace(
			"UID:1938475610293847561",
			`UID:gone-${suffix}`,
		);
		await putObject(href, text);
		await forced();
		expect(tasks().some((t) => t.uid === `gone-${suffix}`)).toBe(true);
		await deleteObject(href);
		await forced();
		expect(tasks().some((t) => t.uid === `gone-${suffix}`)).toBe(false);
		// Deleted and re-created between two syncs: Nextcloud reports a 404 for a live object.
		const back = `${list}back-${suffix}.ics`;
		const text2 = text.replace(`UID:gone-${suffix}`, `UID:back-${suffix}`);
		await putObject(back, text2);
		await forced();
		await deleteObject(back);
		await putObject(back, text2);
		await forced();
		expect(tasks().some((t) => t.uid === `back-${suffix}`)).toBe(true);
	});

	test("create, subtasks, move with subtasks and undo of the move", async () => {
		const parent = await ok(
			attempt(() =>
				createTask(core.ctx, {
					list,
					summary: "Plan trip",
					priority: "low",
					tags: ["travel"],
					due: { date: "2026-11-02", minutes: null },
				}),
			),
		);
		const child = await ok(
			attempt(() =>
				createTask(core.ctx, { parent: parent.href, summary: "Book train" }),
			),
		);
		expect(child).toMatchObject({ parentUid: parent.uid, list });
		const all = await getObject(`${list}${child.uid}.ics`);
		expect(all?.text).toContain(`RELATED-TO:${parent.uid}\r\n`);
		const p = await getObject(`${list}${parent.uid}.ics`);
		expect(p?.text).toContain(
			"PRIORITY:9\r\nCATEGORIES:travel\r\nDUE;VALUE=DATE:20261102\r\n",
		);
		expect(p?.text).toContain("PRODID:-//desk-tasks//Nextcloud tasks//EN\r\n");

		const moved = await ok(
			attempt(() => moveTask(core.ctx, parent.href, other)),
		);
		expect(moved.list).toBe(other);
		expect(moved.id).toBe(parent.id);
		const inOther = await client().list(other);
		expect(inOther).toHaveLength(2);
		for (const o of inOther)
			expect([p?.text, all?.text]).toContain((await getObject(o.href))?.text);
		expect(await getObject(`${list}${parent.uid}.ics`)).toBeNull();

		await ok(
			attempt(() => undo(core.ctx, core.ctx.store.journal()[0]?.id ?? 0)),
		);
		expect(tasks().find((x) => x.id === parent.id)?.list).toBe(list);
	});

	test("a subtask moved alone arrives top-level; Undo puts it back under its parent and a sync keeps it", async () => {
		const parent = await ok(
			attempt(() => createTask(core.ctx, { list, summary: "Renovate" })),
		);
		const child = await ok(
			attempt(() =>
				createTask(core.ctx, { parent: parent.href, summary: "Buy paint" }),
			),
		);
		const before = (await getObject(child.href))?.text;
		const res = await ok(
			attempt(() =>
				journaled(core.ctx, (g) => moveToList(g, child.href, other)),
			),
		);
		const moved = tasks().find((t) => t.uid === child.uid);
		expect(moved).toMatchObject({ list: other, parentUid: null });
		await undoSteps(core.ctx, res.steps);
		expect((await getObject(child.href))?.text).toBe(before);
		await forced();
		expect(tasks().find((t) => t.uid === child.uid)).toMatchObject({
			href: child.href,
			parentUid: parent.uid,
		});
	});

	test("delete with subtasks, then undo restores the bytes", async () => {
		const parent = await ok(
			attempt(() => createTask(core.ctx, { list, summary: "Tidy cellar" })),
		);
		await ok(
			attempt(() =>
				createTask(core.ctx, { parent: parent.href, summary: "Sort boxes" }),
			),
		);
		const before = await getObject(`${list}${parent.uid}.ics`);
		const res = await ok(attempt(() => deleteTask(core.ctx, parent.href)));
		expect(res.deleted).toBe(2);
		expect(await getObject(`${list}${parent.uid}.ics`)).toBeNull();
		const del = core.ctx.store
			.journal()
			.find((j) => j.op === "delete" && j.before?.href === parent.href);
		await ok(attempt(() => undo(core.ctx, del?.id ?? 0)));
		expect((await getObject(`${list}${parent.uid}.ics`))?.text).toBe(
			before?.text,
		);
	});

	test("manual order writes only the moved and bumped tasks, read back byte-exact", async () => {
		const ordered = await mkcalendar(`order-${suffix}`, `Order ${suffix}`, [
			"VTODO",
		]);
		for (const [uid, n] of [
			["o1", 0],
			["o2", 0],
			["o3", 782563200],
		] as const)
			await putObject(
				`${ordered}${uid}.ics`,
				`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:x\r\nBEGIN:VTODO\r\nUID:${uid}-${suffix}\r\nDTSTAMP:20261020T000000Z\r\nSUMMARY:${uid}\r\nX-APPLE-SORT-ORDER:${n}\r\nEND:VTODO\r\nEND:VCALENDAR\r\n`,
			);
		await forced();
		const sibs = tasks()
			.filter((t) => t.list === ordered)
			.sort(compareManual);
		const before = await Promise.all(sibs.map((t) => getObject(t.href)));
		const plan = reorderPlan(sibs, sibs[2] as never, 0); // o3 to the top
		expect(plan.map((p) => p.order)).toEqual([0, 1, 2]);
		const n = proxy.writes().length;
		await ok(attempt(() => journaled(core.ctx, (g) => applyOrder(g, plan))));
		expect(proxy.writes().length - n).toBe(3);
		expect(
			tasks()
				.filter((t) => t.list === ordered)
				.sort(compareManual)
				.map((t) => t.summary),
		).toEqual(["o3", "o1", "o2"]);
		for (const [i, t] of sibs.entries()) {
			const d = diff(
				before[i]?.text ?? "",
				(await getObject(t.href))?.text ?? "",
			);
			expect(d.added.map((l) => l.split(":")[0]).sort()).toEqual([
				"DTSTAMP",
				"X-APPLE-SORT-ORDER",
			]);
			// What the core stored is exactly what Nextcloud holds.
			expect(core.ctx.store.task(t.href)?.ics).toBe(
				(await getObject(t.href))?.text,
			);
		}
	});

	test("a weekly COUNT task advances in place; RRULE + DUE without DTSTART is stored byte for byte", async () => {
		const href = `${list}rec-${suffix}.ics`;
		const text = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:x\r\nBEGIN:VTODO\r\nUID:rec-${suffix}\r\nDTSTAMP:20261020T000000Z\r\nSUMMARY:Water plants\r\nDUE;VALUE=DATE:20261021\r\nRRULE:FREQ=WEEKLY;COUNT=3\r\nEND:VTODO\r\nEND:VCALENDAR\r\n`;
		await putObject(href, text);
		// An open question settled: does Nextcloud rewrite an RRULE without DTSTART? It must not.
		expect((await getObject(href))?.text).toBe(text);
		await forced();
		const t = tasks().find((x) => x.uid === `rec-${suffix}`);
		expect(t?.readOnly).toBeNull();
		expect(t?.repeat?.text).toBe("Weekly · 3 more times");
		const done = await ok(
			attempt(() => updateTask(core.ctx, href, { status: "COMPLETED" })),
		);
		expect(done).toMatchObject({
			status: "NEEDS-ACTION",
			due: { date: "2026-10-28" },
		});
		const after = (await getObject(href))?.text ?? "";
		const d = diff(text, after);
		expect(d.added.map((l) => l.split(/[;:]/)[0]).sort()).toEqual([
			"DTSTAMP",
			"DUE",
			"RRULE",
			"STATUS",
		]);
		expect(after).toContain("RRULE:FREQ=WEEKLY;COUNT=2\r\n");
		expect(after).not.toContain("DTSTART");
	});

	test("a repeating task with occurrence overrides is read-only: nothing is sent", async () => {
		const href = `${list}ovr-${suffix}.ics`;
		await putObject(
			href,
			`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:x\r\nBEGIN:VTODO\r\nUID:ovr-${suffix}\r\nDTSTAMP:20261020T000000Z\r\nDTSTART;VALUE=DATE:20261021\r\nSUMMARY:Series\r\nRRULE:FREQ=WEEKLY\r\nEND:VTODO\r\nBEGIN:VTODO\r\nUID:ovr-${suffix}\r\nDTSTAMP:20261020T000000Z\r\nRECURRENCE-ID;VALUE=DATE:20261028\r\nSUMMARY:Series (moved)\r\nEND:VTODO\r\nEND:VCALENDAR\r\n`,
		);
		await forced();
		const t = tasks().find((x) => x.uid === `ovr-${suffix}`);
		expect(t?.readOnly).toContain("changed in another app");
		const n = proxy.writes().length;
		const err = await failed(
			attempt(() => updateTask(core.ctx, href, { status: "COMPLETED" })),
		);
		expect(err.kind).toBe("refused");
		expect(proxy.writes().length).toBe(n);
	});

	test("the read-only switch sends zero write requests", async () => {
		core.ctx.store.patchSettings({ readOnly: true });
		const n = proxy.writes().length;
		const href = task("planify-task.ics").href;
		for (const p of [
			attempt(() => updateTask(core.ctx, href, { summary: "x" })),
			attempt(() => createTask(core.ctx, { list, summary: "x" })),
			attempt(() => deleteTask(core.ctx, href)),
			attempt(() => moveTask(core.ctx, href, other)),
		])
			expect((await failed(p)).message).toContain("read-only");
		expect(proxy.writes().length).toBe(n);
		core.ctx.store.patchSettings({ readOnly: false });
	});

	test("a read-back mismatch pauses all writes", async () => {
		proxy.tamperGet = hrefs["planify-completed.ics"] ?? "";
		const err = await failed(
			patch("planify-completed.ics", { summary: "Pay rent (Nov)" }),
		);
		proxy.tamperGet = null;
		expect(err.kind).toBe("paused");
		expect(core.ctx.store.settings.paused?.reason).toContain(
			"read back differently",
		);
		const n = proxy.writes().length;
		expect(
			(await failed(patch("planify-task.ics", { summary: "y" }))).message,
		).toContain("paused");
		expect(proxy.writes().length).toBe(n);
		expect(core.ctx.store.journal()[0]?.status).toBe("mismatch");
		resume();
	});

	test("a lost answer pauses writes", async () => {
		proxy.garbleNextWrite = true;
		const err = await failed(
			patch("planify-task.ics", { description: "lost?" }),
		);
		expect(err.kind).toBe("paused");
		expect(core.ctx.store.settings.paused?.reason).toContain("may or may not");
		resume();
		await forced();
	});

	test("a server error after a write, or a failed read-back, pauses writes", async () => {
		proxy.error500NextWrite = true;
		await failed(patch("planify-task.ics", { description: "maybe saved" }));
		expect(core.ctx.store.settings.paused?.reason).toContain("unknown");
		resume();
		await forced();

		proxy.failGet = hrefs["planify-task.ics"] ?? "";
		await failed(
			patch("planify-task.ics", { description: "saved, not verified" }),
		);
		proxy.failGet = null;
		expect(core.ctx.store.settings.paused?.reason).toContain("unknown");
		expect(core.ctx.store.journal()[0]?.status).toBe("mismatch");
		resume();
		await forced();
	});

	test("a list that fails to sync is reported, not shown as synced", async () => {
		proxy.failCollection = other;
		await forced();
		proxy.failCollection = null;
		expect(core.ctx.store.meta.error).toContain("couldn't be synced");
		expect(core.ctx.store.meta.error).toContain(`Someday ${suffix}`);
		expect(core.ctx.store.list(other)?.error).not.toBeNull();
		await forced();
		expect(core.ctx.store.meta.error).toBeNull();
	});
});
