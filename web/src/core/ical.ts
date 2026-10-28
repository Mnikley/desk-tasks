// In-place editing of one VTODO resource. The text is kept as a list of content lines with
// their exact bytes (folding, line endings, parameter spelling); an edit replaces, inserts or
// removes whole content lines of the task's own properties and leaves every other byte alone.
// Nothing is ever regenerated from the app's model.
import ICAL from "ical.js";
import {
	addDays,
	daysBetween,
	isTimeZone,
	wallToInstant,
	zoned,
} from "./time.ts";
import type { TaskPriority, TaskStatus } from "./types.ts";

export class IcalError extends Error {}

interface Param {
	/** Upper-cased parameter name. */
	name: string;
	/** Exact source text including the leading ";". */
	raw: string;
	value: string;
}

interface ContentLine {
	/** Exact bytes, including folding and the line ending(s). */
	raw: string;
	/** The logical line, unfolded, without line ending. */
	text: string;
	/** Line ending of the last physical line ("" at end of file). */
	eol: string;
	/** Upper-cased property name ("" for blank lines). */
	name: string;
	/** Exact text of name and parameters, i.e. everything before the value's colon. */
	head: string;
	params: Param[];
	value: string;
	/** Component nesting, e.g. "VCALENDAR/VTODO/VALARM". BEGIN/END lines belong to the outer level. */
	path: string;
}

const TODO_PATH = "VCALENDAR/VTODO";
/** PRODID of tasks desk-tasks creates. */
export const PRODID = "-//desk-tasks//Nextcloud tasks//EN";
const FOLD_OCTETS = 75;

function parseLine(
	text: string,
): Pick<ContentLine, "name" | "head" | "params" | "value"> {
	let i = 0;
	while (i < text.length && text[i] !== ";" && text[i] !== ":") i++;
	const name = text.slice(0, i).toUpperCase();
	const params: Param[] = [];
	while (text[i] === ";") {
		const start = i;
		i++;
		const eq = text.indexOf("=", i);
		if (eq === -1) throw new IcalError(`Malformed parameter in "${text}".`);
		const pname = text.slice(i, eq).toUpperCase();
		i = eq + 1;
		const values: string[] = [];
		for (;;) {
			if (text[i] === '"') {
				const close = text.indexOf('"', i + 1);
				if (close === -1)
					throw new IcalError(`Unterminated quote in "${text}".`);
				values.push(text.slice(i + 1, close));
				i = close + 1;
			} else {
				const s = i;
				while (i < text.length && !",;:".includes(text[i] ?? "")) i++;
				values.push(text.slice(s, i));
			}
			if (text[i] === ",") i++;
			else break;
		}
		params.push({
			name: pname,
			raw: text.slice(start, i),
			value: values.join(","),
		});
	}
	if (text[i] !== ":") throw new IcalError(`Missing ":" in "${text}".`);
	return { name, head: text.slice(0, i), params, value: text.slice(i + 1) };
}

function parseDocument(src: string): ContentLine[] {
	const physical: { text: string; eol: string }[] = [];
	const re = /([^\r\n]*)(\r\n|\n|\r|$)/g;
	for (let m = re.exec(src); m; m = re.exec(src)) {
		if (m[0] === "") break;
		physical.push({ text: m[1] ?? "", eol: m[2] ?? "" });
	}
	const lines: ContentLine[] = [];
	const stack: string[] = [];
	let cur: { raw: string; text: string; eol: string } | null = null;
	const flush = () => {
		if (!cur) return;
		// A byte-order mark stays in the raw bytes but is not part of the first property name.
		const logical = lines.length ? cur.text : cur.text.replace(/^\uFEFF/, "");
		const blank = logical.trim() === "";
		const parsed = blank
			? { name: "", head: "", params: [], value: "" }
			: parseLine(logical);
		let path = stack.join("/");
		if (parsed.name === "BEGIN") stack.push(parsed.value.toUpperCase());
		else if (parsed.name === "END") {
			if (stack.pop() !== parsed.value.toUpperCase())
				throw new IcalError(`Unbalanced END:${parsed.value}.`);
			path = stack.join("/");
		}
		lines.push({ ...cur, ...parsed, path });
		cur = null;
	};
	for (const p of physical) {
		if ((p.text.startsWith(" ") || p.text.startsWith("\t")) && cur) {
			cur.raw += p.text + p.eol;
			cur.text += p.text.slice(1);
			cur.eol = p.eol;
		} else {
			flush();
			cur = { raw: p.text + p.eol, text: p.text, eol: p.eol };
		}
	}
	flush();
	if (stack.length) throw new IcalError(`Missing END:${stack.at(-1)}.`);
	return lines;
}

