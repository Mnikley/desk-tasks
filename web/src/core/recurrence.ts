// Repeating tasks: advance the same VTODO in place on completion (like tasks.org, Planify and
// what the Tasks app actually does), describe a rule in words, and build the editor's subset
// (daily / weekly with weekdays / monthly same day or last day / yearly, every N, ends never /
// on a date / after N times). Rules outside the subset stay byte for byte.
import ICAL from "ical.js";
import { type IcalDate, instantOf } from "./ical.ts";
import {
	addDays,
	fmtDateNumeric,
	fmtDayShort,
	weekday,
	zoned,
} from "./time.ts";

export type Freq = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
export const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** The editor's rule subset. */
export interface RepeatRule {
	freq: Freq;
	interval: number;
	/** Weekly: the weekdays ("MO", …); empty means the anchor's weekday. */
	byDay: string[];
	/** Monthly: the same day as the anchor, or the last day (BYMONTHDAY=-1). */
	monthDay: "same" | "last";
	end:
		| { kind: "never" }
		| { kind: "until"; date: string }
		| { kind: "count"; count: number };
	/** Next date counted from the completion day instead of the due date. */
	fromCompletion: boolean;
}

/** The RRULE value as parts, keys upper-cased, in the order written. */
function parts(rrule: string): [string, string][] {
	return rrule
		.trim()
		.split(";")
		.filter(Boolean)
		.map((p) => {
			const eq = p.indexOf("=");
			return [p.slice(0, eq).toUpperCase(), p.slice(eq + 1)] as [
				string,
				string,
			];
		});
}

const SUBSET_KEYS = new Set([
	"FREQ",
	"INTERVAL",
	"BYDAY",
	"BYMONTHDAY",
	"COUNT",
	"UNTIL",
	"WKST",
]);

/**
 * The rule in the editor's terms, or null when it is outside the subset (shown read-only as
 * text and kept as written). `anchor` is the due (or start) date the rule hangs on.
 */
export function ruleOf(
	rrule: string,
	anchor: string | null,
	fromCompletion: boolean,
): RepeatRule | null {
	const p = new Map(parts(rrule));
	if ([...p.keys()].some((k) => !SUBSET_KEYS.has(k))) return null;
	const freq = p.get("FREQ");
	if (
		freq !== "DAILY" &&
		freq !== "WEEKLY" &&
		freq !== "MONTHLY" &&
		freq !== "YEARLY"
	)
		return null;
	const interval = Number(p.get("INTERVAL") ?? "1");
	if (!Number.isInteger(interval) || interval < 1) return null;
	const byDay = (p.get("BYDAY") ?? "").split(",").filter(Boolean);
	if (byDay.some((d) => !(WEEKDAYS as readonly string[]).includes(d)))
		return null;
	if (byDay.length && freq !== "WEEKLY") return null;
	const md = p.get("BYMONTHDAY");
	let monthDay: "same" | "last" = "same";
	if (md !== undefined) {
		if (freq !== "MONTHLY") return null;
		if (md === "-1") monthDay = "last";
		else if (!anchor || Number(md) !== Number(anchor.slice(8, 10))) return null;
	}
	let end: RepeatRule["end"] = { kind: "never" };
	const count = p.get("COUNT");
	const until = p.get("UNTIL");
	if (count !== undefined) {
		const n = Number(count);
		if (!Number.isInteger(n) || n < 1) return null;
		end = { kind: "count", count: n };
	} else if (until !== undefined) {
		const m = /^(\d{4})(\d{2})(\d{2})/.exec(until);
		if (!m) return null;
		end = { kind: "until", date: `${m[1]}-${m[2]}-${m[3]}` };
	}
	return { freq, interval, byDay, monthDay, end, fromCompletion };
}

/**
 * The RRULE value for a rule. UNTIL follows the anchor's form (RFC 5545 §3.3.10): a DATE for
 * date tasks, local time without zone for floating ones, UTC for TZID or UTC tasks.
 */
export function rruleOf(
	rule: RepeatRule,
	anchor: IcalDate,
	tz: string,
): string {
	const out = [`FREQ=${rule.freq}`];
	if (rule.interval > 1) out.push(`INTERVAL=${rule.interval}`);
	if (rule.freq === "WEEKLY" && rule.byDay.length)
		out.push(
			`BYDAY=${WEEKDAYS.filter((d) => rule.byDay.includes(d)).join(",")}`,
		);
	if (rule.freq === "MONTHLY" && rule.monthDay === "last")
		out.push("BYMONTHDAY=-1");
	if (rule.end.kind === "count") out.push(`COUNT=${rule.end.count}`);
	if (rule.end.kind === "until")
		out.push(`UNTIL=${untilValue(rule.end.date, anchor, tz)}`);
	return out.join(";");
}

