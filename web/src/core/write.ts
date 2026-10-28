// Guarded task writes. Every write edits the stored bytes in place, sends them with If-Match
// (412 → merge if the remote change doesn't overlap, else conflict), reads back byte for byte
// (a mismatch pauses writes) and is journaled for undo.
import {
	type CaldavClient,
	CaldavError,
	CaldavUnreachable,
	type Fetched,
} from "./caldav.ts";
import { asCore, type Ctx } from "./ctx.ts";
import { CoreError } from "./errors.ts";
import {
	dueBeforeStart,
	dueFromApp,
	dueInApp,
	type IcalDate,
	moveDue,
	newTaskText,
	sameIcalDate,
	TaskDocument,
	type TaskFields,
} from "./ical.ts";
import { addJournal, haltWrites, undoable } from "./journal.ts";
import {
	advance,
	type RepeatRule,
	rruleOf,
	WEEKDAYS,
	withCount,
} from "./recurrence.ts";
import type {
	JournalOp,
	ListRecord,
	TaskRecord,
	VersionRecord,
} from "./store.ts";
import { assertConnectedWritable, storeTask } from "./sync.ts";
import {
	PLANIFY_SECTION,
	parsed,
	readOnlyReason,
	sideOf,
	type TaskView,
	taskRow,
	taskView,
} from "./tasks.ts";
import { fmtDateNumeric, isDate, zoned } from "./time.ts";
import {
	TASK_PRIORITIES,
	TASK_STATUSES,
	type TaskPriority,
	type TaskStatus,
} from "./types.ts";

/** A change to some fields of a task; only these fields are touched in Nextcloud. */
export interface Change {
	summary?: string;
	description?: string;
	/** A due date picked in the app: date plus optional wall minutes (app time zone). */
	due?: { date: string; minutes: number | null } | null;
	/** Moves the due date to another day, keeping its time and form. */
	dueDate?: string;
	priority?: TaskPriority;
	status?: TaskStatus;
	tags?: string[];
	/** Start date (DTSTART), in the same forms as due. tasks.org hides the task until then. */
	start?: { date: string; minutes: number | null } | null;
	pinned?: boolean;
	klass?: "PUBLIC" | "CONFIDENTIAL" | "PRIVATE";
	location?: string;
	url?: string;
	/** PERCENT-COMPLETE 0–100; moves STATUS along (0 to do, 1–99 in progress, 100 done). */
	progress?: number;
	/** X-APPLE-SORT-ORDER (manual order; see order.ts for the rule that picks it). */
	order?: number;
	/** Repeat rule (the editor's subset); null stops repeating. Needs a due or start date. */
	repeat?: RepeatRule | null;
	/**
	 * With status COMPLETED on a repeating task: complete it for good instead of moving it to
	 * its next occurrence (a recurring subtask inside a completing parent).
	 */
	close?: boolean;
}

export interface CreateInput extends Change {
	summary: string;
	/** Href of the list; ignored for a subtask (it lives in its parent's list). */
	list?: string;
	/** Href of the parent task. */
	parent?: string;
}

/** Which stored fields each kind of change touches; a remote change to any of them overlaps. */
const TOUCHES: Record<keyof Change, (f: TaskFields) => unknown> = {
	summary: (f) => f.summary,
	description: (f) => f.description,
	due: (f) => f.due,
	dueDate: (f) => f.due,
	priority: (f) => f.priority,
	// Completing a repeating task moves its dates and COUNT too.
	status: (f) => [
		f.status,
		f.completed,
		f.percent,
		...(f.rrule ? [f.due, f.start, f.rrule] : []),
	],
	tags: (f) => f.categories,
	start: (f) => f.start,
	pinned: (f) => f.pinned,
	klass: (f) => f.klass,
	location: (f) => f.location,
	url: (f) => f.url,
	// A progress change writes STATUS too, so a status change elsewhere overlaps it.
	progress: (f) => [f.status, f.completed, f.percent],
	order: (f) => f.sortOrder,
	repeat: (f) => [f.rrule, f.repeatFromCompletion],
	close: (f) => [f.status, f.completed, f.percent],
};

