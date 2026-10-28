// What the views show: Today is Nextcloud's rule (start or due today or earlier), overdue folds
// above five, Upcoming is 7 days then weeks, a list is its tree in My order with the completed
// folded, filters, due chips.
import { describe, expect, test } from "bun:test";
import type { ListRecord } from "../src/core/store.ts";
import type { TaskView } from "../src/core/tasks.ts";
import {
	buildView,
	dueChip,
	type Filter,
	NO_FILTER,
	shownLists,
	type ViewInput,
	visibleRows,
} from "../src/ui/model.ts";
import { listRecord } from "./helpers.ts";

const TODAY = "2026-10-28";
let nextId = 1;
function task(o: Partial<TaskView> & { summary: string }): TaskView {
	const id = nextId++;
	return {
		id,
		href: `/l/${id}.ics`,
		list: "/l/",
		uid: `u${id}`,
		description: "",
		status: "NEEDS-ACTION",
		priority: "none",
		due: null,
		start: null,
		completedAt: null,
		tags: [],
		parentUid: null,
		section: null,
		sortOrder: id,
		readOnly: null,
		recurring: false,
		reminders: [],
		repeat: null,
		klass: "PUBLIC",
		pinned: false,
		location: "",
		url: "",
		redacted: false,
		origin: null,
		createdAt: null,
		modifiedAt: null,
		...o,
	};
}
const due = (date: string, minutes: number | null = null) => ({
	date,
	minutes,
	at: null,
	zone: null,
});
const list = (href = "/l/", o: Partial<ListRecord> = {}) =>
	listRecord({ href, name: href, ...o });

function input(tasks: TaskView[], o: Partial<ViewInput> = {}): ViewInput {
	return {
		tasks,
		lists: [list()],
		shown: new Set(["/l/"]),
		today: TODAY,
		nowMin: 10 * 60 + 30,
		todayStart: 0,
		filter: NO_FILTER,
		showDone: false,
		folds: new Map(),
		lingering: new Set(),
		...o,
	};
}
const titles = (m: ReturnType<typeof buildView>) =>
	m.groups.map((g) => [g.title ?? g.kind, g.rows.map((r) => r.task.summary)]);

describe("Today", () => {
	test("open tasks whose start or due is today or earlier; overdue on top; timed by time, then priority", () => {
		const ts = [
			task({ summary: "late", due: due("2026-10-26") }),
			task({ summary: "today low", due: due(TODAY), priority: "low" }),
			task({ summary: "today high", due: due(TODAY), priority: "high" }),
			task({ summary: "at 14", due: due(TODAY, 840) }),
			task({ summary: "at 9", due: due(TODAY, 540) }),
			task({
				summary: "started",
				start: { date: "2026-10-27", minutes: null },
				due: due("2026-11-10"),
			}),
			task({ summary: "tomorrow", due: due("2026-10-29") }),
			task({
				summary: "starts later",
				start: { date: "2026-10-30", minutes: null },
			}),
			task({ summary: "undated" }),
			task({
				summary: "done",
				due: due(TODAY),
				status: "COMPLETED",
				completedAt: 5,
			}),
		];
		const m = buildView({ kind: "today" }, input(ts));
		expect(titles(m)).toEqual([
			["Overdue", ["late"]],
			["today", ["at 9", "at 14", "today high", "today low", "started"]],
		]);
		expect(m.total).toBe(6);
		expect(m.doneToday).toBe(1);
	});

	test("overdue unfolds up to five and folds above; an explicit fold wins", () => {
		const late = (n: number) =>
			Array.from({ length: n }, (_, i) =>
				task({ summary: `l${i}`, due: due("2026-10-01") }),
			);
		expect(buildView({ kind: "today" }, input(late(5))).groups[0]?.folded).toBe(
			false,
		);
		const six = buildView({ kind: "today" }, input(late(6)));
		expect(six.groups[0]?.folded).toBe(true);
		expect(six.total).toBe(6); // the header counts folded ones too
		expect(visibleRows(six)).toHaveLength(0);
		const opened = buildView(
			{ kind: "today" },
			input(late(6), { folds: new Map([["group:overdue", false]]) }),
		);
		expect(visibleRows(opened)).toHaveLength(6);
	});

	test("a ticked task stays while it lingers; hidden lists stay out of smart views", () => {
		const t = task({
			summary: "ticked",
			due: due(TODAY),
			status: "COMPLETED",
			completedAt: 1,
		});
		expect(
			visibleRows(
				buildView(
					{ kind: "today" },
					input([t], { lingering: new Set([t.id]) }),
				),
			),
		).toHaveLength(1);
		const other = task({ summary: "deck", list: "/deck/", due: due(TODAY) });
		expect(
			visibleRows(buildView({ kind: "today" }, input([other]))),
		).toHaveLength(0);
	});

	test("a subtask shows flat with its parent's name", () => {
		const p = task({ summary: "Paint fence" });
		const c = task({
			summary: "Buy brushes",
			parentUid: p.uid,
			due: due(TODAY),
		});
		const rows = visibleRows(buildView({ kind: "today" }, input([p, c])));
		expect(rows.map((r) => [r.task.summary, r.crumb, r.depth])).toEqual([
			["Buy brushes", "↳ Paint fence", 0],
		]);
	});
});

