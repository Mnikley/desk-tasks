// Calendar dates are "YYYY-MM-DD" strings; instants are epoch milliseconds (UTC).
// Wall-clock conversion goes through Intl so DST is handled by the platform's tz database.

const MINUTE = 60_000;
const DAY_MS = 86_400_000;
/** Wall minutes in a day. */
export const DAY_MIN = 1440;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function splitDate(s: string): { y: number; m: number; d: number } | null {
	const [, y, m, d] = DATE_RE.exec(s)?.map(Number) ?? [];
	if (y === undefined || m === undefined || d === undefined) return null;
	const t = new Date(Date.UTC(y, m - 1, d));
	const valid =
		t.getUTCFullYear() === y &&
		t.getUTCMonth() === m - 1 &&
		t.getUTCDate() === d;
	return valid ? { y, m, d } : null;
}

export function isDate(s: string): boolean {
	return splitDate(s) !== null;
}

export function parseDate(s: string): { y: number; m: number; d: number } {
	const parts = splitDate(s);
	if (!parts) throw new Error(`Invalid date "${s}", expected YYYY-MM-DD`);
	return parts;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

export function fmtDate(y: number, m: number, d: number): string {
	return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

/** Day arithmetic on calendar dates (no time zone involved). */
export function addDays(date: string, n: number): string {
	const { y, m, d } = parseDate(date);
	const t = new Date(Date.UTC(y, m - 1, d) + n * DAY_MS);
	return fmtDate(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

export function daysBetween(from: string, to: string): number {
	const a = parseDate(from);
	const b = parseDate(to);
	return Math.round(
		(Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / DAY_MS,
	);
}

/** 0 = Monday … 6 = Sunday. */
export function weekday(date: string): number {
	const { y, m, d } = parseDate(date);
	return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

/** Inclusive list of dates. */
export function dateRange(from: string, to: string): string[] {
	const out: string[] = [];
	for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
	return out;
}

export function monthKey(date: string): string {
	return date.slice(0, 7);
}

export function monthStart(month: string): string {
	return `${month}-01`;
}

export function monthEnd(month: string): string {
	const [y, m] = month.split("-").map(Number) as [number, number];
	return fmtDate(y, m, new Date(Date.UTC(y, m, 0)).getUTCDate());
}

export function addMonths(month: string, n: number): string {
	const [y, m] = month.split("-").map(Number) as [number, number];
	const t = new Date(Date.UTC(y, m - 1 + n, 1));
	return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}`;
}

/** ISO-8601 week number and its year. */
export function isoWeek(date: string): { year: number; week: number } {
	const thursday = addDays(date, 3 - weekday(date));
	const { y } = parseDate(thursday);
	return {
		year: y,
		week: Math.floor(daysBetween(`${y}-01-01`, thursday) / 7) + 1,
	};
}

export function startOfWeek(date: string): string {
	return addDays(date, -weekday(date));
}

const partsCache = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(tz: string): Intl.DateTimeFormat {
	let f = partsCache.get(tz);
	if (!f) {
		f = new Intl.DateTimeFormat("en-US", {
			timeZone: tz,
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		});
		partsCache.set(tz, f);
	}
	return f;
}

export function isTimeZone(tz: string): boolean {
	try {
		partsFormatter(tz);
		return true;
	} catch {
		return false;
	}
}

/** Wall-clock parts of an instant in a time zone. */
export function zoned(
	ms: number,
	tz: string,
): { date: string; minutes: number; seconds: number } {
	const p = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
	for (const part of partsFormatter(tz).formatToParts(new Date(ms))) {
		if (part.type in p) p[part.type as keyof typeof p] = Number(part.value);
	}
	return {
		date: fmtDate(p.year, p.month, p.day),
		minutes: p.hour * 60 + p.minute,
		seconds: p.second,
	};
}

/** Offset of `tz` from UTC at instant `ms`, in minutes (Berlin summer = 120). */
export function offsetMinutes(ms: number, tz: string): number {
	const z = zoned(ms, tz);
	const { y, m, d } = parseDate(z.date);
	const asUtc = Date.UTC(y, m - 1, d) + z.minutes * MINUTE + z.seconds * 1000;
	return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / MINUTE);
}

/**
 * Instant for a wall-clock time on a date in `tz`. `minutes` may exceed 1440 (next day).
 * Ambiguous times (the repeated hour when clocks go back) resolve to the first occurrence;
 * non-existent times (the skipped hour) shift forward by the gap, like most calendars do.
 */
export function wallToInstant(
	date: string,
	minutes: number,
	tz: string,
	seconds = 0,
): number {
	const { y, m, d } = parseDate(date);
	const naive = Date.UTC(y, m - 1, d) + minutes * MINUTE + seconds * 1000;
	const before = offsetMinutes(naive - DAY_MS / 2, tz);
	const after = offsetMinutes(naive + DAY_MS / 2, tz);
	// Try the earlier offset first so ambiguous times pick the first occurrence.
	for (const off of before >= after ? [before, after] : [after, before]) {
		const t = naive - off * MINUTE;
		if (offsetMinutes(t, tz) === off) return t;
	}
	// Gap: the wall time does not exist; reading it with the pre-transition offset moves it
	// forward by the size of the gap (02:30 on spring-forward night becomes 03:30).
	return naive - before * MINUTE;
}

/** Start of the local day as an instant. */
export function dayStart(date: string, tz: string): number {
	return wallToInstant(date, 0, tz);
}

/** "08:05" clock time from minutes since midnight (wraps past 24 h). */
export function fmtClock(min: number): string {
	const r = ((Math.round(min) % DAY_MIN) + DAY_MIN) % DAY_MIN;
	return `${pad(Math.floor(r / 60))}:${pad(r % 60)}`;
}

/** Parses "8:40", "08:40", "840", "0840", "8" (hours) into minutes since midnight. */
export function parseClock(s: string): number | null {
	const t = s.trim();
	const match =
		/^(\d{1,2})[:.](\d{2})$/.exec(t) ??
		/^(\d{1,2})(\d{2})$/.exec(t) ??
		/^(\d{1,2})()$/.exec(t);
	if (!match) return null;
	const h = Number(match[1]);
	const m = Number(match[2] || 0);
	if (h > 24 || m > 59 || (h === 24 && m > 0)) return null;
	return h * 60 + m;
}

const MONTHS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];
const MONTHS_LONG = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WEEKDAYS_LONG = [
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
	"Sunday",
];

export const monthName = (m: number, long = false) =>
	(long ? MONTHS_LONG : MONTHS)[m - 1] ?? "?";
export const weekdayName = (wd: number, long = false) =>
	(long ? WEEKDAYS_LONG : WEEKDAYS)[wd] ?? "?";

/** "Tue 20 Oct" */
export function fmtDayShort(date: string): string {
	const { m, d } = parseDate(date);
	return `${weekdayName(weekday(date))} ${d} ${monthName(m)}`;
}

/** "Tuesday, 20 October" */
export function fmtDayLong(date: string): string {
	const { m, d } = parseDate(date);
	return `${weekdayName(weekday(date), true)}, ${d} ${monthName(m, true)}`;
}

/** "28.10.2026" (Austrian numeric form). */
export function fmtDateNumeric(date: string): string {
	const { y, m, d } = parseDate(date);
	return `${pad(d)}.${pad(m)}.${y}`;
}

/** "31 Oct 2027" */
export function fmtDayYear(date: string): string {
	const { y, m, d } = parseDate(date);
	return `${d} ${monthName(m)} ${y}`;
}

/** "October 2026" */
export function fmtMonth(month: string): string {
	const [y, m] = month.split("-").map(Number) as [number, number];
	return `${monthName(m, true)} ${y}`;
}
