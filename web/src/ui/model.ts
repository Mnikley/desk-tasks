// What a view shows, as groups of rows: pure, so the views are tested without a page.
// Today: open tasks whose start or due is today or earlier (Nextcloud's rule), overdue folded on
// top; Upcoming: the next 7 days, then by week; All: every shown list; a list: its tree in My
// order with the completed folded at the bottom.

import { compareManual } from "../core/order.ts";
import type { ListRecord } from "../core/store.ts";
import type { TaskView } from "../core/tasks.ts";
import {
	addDays,
	daysBetween,
	fmtDayShort,
	startOfWeek,
	weekday,
	weekdayName,
} from "../core/time.ts";
import { isOpen, PRIORITY_RANK, taskForest } from "../logic/tasklogic.ts";

export type ViewId =
	| { kind: "today" }
	| { kind: "upcoming" }
	| { kind: "all" }
	| { kind: "list"; href: string }
	| { kind: "trash" };

export const viewKey = (v: ViewId) =>
	v.kind === "list" ? `list:${v.href}` : v.kind;

export interface Filter {
	important: boolean;
	tags: string[];
	text: string;
}
export const NO_FILTER: Filter = { important: false, tags: [], text: "" };
export const filtering = (f: Filter) =>
	f.important || f.tags.length > 0 || f.text.trim() !== "";

export interface Row {
	task: TaskView;
	/** Tree depth in list views (0 = top level); 0 in smart views. */
	depth: number;
	/** In smart views, where a subtask sits ("↳ Paint fence"); null otherwise. */
	crumb: string | null;
	/** Subtasks shown under it in this view, folded or not; null when it has none. */
	expanded: boolean | null;
	/** "2/5": subtasks done of all (direct children), or null without subtasks. */
	progress: { done: number; total: number } | null;
	/** Completed subtasks folded into "2 done" under this task. */
	doneKids: number;
}

export interface Group {
	key: string;
	/** Null: no header (the plain part of Today, a single list's open tasks). */
	title: string | null;
	kind: "overdue" | "today" | "day" | "later" | "list" | "done" | "plain";
	/** Every task the group holds, folded or not (the header count). */
	count: number;
	folded: boolean;
	rows: Row[];
	/** An Upcoming day header: dropping a task here sets this due date. */
	date?: string;
	/** An All section: its list. */
	list?: string;
}

export interface ViewInput {
	tasks: TaskView[];
	lists: ListRecord[];
	/** Lists shown in smart views (Today, Upcoming, All). */
	shown: Set<string>;
	today: string;
	/** Minutes since midnight, now. */
	nowMin: number;
	/** The instant today began (local midnight), for "completed today". */
	todayStart: number;
	filter: Filter;
	/** Show completed tasks (`h`). */
	showDone: boolean;
	/** Explicit folds by key; a missing key takes the group's default. */
	folds: ReadonlyMap<string, boolean>;
	/** Tasks just ticked, still shown while they linger. */
	lingering: ReadonlySet<number>;
}

export interface ViewModel {
	groups: Group[];
	/** Open tasks in the view, folded ones included (the header count). */
	total: number;
	/** Tasks completed today (Today's "All done for today · 5 completed."). */
	doneToday: number;
}

/** Overdue unfolds by default up to this many. */
export const OVERDUE_OPEN_MAX = 5;
export const UPCOMING_DAYS = 7;

const visibleDone = (t: TaskView, input: ViewInput) =>
	isOpen(t) || input.lingering.has(t.id) || input.showDone;

export function matches(t: TaskView, f: Filter): boolean {
	if (f.important && t.priority !== "high") return false;
	if (
		f.tags.length &&
		!f.tags.every((g) =>
			t.tags.some((x) => x.toLowerCase() === g.toLowerCase()),
		)
	)
		return false;
	const q = f.text.trim().toLowerCase();
	if (q && !`${t.summary}\n${t.description}`.toLowerCase().includes(q))
		return false;
	return true;
}

/** The date a task is placed on in smart views: due, else start. */
const placeDate = (t: TaskView) => t.due?.date ?? t.start?.date ?? null;

/** Timed first by time, then priority, then My order. */
export function compareDay(a: TaskView, b: TaskView): number {
	const ta = a.due?.minutes ?? null;
	const tb = b.due?.minutes ?? null;
	if (ta !== null || tb !== null) {
		if (ta === null) return 1;
		if (tb === null) return -1;
		if (ta !== tb) return ta - tb;
	}
	return (
		PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || compareManual(a, b)
	);
}

