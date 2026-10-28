// Task title and quick-add parsing: `Buy milk fri 17:00 /home !2 #errands`.
// Ported from timesheet's shared/quickentry.ts (the task parts). Runs in the browser for the
// live highlight and again when the line is submitted.

import { addDays, fmtDate, isDate, parseClock, weekday } from "../core/time.ts";
import type { TaskPriority } from "../core/types.ts";

export type TokenKind = "date" | "time" | "priority" | "tag" | "list";

/** A recognised token: [from, to) in the line. `ref` is the list href of a /list token. */
export interface QuickToken {
	from: number;
	to: number;
	kind: TokenKind;
	ref?: string;
}

/** A word of the line; `literal` when it was in quotes (always text, quotes dropped). */
interface Word {
	text: string;
	from: number;
	to: number;
	literal: boolean;
}

/** Splits a line into words; "text in quotes" is one literal word, an open quote runs to the end. */
function words(line: string): Word[] {
	const out: Word[] = [];
	for (const m of line.matchAll(/"([^"]*)"?|\S+/g)) {
		const quoted = m[1] !== undefined;
		const text = quoted ? (m[1] ?? "").trim() : m[0];
		if (text)
			out.push({
				text,
				from: m.index,
				to: m.index + m[0].length,
				literal: quoted,
			});
	}
	return out;
}

/** The line with `tok` wrapped in quotes, so it is read as text from now on. */
export function literalize(line: string, tok: { from: number; to: number }) {
	return `${line.slice(0, tok.from)}"${line.slice(tok.from, tok.to)}"${line.slice(tok.to)}`;
}

export const WEEKDAY_WORDS: Record<string, number> = {
	mon: 0,
	monday: 0,
	tue: 1,
	tuesday: 1,
	wed: 2,
	wednesday: 2,
	thu: 3,
	thursday: 3,
	fri: 4,
	friday: 4,
	sat: 5,
	saturday: 5,
	sun: 6,
	sunday: 6,
};

