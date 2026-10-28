// Repeating tasks advance the same VTODO in place on completion; the editor's subset builds
// rules with UNTIL in the anchor's form; anything else is described and kept as written.
import { describe, expect, test } from "bun:test";
import { TaskDocument } from "../src/core/ical.ts";
import {
	describeRule,
	type RepeatRule,
	rruleOf,
	ruleOf,
} from "../src/core/recurrence.ts";
import { applyChange, type Change } from "../src/core/write.ts";
import { diff, TZ } from "./helpers.ts";

const at = (iso: string) => Date.parse(iso);
const doc = (lines: string[]) =>
	[
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//test//EN",
		"BEGIN:VTODO",
		"UID:r",
		"DTSTAMP:20261001T000000Z",
		"SUMMARY:Repeat me",
		...lines,
		"END:VTODO",
		"END:VCALENDAR",
		"",
	].join("\r\n");
const change = (text: string, c: Change, now = at("2026-11-02T10:00:00Z")) =>
	applyChange(
		{ now: () => now, tz: TZ } as Parameters<typeof applyChange>[0],
		text,
		c,
	);
const complete = (text: string, now?: number) =>
	change(text, { status: "COMPLETED" }, now);
const fields = (text: string) => TaskDocument.parse(text).fields();

describe("completing a repeating task advances it in place", () => {
	test("weekly BYDAY with COUNT, TZID: the research doc's example", () => {
		const before = doc([
			"DTSTART;TZID=Europe/Berlin:20261102T090000",
			"DUE;TZID=Europe/Berlin:20261102T170000",
			"RRULE:FREQ=WEEKLY;COUNT=5;BYDAY=MO,WE",
			"STATUS:NEEDS-ACTION",
		]);
		const after = complete(before);
		const d = diff(before, after);
		expect(d.added.sort()).toEqual([
			"DTSTAMP:20261102T100000Z\r\n",
			"DTSTART;TZID=Europe/Berlin:20261104T090000\r\n",
			"DUE;TZID=Europe/Berlin:20261104T170000\r\n",
			"RRULE:FREQ=WEEKLY;COUNT=4;BYDAY=MO,WE\r\n",
		]);
		expect(after).not.toMatch(/COMPLETED|PERCENT-COMPLETE/);
	});

	test("daily, all-day; COMPLETED and PERCENT-COMPLETE go; STATUS is NEEDS-ACTION", () => {
		const after = complete(
			doc([
				"DUE;VALUE=DATE:20261102",
				"RRULE:FREQ=DAILY",
				"STATUS:IN-PROCESS",
				"PERCENT-COMPLETE:40",
			]),
		);
		expect(after).toContain("DUE;VALUE=DATE:20261103\r\n");
		expect(after).toContain("STATUS:NEEDS-ACTION\r\n");
		expect(after).not.toContain("PERCENT-COMPLETE");
		expect(after).toContain("RRULE:FREQ=DAILY\r\n");
	});

	test("monthly on the last day", () => {
		const after = complete(
			doc(["DUE;VALUE=DATE:20260131", "RRULE:FREQ=MONTHLY;BYMONTHDAY=-1"]),
		);
		expect(after).toContain("DUE;VALUE=DATE:20260228\r\n");
	});

	test("floating times stay floating and keep their wall time; DTSTART only shifts if present", () => {
		const after = complete(doc(["DUE:20261102T150000", "RRULE:FREQ=WEEKLY"]));
		expect(after).toContain("DUE:20261109T150000\r\n");
		expect(after).not.toContain("DTSTART");
	});

	test("across the DST change a TZID time keeps its wall clock", () => {
		// 24 Oct 2026 is CEST, 31 Oct CET: still 14:30 local.
		const after = complete(
			doc(["DUE;TZID=Europe/Berlin:20261024T143000", "RRULE:FREQ=WEEKLY"]),
			at("2026-10-24T13:00:00Z"),
		);
		expect(after).toContain("DUE;TZID=Europe/Berlin:20261031T143000\r\n");
	});

	test("a start without a due moves on its own", () => {
		const after = complete(
			doc(["DTSTART;VALUE=DATE:20261102", "RRULE:FREQ=WEEKLY;INTERVAL=2"]),
		);
		expect(after).toContain("DTSTART;VALUE=DATE:20261116\r\n");
	});

	test("from completion: the next date counts from the day it was done", () => {
		const after = complete(
			doc([
				"DUE;VALUE=DATE:20261020",
				"RRULE:FREQ=WEEKLY",
				"X-DESKTASKS-REPEAT-FROM:COMPLETION",
			]),
			at("2026-11-02T10:00:00Z"),
		);
		expect(after).toContain("DUE;VALUE=DATE:20261109\r\n");
		// From the due date it would have been 27 Oct (still overdue).
		const fromDue = complete(
			doc(["DUE;VALUE=DATE:20261020", "RRULE:FREQ=WEEKLY"]),
		);
		expect(fromDue).toContain("DUE;VALUE=DATE:20261027\r\n");
	});

	test("the last occurrence completes normally and keeps its rule: COUNT=1, or past UNTIL", () => {
		for (const rule of [
			"RRULE:FREQ=DAILY;COUNT=1",
			"RRULE:FREQ=DAILY;UNTIL=20261102",
		]) {
			const after = complete(doc(["DUE;VALUE=DATE:20261102", rule]));
			expect(fields(after).status).toBe("COMPLETED");
			expect(after).toContain(`${rule}\r\n`);
		}
		const utc = complete(
			doc(["DUE:20261102T080000Z", "RRULE:FREQ=DAILY;UNTIL=20261103T075959Z"]),
		);
		expect(fields(utc).status).toBe("COMPLETED");
		const stillOne = complete(
			doc(["DUE:20261102T080000Z", "RRULE:FREQ=DAILY;UNTIL=20261103T080000Z"]),
		);
		expect(stillOne).toContain("DUE:20261103T080000Z\r\n");
	});

	test("closing for good (a recurring subtask of a completed parent) doesn't advance", () => {
		const after = change(doc(["DUE;VALUE=DATE:20261102", "RRULE:FREQ=DAILY"]), {
			status: "COMPLETED",
			close: true,
		});
		expect(fields(after).status).toBe("COMPLETED");
		expect(after).toContain("DUE;VALUE=DATE:20261102\r\n");
	});

	test("a custom rule advances too and stays byte for byte apart from COUNT", () => {
		const after = complete(
			doc(["DUE;VALUE=DATE:20261110", "RRULE:freq=MONTHLY;BYDAY=2TU;COUNT=3"]),
		);
		expect(after).toContain("DUE;VALUE=DATE:20261208\r\n");
		expect(after).toContain("RRULE:freq=MONTHLY;BYDAY=2TU;COUNT=2\r\n");
	});
});

