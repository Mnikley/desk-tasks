// The detail sheet's draft: the form, what Save sends of it, and rebasing onto a fresher
// version (the pure parts; Restore lives in the UI).
import type { TaskView } from "../core/tasks.ts";
import { fmtClock, parseClock } from "../core/time.ts";
import type { TaskPriority, TaskStatus } from "../core/types.ts";
import type { Change } from "../core/write.ts";
import { parseTaskTitle, type TitleParse } from "./quickentry.ts";

export interface Form {
	summary: string;
	description: string;
	/** Href of the list. */
	list: string;
	status: TaskStatus;
	priority: TaskPriority;
	dueDate: string;
	dueTime: string;
	tags: string[];
}

export function formOf(
	t: TaskView | null,
	list: string,
	due?: string,
	status?: TaskStatus,
): Form {
	return {
		summary: t?.summary ?? "",
		description: t?.description ?? "",
		list: t?.list ?? list,
		status: t?.status ?? status ?? "NEEDS-ACTION",
		priority: t?.priority ?? "none",
		dueDate: t?.due?.date ?? due ?? "",
		dueTime: t?.due?.minutes != null ? fmtClock(t.due.minutes) : "",
		tags: t?.tags ?? [],
	};
}

export const sameForm = (a: Form, b: Form) =>
	JSON.stringify(a) === JSON.stringify(b);

/** `fresh`, with every field the draft changed from `from` kept as the draft has it. */
export function rebase(fresh: Form, from: Form, draft: Form): Form {
	const out: Record<string, unknown> = { ...fresh };
	for (const k of Object.keys(fresh) as (keyof Form)[])
		if (JSON.stringify(draft[k]) !== JSON.stringify(from[k])) out[k] = draft[k];
	return out as unknown as Form;
}

/** The #tags and !priority typed into the title: ones the saved title has already stay text. */
export function readTitle(f: Form, saved: Form): TitleParse {
	const had = parseTaskTitle(saved.summary).tokens;
	return parseTaskTitle(
		f.summary,
		new Set(had.map((t) => saved.summary.slice(t.from, t.to))),
	);
}

/**
 * The form with the #tags and !priority typed into its title moved into its tags and priority;
 * the same form when there are none. null: nothing but tokens, so no title would be left.
 */
export function liftMarks(f: Form, saved: Form): Form | null {
	const read = readTitle(f, saved);
	if (!read.tokens.length) return f;
	if (!read.summary) return null;
	return {
		...f,
		summary: read.summary,
		priority: read.priority ?? f.priority,
		tags: [...f.tags, ...read.tags.filter((t) => !f.tags.includes(t))],
	};
}

/** The fields of `next` that differ from `base`, as the change Save sends. */
export function changeOf(
	base: Form,
	next: Form,
	due: { date: string; minutes: number | null } | null,
): Change {
	const change: Change = {};
	if (next.summary !== base.summary) change.summary = next.summary;
	if (next.description !== base.description)
		change.description = next.description;
	if (next.priority !== base.priority) change.priority = next.priority;
	if (next.status !== base.status) change.status = next.status;
	if (next.tags.join("\n") !== base.tags.join("\n")) change.tags = next.tags;
	if (next.dueDate !== base.dueDate || next.dueTime !== base.dueTime)
		change.due = due;
	return change;
}

/** A date the date field holds while its year is still being typed ("0002-10-21") isn't whole. */
export const wholeDate = (d: string) => /^[1-9]\d{3}-\d{2}-\d{2}$/.test(d);

export const BAD_TIME = "The due time must look like 14:30.";

/** The due date and time Save sends, or what is wrong with them. A bad time is named first. */
export function dueOf(
	f: Form,
):
	| { due: { date: string; minutes: number | null } | null }
	| { error: string } {
	const minutes = f.dueTime.trim() === "" ? null : parseClock(f.dueTime);
	if (minutes === null && f.dueTime.trim() !== "") return { error: BAD_TIME };
	if (f.dueDate && !wholeDate(f.dueDate))
		return { error: "The due date isn't complete." };
	if (f.dueTime.trim() !== "" && !f.dueDate)
		return { error: "Pick a due date for the time." };
	return { due: f.dueDate ? { date: f.dueDate, minutes } : null };
}
