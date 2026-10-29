// Tasks as the app shows them, parsed from the stored bytes (never a second model).
import ICAL from "ical.js";
import type { Ctx } from "./ctx.ts";
import { CoreError } from "./errors.ts";
import {
	dueInApp,
	type IcalDate,
	instantOf,
	priorityLevel,
	TaskDocument,
	type TaskFields,
	type Trigger,
} from "./ical.ts";
import { describeRule, type RepeatRule, ruleOf } from "./recurrence.ts";
import { triggerInstant, triggerLabel } from "./reminders.ts";
import type { ListRecord, TaskRecord } from "./store.ts";
import { fmtClock } from "./time.ts";
import type { TaskPriority, TaskStatus } from "./types.ts";

/** Seconds between 1970-01-01 and 2001-01-01, the epoch of X-APPLE-SORT-ORDER defaults. */
export const APPLE_EPOCH_S = 978_307_200;
/** Planify stores sections as bare VTODOs with this title prefix. */
export const PLANIFY_SECTION = "List : ";

export interface Parsed {
	doc: TaskDocument;
	f: TaskFields;
}

/** A task as the views show it. */
export interface TaskView {
	/** Session id: stable while the app runs, also across a move to another list. */
	id: number;
	href: string;
	/** Href of its list. */
	list: string;
	uid: string;
	summary: string;
	description: string;
	status: TaskStatus;
	priority: TaskPriority;
	/** Where the due date sits in the app's calendar; `zone` is the TZID kept on writes ("UTC", or null = floating). */
	due: {
		date: string;
		minutes: number | null;
		at: number | null;
		zone: string | null;
	} | null;
	/** Start date (tasks.org: "hide until"). A due date before it is refused. */
	start: { date: string; minutes: number | null } | null;
	completedAt: number | null;
	tags: string[];
	parentUid: string | null;
	/** Planify section the task sits in (shown instead of a parent). */
	section: string | null;
	/** X-APPLE-SORT-ORDER, or CREATED in Apple-epoch seconds like Nextcloud Tasks. */
	sortOrder: number;
	/** Why the app won't change this task (read-only list, …), or null. */
	readOnly: string | null;
	recurring: boolean;
	/** The task's alarms the UI shows (DISPLAY/AUDIO), with when they go off. */
	reminders: {
		key: string;
		label: string;
		trigger: Trigger;
		at: number | null;
	}[];
	/** The repeat in words ("Weekly · Mon, Wed"), and the rule when the editor can show it. */
	repeat: { text: string; rule: RepeatRule | null } | null;
	/** CLASS: "PUBLIC", "CONFIDENTIAL" (show only busy), "PRIVATE", or another value as written. */
	klass: string;
	pinned: boolean;
	location: string;
	url: string;
	/** Redacted by the server for a view-only sharee (shown as "Busy" with a lock). */
	redacted: boolean;
	/** Which app wrote it last ("tasks.org", "Planify", …), from PRODID. */
	origin: string | null;
	/** CREATED (ms), or null when the task has none. */
	createdAt: number | null;
	/** LAST-MODIFIED, else DTSTAMP (ms); null if neither. */
	modifiedAt: number | null;
}

/** What the conflict dialog shows for each side of a conflict. */
export interface TaskSide {
	summary: string;
	status: TaskStatus;
	priority: TaskPriority;
	due: string;
	tags: string[];
	description: string;
}

/** Parsed documents per href and ETag; an unchanged ETag means unchanged bytes. */
const cache = new Map<string, Parsed | null>();
const CACHE_MAX = 5000;

export function parsed(
	row: Pick<TaskRecord, "href" | "etag" | "ics">,
): Parsed | null {
	const key = `${row.href}|${row.etag}`;
	let p = cache.get(key);
	if (p === undefined) {
		try {
			const doc = TaskDocument.parse(row.ics);
			p = { doc, f: doc.fields() };
		} catch {
			p = null;
		}
		if (cache.size >= CACHE_MAX) cache.clear();
		cache.set(key, p);
	}
	return p;
}