function invalid(message: string): never {
	throw new CoreError("invalid", message);
}

/** The checks the HTTP schema made in timesheet: refuse before anything is sent. */
function validate(c: Change): Change {
	const out: Change = { ...c };
	if (c.summary !== undefined) {
		out.summary = c.summary.trim();
		if (!out.summary) invalid("Add what the task is.");
		if (out.summary.length > 500)
			invalid("The title is longer than 500 characters.");
	}
	if (c.description !== undefined && c.description.length > 20_000)
		invalid("The notes are longer than 20,000 characters.");
	if (c.due) {
		if (!isDate(c.due.date)) invalid("That due date isn't a valid date.");
		const m = c.due.minutes;
		if (m !== null && (!Number.isInteger(m) || m < 0 || m > 1439))
			invalid("That due time isn't valid.");
	}
	if (c.dueDate !== undefined && !isDate(c.dueDate))
		invalid("That due date isn't a valid date.");
	if (c.start) {
		if (!isDate(c.start.date)) invalid("That start date isn't a valid date.");
		const m = c.start.minutes;
		if (m !== null && (!Number.isInteger(m) || m < 0 || m > 1439))
			invalid("That start time isn't valid.");
	}
	if (
		c.klass !== undefined &&
		!["PUBLIC", "CONFIDENTIAL", "PRIVATE"].includes(c.klass)
	)
		invalid("Unknown privacy setting.");
	if (c.location !== undefined) {
		out.location = c.location.trim();
		if (out.location.length > 500) invalid("The location is too long.");
	}
	if (c.url !== undefined) {
		out.url = c.url.trim();
		if (out.url.length > 2000 || /\s/.test(out.url))
			invalid("That link isn't a valid address.");
	}
	if (c.repeat) {
		const r = c.repeat;
		if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(r.freq))
			invalid("Unknown repeat.");
		if (!Number.isInteger(r.interval) || r.interval < 1 || r.interval > 999)
			invalid("Repeat every 1 to 999.");
		if (r.byDay.some((d) => !(WEEKDAYS as readonly string[]).includes(d)))
			invalid("Unknown weekday.");
		if (
			r.end.kind === "count" &&
			(!Number.isInteger(r.end.count) || r.end.count < 1 || r.end.count > 999)
		)
			invalid("Repeat 1 to 999 times.");
		if (r.end.kind === "until" && !isDate(r.end.date))
			invalid("That end date isn't a valid date.");
	}
	if (c.order !== undefined && (!Number.isSafeInteger(c.order) || c.order < 0))
		invalid("That position isn't valid.");
	if (
		c.progress !== undefined &&
		(!Number.isFinite(c.progress) || c.progress < 0 || c.progress > 100)
	)
		invalid("Progress goes from 0 to 100 %.");
	if (c.priority !== undefined && !TASK_PRIORITIES.includes(c.priority))
		invalid("Unknown priority.");
	if (c.status !== undefined && !TASK_STATUSES.includes(c.status))
		invalid("Unknown status.");
	if (c.tags !== undefined) {
		out.tags = c.tags.map((t) => t.trim()).filter(Boolean);
		if (out.tags.length > 50 || out.tags.some((t) => t.length > 100))
			invalid("Too many tags, or a tag that is too long.");
	}
	return out;
}