/** Folds a logical line at 75 octets without splitting UTF-8 sequences. */
export function fold(text: string, eol: string): string {
	const bytes = new TextEncoder().encode(text);
	if (bytes.length <= FOLD_OCTETS) return text + eol;
	const out: string[] = [];
	let line = "";
	let size = 0;
	let limit = FOLD_OCTETS;
	for (const ch of text) {
		const n = new TextEncoder().encode(ch).length;
		if (size + n > limit) {
			out.push(line);
			line = "";
			size = 0;
			limit = FOLD_OCTETS - 1; // continuation lines start with a space
		}
		line += ch;
		size += n;
	}
	out.push(line);
	return out.map((l, i) => (i === 0 ? l : ` ${l}`)).join(eol) + eol;
}

export function escapeText(s: string): string {
	return s
		.replace(/\\/g, "\\\\")
		.replace(/;/g, "\\;")
		.replace(/,/g, "\\,")
		.replace(/\r\n|\r|\n/g, "\\n");
}

export function unescapeText(s: string): string {
	return s.replace(/\\([\\;,nN])/g, (_, c: string) =>
		c === "n" || c === "N" ? "\n" : c,
	);
}

/** Splits a list value on unescaped commas, then unescapes each item. */
function splitList(s: string): string[] {
	const out: string[] = [];
	let cur = "";
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (c === "\\" && i + 1 < s.length) {
			cur += c + s[i + 1];
			i++;
		} else if (c === ",") {
			out.push(cur);
			cur = "";
		} else cur += c;
	}
	out.push(cur);
	return out
		.map(unescapeText)
		.map((x) => x.trim())
		.filter(Boolean);
}

const quoteParam = (v: string) => (/[:;,]/.test(v) ? `"${v}"` : v);

// ---------- dates ----------

/** A DATE or DATE-TIME value as written, so it can be rewritten in the same form. */
export type IcalDate =
	| { kind: "date"; date: string }
	| {
			kind: "date-time";
			date: string;
			/** Wall clock "HHMMSS" as written (seconds are kept). */
			time: string;
			tzid: string | null;
			utc: boolean;
	  };

function parseDateValue(value: string, params: Param[]): IcalDate | null {
	const v = value.trim();
	const isDate =
		params.find((p) => p.name === "VALUE")?.value.toUpperCase() === "DATE" ||
		/^\d{8}$/.test(v);
	const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{6})(Z?))?$/.exec(v);
	if (!m) return null;
	const date = `${m[1]}-${m[2]}-${m[3]}`;
	if (isDate || !m[4]) return { kind: "date", date };
	return {
		kind: "date-time",
		date,
		time: m[4],
		tzid: params.find((p) => p.name === "TZID")?.value ?? null,
		utc: m[5] === "Z",
	};
}

const compact = (date: string) => date.replaceAll("-", "");

function formatDateValue(d: IcalDate): string {
	return d.kind === "date"
		? compact(d.date)
		: `${compact(d.date)}T${d.time}${d.utc ? "Z" : ""}`;
}

const timeMinutes = (time: string) =>
	Number(time.slice(0, 2)) * 60 + Number(time.slice(2, 4));
const timeSeconds = (time: string) => Number(time.slice(4, 6));
const hhmmss = (minutes: number, seconds = 0) =>
	`${String(Math.floor(minutes / 60)).padStart(2, "0")}${String(minutes % 60).padStart(2, "0")}${String(seconds).padStart(2, "0")}`;

// ---------- the document ----------

/** Fields the app reads; everything else is carried along untouched. */
export interface TaskFields {
	uid: string;
	summary: string;
	description: string;
	status: TaskStatus;
	/** Raw PRIORITY 0–9 (0 = undefined). */
	priority: number;
	due: IcalDate | null;
	start: IcalDate | null;
	completed: IcalDate | null;
	percent: number | null;
	categories: string[];
	/** UID of the parent task (RELATED-TO with RELTYPE=PARENT or no RELTYPE). */
	parentUid: string | null;
	sortOrder: number | null;
	created: IcalDate | null;
	/** LAST-MODIFIED, or DTSTAMP when a client doesn't write it. */
	modified: IcalDate | null;
	/** RRULE/RDATE or several VTODOs (overrides). */
	recurring: boolean;
	/** More than one VTODO (RECURRENCE-ID overrides, jtx Board): shown read-only. */
	overrides: boolean;
	/** CLASS upper-cased; absent = "PUBLIC". */
	klass: string;
	/** X-PINNED:true (Nextcloud Tasks and Planify sort pinned tasks first). */
	pinned: boolean;
	location: string;
	url: string;
	/** PRODID of the VCALENDAR, "" when missing. */
	prodid: string;
	/** The RRULE value exactly as written, or null. */
	rrule: string | null;
	/** X-DESKTASKS-REPEAT-FROM:COMPLETION ("repeat from completion date"). */
	repeatFromCompletion: boolean;
	/** RDATE or EXDATE lines (extra or skipped dates; only shown, never edited). */
	extraDates: boolean;
	/** The VTODO's VALARMs. */
	alarms: Alarm[];
}

