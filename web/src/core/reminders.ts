// Reminders: which VALARMs (DISPLAY or AUDIO, absolute or relative to DUE/DTSTART) and due
// times fire when, and what a tick should do with them. Pure: the app keeps the fired keys and
// snoozes (IndexedDB) and calls `tickPlan` every 30 s from the bridge's `tick` event, comparing
// wall-clock time (no long timers: they drift across sleep and a covered WebView throttles them).
import {
	type IcalDate,
	instantOf,
	TaskDocument,
	type Trigger,
} from "./ical.ts";
import { fmtClock, fmtDayShort, wallToInstant, zoned } from "./time.ts";

/** An all-day due date's reminders count from 09:00 that day (DATE values have no time). */
export const ALL_DAY_HOUR = 9;
/** A trigger older than this when first seen is "missed", not fired as if it were now. */
export const GRACE_MS = 5 * 60_000;
/** Missed reminders from the last 12 h become one summary; older ones are dropped. */
export const MISSED_WINDOW_MS = 12 * 60 * 60_000;
/** How far ahead reminders are computed. */
export const AHEAD_MS = 48 * 60 * 60_000;

export interface ReminderEntry {
	/** href + UID + instant: each fires once, and resets when tasks.org re-creates the task. */
	key: string;
	href: string;
	uid: string;
	at: number;
	summary: string;
	list: string;
	kind: "alarm" | "due";
	/** Due wall time in the app ("14:00") or date ("Fri 30 Oct"), for the toast body. */
	dueText: string;
	/** Done is left out of the toast for read-only tasks. */
	readOnly: boolean;
}

/** The instant a date means for reminders: its own instant, all-day ones at 09:00 local. */
export function reminderInstant(
	d: IcalDate,
	tz: string,
	doc?: TaskDocument,
): number {
	return d.kind === "date"
		? wallToInstant(d.date, ALL_DAY_HOUR * 60, tz)
		: instantOf(d, tz, doc);
}

/** When a trigger fires, or null when the date it hangs on is missing. */
export function triggerInstant(
	t: Trigger,
	dates: { due: IcalDate | null; start: IcalDate | null },
	tz: string,
	doc?: TaskDocument,
): number | null {
	if (t.kind === "absolute") return t.at;
	const base = t.related === "END" ? dates.due : dates.start;
	return base ? reminderInstant(base, tz, doc) + t.seconds * 1000 : null;
}

/** "At due time", "15 min before", "1 hour before", "1 day before", "Fri 30 Oct 14:00". */
export function triggerLabel(t: Trigger, tz: string): string {
	if (t.kind === "absolute") {
		const z = zoned(t.at, tz);
		return `${fmtDayShort(z.date)} ${fmtClock(z.minutes)}`;
	}
	const what = t.related === "END" ? "due time" : "start";
	if (t.seconds === 0) return `At ${what}`;
	const s = Math.abs(t.seconds);
	const amount =
		s % 86_400 === 0
			? `${s / 86_400} day${s === 86_400 ? "" : "s"}`
			: s % 3600 === 0
				? `${s / 3600} hour${s === 3600 ? "" : "s"}`
				: `${Math.round(s / 60)} min`;
	return `${amount} ${t.seconds < 0 ? "before" : "after"}${t.related === "START" ? " start" : ""}`;
}

/** The editor's presets, written relative to DUE like tasks.org does. */
export const PRESETS: { label: string; trigger: Trigger }[] = [
	{
		label: "At due time",
		trigger: { kind: "relative", related: "END", seconds: 0 },
	},
	{
		label: "15 min before",
		trigger: { kind: "relative", related: "END", seconds: -900 },
	},
	{
		label: "1 hour before",
		trigger: { kind: "relative", related: "END", seconds: -3600 },
	},
	{
		label: "1 day before",
		trigger: { kind: "relative", related: "END", seconds: -86_400 },
	},
];

export const reminderKey = (href: string, uid: string, at: number) =>
	`${href}\n${uid}\n${at}`;

/** What the scheduler needs of a task (a TaskView has all of it). */
export interface Remindable {
	href: string;
	uid: string;
	list: string;
	summary: string;
	status: string;
	readOnly: string | null;
	due: { date: string; minutes: number | null; at: number | null } | null;
}