/** Applies a change to iCalendar text in place. Returns the text unchanged if nothing differs. */
export function applyChange(ctx: Ctx, text: string, c: Change): string {
	const doc = TaskDocument.parse(text);
	const original = doc.toString();
	const f = doc.fields();
	if (c.summary !== undefined) {
		if (c.summary.startsWith(PLANIFY_SECTION))
			invalid(
				`Titles starting with “${PLANIFY_SECTION}” turn into sections in Planify. Pick another title.`,
			);
		if (c.summary !== f.summary) doc.setSummary(c.summary);
	}
	if (c.description !== undefined && c.description !== f.description)
		doc.setDescription(c.description);
	if (c.priority !== undefined) doc.setPriority(c.priority);
	if (c.tags !== undefined) doc.setCategories([...new Set(c.tags)]);
	if (c.status !== undefined) {
		const next =
			c.status === "COMPLETED" &&
			f.rrule &&
			!c.close &&
			f.status !== "COMPLETED"
				? advance(
						f.rrule,
						{ due: f.due, start: f.start },
						{
							fromCompletion: f.repeatFromCompletion,
							completedOn: zoned(ctx.now(), ctx.tz).date,
							tz: ctx.tz,
						},
					)
				: null;
		if (next && f.rrule) {
			// Same VTODO, next occurrence: dates move, COUNT counts down, it is open again.
			doc.openForNext();
			if (next.due) doc.setDue(next.due);
			if (next.start) doc.setStart(next.start);
			if (next.count !== null) doc.setRRule(withCount(f.rrule, next.count));
		} else doc.setStatus(c.status, ctx.now());
	}
	if (c.progress !== undefined) doc.setProgress(c.progress, ctx.now());
	if (c.pinned !== undefined) doc.setPinned(c.pinned);
	if (c.order !== undefined) doc.setSortOrder(c.order);
	if (c.klass !== undefined) doc.setClass(c.klass);
	if (c.location !== undefined && c.location !== f.location)
		doc.setText("LOCATION", c.location);
	if (c.url !== undefined && c.url !== f.url) doc.setUrl(c.url);
	const picked = (
		input: { date: string; minutes: number | null } | null | undefined,
		cur: IcalDate | null,
	): IcalDate | null | undefined => {
		if (input === null) return null;
		if (!input) return undefined;
		const shown = cur ? dueInApp(cur, ctx.tz, doc) : null;
		const same = shown?.date === input.date && shown.minutes === input.minutes;
		return same ? undefined : dueFromApp(input, cur, ctx.tz);
	};
	let due = picked(c.due, f.due);
	if (c.dueDate)
		due = f.due
			? moveDue(f.due, c.dueDate, ctx.tz, doc)
			: { kind: "date", date: c.dueDate };
	const start = picked(c.start, f.start);
	const dueChanged = due !== undefined && !sameIcalDate(due, f.due);
	const startChanged = start !== undefined && !sameIcalDate(start, f.start);
	const finalDue = dueChanged ? (due ?? null) : f.due;
	const finalStart = startChanged ? (start ?? null) : f.start;
	if (
		(dueChanged || startChanged) &&
		finalDue &&
		dueBeforeStart(finalDue, finalStart, ctx.tz, doc)
	) {
		if (!dueChanged)
			invalid(
				"The start is after the due date. Pick an earlier start or move the due date first.",
			);
		const at = finalStart ? dueInApp(finalStart, ctx.tz, doc).date : "";
		invalid(
			`This task starts on ${at ? fmtDateNumeric(at) : "a later day"}. A due date before its start isn't valid; change the start first.`,
		);
	}
	if (dueChanged) doc.setDue(due ?? null);
	if (startChanged) doc.setStart(start ?? null);
	if (c.repeat !== undefined) {
		if (c.repeat === null) {
			doc.setRRule(null);
			doc.setRepeatFromCompletion(false);
		} else {
			const anchor = finalDue ?? finalStart;
			if (!anchor) invalid("Set a due date to repeat.");
			doc.setRRule(rruleOf(c.repeat, anchor, ctx.tz));
			doc.setRepeatFromCompletion(c.repeat.fromCompletion);
		}
	} else if (
		f.rrule &&
		(dueChanged || startChanged) &&
		!finalDue &&
		!finalStart
	) {
		// Without dates a task can't repeat: the rule goes too (the Tasks app does the same;
		// the UI asks first).
		doc.setRRule(null);
		doc.setRepeatFromCompletion(false);
	}
	if (doc.toString() === original) return text;
	doc.touch(ctx.now());
	return doc.toString();
}

// ---------- gate, journal, failures ----------