describe("Upcoming", () => {
	test("7 day headers from tomorrow, then the rest by week; undated left out", () => {
		const ts = [
			task({ summary: "tomorrow", due: due("2026-10-29") }),
			task({ summary: "in 7", due: due("2026-11-04") }),
			task({ summary: "in 8", due: due("2026-11-05") }),
			task({ summary: "in 13", due: due("2026-11-10") }),
			task({ summary: "today", due: due(TODAY) }),
			task({ summary: "undated" }),
		];
		const m = buildView({ kind: "upcoming" }, input(ts));
		expect(m.groups.filter((g) => g.kind === "day").map((g) => g.date)).toEqual(
			[
				"2026-10-29",
				"2026-10-30",
				"2026-10-31",
				"2026-11-01",
				"2026-11-02",
				"2026-11-03",
				"2026-11-04",
			],
		);
		expect(m.groups[0]?.title).toBe("Tomorrow");
		const later = m.groups.filter((g) => g.kind === "later");
		expect(
			later.map((g) => [g.title, g.rows.map((r) => r.task.summary)]),
		).toEqual([
			["5–8 Nov", ["in 8"]],
			["Week of 9 Nov", ["in 13"]],
		]);
		expect(m.total).toBe(4);
	});
});

describe("a list", () => {
	test("the tree in My order; completed tasks folded at the bottom; completed subtasks under their parent", () => {
		const a = task({ summary: "A", sortOrder: 20 });
		const b = task({ summary: "B", sortOrder: 10 });
		const b1 = task({ summary: "B1", parentUid: b.uid, sortOrder: 2 });
		const b2 = task({
			summary: "B2",
			parentUid: b.uid,
			sortOrder: 1,
			status: "COMPLETED",
		});
		const done = task({ summary: "Old", status: "COMPLETED", completedAt: 1 });
		const m = buildView(
			{ kind: "list", href: "/l/" },
			input([a, b, b1, b2, done]),
		);
		expect(m.groups.map((g) => [g.title, g.folded])).toEqual([
			[null, false],
			["1 completed", true],
		]);
		expect(
			m.groups[0]?.rows.map((r) => [r.task.summary, r.depth, r.doneKids]),
		).toEqual([
			["B", 0, 1],
			["B1", 1, 0],
			["A", 0, 0],
		]);
		expect(m.groups[0]?.rows[0]?.progress).toEqual({ done: 1, total: 2 });
		const shown = buildView(
			{ kind: "list", href: "/l/" },
			input([a, b, b1, b2, done], { showDone: true }),
		);
		expect(shown.groups[1]?.folded).toBe(false);
		expect(shown.groups[0]?.rows.map((r) => r.task.summary)).toEqual([
			"B",
			"B1",
			"B2",
			"A",
		]);
	});

	test("a folded parent hides its subtree but the count keeps it", () => {
		const p = task({ summary: "P" });
		const k = task({ summary: "K", parentUid: p.uid });
		const m = buildView(
			{ kind: "list", href: "/l/" },
			input([p, k], { folds: new Map([[`task:${p.id}`, true]]) }),
		);
		expect(m.groups[0]?.rows.map((r) => [r.task.summary, r.expanded])).toEqual([
			["P", false],
		]);
		expect(m.total).toBe(2);
	});
});