export class TaskDocument {
	private constructor(
		private lines: ContentLine[],
		readonly componentCount: number,
	) {}

	static parse(text: string): TaskDocument {
		const lines = parseDocument(text);
		const begins = lines.filter((l) => l.name === "BEGIN");
		if (begins[0]?.value.toUpperCase() !== "VCALENDAR" || begins[0].path !== "")
			throw new IcalError("Not a VCALENDAR.");
		if (lines.filter((l) => l.name === "BEGIN" && l.path === "").length !== 1)
			throw new IcalError("More than one VCALENDAR in one resource.");
		const todos = begins.filter(
			(l) => l.path === "VCALENDAR" && l.value.toUpperCase() === "VTODO",
		).length;
		if (todos === 0) throw new IcalError("The resource has no VTODO.");
		return new TaskDocument(lines, todos);
	}

	toString(): string {
		return this.lines.map((l) => l.raw).join("");
	}

	/** Index range [begin, end] of the first VTODO's BEGIN and END lines. */
	private range(): [number, number] {
		const begin = this.lines.findIndex(
			(l) =>
				l.name === "BEGIN" &&
				l.path === "VCALENDAR" &&
				l.value.toUpperCase() === "VTODO",
		);
		const end = this.lines.findIndex(
			(l, i) =>
				i > begin &&
				l.name === "END" &&
				l.path === "VCALENDAR" &&
				l.value.toUpperCase() === "VTODO",
		);
		return [begin, end];
	}

	/** Properties of the (first) VTODO itself, not of nested components such as VALARM. */
	private own(name: string): { line: ContentLine; index: number }[] {
		const [b, e] = this.range();
		const out: { line: ContentLine; index: number }[] = [];
		for (let i = b + 1; i < e; i++) {
			const l = this.lines[i];
			if (l && l.path === TODO_PATH && l.name === name)
				out.push({ line: l, index: i });
		}
		return out;
	}

	value(name: string): string | null {
		return this.own(name)[0]?.line.value ?? null;
	}

	private text(name: string): string {
		const v = this.value(name);
		return v === null ? "" : unescapeText(v);
	}

	private date(name: string): IcalDate | null {
		const l = this.own(name)[0]?.line;
		return l ? parseDateValue(l.value, l.params) : null;
	}

	fields(): TaskFields {
		const status = (this.value("STATUS") ?? "").trim().toUpperCase();
		const completed = this.date("COMPLETED");
		const percentRaw = this.value("PERCENT-COMPLETE");
		const percent = percentRaw === null ? null : Number(percentRaw.trim());
		const priority = Number((this.value("PRIORITY") ?? "0").trim());
		const parent = this.own("RELATED-TO").find(({ line }) => {
			const t = line.params.find((p) => p.name === "RELTYPE")?.value;
			return !t || t.toUpperCase() === "PARENT";
		});
		const sort = this.value("X-APPLE-SORT-ORDER");
		return {
			uid: (this.value("UID") ?? "").trim(),
			summary: this.text("SUMMARY"),
			description: this.text("DESCRIPTION"),
			status: readStatus(status, completed !== null, percent),
			priority:
				Number.isInteger(priority) && priority >= 0 && priority <= 9
					? priority
					: 0,
			due: this.date("DUE"),
			start: this.date("DTSTART"),
			completed,
			percent: Number.isFinite(percent) ? percent : null,
			categories: this.own("CATEGORIES").flatMap(({ line }) =>
				splitList(line.value),
			),
			parentUid: parent ? parent.line.value.trim() : null,
			sortOrder:
				sort !== null && Number.isFinite(Number(sort.trim()))
					? Number(sort.trim())
					: null,
			created: this.date("CREATED"),
			modified: this.date("LAST-MODIFIED") ?? this.date("DTSTAMP"),
			recurring:
				this.componentCount > 1 ||
				this.own("RRULE").length > 0 ||
				this.own("RDATE").length > 0,
			overrides:
				this.componentCount > 1 || this.own("RECURRENCE-ID").length > 0,
			klass: (this.value("CLASS") ?? "").trim().toUpperCase() || "PUBLIC",
			pinned: (this.value("X-PINNED") ?? "").trim().toLowerCase() === "true",
			location: this.text("LOCATION"),
			url: (this.value("URL") ?? "").trim(),
			rrule: this.value("RRULE")?.trim() ?? null,
			repeatFromCompletion:
				(this.value("X-DESKTASKS-REPEAT-FROM") ?? "").trim().toUpperCase() ===
				"COMPLETION",
			extraDates: this.own("RDATE").length > 0 || this.own("EXDATE").length > 0,
			alarms: this.alarms(),
			prodid:
				this.lines
					.find((l) => l.path === "VCALENDAR" && l.name === "PRODID")
					?.value.trim() ?? "",
		};
	}