function gate(ctx: Ctx, list: ListRecord, row?: TaskRecord): CaldavClient {
	const dc = assertConnectedWritable(ctx);
	if (list.error?.kind === "gone")
		throw new CoreError("gone", `“${list.name}” isn't in Nextcloud any more.`);
	if (!list.writable)
		throw new CoreError(
			"refused",
			`“${list.name}” is view only. You can see these tasks but not change them.`,
		);
	if (row) {
		const reason = readOnlyReason(row, list, parsed(row)?.f ?? null);
		if (reason)
			throw new CoreError(
				"refused",
				`This task can't be changed here: ${reason}`,
			);
	}
	return dc;
}

const version = (
	href: string,
	list: string,
	got: { etag: string; text?: string; ics?: string },
): VersionRecord => ({
	href,
	list,
	etag: got.etag,
	ics: got.text ?? got.ics ?? "",
});

type Op = JournalOp;

/** Pauses writes, journals the evidence and tells the user (see haltWrites). */
function halt(
	ctx: Ctx,
	e: {
		op: Op;
		target: string;
		before: VersionRecord | null;
		after: VersionRecord | null;
		reason: string;
		detail?: string;
		undoOf?: number;
	},
	userMessage = "Saving to Nextcloud is paused because a change couldn't be confirmed.",
): Promise<never> {
	return haltWrites(ctx, e, userMessage);
}

/**
 * A failed write. A clear refusal (4xx) changed nothing: it is journaled with Nextcloud's
 * message. A request that never left (connect) is a plain failure too. Anything else (no
 * answer, a server error) may or may not have been applied, so all writes pause.
 */
async function writeFailed(
	ctx: Ctx,
	err: unknown,
	op: Op,
	target: string,
	before: VersionRecord | null,
	undoOf?: number,
): Promise<never> {
	if (
		(err instanceof CaldavUnreachable && err.kind !== "connect") ||
		(err instanceof CaldavError && err.status >= 500)
	)
		return outcomeUnknown(ctx, err, op, target, before, undoOf);
	if (err instanceof CaldavError)
		addJournal(ctx, {
			op,
			target,
			before,
			after: null,
			status: "failed",
			message: err.message,
			...(undoOf === undefined ? {} : { undoOf }),
		});
	return asCore(err);
}

/** The write may have landed but we can't tell: pause, journal, say so. */
async function outcomeUnknown(
	ctx: Ctx,
	err: unknown,
	op: Op,
	target: string,
	before: VersionRecord | null,
	undoOf?: number,
): Promise<never> {
	return halt(ctx, {
		op,
		target,
		before,
		after: null,
		reason: `The result of a ${op} is unknown; it may or may not have been saved.`,
		detail: (err as Error).message,
		...(undoOf === undefined ? {} : { undoOf }),
	});
}

function conflict(
	ctx: Ctx,
	message: string,
	mine: string | null,
	theirs: string | null,
): CoreError {
	return new CoreError("conflict", message, {
		conflict: { mine: sideOf(ctx, mine), theirs: sideOf(ctx, theirs) },
	});
}

/** Reads the object back; anything but the exact bytes sent pauses writes. */
async function readBack(
	ctx: Ctx,
	dc: CaldavClient,
	e: {
		op: Op;
		href: string;
		list: string;
		sent: string;
		before: VersionRecord | null;
		undoOf?: number;
		/** The write makes the task private in a list shared with me: Nextcloud hides it then. */
		mayHide?: boolean;
	},
): Promise<Fetched | "hidden"> {
	let got: Fetched | null;
	try {
		got = await dc.get(e.href);
	} catch (err) {
		// The write itself went through; only its verification failed.
		return outcomeUnknown(ctx, err, e.op, e.href, e.before, e.undoOf);
	}
	if (got && got.text === e.sent && !got.binary) return got;
	if (!got && e.mayHide) return "hidden";
	if (got) storeTask(ctx, e.list, e.href, got);
	return halt(ctx, {
		op: e.op,
		target: e.href,
		before: e.before,
		after: got ? version(e.href, e.list, got) : null,
		reason: got
			? `The task read back differently after a ${e.op} (${e.href}).`
			: `The task wasn't there when read back after a ${e.op} (${e.href}).`,
		...(e.undoOf === undefined ? {} : { undoOf: e.undoOf }),
	});
}