describe("filters and lists", () => {
	const f = (o: Partial<Filter>): Filter => ({ ...NO_FILTER, ...o });
	test("Important is High priority; tags all have to match; text searches title and notes", () => {
		const ts = [
			task({ summary: "a", priority: "high", tags: ["work"], due: due(TODAY) }),
			task({
				summary: "b",
				priority: "medium",
				tags: ["work", "x"],
				due: due(TODAY),
				description: "rent",
			}),
		];
		const names = (fl: Filter) =>
			visibleRows(buildView({ kind: "today" }, input(ts, { filter: fl }))).map(
				(r) => r.task.summary,
			);
		expect(names(f({ important: true }))).toEqual(["a"]);
		expect(names(f({ tags: ["WORK", "x"] }))).toEqual(["b"]);
		expect(names(f({ text: "Rent" }))).toEqual(["b"]);
	});

	test("Deck boards are hidden from smart views by default; a flag wins", () => {
		const own = list("/own/");
		const deck = list("/deck/", { appGenerated: true, writable: false });
		expect([...shownLists([own, deck], {})]).toEqual(["/own/"]);
		expect([
			...shownLists([own, deck], {
				"/deck/": { shown: true },
				"/own/": { shown: false },
			}),
		]).toEqual(["/deck/"]);
	});
});

describe("due chips", () => {
	const chip = (t: TaskView, inToday = false) =>
		dueChip(t, TODAY, 630, { inToday });
	test("each state as the spec draws it", () => {
		expect(chip(task({ summary: "", due: due("2026-10-26") }))).toMatchObject({
			text: "Mon · 2 d",
			tone: "muted",
		});
		expect(chip(task({ summary: "", due: due(TODAY, 540) }))).toMatchObject({
			text: "09:00",
			tone: "late",
		});
		expect(chip(task({ summary: "", due: due(TODAY, 840) }))).toMatchObject({
			text: "14:00",
			tone: "accent",
		});
		expect(chip(task({ summary: "", due: due(TODAY) }), true)).toBeNull();
		expect(chip(task({ summary: "", due: due(TODAY) }))).toMatchObject({
			text: "Today",
		});
		expect(chip(task({ summary: "", due: due("2026-10-29") }))).toMatchObject({
			text: "Tomorrow",
		});
		expect(chip(task({ summary: "", due: due("2026-10-30") }))).toMatchObject({
			text: "Fri",
		});
		expect(chip(task({ summary: "", due: due("2026-11-12") }))).toMatchObject({
			text: "12 Nov",
		});
		expect(
			chip(task({ summary: "", start: { date: "2026-10-30", minutes: null } })),
		).toMatchObject({ text: "▷ Fri", tone: "muted" });
	});
});

describe("drop place", () => {
	const r = (
		summary: string,
		depth: number,
	): import("../src/ui/model.ts").Row => ({
		task: task({ summary }),
		depth,
		crumb: null,
		expanded: null,
		progress: null,
		doneKids: 0,
	});
	test("depth follows the pointer within what the neighbours allow; index counts siblings", async () => {
		const { dropPlace } = await import("../src/ui/model.ts");
		const rows = [r("A", 0), r("A1", 1), r("A2", 1), r("B", 0), r("C", 0)];
		const dragged = new Set([(rows[4] as { task: TaskView }).task.id]); // C
		// Between A2 and B: depth 0..2.
		expect(dropPlace(rows, dragged, 3, 0)).toMatchObject({
			parent: null,
			index: 1,
			depth: 0,
		});
		expect(dropPlace(rows, dragged, 3, 1)).toMatchObject({
			parent: rows[0]?.task,
			index: 2,
			depth: 1,
		});
		expect(dropPlace(rows, dragged, 3, 2)).toMatchObject({
			parent: rows[2]?.task,
			index: 0,
			depth: 2,
		});
		expect(dropPlace(rows, dragged, 3, 9)).toMatchObject({ depth: 2 });
		// Between A and A1: at least depth 1 (A1 stays under A).
		expect(dropPlace(rows, dragged, 1, 0)).toMatchObject({
			parent: rows[0]?.task,
			index: 0,
			depth: 1,
		});
		// At the top: always top level.
		expect(dropPlace(rows, dragged, 0, 3)).toMatchObject({
			parent: null,
			index: 0,
			depth: 0,
		});
	});

	test("a dragged task's own subtree isn't a target", async () => {
		const { dropPlace } = await import("../src/ui/model.ts");
		const rows = [r("A", 0), r("A1", 1), r("B", 0)];
		const dragged = new Set([(rows[0] as { task: TaskView }).task.id]);
		// Just below A1 (inside A's subtree) is the same place as above B.
		expect(dropPlace(rows, dragged, 2, 1)).toMatchObject({
			parent: null,
			index: 0,
			depth: 0,
		});
	});
});