	/** VTIMEZONE definitions in this resource, for TZIDs that aren't IANA names. */
	timezoneComponents(): string {
		return this.lines
			.filter(
				(l) =>
					l.path.startsWith("VCALENDAR/VTIMEZONE") ||
					(l.path === "VCALENDAR" &&
						(l.name === "BEGIN" || l.name === "END") &&
						l.value.toUpperCase() === "VTIMEZONE"),
			)
			.map((l) => l.text)
			.join("\r\n");
	}

	// ---------- low-level edits (first VTODO only) ----------

	private eolOfTodo(): string {
		const [, e] = this.range();
		return this.lines[e]?.eol || "\r\n";
	}

	private make(
		head: string,
		value: string,
		eol: string,
		path = TODO_PATH,
	): ContentLine {
		const text = `${head}:${value}`;
		return {
			raw: fold(text, eol),
			text,
			eol,
			...parseLine(text),
			path,
		};
	}

	// ---------- alarms (VALARM components of the first VTODO) ----------

	/** Line ranges [BEGIN, END] of the first VTODO's own VALARMs. */
	private alarmRanges(): [number, number][] {
		const [b, e] = this.range();
		const out: [number, number][] = [];
		for (let i = b + 1; i < e; i++) {
			const l = this.lines[i];
			if (
				l?.path !== TODO_PATH ||
				l.name !== "BEGIN" ||
				l.value.toUpperCase() !== "VALARM"
			)
				continue;
			let j = i + 1;
			while (j < e) {
				const m = this.lines[j];
				if (
					m?.path === TODO_PATH &&
					m.name === "END" &&
					m.value.toUpperCase() === "VALARM"
				)
					break;
				j++;
			}
			out.push([i, j]);
			i = j;
		}
		return out;
	}

	/** The VALARMs as written; `key` names one (its exact text) for removal. */
	alarms(): Alarm[] {
		return this.alarmRanges().map(([b, e]) => {
			const own = this.lines
				.slice(b + 1, e)
				.filter((l) => l.path === `${TODO_PATH}/VALARM`);
			const get = (n: string) => own.find((l) => l.name === n);
			const trigger = get("TRIGGER");
			return {
				key: this.lines
					.slice(b, e + 1)
					.map((l) => l.text)
					.join("\n"),
				action: (get("ACTION")?.value ?? "").trim().toUpperCase(),
				trigger: trigger ? parseTrigger(trigger.value, trigger.params) : null,
			};
		});
	}

	/** Removes the VALARM with this key (and nothing else). */
	removeAlarm(key: string): void {
		const r = this.alarmRanges().find(
			([b, e]) =>
				this.lines
					.slice(b, e + 1)
					.map((l) => l.text)
					.join("\n") === key,
		);
		if (r) this.lines.splice(r[0], r[1] - r[0] + 1);
	}

	/** Adds a DISPLAY alarm (what tasks.org and the Tasks app write) before END:VTODO. */
	addAlarm(trigger: Trigger, description: string): void {
		const [, e] = this.range();
		const eol = this.eolOfTodo();
		const inner = `${TODO_PATH}/VALARM`;
		const t =
			trigger.kind === "relative"
				? this.make(
						`TRIGGER;RELATED=${trigger.related}`,
						durationText(trigger.seconds),
						eol,
						inner,
					)
				: this.make(
						"TRIGGER;VALUE=DATE-TIME",
						utcStamp(trigger.at),
						eol,
						inner,
					);
		this.lines.splice(
			e,
			0,
			this.make("BEGIN", "VALARM", eol),
			this.make("ACTION", "DISPLAY", eol, inner),
			this.make(
				"DESCRIPTION",
				escapeText(description || "Reminder"),
				eol,
				inner,
			),
			t,
			this.make("END", "VALARM", eol),
		);
	}

