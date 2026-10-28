// The quick-add grammar as a table of English and German inputs, including the ambiguity rules
// (German abbreviations need their dot, sat/sun only as the last word, "every" eats its day).
import { describe, expect, test } from "bun:test";
import { parseDatePhrase } from "../src/logic/dates.ts";
import {
	literalize,
	parseTaskLine,
	type TaskList,
} from "../src/logic/quickentry.ts";

const TODAY = "2026-10-28"; // a Wednesday
const LISTS: TaskList[] = [
	{ href: "/l/work/", name: "Work" },
	{ href: "/l/privat/", name: "Privat" },
	{ href: "/l/family/", name: "Family", writable: false },
];
const parse = (line: string) =>
	parseTaskLine(line, { today: TODAY, lists: LISTS });

// [input, summary, due date, due minutes, extra expectations]
const TABLE: [
	string,
	string,
	string | null,
	number | null,
	Record<string, unknown>?,
][] = [
	[
		"Call dentist tomorrow 9:00 !1",
		"Call dentist",
		"2026-10-29",
		540,
		{ priority: "high" },
	],
	[
		"Arbeitnehmerveranlagung /privat #finanzen 30.11.",
		"Arbeitnehmerveranlagung",
		"2026-11-30",
		null,
		{ list: "/l/privat/", tags: ["finanzen"] },
	],
	[
		"Draft Q4 report >mon fri !2 /work",
		"Draft Q4 report",
		"2026-11-06", // starts Mon, due that Friday
		null,
		{ start: "2026-11-02", priority: "medium", list: "/l/work/" },
	],
	[
		"Book flights in 2 weeks // compare OS vs. Ryanair",
		"Book flights",
		"2026-11-11",
		null,
		{ notes: "compare OS vs. Ryanair" },
	],
	["Do. Elternabend 19:00", "Elternabend", "2026-10-29", 1140, {}],
	["Do the dishes", "Do the dishes", null, null, {}],
	["heute Steuer", "Steuer", "2026-10-28", null, {}],
	["morgen Müll rausbringen", "Müll rausbringen", "2026-10-29", null, {}],
	["übermorgen Paket abholen", "Paket abholen", "2026-10-30", null, {}],
	["Mi. Zahnarzt", "Zahnarzt", "2026-10-28", null, {}], // today is Wednesday
	["Mo Meeting", "Mo Meeting", null, null, {}], // no dot: text
	["Rechnung nächste Woche", "Rechnung", "2026-11-02", null, {}],
	["Report next week", "Report", "2026-11-02", null, {}],
	["Party next fri", "Party", "2026-11-06", null, {}], // Friday of next week, not this one
	["Feier nächsten Fr.", "Feier", "2026-11-06", null, {}],
	["Garten Wochenende", "Garten", "2026-10-31", null, {}],
	["clean garage weekend", "clean garage", "2026-10-31", null, {}],
	["Reifen wechseln in 3 Tagen", "Reifen wechseln", "2026-10-31", null, {}],
	["renew passport in 2 months", "renew passport", "2026-12-28", null, {}],
	["Steuern +3d", "Steuern", "2026-10-31", null, {}],
	["Review +1w", "Review", "2026-11-04", null, {}],
	["Service +1m", "Service", "2026-11-28", null, {}],
	["Termin 2026-12-01 14:30", "Termin", "2026-12-01", 870, {}],
	["Buy sun cream", "Buy sun cream", null, null, {}], // sun only as the last word
	["Picnic sun", "Picnic", "2026-11-01", null, {}],
	["sat night fever", "sat night fever", null, null, {}],
	[
		"Stand-up every monday",
		"Stand-up",
		"2026-11-02",
		null,
		{ repeat: { freq: "WEEKLY", interval: 1, byDay: ["MO"] } },
	],
	[
		"Blumen gießen jeden Tag",
		"Blumen gießen",
		"2026-10-28",
		null,
		{ repeat: { freq: "DAILY", interval: 1 } },
	],
	[
		"Müll jeden Montag",
		"Müll",
		"2026-11-02",
		null,
		{ repeat: { freq: "WEEKLY", interval: 1, byDay: ["MO"] } },
	],
	[
		"Miete monatlich 1.11.",
		"Miete",
		"2026-11-01",
		null,
		{ repeat: { freq: "MONTHLY", interval: 1 } },
	],
	[
		"Backup weekly fri",
		"Backup",
		"2026-10-30",
		null,
		{ repeat: { freq: "WEEKLY", interval: 1 } },
	],
	[
		"Filter alle 2 Wochen",
		"Filter",
		"2026-10-28",
		null,
		{ repeat: { freq: "WEEKLY", interval: 2 } },
	],
	[
		"Water plants every 3 days",
		"Water plants",
		"2026-10-28",
		null,
		{ repeat: { freq: "DAILY", interval: 3 } },
	],
	[
		"Steuer jährlich",
		"Steuer",
		"2026-10-28",
		null,
		{ repeat: { freq: "YEARLY", interval: 1 } },
	],
	["Call mom 18:00", "Call mom", "2026-10-28", 1080, {}], // a time alone is today
	["Fix bug #42 #work", "Fix bug #42", null, null, { tags: ["work"] }],
	[
		"Plan *urlaub !3",
		"Plan",
		null,
		null,
		{ tags: ["urlaub"], priority: "low" },
	],
	['Read "next week" magazine', "Read next week magazine", null, null, {}],
	[
		"Read https://example.com/a//b later",
		"Read https://example.com/a//b later",
		null,
		null,
		{ notes: "" },
	],
	["tomorrow fri report", "fri report", "2026-10-29", null, {}], // first date wins
	["Trip >fri mon", "Trip", "2026-11-02", null, { start: "2026-10-30" }],
];