function untilValue(date: string, anchor: IcalDate, tz: string): string {
	const compact = date.replaceAll("-", "");
	if (anchor.kind === "date") return compact;
	if (!anchor.utc && !anchor.tzid) return `${compact}T235959`;
	// The end of that day where the task lives, in UTC.
	const zone = anchor.utc ? "UTC" : anchor.tzid;
	const end = instantOf(
		{ kind: "date-time", date, time: "235959", tzid: zone, utc: anchor.utc },
		tz,
	);
	const z = zoned(end, "UTC");
	const hh = String(Math.floor(z.minutes / 60)).padStart(2, "0");
	const mm = String(z.minutes % 60).padStart(2, "0");
	return `${z.date.replaceAll("-", "")}T${hh}${mm}${String(z.seconds).padStart(2, "0")}Z`;
}

/** "Weekly · Mon, Wed", "Every 2 weeks", "Monthly · last day", "Custom repeat: …". */
export function describeRule(rrule: string, anchor: string | null): string {
	const rule = ruleOf(rrule, anchor, false);
	if (!rule) return `Custom repeat: ${customText(rrule)}`;
	const unit = {
		DAILY: "day",
		WEEKLY: "week",
		MONTHLY: "month",
		YEARLY: "year",
	}[rule.freq];
	const base =
		rule.interval === 1
			? {
					DAILY: "Daily",
					WEEKLY: "Weekly",
					MONTHLY: "Monthly",
					YEARLY: "Yearly",
				}[rule.freq]
			: `Every ${rule.interval} ${unit}s`;
	const extra: string[] = [];
	if (rule.byDay.length)
		extra.push(
			WEEKDAYS.filter((d) => rule.byDay.includes(d))
				.map((d) => DAY_NAMES[WEEKDAYS.indexOf(d)])
				.join(", "),
		);
	if (rule.freq === "MONTHLY" && rule.monthDay === "last")
		extra.push("last day");
	if (rule.end.kind === "count")
		extra.push(
			rule.end.count === 1 ? "last time" : `${rule.end.count} more times`,
		);
	if (rule.end.kind === "until")
		extra.push(`until ${fmtDateNumeric(rule.end.date)}`);
	return [base, ...extra].join(" · ");
}

const ORDINAL = ["", "1st", "2nd", "3rd", "4th", "5th"];

/** Plain words for rules the editor doesn't model ("every 2nd Tuesday of the month"). */
function customText(rrule: string): string {
	try {
		const r = ICAL.Recur.fromString(rrule);
		const unit =
			{
				HOURLY: "hour",
				MINUTELY: "minute",
				SECONDLY: "second",
				DAILY: "day",
				WEEKLY: "week",
				MONTHLY: "month",
				YEARLY: "year",
			}[r.freq] ?? "time";
		const every =
			r.interval > 1 ? `every ${r.interval} ${unit}s` : `every ${unit}`;
		const days = (r.parts.BYDAY ?? []) as string[];
		const named = days.map((d) => {
			const m = /^([+-]?\d)?(MO|TU|WE|TH|FR|SA|SU)$/.exec(String(d));
			if (!m) return String(d);
			const n = Number(m[1] ?? 0);
			const name =
				DAY_NAMES[WEEKDAYS.indexOf(m[2] as (typeof WEEKDAYS)[number])] ?? "";
			return n === 0
				? name
				: n === -1
					? `last ${name}`
					: `${ORDINAL[n] ?? `${n}th`} ${name}`;
		});
		return named.length
			? `every ${named.join(", ")}${r.interval > 1 ? ` (${every})` : ""}`
			: every;
	} catch {
		return rrule;
	}
}

// ---------- advancing on completion ----------

/** ICAL.Time of a date as written (wall clock of its own zone; UTC as UTC). */
function wallTime(d: IcalDate): ICAL.Time {
	const [y, m, day] = d.date.split("-").map(Number) as [number, number, number];
	if (d.kind === "date")
		return ICAL.Time.fromData({ year: y, month: m, day, isDate: true });
	return ICAL.Time.fromData({
		year: y,
		month: m,
		day,
		hour: Number(d.time.slice(0, 2)),
		minute: Number(d.time.slice(2, 4)),
		second: Number(d.time.slice(4, 6)),
		isDate: false,
	});
}