	/**
	 * Sets a property: the first instance is replaced in place (its parameters kept unless
	 * `params` says otherwise), further instances are removed, and a missing property is
	 * inserted before the first nested component (or END:VTODO). An unchanged value keeps its bytes.
	 */
	set(
		name: string,
		value: string,
		params?: { drop?: string[]; add?: [string, string][] },
	): void {
		const existing = this.own(name);
		const first = existing[0];
		const added = (params?.add ?? [])
			.map(([k, v]) => `;${k}=${quoteParam(v)}`)
			.join("");
		if (first) {
			const drop = new Set([
				...(params?.drop ?? []),
				...(params?.add ?? []).map(([k]) => k),
			]);
			const kept = first.line.params.filter((p) => !drop.has(p.name));
			const nameRaw = first.line.head.slice(
				0,
				first.line.head.length -
					first.line.params.map((p) => p.raw).join("").length,
			);
			const head = nameRaw + kept.map((p) => p.raw).join("") + added;
			if (head !== first.line.head || value !== first.line.value)
				this.lines[first.index] = this.make(head, value, first.line.eol);
			for (const extra of existing.slice(1).reverse())
				this.lines.splice(extra.index, 1);
			return;
		}
		const [b, e] = this.range();
		let at = e;
		for (let i = b + 1; i < e; i++) {
			const l = this.lines[i];
			if (l?.path !== TODO_PATH || l.name === "BEGIN") {
				at = i;
				break;
			}
		}
		this.lines.splice(at, 0, this.make(name + added, value, this.eolOfTodo()));
	}

	remove(name: string): void {
		for (const { index } of this.own(name).reverse())
			this.lines.splice(index, 1);
	}

	// ---------- task-level edits ----------

	setSummary(s: string): void {
		this.set("SUMMARY", escapeText(s));
	}

	/** Writes DESCRIPTION and, like the Tasks app, drops X-ALT-DESC (it would show stale HTML). */
	setDescription(s: string): void {
		if (s === "") this.remove("DESCRIPTION");
		else this.set("DESCRIPTION", escapeText(s));
		this.remove("X-ALT-DESC");
	}

	/** A plain TEXT property; empty removes it. */
	setText(name: "LOCATION", s: string): void {
		if (s === "") this.remove(name);
		else this.set(name, escapeText(s));
	}

	/** URL is a URI value: written as is, no TEXT escaping. Empty removes it. */
	setUrl(s: string): void {
		if (s === "") this.remove("URL");
		else this.set("URL", s);
	}

	/** RRULE as given (built by recurrence.ts, or a COUNT change of the one written); null removes it. */
	setRRule(value: string | null): void {
		if (value === null) this.remove("RRULE");
		else if (value !== this.value("RRULE")?.trim()) this.set("RRULE", value);
	}

	/** desk-tasks' own "repeat from completion date" (no other client stores it on the server). */
	setRepeatFromCompletion(on: boolean): void {
		if (this.fields().repeatFromCompletion === on) return;
		if (on) this.set("X-DESKTASKS-REPEAT-FROM", "COMPLETION");
		else this.remove("X-DESKTASKS-REPEAT-FROM");
	}

	/** A repeating task moved on to its next occurrence: open, no COMPLETED or PERCENT-COMPLETE. */
	openForNext(): void {
		if ((this.value("STATUS") ?? "").trim().toUpperCase() !== "NEEDS-ACTION")
			this.set("STATUS", "NEEDS-ACTION");
		this.remove("COMPLETED");
		this.remove("PERCENT-COMPLETE");
	}

	/**
	 * Sets the parent: only the first RELATED-TO with RELTYPE=PARENT or no RELTYPE changes (in
	 * place, its parameters kept); CHILD, SIBLING and RFC 9253 relations stay untouched. null
	 * removes that one line; a task without one gets a plain RELATED-TO.
	 */
	setParent(uid: string | null): void {
		const parent = this.own("RELATED-TO").find(({ line }) => {
			const t = line.params.find((p) => p.name === "RELTYPE")?.value;
			return !t || t.toUpperCase() === "PARENT";
		});
		if (parent) {
			if (uid === null) this.lines.splice(parent.index, 1);
			else if (parent.line.value.trim() !== uid)
				this.lines[parent.index] = this.make(
					parent.line.head,
					uid,
					parent.line.eol,
				);
			return;
		}
		if (uid === null) return;
		// A new line; `set` would replace a CHILD or SIBLING relation, so insert it directly.
		const [b, e] = this.range();
		let at = e;
		for (let i = b + 1; i < e; i++) {
			const l = this.lines[i];
			if (l?.path !== TODO_PATH || l.name === "BEGIN") {
				at = i;
				break;
			}
		}
		this.lines.splice(at, 0, this.make("RELATED-TO", uid, this.eolOfTodo()));
	}