/**
 * PUT with a precondition, read back byte for byte, store and journal. Returns null on 412 so
 * each caller decides what a changed task means (merge, conflict, refused undo); every other
 * failure goes through writeFailed.
 */
async function putVerified(
	ctx: Ctx,
	dc: CaldavClient,
	w: {
		op: "create" | "update";
		href: string;
		list: string;
		text: string;
		cond: { ifMatch: string } | { ifNoneMatch: "*" };
		before: VersionRecord | null;
		undoOf?: number;
		message?: string;
		mayHide?: boolean;
	},
): Promise<Fetched | "hidden" | null> {
	try {
		await dc.put(w.href, w.text, w.cond);
	} catch (err) {
		if (err instanceof CaldavError && err.status === 412) return null;
		return writeFailed(ctx, err, w.op, w.href, w.before, w.undoOf);
	}
	const got = await readBack(ctx, dc, {
		op: w.op,
		href: w.href,
		list: w.list,
		sent: w.text,
		before: w.before,
		...(w.undoOf === undefined ? {} : { undoOf: w.undoOf }),
		...(w.mayHide ? { mayHide: true } : {}),
	});
	if (got === "hidden") {
		// Saved and now invisible to me, as Nextcloud does with private tasks for sharees.
		ctx.store.forgetTask(w.href, ctx.now());
		addJournal(ctx, {
			op: w.op,
			target: w.href,
			before: w.before,
			after: null,
			status: "ok",
			message: "made private; Nextcloud hides it from you now",
		});
		return "hidden";
	}
	storeTask(ctx, w.list, w.href, got);
	addJournal(ctx, {
		op: w.op,
		target: w.href,
		before: w.before,
		after: version(w.href, w.list, got),
		status: "ok",
		...(w.message === undefined ? {} : { message: w.message }),
		...(w.undoOf === undefined ? {} : { undoOf: w.undoOf }),
	});
	return got;
}

const listOf = (ctx: Ctx, href: string): ListRecord => {
	const l = ctx.store.list(href);
	if (!l) throw new CoreError("gone", "That list doesn't exist (anymore).");
	return l;
};

/** A remote GET that can fail: failures become core failures. */
const fetchCurrent = (dc: CaldavClient, href: string) =>
	dc.get(href).catch((err: unknown) => asCore(err));

// ---------- update ----------

/** A private task in a list shared with me disappears for me once saved. */
const hidesFromMe = (list: ListRecord, text: string) =>
	list.shared && TaskDocument.parse(text).fields().klass === "PRIVATE";

/**
 * Changes some fields of a task. Returns the task as now stored, or null when the change made
 * it private in a list shared with me (Nextcloud hides it from me then).
 */
export async function updateTask(
	ctx: Ctx,
	href: string,
	input: Change,
): Promise<TaskView | null> {
	const change = validate(input);
	const { row, list } = taskRow(ctx, href);
	const dc = gate(ctx, list, row);
	const next = applyChange(ctx, row.ics, change);
	if (next === row.ics) return taskView(ctx, href);
	const saved = await putVerified(ctx, dc, {
		op: "update",
		href: row.href,
		list: list.href,
		text: next,
		cond: { ifMatch: row.etag },
		before: version(row.href, list.href, row),
		mayHide: hidesFromMe(list, next),
	});
	if (!saved) return mergeAndRetry(ctx, dc, row, list, change, next);
	if (saved === "hidden") return null;
	return taskView(ctx, href);
}

/**
 * The task changed in Nextcloud since our copy. If none of the fields this change touches
 * changed there, the change is applied to the new version and sent once more; otherwise the
 * user sees both versions and nothing is written.
 */
