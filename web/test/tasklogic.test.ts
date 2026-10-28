import { expect, test } from "bun:test";
import type { TaskView as TaskDTO } from "../src/core/tasks.ts";
import {
	ancestors,
	compareTasks,
	descendants,
	dueGroups,
	overdueAge,
	taskForest,
} from "../src/logic/tasklogic.ts";

const task = (uid: string, o: Partial<TaskDTO> = {}): TaskDTO => ({
	id: 0,
	href: `/l/${uid}.ics`,
	list: "/l1/",
	uid,
	summary: uid,
	description: "",
	status: "NEEDS-ACTION",
	priority: "none",
	due: null,
	start: null,
	completedAt: null,
	tags: [],
	parentUid: null,
	section: null,
	sortOrder: 0,
	readOnly: null,
	recurring: false,
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
});

test("descendants: the whole subtree in the same list, cycles ignored", () => {
	const all = [
		task("p"),
		task("c1", { parentUid: "p" }),
		task("g1", { parentUid: "c1" }),
		task("other-list", { parentUid: "p", list: "/l2/" }),
		task("loop", { parentUid: "g1" }),
		task("p2", { parentUid: "loop" }),
	];
	expect(descendants(task("p"), all).map((t) => t.uid)).toEqual([
		"c1",
		"g1",
		"loop",
		"p2",
	]);
});

test("taskForest: nests to any depth within a list, open first; a loop shows each task once", () => {
	const tasks = [
		task("g", { id: 3, parentUid: "c" }),
		task("c", { id: 2, parentUid: "p" }),
		task("done", { id: 4, parentUid: "p", status: "COMPLETED" }),
		task("p", { id: 1 }),
		task("other-list", { id: 5, parentUid: "p", list: "/l2/" }),
		task("a", { id: 6, parentUid: "b" }),
		task("b", { id: 7, parentUid: "a" }),
	];
	const { roots, kids } = taskForest(tasks);
	const uids = (ts: TaskDTO[] | undefined) => ts?.map((t) => t.uid);
	expect(uids(roots)).toEqual(["p", "other-list", "a"]);
	expect(uids(kids.get(1))).toEqual(["c", "done"]);
	expect(uids(kids.get(2))).toEqual(["g"]);
	expect(uids(kids.get(6))).toEqual(["b"]);
	expect(uids(kids.get(7))).toEqual([]);
	expect(uids(ancestors(tasks[0] as TaskDTO, tasks))).toEqual(["p", "c"]);
	expect(uids(ancestors(tasks[5] as TaskDTO, tasks))).toEqual(["b"]);
});

test("board order: priority, then due date (none last), then sort order, then title", () => {
	const due = (date: string, minutes: number | null = null) => ({
		date,
		minutes,
		at: null,
		zone: null,
	});
	const list = [
		task("none-early", { due: due("2026-10-01") }),
		task("high-late", { priority: "high", due: due("2026-10-30") }),
		task("high-undated", { priority: "high" }),
		task("high-early-timed", { priority: "high", due: due("2026-10-30", 600) }),
		task("medium", { priority: "medium" }),
	];
	expect([...list].sort(compareTasks).map((t) => t.uid)).toEqual([
		"high-early-timed",
		"high-late",
		"high-undated",
		"medium",
		"none-early",
	]);
});

test("overdue age: days late, or the time when it passed earlier today", () => {
	const due = (date: string, minutes: number | null) => ({
		date,
		minutes,
		at: null,
		zone: null,
	});
	expect(
		overdueAge(task("a", { due: due("2026-10-17", null) }), "2026-10-20"),
	).toBe("3 d");
	expect(
		overdueAge(task("a", { due: due("2026-10-19", 600) }), "2026-10-20"),
	).toBe("1 d");
	expect(
		overdueAge(task("a", { due: due("2026-10-20", 600) }), "2026-10-20"),
	).toBe("10:00");
});

test("due groups: a task due earlier today is overdue; hidden lists, done tasks and subtasks stay out", () => {
	const today = "2026-10-23";
	const now = 10 * 60;
	const due = (date: string, minutes: number | null = null) => ({
		date,
		minutes,
		at: null,
		zone: null,
	});
	const g = dueGroups(
		[
			task("yesterday", { due: due("2026-10-22") }),
			task("passed-today", { due: due(today, 9 * 60) }),
			task("later-today", { due: due(today, 11 * 60) }),
			task("all-day-today", { due: due(today) }),
			task("in-a-week", { due: due("2026-10-30") }),
			task("in-eight-days", { due: due("2026-10-31") }),
			task("undated"),
			task("hidden-list", { list: "/l2/", due: due(today) }),
			task("done", { status: "COMPLETED", due: due(today) }),
			task("subtask", { parentUid: "undated", due: due(today) }),
		],
		new Set(["/l1/"]),
		today,
		now,
	);
	const uids = (list: TaskDTO[]) => list.map((t) => t.uid);
	expect({
		overdue: uids(g.overdue),
		today: uids(g.today),
		soon: uids(g.soon),
		undated: uids(g.undated),
	}).toEqual({
		overdue: ["yesterday", "passed-today"],
		today: ["later-today", "all-day-today"],
		soon: ["in-a-week"],
		undated: ["undated"],
	});
});