const byDueThenDay = (a: TaskView, b: TaskView) =>
	(placeDate(a) ?? "").localeCompare(placeDate(b) ?? "") || compareDay(a, b);

/** Open first; completed at the end, most recently completed first. */
const doneLast = (a: TaskView, b: TaskView) =>
	Number(!isOpen(a)) - Number(!isOpen(b)) ||
	(isOpen(a) ? 0 : (b.completedAt ?? 0) - (a.completedAt ?? 0));

function crumb(t: TaskView, byKey: Map<string, TaskView>): string | null {
	if (!t.parentUid) return t.section ? `↳ ${t.section}` : null;
	const p = byKey.get(`${t.list}\n${t.parentUid}`);
	return p ? `↳ ${p.summary}` : null;
}

function progressOf(t: TaskView, all: TaskView[]): Row["progress"] {
	const kids = all.filter((c) => c.parentUid === t.uid && c.list === t.list);
	if (!kids.length) return null;
	return {
		done: kids.filter((k) => k.status === "COMPLETED").length,
		total: kids.length,
	};
}

/** Flat rows for a smart view (subtasks with a crumb). */
function flatRows(tasks: TaskView[], input: ViewInput): Row[] {
	const byKey = new Map(input.tasks.map((t) => [`${t.list}\n${t.uid}`, t]));
	return tasks.map((task) => ({
		task,
		depth: 0,
		crumb: crumb(task, byKey),
		expanded: null,
		progress: progressOf(task, input.tasks),
		doneKids: 0,
	}));
}

const fold = (input: ViewInput, key: string, byDefault: boolean) =>
	input.folds.get(key) ?? byDefault;

/** A list's tree in My order; completed subtasks fold under their parent ("2 done"). */
function treeRows(
	tasks: TaskView[],
	input: ViewInput,
): { rows: Row[]; open: number } {
	const order = (a: TaskView, b: TaskView) =>
		doneLast(a, b) || compareManual(a, b);
	const forest = taskForest(tasks, order);
	// taskForest sorts the subtasks; the top level is sorted here.
	const roots = [...forest.roots].sort(order);
	const kids = forest.kids;
	const rows: Row[] = [];
	let open = 0;
	const walk = (t: TaskView, depth: number) => {
		const all = kids.get(t.id) ?? [];
		const shownKids = all.filter((k) => visibleDone(k, input));
		const doneKids = all.length - shownKids.length;
		const folded = fold(input, `task:${t.id}`, false);
		if (isOpen(t)) open++;
		rows.push({
			task: t,
			depth,
			crumb: null,
			expanded: shownKids.length ? !folded : null,
			progress: progressOf(t, input.tasks),
			doneKids: folded ? 0 : doneKids,
		});
		for (const k of shownKids) {
			if (folded) countOpen(k);
			else walk(k, depth + 1);
		}
	};
	const countOpen = (t: TaskView) => {
		if (isOpen(t)) open++;
		for (const k of kids.get(t.id) ?? []) countOpen(k);
	};
	for (const r of roots) walk(r, 0);
	return { rows, open };
}

function todayView(input: ViewInput, pool: TaskView[]): ViewModel {
	const due = (t: TaskView) => {
		const s = t.start?.date ?? null;
		const d = t.due?.date ?? null;
		return (s !== null && s <= input.today) || (d !== null && d <= input.today);
	};
	const inView = pool.filter((t) =>
		isOpen(t) || input.lingering.has(t.id) ? due(t) : false,
	);
	const doneToday = pool.filter(
		(t) =>
			t.status === "COMPLETED" &&
			t.completedAt !== null &&
			t.completedAt >= input.todayStart,
	);
	const overdue = inView
		.filter((t) => t.due !== null && t.due.date < input.today)
		.sort(byDueThenDay);
	const rest = inView.filter((t) => !overdue.includes(t)).sort(compareDay);
	const groups: Group[] = [];
	if (overdue.length)
		groups.push({
			key: "overdue",
			title: "Overdue",
			kind: "overdue",
			count: overdue.length,
			folded: fold(input, "group:overdue", overdue.length > OVERDUE_OPEN_MAX),
			rows: flatRows(overdue, input),
		});
	groups.push({
		key: "today",
		title: null,
		kind: "today",
		count: rest.length,
		folded: false,
		rows: flatRows(rest, input),
	});
	if (input.showDone && doneToday.length) {
		const done = doneToday.filter((t) => !input.lingering.has(t.id));
		groups.push({
			key: "done",
			title: "Completed today",
			kind: "done",
			count: done.length,
			folded: fold(input, "group:done-today", false),
			rows: flatRows(done, input),
		});
	}
	const total = inView.filter(isOpen).length;
	return {
		groups: groups.filter((g) => g.kind === "today" || g.count > 0),
		total,
		doneToday: doneToday.length,
	};
}