	/** X-APPLE-SORT-ORDER (manual order), an integer as every client writes it. */
	setSortOrder(n: number): void {
		if (this.fields().sortOrder === n) return;
		this.set("X-APPLE-SORT-ORDER", String(Math.round(n)));
	}

	/** X-PINNED:true, as Nextcloud Tasks and Planify write it; unpinning removes the line. */
	setPinned(pinned: boolean): void {
		if (this.fields().pinned === pinned) return;
		if (pinned) this.set("X-PINNED", "true");
		else this.remove("X-PINNED");
	}

	/** CLASS; PUBLIC is the default and removes the line. */
	setClass(klass: "PUBLIC" | "CONFIDENTIAL" | "PRIVATE"): void {
		if (this.fields().klass === klass) return;
		if (klass === "PUBLIC") this.remove("CLASS");
		else this.set("CLASS", klass);
	}

	/**
	 * PERCENT-COMPLETE with STATUS, as the Tasks app moves them together: 0 removes PERCENT and
	 * means NEEDS-ACTION, 1–99 is IN-PROCESS, 100 completes the task.
	 */
	setProgress(p: number, now: number): void {
		const f = this.fields();
		if (p >= 100) {
			this.setStatus("COMPLETED", now);
			return;
		}
		if (p <= 0) {
			this.remove("PERCENT-COMPLETE");
			if (f.status !== "NEEDS-ACTION") this.set("STATUS", "NEEDS-ACTION");
			this.remove("COMPLETED");
			return;
		}
		if (f.percent !== p) this.set("PERCENT-COMPLETE", String(Math.round(p)));
		if (f.status !== "IN-PROCESS") this.set("STATUS", "IN-PROCESS");
		this.remove("COMPLETED");
	}

	setPriority(level: TaskPriority): void {
		const current = this.fields().priority;
		if (priorityLevel(current) === level) return;
		if (level === "none") this.remove("PRIORITY");
		else this.set("PRIORITY", String(PRIORITY_VALUE[level]));
	}

	setCategories(tags: string[]): void {
		const current = this.fields().categories;
		if (
			current.length === tags.length &&
			current.every((t, i) => t === tags[i])
		)
			return;
		if (!tags.length) {
			this.remove("CATEGORIES");
			return;
		}
		this.set("CATEGORIES", tags.map(escapeText).join(","));
	}

	/** TaskStatus with the companion properties tasks.org and Planify read (see the research doc). */
	setStatus(status: TaskStatus, now: number): void {
		const f = this.fields();
		if (f.status === status) return;
		this.set("STATUS", status);
		if (status === "COMPLETED") {
			this.set("PERCENT-COMPLETE", "100");
			this.set("COMPLETED", utcStamp(now), { drop: ["VALUE", "TZID"] });
			return;
		}
		this.remove("COMPLETED");
		if (f.percent === 100) this.remove("PERCENT-COMPLETE");
	}

	/** Writes a due date. `null` removes it. */
	setDue(next: IcalDate | null): void {
		this.setDate("DUE", next);
	}

	/** Writes the start date (DTSTART), in the same value forms as DUE. `null` removes it. */
	setStart(next: IcalDate | null): void {
		this.setDate("DTSTART", next);
	}

	private setDate(name: "DUE" | "DTSTART", next: IcalDate | null): void {
		if (!next) {
			this.remove(name);
			return;
		}
		if (next.kind === "date") {
			this.set(name, formatDateValue(next), {
				drop: ["TZID"],
				add: [["VALUE", "DATE"]],
			});
		} else {
			this.set(name, formatDateValue(next), {
				drop: ["VALUE", ...(next.tzid ? [] : ["TZID"])],
				add: next.tzid ? [["TZID", next.tzid]] : [],
			});
		}
	}

	/** Bookkeeping on every write: DTSTAMP always, LAST-MODIFIED when the task has one. */
	touch(now: number): void {
		this.set("DTSTAMP", utcStamp(now), { drop: ["VALUE", "TZID"] });
		if (this.own("LAST-MODIFIED").length)
			this.set("LAST-MODIFIED", utcStamp(now), { drop: ["VALUE", "TZID"] });
	}
}