/**
 * Reminder entries of open tasks between `from` and `to`: their DISPLAY/AUDIO alarms (EMAIL
 * ignored), and, when `dueTime` is on, the due time of timed tasks that have no alarm.
 */
export function reminderEntries(
	tasks: { view: Remindable; ics: string }[],
	opts: { tz: string; dueTime: boolean; notify: (list: string) => boolean },
	from: number,
	to: number,
): ReminderEntry[] {
	const out: ReminderEntry[] = [];
	for (const { view: t, ics } of tasks) {
		if (t.status === "COMPLETED" || t.status === "CANCELLED") continue;
		if (!opts.notify(t.list)) continue;
		let doc: TaskDocument;
		try {
			doc = TaskDocument.parse(ics);
		} catch {
			continue;
		}
		const f = doc.fields();
		const dueText = !t.due
			? ""
			: t.due.minutes === null
				? fmtDayShort(t.due.date)
				: fmtClock(t.due.minutes);
		const add = (at: number, kind: ReminderEntry["kind"]) => {
			if (at < from || at > to) return;
			out.push({
				key: reminderKey(t.href, t.uid, at),
				href: t.href,
				uid: t.uid,
				at,
				summary: t.summary,
				list: t.list,
				kind,
				dueText,
				readOnly: t.readOnly !== null,
			});
		};
		const alarms = f.alarms.filter(
			(a) => a.action === "DISPLAY" || a.action === "AUDIO",
		);
		for (const a of alarms) {
			const at = a.trigger ? triggerInstant(a.trigger, f, opts.tz, doc) : null;
			if (at !== null) add(at, "alarm");
		}
		if (!alarms.length && opts.dueTime && t.due?.at != null)
			add(t.due.at, "due");
	}
	// Two alarms at the same instant are one reminder.
	return [...new Map(out.map((e) => [e.key, e])).values()].sort(
		(a, b) => a.at - b.at,
	);
}

export interface Snooze {
	entry: ReminderEntry;
	until: number;
}

/** "15 min", "1 h", "tomorrow 9:00" (local). */
export function snoozeUntil(
	choice: "15m" | "1h" | "tomorrow",
	now: number,
	tz: string,
): number {
	if (choice === "15m") return now + 15 * 60_000;
	if (choice === "1h") return now + 60 * 60_000;
	const today = zoned(now, tz).date;
	const [y, m, d] = today.split("-").map(Number) as [number, number, number];
	const tomorrow = new Date(Date.UTC(y, m - 1, d + 1))
		.toISOString()
		.slice(0, 10);
	return wallToInstant(tomorrow, 9 * 60, tz);
}

/**
 * What a tick does: `fire` (due now), `missed` (overdue for more than the grace time, within
 * 12 h: one summary toast), `expire` (older: remembered as fired without a toast), and snoozes
 * that are due. Nothing fires while notifications are paused; it waits until the pause ends.
 */
export function tickPlan(
	entries: ReminderEntry[],
	now: number,
	state: {
		fired: ReadonlySet<string>;
		snoozes: Snooze[];
		pausedUntil: number | null;
	},
): {
	fire: ReminderEntry[];
	missed: ReminderEntry[];
	expire: string[];
	snoozesDue: Snooze[];
} {
	const fire: ReminderEntry[] = [];
	const missed: ReminderEntry[] = [];
	const expire: string[] = [];
	if (state.pausedUntil !== null && now < state.pausedUntil)
		return { fire, missed, expire, snoozesDue: [] };
	for (const e of entries) {
		if (e.at > now || state.fired.has(e.key)) continue;
		const late = now - e.at;
		if (late <= GRACE_MS) fire.push(e);
		else if (late <= MISSED_WINDOW_MS) missed.push(e);
		else expire.push(e.key);
	}
	const snoozesDue = state.snoozes.filter((s) => s.until <= now);
	return { fire, missed, expire, snoozesDue };
}

/** "3 reminders while you were away". */
export const missedText = (n: number) =>
	`${n} reminder${n === 1 ? "" : "s"} while you were away`;

/** The toast body: "Due 14:00 · Work". */
export function toastBody(e: ReminderEntry, listName: string): string {
	return [e.dueText ? `Due ${e.dueText}` : "", listName]
		.filter(Boolean)
		.join(" · ");
}
