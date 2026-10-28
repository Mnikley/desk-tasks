// The task list built from stored bytes: Planify sections, the sort-order fallback, read-only
// reasons, and writes refused before anything is sent. Ported from timesheet's tasks.test.ts
// (its plans, time links, stats and backup aren't part of desk-tasks).
import { beforeEach, describe, expect, test } from "bun:test";
import { attempt, type Ctx, consoleLogger } from "../src/core/ctx.ts";
import { type ListRecord, Store } from "../src/core/store.ts";
import { listTasks } from "../src/core/tasks.ts";
import { updateTask } from "../src/core/write.ts";
import { at, listRecord as baseList, fixture, TZ } from "./helpers.ts";

const LIST = "/remote.php/dav/calendars/u/errands/";
const PLANIFY = "8c1f3a52-6d0e-4b7a-9f21-3e5d7c4a1b90";
const TASKSORG = "6352917440981726354";

let ctx: Ctx;

const listRecord = (o: Partial<ListRecord> = {}): ListRecord =>
	baseList({ href: LIST, ...o });

/** Stores tasks as if a sync had fetched them. */
async function seed(names: string[], opts: { writable?: boolean } = {}) {
	ctx.store.putList(listRecord({ writable: opts.writable ?? true }));
	for (const n of names) {
		const ics = await fixture(n);
		ctx.store.putTask(
			{
				href: `${LIST}${n}`,
				list: LIST,
				etag: '"e"',
				ics,
				notUtf8: false,
				uid: /UID:([^\r\n]+)/.exec(ics)?.[1] ?? "",
			},
			0,
		);
	}
}

const byUid = (uid: string) => {
	const t = listTasks(ctx).find((x) => x.uid === uid);
	if (!t) throw new Error(`no task ${uid}`);
	return t;
};

beforeEach(() => {
	ctx = {
		store: new Store(),
		dav: null,
		now: () => at("2026-10-20", "09:00"),
		tz: TZ,
		log: consoleLogger,
	};
});

describe("task list", () => {
	test("Planify sections become a label, not a task", async () => {
		await seed([
			"planify-task.ics",
			"planify-section.ics",
			"tasksorg-subtask.ics",
		]);
		expect(
			listTasks(ctx)
				.map((t) => t.summary)
				.sort(),
		).toEqual(["Call Bob", "Prepare quarterly report"]);
		expect(byUid(PLANIFY)).toMatchObject({
			section: "Errands",
			parentUid: null,
			list: LIST,
		});
		expect(byUid(TASKSORG).parentUid).toBe("4824967301958274615");
	});

	test("sort order: X-APPLE-SORT-ORDER, else CREATED in Apple-epoch seconds", async () => {
		await seed(["planify-task.ics", "tasksorg-allday.ics"]);
		expect(byUid(PLANIFY).sortOrder).toBe(3);
		// CREATED 2026-10-20T09:14:55Z
		expect(byUid("1938475610293847561").sortOrder).toBe(
			Date.UTC(2026, 9, 20, 9, 14, 55) / 1000 - 978_307_200,
		);
	});

	test("view-only lists and recurring tasks say why", async () => {
		await seed(["planify-task.ics"], { writable: false });
		expect(byUid(PLANIFY).readOnly).toContain("view only");
		ctx.store.patchList(LIST, { writable: true });
		ctx.store.putTask(
			{
				href: "/r.ics",
				list: LIST,
				etag: '"r"',
				uid: "rec",
				notUtf8: false,
				ics: "BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:rec\r\nSUMMARY:Water plants\r\nRRULE:FREQ=WEEKLY\r\nEND:VTODO\r\nEND:VCALENDAR\r\n",
			},
			0,
		);
		expect(byUid("rec")).toMatchObject({
			recurring: true,
			readOnly: expect.stringContaining("Recurring"),
		});
	});

	test("a task that isn't UTF-8 is read-only", async () => {
		await seed([]);
		ctx.store.putTask(
			{
				href: `${LIST}bin.ics`,
				list: LIST,
				etag: '"b"',
				uid: "bin",
				notUtf8: true,
				ics: "BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:bin\r\nSUMMARY:B�\r\nEND:VTODO\r\nEND:VCALENDAR\r\n",
			},
			0,
		);
		expect(byUid("bin").readOnly).toContain("UTF-8");
	});

	test("lists gone from Nextcloud are not shown", async () => {
		await seed(["planify-task.ics"]);
		ctx.store.patchList(LIST, {
			error: { kind: "gone", message: "gone", action: "" },
		});
		expect(listTasks(ctx)).toEqual([]);
	});

	test("writes need a connection and are refused before anything is sent", async () => {
		await seed(["planify-task.ics"]);
		const res = await attempt(() =>
			updateTask(ctx, byUid(PLANIFY).href, { summary: "x" }),
		);
		expect(!res.ok && res.error.kind).toBe("not-connected");
		const empty = await attempt(() =>
			updateTask(ctx, byUid(PLANIFY).href, { summary: "  " }),
		);
		expect(!empty.ok && empty.error.kind).toBe("invalid");
	});
});