/** Planify stores sections as bare VTODOs named "List : …". */
export function isSection(f: TaskFields): boolean {
	return (
		f.summary.startsWith(PLANIFY_SECTION) &&
		!f.due &&
		!f.description &&
		!f.categories.length &&
		!f.parentUid &&
		f.priority === 0
	);
}

/** Who owns a shared list, in words ("Bob"; "its owner" when Nextcloud doesn't say). */
export const ownerOf = (list: Pick<ListRecord, "ownerName" | "owner">) =>
	list.ownerName || list.owner?.split("/").pop() || "its owner";

/** Why a task can't be changed here, or null. */
export function readOnlyReason(
	row: Pick<TaskRecord, "notUtf8">,
	list:
		| Pick<ListRecord, "writable" | "name" | "shared" | "ownerName" | "owner">
		| undefined,
	f: TaskFields | null,
): string | null {
	if (!f) return "This task couldn't be read.";
	if (row.notUtf8)
		return "It contains text that isn't valid UTF-8; change it in another app.";
	if (!list) return "Its list isn't here any more.";
	if (!list.writable)
		return `“${list.name}” is view only. You can see these tasks but not change them.`;
	// The Tasks app's rule: in a list shared with you, only public tasks may be changed (the
	// server may have redacted the others).
	if (list.shared && f.klass !== "PUBLIC")
		return `${ownerOf(list)} marked this task as private.`;
	if (f.overrides)
		return "This repeating task has occurrences changed in another app; shown read-only.";
	if (f.extraDates)
		return "This task repeats on extra or skipped dates set in another app; shown read-only.";
	if (f.rrule && !readableRule(f.rrule))
		return "Its repeat rule can't be read here; change it in another app.";
	return null;
}

/** ical.js can iterate the rule (it has a FREQ it knows). */
function readableRule(rrule: string): boolean {
	try {
		return !!ICAL.Recur.fromString(rrule).freq;
	} catch {
		return false;
	}
}

/** Which app last wrote a task, from its PRODID (the sheet footer says "… in tasks.org"). */
export function originOf(prodid: string): string | null {
	const p = prodid.toLowerCase();
	if (p.includes("tasks.org")) return "tasks.org";
	if (p.includes("planify")) return "Planify";
	if (p.includes("desk-tasks")) return "desk-tasks";
	if (p.includes("timesheet")) return "timesheet";
	if (p.includes("nextcloud")) return "Nextcloud";
	return prodid ? "another app" : null;
}

const zoneOf = (d: IcalDate | null) =>
	d?.kind === "date-time" ? (d.utc ? "UTC" : d.tzid) : null;

