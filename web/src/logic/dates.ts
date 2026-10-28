// Date and repeat phrases in English and German, for quick add and the date popover:
// `tomorrow`, `Do.`, `next fri`, `nächste Woche`, `in 3 Tagen`, `+2w`, `30.11.`, `every monday`,
// `jeden Tag`, `alle 2 Wochen`. Words are matched case-insensitively; a phrase may span words.
import {
	addDays,
	addMonths,
	fmtDate,
	isDate,
	monthEnd,
	parseDate,
	startOfWeek,
	weekday,
} from "../core/time.ts";

/** 0 = Monday … 6 = Sunday, English short and long names. */
const EN_WEEKDAYS: Record<string, number> = {
	mon: 0,
	monday: 0,
	tue: 1,
	tues: 1,
	tuesday: 1,
	wed: 2,
	wednesday: 2,
	thu: 3,
	thur: 3,
	thurs: 3,
	thursday: 3,
	fri: 4,
	friday: 4,
	sat: 5,
	saturday: 5,
	sun: 6,
	sunday: 6,
};
/** German weekday names; the short forms only with their dot ("Do the dishes" stays text). */
const DE_WEEKDAYS: Record<string, number> = {
	montag: 0,
	dienstag: 1,
	mittwoch: 2,
	donnerstag: 3,
	freitag: 4,
	samstag: 5,
	sonnabend: 5,
	sonntag: 6,
	"mo.": 0,
	"di.": 1,
	"mi.": 2,
	"do.": 3,
	"fr.": 4,
	"sa.": 5,
	"so.": 6,
};
/** "sat" and "sun" are dates only as the last word ("sun cream" stays text). */
const LAST_WORD_ONLY = new Set(["sat", "sun"]);

export const BYDAY = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;

/** The weekday a word names (0 = Monday), or null. */
export function weekdayOf(word: string, isLast = true): number | null {
	const w = word.toLowerCase();
	if (LAST_WORD_ONLY.has(w) && !isLast) return null;
	return EN_WEEKDAYS[w] ?? DE_WEEKDAYS[w] ?? null;
}

type Unit = "day" | "week" | "month" | "year";
const UNITS: Record<string, Unit> = {
	day: "day",
	days: "day",
	tag: "day",
	tage: "day",
	tagen: "day",
	week: "week",
	weeks: "week",
	woche: "week",
	wochen: "week",
	month: "month",
	months: "month",
	monat: "month",
	monate: "month",
	monaten: "month",
	year: "year",
	years: "year",
	jahr: "year",
	jahre: "year",
	jahren: "year",
};