async function mergeAndRetry(
	ctx: Ctx,
	dc: CaldavClient,
	row: TaskRecord,
	list: ListRecord,
	change: Change,
	mine: string,
): Promise<TaskView | null> {
	const cur = await fetchCurrent(dc, row.href);
	if (!cur) {
		ctx.store.forgetTask(row.href, ctx.now());
		throw conflict(
			ctx,
			"This task was deleted in Nextcloud since the last sync. Nothing was written.",
			mine,
			null,
		);
	}
	storeTask(ctx, list.href, row.href, cur);
	const base = TaskDocument.parse(row.ics).fields();
	const theirsDoc = parsed({ href: row.href, etag: cur.etag, ics: cur.text });
	// The new version decides whether the task may be changed at all.
	const now = readOnlyReason(
		{ notUtf8: cur.binary },
		list,
		theirsDoc?.f ?? null,
	);
	if (now || !theirsDoc)
		throw new CoreError(
			"refused",
			`This task changed in Nextcloud since the last sync and can't be changed here any more: ${now} Nothing was written.`,
		);
	const theirs = theirsDoc.f;
	// Nextcloud already holds what the user wanted (e.g. completed on the phone too): done.
	const next = applyChange(ctx, cur.text, change);
	if (next === cur.text) return taskView(ctx, row.href);
	const overlap = (Object.keys(change) as (keyof Change)[]).filter(
		(k) =>
			JSON.stringify(TOUCHES[k](base)) !== JSON.stringify(TOUCHES[k](theirs)),
	);
	if (overlap.length)
		throw conflict(
			ctx,
			"This task changed in Nextcloud since the last sync, in the same fields. Nothing was written; compare both versions.",
			mine,
			cur.text,
		);
	const saved = await putVerified(ctx, dc, {
		op: "update",
		href: row.href,
		list: list.href,
		text: next,
		cond: { ifMatch: cur.etag },
		before: version(row.href, list.href, cur),
		message: "merged with a change made elsewhere to other fields",
		mayHide: hidesFromMe(list, next),
	});
	if (saved === "hidden") return null;
	if (!saved)
		throw conflict(
			ctx,
			"This task is being changed in Nextcloud right now. Nothing was written; try again.",
			next,
			null,
		);
	return taskView(ctx, row.href);
}

// ---------- create ----------

export async function createTask(
	ctx: Ctx,
	input: CreateInput,
): Promise<TaskView> {
	const { list: listHref, parent, ...fields } = input;
	const change = validate(fields);
	let list: ListRecord;
	let parentUid: string | null = null;
	if (parent) {
		// Subtasks live in their parent's list (tasks.org and Planify only link within a list).
		const p = taskRow(ctx, parent);
		list = p.list;
		parentUid = parsed(p.row)?.f.uid ?? null;
		if (!parentUid)
			throw new CoreError("refused", "The parent task couldn't be read.");
	} else {
		if (!listHref) invalid("Pick a list for the new task.");
		list = listOf(ctx, listHref);
	}
	const dc = gate(ctx, list);
	const uid = crypto.randomUUID();
	const href = `${list.href.replace(/\/*$/, "/")}${uid}.ics`;
	const text = applyChange(
		ctx,
		newTaskText({
			uid,
			summary: change.summary ?? "",
			now: ctx.now(),
			parentUid,
		}),
		change,
	);
	const saved = await putVerified(ctx, dc, {
		op: "create",
		href,
		list: list.href,
		text,
		cond: { ifNoneMatch: "*" },
		before: null,
	});
	// A fresh UUID file name that already exists: nothing was written.
	if (!saved)
		throw new CoreError(
			"refused",
			"Nextcloud already has a task at that place. Nothing was written; try again.",
		);
	return taskView(ctx, href);
}

// ---------- delete & move (with subtasks) ----------

/** The task and its subtasks in the same list, children before parents (all of the mirror). */
export function subtree(ctx: Ctx, row: TaskRecord): TaskRecord[] {
	const rows = ctx.store.tasksOf(row.list);
	const byParent = new Map<string, TaskRecord[]>();
	for (const r of rows) {
		const p = parsed(r)?.f.parentUid;
		if (p) byParent.set(p, [...(byParent.get(p) ?? []), r]);
	}
	const out: TaskRecord[] = [];
	const seen = new Set<string>();
	const visit = (r: TaskRecord) => {
		if (seen.has(r.href)) return;
		seen.add(r.href);
		const uid = parsed(r)?.f.uid;
		for (const c of uid ? (byParent.get(uid) ?? []) : []) visit(c);
		out.push(r);
	};
	visit(row);
	return out;
}