function toView(
	ctx: Ctx,
	row: TaskRecord,
	list: ListRecord,
	p: Parsed,
	sections: Map<string, string>,
): TaskView {
	const { f, doc } = p;
	const section = f.parentUid ? (sections.get(f.parentUid) ?? null) : null;
	const created = f.created ? instantOf(f.created, ctx.tz, doc) : null;
	const due = f.due ? dueInApp(f.due, ctx.tz, doc) : null;
	const start = f.start ? dueInApp(f.start, ctx.tz, doc) : null;
	return {
		id: ctx.store.idOf(row.href),
		href: row.href,
		list: list.href,
		uid: f.uid,
		summary: f.summary,
		description: f.description,
		status: f.status,
		priority: priorityLevel(f.priority),
		due: due ? { ...due, zone: zoneOf(f.due) } : null,
		start: start ? { date: start.date, minutes: start.minutes } : null,
		completedAt: f.completed ? instantOf(f.completed, ctx.tz, doc) : null,
		tags: f.categories,
		parentUid: section ? null : f.parentUid,
		section,
		sortOrder:
			f.sortOrder ??
			(created === null ? 0 : Math.round(created / 1000) - APPLE_EPOCH_S),
		readOnly: readOnlyReason(row, list, f),
		recurring: f.recurring,
		reminders: f.alarms.flatMap((a) =>
			a.trigger && (a.action === "DISPLAY" || a.action === "AUDIO")
				? [
						{
							key: a.key,
							label: triggerLabel(a.trigger, ctx.tz),
							trigger: a.trigger,
							at: triggerInstant(a.trigger, f, ctx.tz, doc),
						},
					]
				: [],
		),
		repeat: f.rrule
			? {
					text: describeRule(f.rrule, due?.date ?? start?.date ?? null),
					rule: ruleOf(
						f.rrule,
						(f.due ?? f.start)?.date ?? null,
						f.repeatFromCompletion,
					),
				}
			: null,
		klass: f.klass,
		pinned: f.pinned,
		location: f.location,
		url: f.url,
		redacted: list.shared && !list.writable && f.klass === "CONFIDENTIAL",
		origin: originOf(f.prodid),
		createdAt: created,
		modifiedAt: f.modified ? instantOf(f.modified, ctx.tz, doc) : null,
	};
}

/** Every task of the lists still there (Planify sections excluded). */
export function listTasks(ctx: Ctx): TaskView[] {
	const lists = new Map(
		ctx.store
			.lists()
			.filter((l) => l.error?.kind !== "gone")
			.map((l) => [l.href, l]),
	);
	const all = ctx.store.tasks().flatMap((r) => {
		const list = lists.get(r.list);
		const p = list ? parsed(r) : null;
		return list && p ? [{ r, p, list }] : [];
	});
	// Sections per list: a task only belongs to a section of its own list.
	const sections = new Map<string, Map<string, string>>();
	for (const { r, p } of all)
		if (isSection(p.f)) {
			const m = sections.get(r.list) ?? new Map<string, string>();
			m.set(p.f.uid, p.f.summary.slice(PLANIFY_SECTION.length));
			sections.set(r.list, m);
		}
	const none = new Map<string, string>();
	return all
		.filter(({ p }) => !isSection(p.f))
		.map(({ r, p, list }) =>
			toView(ctx, r, list, p, sections.get(r.list) ?? none),
		);
}

/** Tasks that couldn't be parsed, per list (shown as "2 tasks in Work couldn't be read."). */
export function unreadable(ctx: Ctx, list: string): TaskRecord[] {
	return ctx.store.tasksOf(list).filter((r) => parsed(r) === null);
}

export function taskView(ctx: Ctx, href: string): TaskView {
	const t = listTasks(ctx).find((x) => x.href === href);
	if (!t)
		throw new CoreError(
			"gone",
			"That task is no longer here. It may have been deleted or moved in Nextcloud.",
		);
	return t;
}

/** The stored row and its list, for writes. */
export function taskRow(
	ctx: Ctx,
	href: string,
): { row: TaskRecord; list: ListRecord } {
	const row = ctx.store.task(href);
	if (!row)
		throw new CoreError(
			"gone",
			"That task is no longer here. It may have been deleted or moved in Nextcloud.",
		);
	const list = ctx.store.list(row.list);
	if (!list) throw new Error("Broken invariant: a task without its list.");
	return { row, list };
}

/** One side of a conflict, in words the dialog can show. */
export function sideOf(ctx: Ctx, text: string | null): TaskSide | null {
	if (text === null) return null;
	const doc = TaskDocument.parse(text);
	const f = doc.fields();
	let due = "none";
	if (f.due) {
		const d = dueInApp(f.due, ctx.tz, doc);
		due = d.minutes === null ? d.date : `${d.date} ${fmtClock(d.minutes)}`;
	}
	return {
		summary: f.summary,
		status: f.status,
		priority: priorityLevel(f.priority),
		due,
		tags: f.categories,
		description: f.description,
	};
}