describe("quick add: English and German", () => {
	for (const [line, summary, date, minutes, extra] of TABLE) {
		test(line, () => {
			const p = parse(line);
			expect(p.errors).toEqual([]);
			expect(p.summary).toBe(summary);
			expect(p.due).toEqual(date === null ? null : { date, minutes });
			if (extra) expect(p).toMatchObject(extra);
		});
	}
});

describe("quick add: errors and tokens", () => {
	test("unknown and view-only lists, and a title made of tokens only", () => {
		expect(parse("Call /wrk").errors).toEqual([
			"No list “wrk”. Did you mean Work?",
		]);
		expect(parse("Call /family").errors).toEqual([
			"“Family” is view only. Pick another list with /.",
		]);
		expect(parse("tomorrow !1 #x").errors).toEqual(["Add what the task is."]);
		expect(parse("Plan >30.11. 1.11.").errors).toEqual([
			"The due date is before the start. Change one of them.",
		]);
	});

	test("tokens cover their whole phrase, and literalizing one makes it text", () => {
		const line = "Party next fri 19:00 // bring cake";
		const p = parse(line);
		const spans = p.tokens.map((t) => [t.kind, line.slice(t.from, t.to)]);
		expect(spans).toEqual([
			["notes", "// bring cake"],
			["date", "next fri"],
			["time", "19:00"],
		]);
		const date = p.tokens.find((t) => t.kind === "date");
		if (!date) throw new Error("no date token");
		const lit = parse(literalize(line, date));
		expect(lit.due).toEqual({ date: TODAY, minutes: 1140 });
		expect(lit.summary).toBe("Party next fri");
	});

	test("the date popover reads the same phrases", () => {
		expect(parseDatePhrase("next fri", TODAY)).toBe("2026-11-06");
		expect(parseDatePhrase("in 3 Tagen", TODAY)).toBe("2026-10-31");
		expect(parseDatePhrase("Do.", TODAY)).toBe("2026-10-29");
		expect(parseDatePhrase("31.2.", TODAY)).toBeNull();
		expect(parseDatePhrase("next fri please", TODAY)).toBeNull();
	});
});