function upcomingView(input: ViewInput, pool: TaskView[]): ViewModel {
	const from = addDays(input.today, 1);
	const end = addDays(input.today, UPCOMING_DAYS);
	const dated = pool.filter((t) => {
		const d = placeDate(t);
		return (
			d !== null &&
			d >= from &&
			(isOpen(t) || input.lingering.has(t.id) || input.showDone)
		);
	});
	const groups: Group[] = [];
	for (let i = 1; i <= UPCOMING_DAYS; i++) {
		const date = addDays(input.today, i);
		const day = dated.filter((t) => placeDate(t) === date).sort(compareDay);
		groups.push({
			key: `day:${date}`,
			title: i === 1 ? "Tomorrow" : dayTitle(date),
			kind: "day",
			count: day.filter(isOpen).length,
			folded: false,
			rows: flatRows(day, input),
			date,
		});
	}
	const later = dated
		.filter((t) => (placeDate(t) as string) > end)
		.sort(byDueThenDay);
	const weeks = new Map<string, TaskView[]>();
	for (const t of later) {
		const w = startOfWeek(placeDate(t) as string);
		weeks.set(w, [...(weeks.get(w) ?? []), t]);
	}
	const after = addDays(end, 1);
	const dayMonth = (x: string) => fmtDayShort(x).replace(/^\w+ /, "");
	for (const [w, ts] of weeks)
		groups.push({
			key: `week:${w}`,
			// The week the 7 days end in is only partly "later": "5–8 Nov".
			title:
				w < after
					? `${Number(after.slice(8))}–${dayMonth(addDays(w, 6))}`
					: `Week of ${dayMonth(w)}`,
			kind: "later",
			count: ts.filter(isOpen).length,
			folded: fold(input, `group:week:${w}`, false),
			rows: flatRows(ts, input),
		});
	return { groups, total: dated.filter(isOpen).length, doneToday: 0 };
}

const dayTitle = (date: string) => fmtDayShort(date);

function allView(input: ViewInput, pool: TaskView[]): ViewModel {
	const groups: Group[] = [];
	let total = 0;
	for (const l of input.lists) {
		if (!input.shown.has(l.href)) continue;
		const tasks = pool.filter(
			(t) => t.list === l.href && visibleDone(t, input),
		);
		const { rows, open } = treeRows(tasks, input);
		total += open;
		groups.push({
			key: `list:${l.href}`,
			title: l.name,
			kind: "list",
			count: open,
			folded: fold(input, `group:list:${l.href}`, false),
			rows,
			list: l.href,
		});
	}
	return { groups, total, doneToday: 0 };
}

function listView(input: ViewInput, pool: TaskView[], href: string): ViewModel {
	const mine = pool.filter((t) => t.list === href);
	const open = mine.filter((t) => isOpen(t) || input.lingering.has(t.id));
	const openUids = new Set(open.map((t) => t.uid));
	// A completed task whose parent is open stays in the tree (folded into "2 done").
	const doneTop = mine.filter(
		(t) =>
			!open.includes(t) && !(t.parentUid !== null && openUids.has(t.parentUid)),
	);
	const tree = treeRows(
		[...open, ...mine.filter((t) => !open.includes(t) && !doneTop.includes(t))],
		input,
	);
	const groups: Group[] = [
		{
			key: "open",
			title: null,
			kind: "plain",
			count: tree.open,
			folded: false,
			rows: tree.rows,
		},
	];
	if (doneTop.length) {
		const done = treeRows(doneTop, { ...input, showDone: true });
		groups.push({
			key: "done",
			title: `${doneTop.length} completed`,
			kind: "done",
			count: doneTop.length,
			folded: fold(input, `group:done:${href}`, !input.showDone),
			rows: done.rows,
		});
	}
	return { groups, total: tree.open, doneToday: 0 };
}

/** The view's groups and counts. */
export function buildView(view: ViewId, input: ViewInput): ViewModel {
	const pool = input.tasks.filter((t) => matches(t, input.filter));
	const smart = pool.filter((t) => input.shown.has(t.list));
	switch (view.kind) {
		case "today":
			return todayView(input, smart);
		case "upcoming":
			return upcomingView(input, smart);
		case "all":
			return allView(input, pool);
		case "list":
			return listView(input, pool, view.href);
		case "trash":
			return { groups: [], total: 0, doneToday: 0 };
	}
}