function fromWall(t: ICAL.Time, like: IcalDate): IcalDate {
	const date = `${String(t.year).padStart(4, "0")}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`;
	if (like.kind === "date") return { kind: "date", date };
	const time = `${String(t.hour).padStart(2, "0")}${String(t.minute).padStart(2, "0")}${String(t.second).padStart(2, "0")}`;
	return { ...like, date, time };
}

/** Seconds of a wall date-time, for shifting DTSTART by the amount DUE moved. */
const wallSeconds = (d: IcalDate) =>
	Date.UTC(
		...((d.date.split("-").map(Number) as [number, number, number]).map(
			(v, i) => (i === 1 ? v - 1 : v),
		) as [number, number, number]),
		d.kind === "date" ? 0 : Number(d.time.slice(0, 2)),
		d.kind === "date" ? 0 : Number(d.time.slice(2, 4)),
		d.kind === "date" ? 0 : Number(d.time.slice(4, 6)),
	) / 1000;

function shiftBy(d: IcalDate, seconds: number): IcalDate {
	if (d.kind === "date")
		return {
			kind: "date",
			date: addDays(d.date, Math.round(seconds / 86_400)),
		};
	const at = new Date((wallSeconds(d) + seconds) * 1000);
	const date = at.toISOString().slice(0, 10);
	const time = at.toISOString().slice(11, 19).replaceAll(":", "");
	return { ...d, date, time };
}

export interface Advance {
	due: IcalDate | null;
	start: IcalDate | null;
	/** The new COUNT, when the rule has one. */
	count: number | null;
}

/**
 * Where a repeating task moves when this occurrence is completed, or null when it was the last
 * one (COUNT=1, or the next date lies after UNTIL): then it completes normally, RRULE kept.
 * The next date comes from DUE (or DTSTART without DUE), or from the completion day.
 */
export function advance(
	rrule: string,
	dates: { due: IcalDate | null; start: IcalDate | null },
	opts: { fromCompletion: boolean; completedOn: string; tz: string },
): Advance | null {
	const anchor = dates.due ?? dates.start;
	if (!anchor) return null;
	const p = parts(rrule);
	const count = p.find(([k]) => k === "COUNT")?.[1];
	if (count !== undefined && Number(count) <= 1) return null;
	const recur = ICAL.Recur.fromString(
		p
			.filter(([k]) => k !== "COUNT" && k !== "UNTIL")
			.map(([k, v]) => `${k}=${v}`)
			.join(";"),
	);
	const from = opts.fromCompletion
		? fromWall(
				wallTime({ ...anchor, date: opts.completedOn } as IcalDate),
				anchor,
			)
		: anchor;
	const it = recur.iterator(wallTime(from));
	// The iterator hands back one Time object it keeps changing: copy what we keep.
	const first = it.next()?.clone(); // the anchor itself
	let next = it.next()?.clone();
	// From completion: the first occurrence after the completion day.
	while (opts.fromCompletion && next && first && next.compare(first) <= 0)
		next = it.next()?.clone();
	if (!next) return null;
	const moved = fromWall(next, anchor);
	const until = p.find(([k]) => k === "UNTIL")?.[1];
	if (until && pastUntil(moved, until, opts.tz)) return null;
	const delta = wallSeconds(moved) - wallSeconds(anchor);
	return {
		due: dates.due
			? dates.due === anchor
				? moved
				: shiftBy(dates.due, delta)
			: null,
		start: dates.start
			? dates.start === anchor
				? moved
				: shiftBy(dates.start, delta)
			: null,
		count: count === undefined ? null : Number(count) - 1,
	};
}

/** Whether an occurrence lies after the rule's UNTIL (inclusive bound). */
function pastUntil(next: IcalDate, until: string, tz: string): boolean {
	const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{6})(Z?))?$/.exec(until.trim());
	if (!m) return false;
	const date = `${m[1]}-${m[2]}-${m[3]}`;
	if (next.kind === "date" || !m[4]) return next.date > date;
	const end = instantOf(
		{ kind: "date-time", date, time: m[4], tzid: null, utc: m[5] === "Z" },
		tz,
	);
	return instantOf(next, tz) > end;
}

/** The RRULE value with COUNT replaced, everything else exactly as written. */
export function withCount(rrule: string, count: number): string {
	return rrule.replace(/(^|;)COUNT=\d+/i, `$1COUNT=${count}`);
}

/** "Mon 2 Nov" for the toast "Next: Mon 2 Nov". */
export const nextText = (d: IcalDate) => fmtDayShort(d.date);

/** The weekday code of a date ("MO"). */
export const weekdayCode = (date: string) => WEEKDAYS[weekday(date)] as string;