export function slug(s: string): string {
	return s
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

/** A date word ("fri", "tomorrow", "20.11.", "2026-12-01") as a date, or null. */
export function parseDateToken(tok: string, today: string): string | null {
	const t = tok.toLowerCase();
	if (t === "today" || t === "heute") return today;
	if (t === "yesterday" || t === "yday" || t === "gestern")
		return addDays(today, -1);
	if (t === "tomorrow" || t === "morgen") return addDays(today, 1);
	if (t in WEEKDAY_WORDS) {
		// Most recent such weekday, today included: "mon" on a Wednesday means two days ago.
		const back = (weekday(today) - (WEEKDAY_WORDS[t] ?? 0) + 7) % 7;
		return addDays(today, -back);
	}
	let m = /^-(\d{1,3})d$/.exec(t);
	if (m) return addDays(today, -Number(m[1]));
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

export function matchByName<T>(
	items: T[],
	key: string,
	names: (item: T) => string[],
): { item: T; how: "exact" | "prefix" } | { ambiguous: T[] } | null {
	const k = slug(key);
	const exact = items.filter((i) => names(i).some((n) => slug(n) === k));
	const [first] = exact;
	if (first && exact.length === 1) return { item: first, how: "exact" };
	if (exact.length > 1) return { ambiguous: exact };
	const prefix = items.filter((i) =>
		names(i).some((n) => slug(n).startsWith(k)),
	);
	const [firstPrefix] = prefix;
	if (firstPrefix && prefix.length === 1)
		return { item: firstPrefix, how: "prefix" };
	if (prefix.length > 1) return { ambiguous: prefix };
	return null;
}

export interface Suggestion {
	label: string;
	/** The token that replaces the one being typed, sigil included. */
	insert: string;
}

const MAX_SUGGESTIONS = 8;

// ---------- task capture ----------

export interface TaskList {
	/** The list's href. */
	href: string;
	name: string;
}

/** !1 is the highest; !4 is no priority (the levels tasks.org and Planify read alike). */
export const TASK_PRIORITY: Record<string, TaskPriority> = {
	"!1": "high",
	"!2": "medium",
	"!3": "low",
	"!4": "none",
};

export interface TaskParse {
	summary: string;
	priority: TaskPriority;
	tags: string[];
	/** The list named with /list; null: the default list. */
	list: string | null;
	/** Wall time in the app's zone; minutes null for an all-day due date. */
	due: { date: string; minutes: number | null } | null;
	tokens: QuickToken[];
	errors: string[];
}

/** The list `/key` names, or why it names none. */
function readList(
	key: string,
	lists: TaskList[],
): { href: string } | { error: string } {
	const found = matchByName(lists, key, (l) => [l.name]);
	if (!found) return { error: `No task list “${key}”.` };
	if ("ambiguous" in found)
		return {
			error: `“/${key}” could be ${found.ambiguous.map((l) => l.name).join(" or ")}.`,
		};
	return { href: found.item.href };
}

const PRIORITY_SUGGESTION: Record<TaskPriority, string> = {
	high: "High priority",
	medium: "Medium priority",
	low: "Low priority",
	none: "No priority",
};

/**
 * What the #tag, !priority or /list (with `lists`) being typed at the caret of a task title can
 * become: known tags and lists ranked by how well they match, the four priorities in order.
 */
export function suggestTask(
	line: string,
	caret: number,
	ctx: { tags: string[]; lists?: TaskList[] },
): { from: number; to: number; items: Suggestion[] } | null {
	const m = /(?:^|\s)([#!/])(\S*)$/.exec(line.slice(0, caret));
	if (!m) return null;
	const sigil = m[1] ?? "";
	const typed = m[2] ?? "";
	const from = caret - typed.length - 1;
	const to = caret + (/^\S*/.exec(line.slice(caret))?.[0].length ?? 0);
	const ranked = <T>(all: T[], name: (t: T) => string): T[] =>
		typed
			? all
					.map((t) => ({ t, score: fuzzyScore(typed, name(t)) }))
					.filter((x) => x.score !== null)
					.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
					.map((x) => x.t)
			: all;
	let items: Suggestion[] = [];
	if (sigil === "!")
		items = Object.entries(TASK_PRIORITY)
			.filter(([tok]) => tok.startsWith(`!${typed}`))
			.map(([tok, p]) => ({ label: PRIORITY_SUGGESTION[p], insert: tok }));
	else if (sigil === "/")
		items = ranked(ctx.lists ?? [], (l) => l.name).map((l) => ({
			label: l.name,
			insert: `/${slug(l.name)}`,
		}));
	else if (!/^\d+$/.test(typed))
		// A tag with a space or a sigil in it can't be typed as one token.
		items = ranked(
			ctx.tags.filter((t) => !/[\s#*]/.test(t)),
			(t) => t,
		).map((t) => ({ label: t, insert: `#${t}` }));
	items = items.slice(0, MAX_SUGGESTIONS);
	// A finished token needs no list (it would only take the Enter meant for submitting).
	const done = items.length === 1 && items[0]?.insert === `${sigil}${typed}`;
	return items.length && !done ? { from, to, items } : null;
}

/** The tag a #tag or *tag token names; null for other words and "#1" style numbers. */
function tagOf(tok: string): string | null {
	return /^[#*][^#*\s]/.test(tok) && !/^#\d+$/.test(tok) ? tok.slice(1) : null;
}

export interface TitleParse {
	/** The title as typed, without its tokens. */
	summary: string;
	/** null: the title names none. */
	priority: TaskPriority | null;
	tags: string[];
	/** The list named with /list; null: none named, or no lists given. */
	list: string | null;
	tokens: QuickToken[];
	errors: string[];
}

/**
 * The #tags (or *tags) and !1–!4 priority in a task title field, and /list when `lists` is
 * given. Everything else stays as typed, dates, quotes and slashes included; a quoted token, or
 * one in `keep`, stays text.
 */
export function parseTaskTitle(
	title: string,
	keep: ReadonlySet<string> = new Set(),
	lists?: TaskList[],
): TitleParse {
	const out: TitleParse = {
		summary: "",
		priority: null,
		tags: [],
		list: null,
		tokens: [],
		errors: [],
	};
	let summary = "";
	let at = 0;
	for (const w of words(title)) {
		if (w.literal || keep.has(w.text)) continue;
		const prio = TASK_PRIORITY[w.text];
		const tag = prio ? null : tagOf(w.text);
		if (prio) out.priority = prio;
		else if (tag !== null) {
			if (!out.tags.includes(tag)) out.tags.push(tag);
		} else if (lists && w.text.length > 1 && w.text.startsWith("/")) {
			const list = readList(w.text.slice(1), lists);
			if ("error" in list) {
				out.errors.push(list.error);
				continue;
			}
			out.list = list.href;
			out.tokens.push({ from: w.from, to: w.to, kind: "list", ref: list.href });
			summary += title.slice(at, w.from);
			at = w.to;
			continue;
		} else continue;
		out.tokens.push({
			from: w.from,
			to: w.to,
			kind: prio ? "priority" : "tag",
		});
		summary += title.slice(at, w.from);
		at = w.to;
	}
	out.summary = (summary + title.slice(at)).replace(/\s+/g, " ").trim();
	return out;
}

/** A due date: like an entry's date, except a weekday is the next one (today included). */
function dueDate(tok: string, today: string): string | null {
	const wd = WEEKDAY_WORDS[tok.toLowerCase()];
	if (wd === undefined) return parseDateToken(tok, today);
	return addDays(today, (wd - weekday(today) + 7) % 7);
}

/**
 * A task line such as `Buy milk fri 17:00 /home !2 #errands`. Date, time, !priority, #tag (or
 * *tag) and /list are read anywhere (the first date and time only); quoted words, "#1" style
 * numbers and the rest are the summary. A time without a date is today.
 */
export function parseTaskLine(
	line: string,
	ctx: { today: string; lists: TaskList[] },
): TaskParse {
	const out: TaskParse = {
		summary: "",
		priority: "none",
		tags: [],
		list: null,
		due: null,
		tokens: [],
		errors: [],
	};
	const text: string[] = [];
	let date: string | null = null;
	let minutes: number | null = null;
	const all = words(line);
	for (const w of all) {
		const tok = w.text;
		const mark = (kind: TokenKind, ref?: string) =>
			out.tokens.push({
				from: w.from,
				to: w.to,
				kind,
				...(ref ? { ref } : {}),
			});
		if (w.literal) {
			text.push(tok);
			continue;
		}
		const prio = TASK_PRIORITY[tok];
		if (prio) {
			out.priority = prio;
			mark("priority");
			continue;
		}
		const tag = tagOf(tok);
		if (tag) {
			if (!out.tags.includes(tag)) out.tags.push(tag);
			mark("tag");
			continue;
		}
		if (tok.startsWith("/") && tok.length > 1) {
			const list = readList(tok.slice(1), ctx.lists);
			if ("error" in list) out.errors.push(list.error);
			else {
				out.list = list.href;
				mark("list", list.href);
			}
			continue;
		}
		const d: string | null = date === null ? dueDate(tok, ctx.today) : null;
		if (d) {
			date = d;
			mark("date");
			continue;
		}
		if (minutes === null && /^\d{1,2}:\d{2}$/.test(tok)) {
			const m = parseClock(tok);
			if (m !== null && m < 1440) {
				minutes = m;
				mark("time");
				continue;
			}
		}
		text.push(tok);
	}
	out.summary = text.join(" ");
	if (date !== null || minutes !== null)
		out.due = { date: date ?? ctx.today, minutes };
	if (!out.summary) out.errors.push("Add what the task is.");
	return out;
}

// ---------- fuzzy matching for commands ----------

/**
 * How well `query` matches `text`: 3 at the start, 2 at the start of a word, 1 anywhere, 0.5
 * its letters in order. null: no match.
 */
export function fuzzyScore(query: string, text: string): number | null {
	const q = query.trim().toLowerCase();
	const t = text.toLowerCase();
	if (!q) return null;
	if (t.startsWith(q)) return 3;
	if (t.split(/[^\p{L}\p{N}]+/u).some((w) => w.startsWith(q))) return 2;
	if (t.includes(q)) return 1;
	let i = 0;
	for (const ch of t) if (ch === q[i]) i++;
	return q.length > 1 && i === q.length ? 0.5 : null;
}