/** Runs steps in order; a failure says how many were already done ("2 of 5 tasks were …"). */
export async function eachOf<T>(
	nodes: T[],
	verb: string,
	step: (n: T) => Promise<void>,
): Promise<void> {
	let done = 0;
	try {
		for (const n of nodes) {
			await step(n);
			done++;
		}
	} catch (err) {
		if (done && err instanceof CoreError)
			throw new CoreError(
				err.kind,
				`${done} of ${nodes.length} tasks were already ${verb}. ${err.message}`,
				err.extra,
			);
		throw err;
	}
}

export async function deleteTask(
	ctx: Ctx,
	href: string,
): Promise<{ deleted: number }> {
	const { row, list } = taskRow(ctx, href);
	const nodes = subtree(ctx, row);
	let dc: CaldavClient | null = null;
	for (const n of nodes) dc = gate(ctx, list, n);
	if (!dc) throw new Error("Broken invariant: an empty subtree.");
	const client = dc;
	await eachOf(nodes, "deleted (subtasks first)", (n) =>
		deleteOne(ctx, client, n, list.href),
	);
	return { deleted: nodes.length };
}

async function deleteOne(
	ctx: Ctx,
	dc: CaldavClient,
	n: { href: string; etag: string; ics: string },
	list: string,
	undoOf?: number,
): Promise<void> {
	const before = version(n.href, list, n);
	try {
		await dc.delete(n.href, n.etag);
	} catch (err) {
		if (err instanceof CaldavError && err.status === 412) {
			if (undoOf)
				throw new CoreError(
					"conflict",
					"This task changed in Nextcloud after the change, so undoing it would delete that newer version. Nothing was changed.",
				);
			const cur = await fetchCurrent(dc, n.href);
			if (cur) storeTask(ctx, list, n.href, cur);
			else ctx.store.forgetTask(n.href, ctx.now());
			throw conflict(
				ctx,
				"This task changed in Nextcloud since the last sync, so it wasn't deleted. Check the new version.",
				null,
				cur?.text ?? null,
			);
		}
		return writeFailed(ctx, err, "delete", n.href, before, undoOf);
	}
	const still = await dc
		.etag(n.href)
		.catch((err: unknown) =>
			outcomeUnknown(ctx, err, "delete", n.href, before, undoOf),
		);
	if (still !== null) {
		await halt(ctx, {
			op: "delete",
			target: n.href,
			before,
			after: null,
			reason: `The task was still there after deleting it (${n.href}).`,
			...(undoOf === undefined ? {} : { undoOf }),
		});
	}
	ctx.store.forgetTask(n.href, ctx.now());
	addJournal(ctx, {
		op: "delete",
		target: n.href,
		before,
		after: null,
		status: "ok",
		...(undoOf === undefined ? {} : { undoOf }),
	});
}

export async function moveTask(
	ctx: Ctx,
	href: string,
	to: string,
): Promise<TaskView> {
	const { row, list } = taskRow(ctx, href);
	const target = listOf(ctx, to);
	if (target.href === list.href) return taskView(ctx, href);
	const nodes = subtree(ctx, row);
	for (const n of nodes) gate(ctx, list, n);
	if (!target.components.includes("VTODO"))
		throw new CoreError("refused", `“${target.name}” can't hold tasks.`);
	const dc = gate(ctx, target);
	// Children first, then the task itself, like Nextcloud Tasks.
	let moved = href;
	await eachOf(nodes, "moved (subtasks first)", async (n) => {
		const dest = await moveOne(ctx, dc, n, list.href, target);
		if (n.href === href) moved = dest;
	});
	return taskView(ctx, moved);
}