describe("the repeat editor", () => {
	const rule = (o: Partial<RepeatRule> = {}): RepeatRule => ({
		freq: "WEEKLY",
		interval: 1,
		byDay: [],
		monthDay: "same",
		end: { kind: "never" },
		fromCompletion: false,
		...o,
	});

	test("UNTIL follows the anchor: DATE, floating local time, or UTC", () => {
		const until = rule({ end: { kind: "until", date: "2026-12-31" } });
		expect(rruleOf(until, { kind: "date", date: "2026-11-02" }, TZ)).toBe(
			"FREQ=WEEKLY;UNTIL=20261231",
		);
		expect(
			rruleOf(
				until,
				{
					kind: "date-time",
					date: "2026-11-02",
					time: "090000",
					tzid: null,
					utc: false,
				},
				TZ,
			),
		).toBe("FREQ=WEEKLY;UNTIL=20261231T235959");
		expect(
			rruleOf(
				until,
				{
					kind: "date-time",
					date: "2026-11-02",
					time: "090000",
					tzid: "Europe/Berlin",
					utc: false,
				},
				TZ,
			),
		).toBe("FREQ=WEEKLY;UNTIL=20261231T225959Z");
	});

	test("the subset round-trips through rruleOf and ruleOf", () => {
		const cases: [RepeatRule, string][] = [
			[rule({ freq: "DAILY" }), "FREQ=DAILY"],
			[
				rule({ interval: 2, byDay: ["WE", "MO"] }),
				"FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE",
			],
			[
				rule({ freq: "MONTHLY", monthDay: "last" }),
				"FREQ=MONTHLY;BYMONTHDAY=-1",
			],
			[
				rule({ freq: "YEARLY", end: { kind: "count", count: 3 } }),
				"FREQ=YEARLY;COUNT=3",
			],
		];
		for (const [r, text] of cases) {
			expect(rruleOf(r, { kind: "date", date: "2026-11-02" }, TZ)).toBe(text);
			expect(ruleOf(text, "2026-11-02", false)).toEqual({
				...r,
				byDay: [...r.byDay].sort(
					(a, b) =>
						["MO", "TU", "WE", "TH", "FR", "SA", "SU"].indexOf(a) -
						["MO", "TU", "WE", "TH", "FR", "SA", "SU"].indexOf(b),
				),
			});
		}
		// nth-weekday and hourly rules are outside the subset.
		expect(ruleOf("FREQ=MONTHLY;BYDAY=2TU", "2026-11-10", false)).toBeNull();
		expect(ruleOf("FREQ=HOURLY", null, false)).toBeNull();
	});

	test("rules in words", () => {
		expect(describeRule("FREQ=WEEKLY;BYDAY=MO,WE", null)).toBe(
			"Weekly · Mon, Wed",
		);
		expect(describeRule("FREQ=WEEKLY;INTERVAL=2", null)).toBe("Every 2 weeks");
		expect(describeRule("FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=3", null)).toBe(
			"Monthly · last day · 3 more times",
		);
		expect(describeRule("FREQ=MONTHLY;BYDAY=2TU", null)).toBe(
			"Custom repeat: every 2nd Tue",
		);
	});

	test("setting a repeat needs a date; it writes RRULE and the repeat-from mark", () => {
		const plain = doc([]);
		expect(() => change(plain, { repeat: rule() })).toThrow(
			"Set a due date to repeat.",
		);
		const set = change(doc(["DUE;VALUE=DATE:20261102"]), {
			repeat: rule({ byDay: ["MO"], fromCompletion: true }),
		});
		expect(set).toContain("RRULE:FREQ=WEEKLY;BYDAY=MO\r\n");
		expect(set).toContain("X-DESKTASKS-REPEAT-FROM:COMPLETION\r\n");
		const off = change(set, { repeat: null });
		expect(off).not.toMatch(/RRULE|X-DESKTASKS/);
	});

	test("removing both dates of a repeating task removes its rule too", () => {
		const after = change(
			doc([
				"DUE;VALUE=DATE:20261102",
				"DTSTART;VALUE=DATE:20261101",
				"RRULE:FREQ=DAILY",
			]),
			{
				due: null,
				start: null,
			},
		);
		expect(after).not.toMatch(/RRULE|DUE|DTSTART/);
		// Only one of them: the rule stays (it hangs on the other).
		const one = change(
			doc([
				"DUE;VALUE=DATE:20261102",
				"DTSTART;VALUE=DATE:20261101",
				"RRULE:FREQ=DAILY",
			]),
			{ due: null },
		);
		expect(one).toContain("RRULE:FREQ=DAILY");
	});
});