/** When an alarm goes off: relative to DUE (END) or DTSTART (START), or at an instant. */
export type Trigger =
	| { kind: "relative"; related: "START" | "END"; seconds: number }
	| { kind: "absolute"; at: number };

export interface Alarm {
	key: string;
	action: string;
	trigger: Trigger | null;
}

/** "-PT15M", "P1D", "-P1W", "PT0S" as seconds; null if it isn't a duration. */
export function parseDuration(value: string): number | null {
	const m =
		/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
			value.trim().toUpperCase(),
		);
	if (!m || value.trim().toUpperCase().endsWith("T")) return null;
	const [, sign, w, d, h, min, sec] = m;
	if ([w, d, h, min, sec].every((x) => x === undefined)) return null;
	if ([w, d, h, min, sec].every((x) => x === undefined)) return null;
	const n =
		Number(w ?? 0) * 604_800 +
		Number(d ?? 0) * 86_400 +
		Number(h ?? 0) * 3600 +
		Number(min ?? 0) * 60 +
		Number(sec ?? 0);
	return sign === "-" ? -n : n;
}

/** Seconds as an iCalendar duration, the way tasks.org writes them ("-PT15M", "-P1D", "PT0S"). */
export function durationText(seconds: number): string {
	const sign = seconds < 0 ? "-" : "";
	let s = Math.abs(Math.round(seconds));
	if (s === 0) return "PT0S";
	if (s % 86_400 === 0) return `${sign}P${s / 86_400}D`;
	const days = Math.floor(s / 86_400);
	s -= days * 86_400;
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	return `${sign}P${days ? `${days}D` : ""}T${h ? `${h}H` : ""}${m ? `${m}M` : ""}${sec ? `${sec}S` : ""}`;
}

function parseTrigger(value: string, params: Param[]): Trigger | null {
	const valueType = params.find((p) => p.name === "VALUE")?.value.toUpperCase();
	if (valueType === "DATE-TIME") {
		const d = parseDateValue(value, params);
		if (!d || d.kind !== "date-time" || !d.utc) return null;
		return { kind: "absolute", at: instantOf(d, "UTC") };
	}
	const seconds = parseDuration(value);
	if (seconds === null) return null;
	const related =
		params.find((p) => p.name === "RELATED")?.value.toUpperCase() === "END"
			? "END"
			: "START";
	return { kind: "relative", related, seconds };
}

function readStatus(
	status: string,
	hasCompleted: boolean,
	percent: number | null,
): TaskStatus {
	if (status === "CANCELLED") return "CANCELLED";
	// tasks.org treats COMPLETED as done whatever STATUS says; Planify also accepts 100 %.
	if (status === "COMPLETED" || hasCompleted || percent === 100)
		return "COMPLETED";
	if (status === "IN-PROCESS") return "IN-PROCESS";
	return "NEEDS-ACTION";
}

/** Values written for each level; the shared reading below is what tasks.org and Planify do. */
const PRIORITY_VALUE = { high: 1, medium: 5, low: 9 } as const;

export function priorityLevel(p: number): TaskPriority {
	if (p >= 1 && p <= 4) return "high";
	if (p === 5) return "medium";
	if (p >= 6 && p <= 9) return "low";
	return "none";
}

function utcStamp(ms: number): string {
	return `${new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`;
}

// ---------- instants and app-level due dates ----------

/**
 * The instant of a DATE-TIME value: UTC as is, IANA TZIDs directly, other TZIDs through the
 * resource's VTIMEZONE, floating times in `appTz`. DATE values: local midnight in `appTz`.
 */
export function instantOf(
	d: IcalDate,
	appTz: string,
	doc?: TaskDocument,
): number {
	if (d.kind === "date") return wallToInstant(d.date, 0, appTz);
	const minutes = timeMinutes(d.time);
	const seconds = timeSeconds(d.time);
	if (d.utc) return wallToInstant(d.date, minutes, "UTC", seconds);
	if (!d.tzid) return wallToInstant(d.date, minutes, appTz, seconds);
	if (isTimeZone(d.tzid))
		return wallToInstant(d.date, minutes, d.tzid, seconds);
	const viaVtimezone = doc ? vtimezoneInstant(d, doc) : null;
	return viaVtimezone ?? wallToInstant(d.date, minutes, appTz, seconds);
}