async function moveOne(
	ctx: Ctx,
	dc: CaldavClient,
	n: { href: string; etag: string; ics: string },
	fromList: string,
	target: ListRecord,
	undoOf?: number,
): Promise<string> {
	// A fresh file name: Nextcloud may report a re-used href as deleted (see the research doc).
	const dest = `${target.href.replace(/\/*$/, "/")}${crypto.randomUUID()}.ics`;
	const before = version(n.href, fromList, n);
	try {
		await dc.move(n.href, dest, n.etag);
	} catch (err) {
		if (err instanceof CaldavError && err.status === 412) {
			if (undoOf)
				throw new CoreError(
					"conflict",
					"This task changed in Nextcloud after the move, so it wasn't moved back. Nothing was changed.",
				);
			const cur = await fetchCurrent(dc, n.href);
			if (cur) storeTask(ctx, fromList, n.href, cur);
			throw conflict(
				ctx,
				"This task changed in Nextcloud since the last sync, so it wasn't moved. Check the new version.",
				null,
				cur?.text ?? null,
			);
		}
		if (err instanceof CaldavError && err.condition === "no-uid-conflict")
			throw new CoreError(
				"refused",
				`“${target.name}” already has a task with the same identity (UID), so it wasn't moved.`,
			);
		return writeFailed(ctx, err, "move", n.href, before, undoOf);
	}
	const got = await readBack(ctx, dc, {
		op: "move",
		href: dest,
		list: target.href,
		sent: n.ics,
		before,
		...(undoOf === undefined ? {} : { undoOf }),
	});
	if (got === "hidden")
		throw new Error("Broken invariant: a moved task hidden.");
	const source = await dc
		.etag(n.href)
		.catch((err: unknown) =>
			outcomeUnknown(ctx, err, "move", n.href, before, undoOf),
		);
	if (source !== null) {
		await halt(ctx, {
			op: "move",
			target: dest,
			before,
			after: version(dest, target.href, got),
			reason: `The task was still in its old list after moving it (${n.href}).`,
			...(undoOf === undefined ? {} : { undoOf }),
		});
	}
	ctx.store.moveTask(
		n.href,
		{
			href: dest,
			list: target.href,
			etag: got.etag,
			ics: got.text,
			notUtf8: false,
			uid: parsed({ href: dest, etag: got.etag, ics: got.text })?.f.uid ?? "",
		},
		ctx.now(),
	);
	addJournal(ctx, {
		op: "move",
		target: dest,
		before,
		after: version(dest, target.href, got),
		status: "ok",
		...(undoOf === undefined ? {} : { undoOf }),
	});
	return dest;
}

// ---------- undo ----------

const UNDO_REFUSED =
	"This task changed in Nextcloud after that change, so undoing it would overwrite the newer version. Nothing was changed.";

/** Reverts one journaled write. Nextcloud must still hold our "after" (If-Match on its ETag). */
export async function undo(ctx: Ctx, journalId: number): Promise<void> {
	const e = undoable(ctx, journalId);
	const { before, after } = e;
	if (e.op === "create" && after) {
		const dc = gate(ctx, listOf(ctx, after.list));
		await deleteOne(ctx, dc, after, after.list, e.id);
	} else if (e.op === "update" && before && after) {
		const list = listOf(ctx, after.list);
		const dc = gate(ctx, list);
		const saved = await putVerified(ctx, dc, {
			op: "update",
			href: after.href,
			list: list.href,
			text: before.ics,
			cond: { ifMatch: after.etag },
			before: after,
			undoOf: e.id,
		});
		if (!saved) throw new CoreError("conflict", UNDO_REFUSED);
	} else if (e.op === "delete" && before) {
		const list = listOf(ctx, before.list);
		const dc = gate(ctx, list);
		const saved = await putVerified(ctx, dc, {
			op: "create",
			href: before.href,
			list: list.href,
			text: before.ics,
			cond: { ifNoneMatch: "*" },
			before: null,
			undoOf: e.id,
		});
		if (!saved)
			throw new CoreError(
				"conflict",
				"Something else was saved in that place since, so the task wasn't restored. Nothing was changed.",
			);
	} else if (e.op === "move" && before && after) {
		const back = listOf(ctx, before.list);
		gate(ctx, listOf(ctx, after.list));
		const dc = gate(ctx, back);
		await moveOne(ctx, dc, after, after.list, back, e.id);
	} else throw new CoreError("refused", "This change can't be undone.");
	ctx.store.markUndone(journalId);
}