/** Adds whole months, clamping the day (31 Jan + 1 month = 28/29 Feb). */
export function addMonthsClamped(date: string, n: number): string {
	const { d } = parseDate(date);
	const month = addMonths(date.slice(0, 7), n);
	const last = Number(monthEnd(month).slice(8));
	return `${month}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

export function shift(date: string, n: number, unit: Unit): string {
	if (unit === "day") return addDays(date, n);
	if (unit === "week") return addDays(date, 7 * n);
	if (unit === "month") return addMonthsClamped(date, n);
	return addMonthsClamped(date, 12 * n);
}

/** The next such weekday, today included. */
export const nextWeekday = (today: string, wd: number) =>
	addDays(today, (wd - weekday(today) + 7) % 7);

/** A single word as a date, or null. */
function dateWord(word: string, today: string, isLast: boolean): string | null {
	const t = word.toLowerCase();
	if (t === "today" || t === "tod" || t === "heute") return today;
	if (t === "tomorrow" || t === "tmr" || t === "morgen")
		return addDays(today, 1);
	if (t === "übermorgen" || t === "uebermorgen") return addDays(today, 2);
	if (t === "yesterday" || t === "yday" || t === "gestern")
		return addDays(today, -1);
	if (t === "weekend" || t === "wochenende") return nextWeekday(today, 5);
	const wd = weekdayOf(t, isLast);
	if (wd !== null) return nextWeekday(today, wd);
	let m = /^([+-])(\d{1,3})([dwm])$/.exec(t);
	if (m) {
		const n = Number(m[2]) * (m[1] === "-" ? -1 : 1);
		return shift(
			today,
			n,
			m[3] === "d" ? "day" : m[3] === "w" ? "week" : "month",
		);
	}
	m =
		/^(\d{1,2})\.(\d{1,2})\.(\d{4})?$/.exec(t) ??
		/^(\d{1,2})\.(\d{1,2})$/.exec(t);
	if (m) {
		const year = m[3] ? Number(m[3]) : Number(today.slice(0, 4));
		const d = fmtDate(year, Number(m[2]), Number(m[1]));
		return isDate(d) ? d : null;
	}
	if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return isDate(t) ? t : null;
	return null;
}

const NEXT = new Set([
	"next",
	"nächste",
	"nächsten",
	"nächster",
	"naechste",
	"naechsten",
]);

/**
 * The date phrase starting at word `i`, and how many words it takes; null when there is none.
 * Multi-word forms: "next week" / "nächste Woche" (next Monday), "next fri" / "nächsten Fr."
 * (the one in next week, Todoist's rule), "in 3 days" / "in 3 Tagen".
 */
export function datePhrase(
	words: string[],
	i: number,
	today: string,
): { date: string; n: number } | null {
	const w0 = (words[i] ?? "").toLowerCase();
	const w1 = (words[i + 1] ?? "").toLowerCase();
	const w2 = (words[i + 2] ?? "").toLowerCase();
	if (NEXT.has(w0) && w1) {
		if (UNITS[w1] === "week")
			return { date: addDays(startOfWeek(today), 7), n: 2 };
		const wd = weekdayOf(w1, true);
		if (wd !== null) return { date: addDays(startOfWeek(today), 7 + wd), n: 2 };
	}
	if (w0 === "in" && /^\d{1,3}$/.test(w1) && UNITS[w2]) {
		return { date: shift(today, Number(w1), UNITS[w2] as Unit), n: 3 };
	}
	const d = dateWord(w0, today, i === words.length - 1);
	return d ? { date: d, n: 1 } : null;
}

/** A whole text as one date phrase ("next fri", "30.11."), or null. */
export function parseDatePhrase(text: string, today: string): string | null {
	const ws = text.trim().split(/\s+/).filter(Boolean);
	const p = ws.length ? datePhrase(ws, 0, today) : null;
	return p && p.n === ws.length ? p.date : null;
}

// ---------- repeat ----------

export type Freq = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

export interface RepeatSpec {
	freq: Freq;
	interval: number;
	/** Weekdays for weekly rules ("MO", …). */
	byDay?: string[];
}

const FREQ_OF: Record<Unit, Freq> = {
	day: "DAILY",
	week: "WEEKLY",
	month: "MONTHLY",
	year: "YEARLY",
};
const SINGLE: Record<string, Freq> = {
	daily: "DAILY",
	weekly: "WEEKLY",
	monthly: "MONTHLY",
	yearly: "YEARLY",
	täglich: "DAILY",
	wöchentlich: "WEEKLY",
	monatlich: "MONTHLY",
	jährlich: "YEARLY",
};
const EVERY = new Set(["every", "jeden", "jede", "jedes", "alle"]);

/**
 * The repeat phrase starting at word `i`: "every day|week|month|year", "every monday",
 * "every 2 weeks", "jeden Tag|Montag", "jede Woche", "alle 2 Wochen", "daily", "wöchentlich".
 * `every`/`jeden` consumes the day word after it, so "every monday" is a repeat, not a due date.
 */
export function repeatPhrase(
	words: string[],
	i: number,
): { repeat: RepeatSpec; n: number } | null {
	const w0 = (words[i] ?? "").toLowerCase();
	const single = SINGLE[w0];
	if (single) return { repeat: { freq: single, interval: 1 }, n: 1 };
	if (!EVERY.has(w0)) return null;
	const w1 = (words[i + 1] ?? "").toLowerCase();
	const w2 = (words[i + 2] ?? "").toLowerCase();
	if (/^\d{1,3}$/.test(w1) && UNITS[w2]) {
		const interval = Math.max(1, Number(w1));
		return { repeat: { freq: FREQ_OF[UNITS[w2] as Unit], interval }, n: 3 };
	}
	if (UNITS[w1])
		return { repeat: { freq: FREQ_OF[UNITS[w1] as Unit], interval: 1 }, n: 2 };
	const wd = weekdayOf(w1, true);
	if (wd !== null)
		return {
			repeat: { freq: "WEEKLY", interval: 1, byDay: [BYDAY[wd] as string] },
			n: 2,
		};
	return null;
}

/** The first date a new repeating task is due: its weekday for "every monday", else today. */
export function firstOccurrence(r: RepeatSpec, today: string): string {
	const day = r.byDay?.[0];
	const wd = day ? BYDAY.indexOf(day as (typeof BYDAY)[number]) : -1;
	return wd >= 0 ? nextWeekday(today, wd) : today;
}