function vtimezoneInstant(
	d: Extract<IcalDate, { kind: "date-time" }>,
	doc: TaskDocument,
): number | null {
	try {
		const comp = new ICAL.Component(
			ICAL.parse(
				`BEGIN:VCALENDAR\r\n${doc.timezoneComponents()}\r\nEND:VCALENDAR`,
			),
		);
		const vtz = comp
			.getAllSubcomponents("vtimezone")
			.find((c) => c.getFirstPropertyValue("tzid") === d.tzid);
		if (!vtz) return null;
		const zone = new ICAL.Timezone(vtz);
		const t = ICAL.Time.fromData(
			{
				year: Number(d.date.slice(0, 4)),
				month: Number(d.date.slice(5, 7)),
				day: Number(d.date.slice(8, 10)),
				hour: Number(d.time.slice(0, 2)),
				minute: Number(d.time.slice(2, 4)),
				second: Number(d.time.slice(4, 6)),
			},
			zone,
		);
		return t.toUnixTime() * 1000;
	} catch {
		return null;
	}
}

/** Where a due date sits in the app: its local date, and the wall minutes for timed ones. */
export function dueInApp(
	d: IcalDate,
	appTz: string,
	doc?: TaskDocument,
): { date: string; minutes: number | null; at: number | null } {
	if (d.kind === "date") return { date: d.date, minutes: null, at: null };
	const at = instantOf(d, appTz, doc);
	const z = zoned(at, appTz);
	return { date: z.date, minutes: z.minutes, at };
}

/**
 * The same due date moved to another day of the app's calendar, keeping its value type, its
 * TZID and its wall-clock time (seconds included). UTC values keep the app-local wall time.
 */
export function moveDue(
	d: IcalDate,
	toDate: string,
	appTz: string,
	doc?: TaskDocument,
): IcalDate {
	if (d.kind === "date") return { kind: "date", date: toDate };
	const from = dueInApp(d, appTz, doc).date;
	const shift = daysBetween(from, toDate);
	if (d.utc) {
		const at = instantOf(d, appTz);
		const z = zoned(at, appTz);
		const moved = wallToInstant(
			addDays(z.date, shift),
			z.minutes,
			appTz,
			z.seconds,
		);
		const u = zoned(moved, "UTC");
		return { ...d, date: u.date, time: hhmmss(u.minutes, u.seconds) };
	}
	return { ...d, date: addDays(d.date, shift) };
}

/**
 * A due date chosen in the app (date, optionally wall minutes in `appTz`) written in the form
 * the task already uses: same TZID, UTC stays UTC, floating stays floating. A task without a
 * timed due date gets a floating time (what Planify writes; needs no VTIMEZONE).
 */
export function dueFromApp(
	input: { date: string; minutes: number | null },
	current: IcalDate | null,
	appTz: string,
): IcalDate {
	if (input.minutes === null) return { kind: "date", date: input.date };
	const base =
		current?.kind === "date-time"
			? current
			: {
					kind: "date-time" as const,
					date: input.date,
					time: "000000",
					tzid: null,
					utc: false,
				};
	const zone = base.utc
		? "UTC"
		: base.tzid && isTimeZone(base.tzid)
			? base.tzid
			: null;
	if (zone) {
		const z = zoned(wallToInstant(input.date, input.minutes, appTz), zone);
		return { ...base, date: z.date, time: hhmmss(z.minutes) };
	}
	// Floating (or a non-IANA TZID, kept as written): the wall time is taken as entered.
	return { ...base, date: input.date, time: hhmmss(input.minutes) };
}

/** True when `due` would lie before the task's start (tasks.org's "hide until"). */
export function dueBeforeStart(
	due: IcalDate,
	start: IcalDate | null,
	appTz: string,
	doc?: TaskDocument,
): boolean {
	if (!start) return false;
	if (due.kind === "date" || start.kind === "date") {
		return dueInApp(due, appTz, doc).date < dueInApp(start, appTz, doc).date;
	}
	return instantOf(due, appTz, doc) < instantOf(start, appTz, doc);
}

export function sameIcalDate(a: IcalDate | null, b: IcalDate | null): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** A new resource for a task created in the app. */
export function newTaskText(opts: {
	uid: string;
	summary: string;
	now: number;
	parentUid?: string | null;
}): string {
	const stamp = utcStamp(opts.now);
	const lines = [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		`PRODID:${PRODID}`,
		"BEGIN:VTODO",
		`UID:${opts.uid}`,
		`DTSTAMP:${stamp}`,
		`CREATED:${stamp}`,
		`LAST-MODIFIED:${stamp}`,
		`SUMMARY:${escapeText(opts.summary)}`,
		"STATUS:NEEDS-ACTION",
		...(opts.parentUid ? [`RELATED-TO:${opts.parentUid}`] : []),
		"END:VTODO",
		"END:VCALENDAR",
	];
	return lines.map((l) => fold(l, "\r\n")).join("");
}
