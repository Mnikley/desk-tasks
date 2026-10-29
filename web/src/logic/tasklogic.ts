// Pure task logic the views use: ordering, due buckets, and the subtask tree.
import type { TaskView } from "../core/tasks.ts";
import { addDays, daysBetween, fmtClock, fmtDayShort } from "../core/time.ts";
import type { TaskPriority, TaskStatus } from "../core/types.ts";

export const STATUS_LABEL: Record<TaskStatus, string> = {
	"NEEDS-ACTION": "To do",
	"IN-PROCESS": "In progress",
	COMPLETED: "Done",
	CANCELLED: "Cancelled",
};
export const PRIORITY_LABEL: Record<TaskPriority, string> = {
	high: "High",
	medium: "Medium",
	low: "Low",
	none: "None",
};
/** Every tag the tasks use, in alphabetical order. */
export const knownTags = (tasks: TaskView[]): string[] =>
	[...new Set(tasks.flatMap((t) => t.tags))].sort((a, b) => a.localeCompare(b));
/** Highest first, as filters and rows list them. */
export const PRIORITY_ORDER = ["high", "medium", "low", "none"] as const;
export const PRIORITY_RANK: Record<TaskPriority, number> = {
	high: 0,
	medium: 1,
	low: 2,
	none: 3,
};

export const isOpen = (t: Pick<TaskView, "status">) =>
	t.status === "NEEDS-ACTION" || t.status === "IN-PROCESS";

/** A due date as a string that sorts by time; an all-day one after timed ones that day. */
export const dueSortKey = (t: TaskView): string | null =>
	t.due
		? `${t.due.date}T${String(t.due.minutes ?? 1440).padStart(4, "0")}`
		: null;

/** Priority, due date (undated last), the apps' sort order, title. */
export function compareTasks(a: TaskView, b: TaskView): number {
	const da = dueSortKey(a);
	const db = dueSortKey(b);
	const byDue =
		da === db ? 0 : da === null ? 1 : db === null ? -1 : da < db ? -1 : 1;
	return (
		PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
		byDue ||
		a.sortOrder - b.sortOrder ||
		a.summary.localeCompare(b.summary)
	);
}

/** "Tue 21 Oct 14:30" / "Tue 21 Oct" */
export function dueText(t: TaskView): string {
	if (!t.due) return "";
	const day = fmtDayShort(t.due.date);
	return t.due.minutes === null ? day : `${day} ${fmtClock(t.due.minutes)}`;
}

export function overdue(t: TaskView, today: string, nowMin: number): boolean {
	if (!t.due || !isOpen(t)) return false;
	if (t.due.date !== today) return t.due.date < today;
	return t.due.minutes !== null && t.due.minutes < nowMin;
}

/** Days ahead that count as "soon". */
export const SOON_DAYS = 7;

export type DueBucket = "overdue" | "today" | "soon" | "later" | "none";

/** When a task is due. A task due today at a time already past is overdue, not today. */
export function dueBucket(
	t: TaskView,
	today: string,
	nowMin: number,
): DueBucket {
	if (!t.due) return "none";
	if (t.due.date < today || overdue(t, today, nowMin)) return "overdue";
	if (t.due.date === today) return "today";
	return t.due.date <= addDays(today, SOON_DAYS) ? "soon" : "later";
}

/** Open top-level tasks in shown lists by when they're due. */
export function dueGroups(
	tasks: TaskView[],
	shownLists: Set<string>,
	today: string,
	nowMin: number,
): {
	overdue: TaskView[];
	today: TaskView[];
	soon: TaskView[];
	later: TaskView[];
	undated: TaskView[];
} {
	const open = tasks
		.filter((t) => shownLists.has(t.list) && isOpen(t) && !t.parentUid)
		.sort(compareTasks);
	const by = (b: DueBucket) =>
		open.filter((t) => dueBucket(t, today, nowMin) === b);
	return {
		overdue: by("overdue"),
		today: by("today"),
		soon: by("soon"),
		later: by("later"),
		undated: by("none"),
	};
}