/** The rows a keyboard walks: folded groups and folded subtrees left out. */
export const visibleRows = (m: ViewModel): Row[] =>
	m.groups.flatMap((g) => (g.folded ? [] : g.rows));

/** Lists shown in smart views by default: everything but app-generated ones (Deck boards). */
export function shownLists(
	lists: ListRecord[],
	flags: Record<string, Record<string, boolean>>,
): Set<string> {
	return new Set(
		lists
			.filter((l) => flags[l.href]?.shown ?? !l.appGenerated)
			.map((l) => l.href),
	);
}

/** "Mon · 3 d", "14:00", "Today", "Tomorrow", "Fri", "12 Nov", "▷ Fri". */
export interface DueChip {
	text: string;
	tone: "muted" | "late" | "accent" | "plain";
	label: string;
}

export function dueChip(
	t: TaskView,
	today: string,
	nowMin: number,
	where: { inToday?: boolean; dayGrouped?: boolean } = {},
): DueChip | null {
	const inToday = where.inToday ?? false;
	if (
		t.start &&
		t.start.date > today &&
		(!t.due || t.due.date > t.start.date)
	) {
		const s = shortDay(t.start.date, today);
		if (!t.due) return { text: `▷ ${s}`, tone: "muted", label: `Starts ${s}` };
	}
	if (!t.due) return null;
	const d = t.due.date;
	const time = t.due.minutes === null ? null : clock(t.due.minutes);
	if (d < today) {
		const late = daysBetween(d, today);
		const wd = weekdayName(weekday(d));
		return {
			text: `${wd} · ${late} d`,
			tone: "muted",
			label: `Overdue since ${fmtDayShort(d)}`,
		};
	}
	if (d === today) {
		if (time === null)
			return inToday
				? null
				: { text: "Today", tone: "plain", label: "Due today" };
		const passed = (t.due.minutes as number) < nowMin && isOpen(t);
		return {
			text: time,
			tone: passed ? "late" : "accent",
			label: passed ? `Was due at ${time}` : `Due at ${time}`,
		};
	}
	// Under an Upcoming day header the day is said already: only the time.
	if (where.dayGrouped)
		return time ? { text: time, tone: "plain", label: `Due at ${time}` } : null;
	const text = shortDay(d, today);
	return {
		text: time ? `${text} ${time}` : text,
		tone: "plain",
		label: `Due ${fmtDayShort(d)}${time ? ` ${time}` : ""}`,
	};
}

function shortDay(d: string, today: string): string {
	const ahead = daysBetween(today, d);
	if (ahead === 1) return "Tomorrow";
	if (ahead > 1 && ahead <= 6) return weekdayName(weekday(d));
	return fmtDayShort(d).replace(/^\w+ /, "");
}

const clock = (m: number) =>
	`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/**
 * Where a drag drops in a tree: before `rows[at]` (after the filter below), at the depth the
 * pointer asks for within what the neighbours allow (no deeper than one below the row above,
 * no shallower than the row below). The dragged tasks and their subtrees don't count.
 * Returns the parent (null: top level) and the index among its open subtasks.
 */
export function dropPlace(
	all: Row[],
	dragged: ReadonlySet<number>,
	at: number,
	want: number,
): { parent: TaskView | null; index: number; depth: number } {
	const rows: Row[] = [];
	let skipBelow: number | null = null;
	let mapped = at;
	for (const [i, r] of all.entries()) {
		if (skipBelow !== null && r.depth > skipBelow) {
			if (i < at) mapped--;
			continue;
		}
		skipBelow = null;
		if (dragged.has(r.task.id)) {
			skipBelow = r.depth;
			if (i < at) mapped--;
			continue;
		}
		rows.push(r);
	}
	const prev = rows[mapped - 1];
	const next = rows[mapped];
	const maxD = prev ? prev.depth + 1 : 0;
	const minD = Math.min(next ? next.depth : 0, maxD);
	const depth = Math.max(minD, Math.min(maxD, want));
	let parent: TaskView | null = null;
	let parentAt = -1;
	if (depth > 0)
		for (let i = mapped - 1; i >= 0; i--)
			if ((rows[i] as Row).depth === depth - 1) {
				parent = (rows[i] as Row).task;
				parentAt = i;
				break;
			}
	let index = 0;
	for (let i = parentAt + 1; i < mapped; i++)
		if ((rows[i] as Row).depth === depth) index++;
	return { parent, index, depth };
}