/** How late an overdue task is: "3 d", or its due time when that passed earlier today. */
export function overdueAge(t: TaskView, today: string): string {
	if (!t.due) return "";
	const late = daysBetween(t.due.date, today);
	return late > 0 || t.due.minutes === null
		? `${late} d`
		: fmtClock(t.due.minutes);
}

/** Every subtask below `t` in its list (deleting a task deletes all of them). */
export function descendants(t: TaskView, all: TaskView[]): TaskView[] {
	const out: TaskView[] = [];
	const seen = new Set([t.uid]);
	for (let i = 0, queue = [t]; i < queue.length; i++) {
		const parent = queue[i] as TaskView;
		for (const c of all)
			if (c.parentUid === parent.uid && c.list === t.list && !seen.has(c.uid)) {
				seen.add(c.uid);
				out.push(c);
				queue.push(c);
			}
	}
	return out;
}

export const parentOf = (t: TaskView, all: TaskView[]) =>
	t.parentUid === null
		? undefined
		: all.find((p) => p.uid === t.parentUid && p.list === t.list);

/** The tasks above `t` in its list, the topmost first; a loop of parents ends the climb. */
export function ancestors(t: TaskView, all: TaskView[]): TaskView[] {
	const out: TaskView[] = [];
	const seen = new Set([t.id]);
	for (let p = parentOf(t, all); p && !seen.has(p.id); p = parentOf(p, all)) {
		seen.add(p.id);
		out.unshift(p);
	}
	return out;
}

/** Tasks above a task, cut to the first and the nearest when there are more. */
const CRUMB_MAX = 2;

/**
 * Where a subtask sits, for where it shows without its parent: "A › … › C" (`short`) and every
 * task above it (`full`, for hover and screen readers). Null for a top-level task.
 */
export function crumbOf(
	t: TaskView,
	all: TaskView[],
): { short: string; full: string } | null {
	const path = ancestors(t, all).map((p) => p.summary);
	if (!path.length) return null;
	const short = path.length > CRUMB_MAX ? [path[0], "…", path.at(-1)] : path;
	return { short: short.join(" › "), full: path.join(" › ") };
}

const openFirst = (a: TaskView, b: TaskView) =>
	Number(!isOpen(a)) - Number(!isOpen(b)) || compareTasks(a, b);

/**
 * `tasks` as trees: the ones whose parent isn't among them, and each one's subtasks among them,
 * sorted by `order` (open first, then priority/due by default). A loop of parents (A under B under
 * A) starts at its first task, so every task shows exactly once.
 */
export function taskForest(
	tasks: TaskView[],
	order: (a: TaskView, b: TaskView) => number = openFirst,
): {
	roots: TaskView[];
	kids: Map<number, TaskView[]>;
} {
	const key = (list: string, uid: string) => `${list}\n${uid}`;
	const here = new Set(tasks.map((t) => key(t.list, t.uid)));
	const under = new Map<string, TaskView[]>();
	const roots: TaskView[] = [];
	for (const t of tasks) {
		const p = t.parentUid === null ? null : key(t.list, t.parentUid);
		if (p === null || !here.has(p) || t.parentUid === t.uid) roots.push(t);
		else under.set(p, [...(under.get(p) ?? []), t]);
	}
	const kids = new Map<number, TaskView[]>();
	const placed = new Set<number>();
	const place = (t: TaskView) => {
		placed.add(t.id);
		const below = (under.get(key(t.list, t.uid)) ?? [])
			.filter((c) => !placed.has(c.id))
			.sort(order);
		kids.set(t.id, below);
		for (const c of below) place(c);
	};
	for (const t of roots) place(t);
	for (const t of tasks)
		if (!placed.has(t.id)) {
			roots.push(t);
			place(t);
		}
	return { roots, kids };
}

/** What deleting a task takes with it, as the confirmation asks it. */
export const deleteQuestion = (t: { summary: string }, subtasks: number) =>
	`Delete “${t.summary}”${subtasks ? ` and its ${subtasks} subtask${subtasks === 1 ? "" : "s"}` : ""}?`;
