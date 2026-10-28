import { describe, expect, test } from "bun:test";
import {
	dueBeforeStart,
	dueFromApp,
	dueInApp,
	escapeText,
	fold,
	IcalError,
	instantOf,
	moveDue,
	newTaskText,
	priorityLevel,
	TaskDocument,
	unescapeText,
} from "../src/core/ical.ts";
import { diff, fixture, physical } from "./helpers.ts";

const TZ = "Europe/Berlin";
const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const STAMP = "20261020T120000Z";

const ALL = [
	"tasksorg-subtask.ics",
	"tasksorg-completed.ics",
	"tasksorg-allday.ics",
	"planify-task.ics",
	"planify-completed.ics",
	"planify-allday.ics",
	"planify-section.ics",
	"kitchen-sink.ics",
];

describe("parsing", () => {
	test("every fixture serialises back byte for byte", async () => {
		for (const name of ALL) {
			const text = await fixture(name);
			expect(TaskDocument.parse(text).toString()).toBe(text);
		}
	});

	test("tasks.org subtask fields", async () => {
		const f = TaskDocument.parse(
			await fixture("tasksorg-subtask.ics"),
		).fields();
		expect(f).toMatchObject({
			uid: "6352917440981726354",
			summary: "Prepare quarterly report",
			description: "Collect numbers from Anna, then draft.\nSend by Friday.",
			status: "NEEDS-ACTION",
			priority: 1,
			categories: ["work", "finance"],
			parentUid: "4824967301958274615",
			sortOrder: 782563200,
			recurring: false,
			due: {
				kind: "date-time",
				date: "2026-10-22",
				time: "143001",
				tzid: "Europe/Berlin",
				utc: false,
			},
		});
	});

	test("completion signals follow tasks.org and Planify", async () => {
		expect(
			TaskDocument.parse(await fixture("tasksorg-completed.ics")).fields()
				.status,
		).toBe("COMPLETED");
		expect(
			TaskDocument.parse(await fixture("planify-completed.ics")).fields()
				.status,
		).toBe("COMPLETED");
		const doc = (body: string) =>
			TaskDocument.parse(
				`BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:x\r\n${body}END:VTODO\r\nEND:VCALENDAR\r\n`,
			).fields().status;
		expect(doc("COMPLETED:20261020T000000Z\r\n")).toBe("COMPLETED"); // tasks.org: COMPLETED wins
		expect(doc("PERCENT-COMPLETE:100\r\n")).toBe("COMPLETED"); // Planify: 100 % is done
		expect(doc("STATUS:CANCELLED\r\nPERCENT-COMPLETE:100\r\n")).toBe(
			"CANCELLED",
		);
		expect(doc("STATUS:IN-PROCESS\r\nPERCENT-COMPLETE:40\r\n")).toBe(
			"IN-PROCESS",
		);
		expect(doc("")).toBe("NEEDS-ACTION"); // tasks.org writes no STATUS for open tasks
	});

	test("priority bands are read like tasks.org and Planify read them", () => {
		expect([0, 1, 4, 5, 6, 9].map(priorityLevel)).toEqual([
			"none",
			"high",
			"high",
			"medium",
			"low",
			"low",
		]);
	});

	test("kitchen sink: lists, relations, non-IANA zone", async () => {
		const doc = TaskDocument.parse(await fixture("kitchen-sink.ics"));
		const f = doc.fields();
		expect(f.categories).toEqual(["alpha", "beta, gamma", "delta"]);
		expect(f.parentUid).toBe("parent-uid-1");
		expect(f.summary).toBe("Übergabe vorbereiten – Bürokram");
		expect(f.description).toBe(
			"A long description that is folded because it goes on well past the seventy-five octet limit, with ümlauts and a semicolon; here.",
		);
		// 25 Oct 2026 is after the switch to CET: 17:00 local = 16:00 UTC.
		expect(f.due && instantOf(f.due, TZ, doc)).toBe(
			Date.UTC(2026, 9, 25, 16, 0),
		);
		expect(f.start && instantOf(f.start, TZ, doc)).toBe(
			Date.UTC(2026, 9, 21, 7, 0),
		);
	});

	test("recurrence and overrides are flagged", () => {
		const one =
			"BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:r\r\nRRULE:FREQ=DAILY\r\nEND:VTODO\r\nEND:VCALENDAR\r\n";
		expect(TaskDocument.parse(one).fields().recurring).toBe(true);
		const two =
			"BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:r\r\nEND:VTODO\r\nBEGIN:VTODO\r\nUID:r\r\nRECURRENCE-ID:20261021T100000Z\r\nEND:VTODO\r\nEND:VCALENDAR\r\n";
		const d = TaskDocument.parse(two);
		expect(d.componentCount).toBe(2);
		expect(d.fields().recurring).toBe(true);
	});

	test("malformed input is refused, not guessed", () => {
		expect(() => TaskDocument.parse("hello")).toThrow(IcalError);
		expect(() =>
			TaskDocument.parse("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n"),
		).toThrow("no VTODO");
		expect(() =>
			TaskDocument.parse("BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nEND:VCALENDAR\r\n"),
		).toThrow(IcalError);
		expect(() =>
			TaskDocument.parse(
				'BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nX;P="open:x\r\nEND:VTODO\r\nEND:VCALENDAR\r\n',
			),
		).toThrow(IcalError);
	});
});

describe("in-place edits touch only what changed", () => {
	test("summary keeps its parameters; everything else stays byte-identical", async () => {
		const text = await fixture("kitchen-sink.ics");
		const doc = TaskDocument.parse(text);
		doc.setSummary("Handover, part 2");
		doc.touch(NOW);
		const d = diff(text, doc.toString());
		expect(d.removed).toEqual([
			"LAST-MODIFIED:20261019T080000Z\r\n",
			"DTSTAMP:20261019T080000Z\r\n",
			"SUMMARY;LANGUAGE=de:Übergabe vorbereiten – Bürokram\r\n",
		]);
		expect(d.added).toEqual([
			`LAST-MODIFIED:${STAMP}\r\n`,
			`DTSTAMP:${STAMP}\r\n`,
			"SUMMARY;LANGUAGE=de:Handover\\, part 2\r\n",
		]);
	});

	test("completing sets STATUS, PERCENT-COMPLETE and COMPLETED; alarms untouched", async () => {
		const text = await fixture("kitchen-sink.ics");
		const doc = TaskDocument.parse(text);
		doc.setStatus("COMPLETED", NOW);
		const out = doc.toString();
		const d = diff(text, out);
		expect(d.removed.sort()).toEqual([
			"PERCENT-COMPLETE:40\r\n",
			"STATUS:IN-PROCESS\r\n",
		]);
		expect(d.added.sort()).toEqual([
			`COMPLETED:${STAMP}\r\n`,
			"PERCENT-COMPLETE:100\r\n",
			"STATUS:COMPLETED\r\n",
		]);
		// The new property goes into the VTODO itself, before its first VALARM.
		expect(out.indexOf(`COMPLETED:${STAMP}`)).toBeLessThan(
			out.indexOf("BEGIN:VALARM"),
		);
		expect(TaskDocument.parse(out).fields().status).toBe("COMPLETED");
	});

	test("re-opening removes COMPLETED and a 100 % PERCENT-COMPLETE, keeps unknown lines", async () => {
		const text = await fixture("tasksorg-completed.ics");
		const doc = TaskDocument.parse(text);
		doc.setStatus("NEEDS-ACTION", NOW);
		const d = diff(text, doc.toString());
		expect(d.removed.sort()).toEqual([
			"COMPLETED:20261020T081512Z\r\n",
			"PERCENT-COMPLETE:100\r\n",
			"STATUS:COMPLETED\r\n",
		]);
		expect(d.added).toEqual(["STATUS:NEEDS-ACTION\r\n"]);
		expect(doc.toString()).toContain("SEQUENCE:2\r\nCREATED");
		expect(doc.toString()).toContain("X-OTHERCLIENT-FOO:bar\r\n");
	});

	test("Planify's mixed line endings survive an edit", async () => {
		const text = await fixture("planify-task.ics");
		const doc = TaskDocument.parse(text);
		doc.setPriority("low");
		doc.touch(NOW);
		const out = doc.toString();
		const d = diff(text, out);
		expect(d.removed).toEqual([
			"DTSTAMP:20261020T101530Z\r\n",
			"PRIORITY:1\r\n",
		]);
		expect(d.added).toEqual([`DTSTAMP:${STAMP}\r\n`, "PRIORITY:9\r\n"]);
		expect(out.startsWith("BEGIN:VCALENDAR\nVERSION:2.0\n")).toBe(true);
		expect(out).toContain(
			"BEGIN:VALARM\nTRIGGER;VALUE=DATE-TIME:20261021T123000Z\n",
		);
		expect(out.endsWith("END:VTODO\r\nEND:VCALENDAR\n")).toBe(true);
		// Planify has no LAST-MODIFIED; none is added.
		expect(out).not.toContain("LAST-MODIFIED");
	});

	test("priority within the same band is left alone; none removes it", async () => {
		const text = await fixture("kitchen-sink.ics");
		const doc = TaskDocument.parse(text);
		doc.setPriority("high"); // PRIORITY:3 already reads as high
		expect(doc.toString()).toBe(text);
		doc.setPriority("none");
		expect(diff(text, doc.toString())).toEqual({
			removed: ["PRIORITY:3\r\n"],
			added: [],
		});
	});

	test("changed tags become one CATEGORIES line at the first one's place", async () => {
		const text = await fixture("kitchen-sink.ics");
		const doc = TaskDocument.parse(text);
		doc.setCategories(["alpha", "beta, gamma", "delta"]);
		expect(doc.toString()).toBe(text);
		doc.setCategories(["alpha", "epsilon"]);
		const out = doc.toString();
		expect(diff(text, out)).toEqual({
			removed: ["CATEGORIES:alpha,beta\\, gamma\r\n", "CATEGORIES:delta\r\n"],
			added: ["CATEGORIES:alpha,epsilon\r\n"],
		});
		expect(TaskDocument.parse(out).fields().categories).toEqual([
			"alpha",
			"epsilon",
		]);
	});

	test("an emptied description is removed, a long one is folded at 75 octets", async () => {
		const text = await fixture("tasksorg-allday.ics");
		const doc = TaskDocument.parse(text);
		const long = "Ä".repeat(60);
		doc.setDescription(long);
		const out = doc.toString();
		for (const l of physical(out))
			expect(
				new TextEncoder().encode(l.replace(/\r?\n$/, "")).length,
			).toBeLessThanOrEqual(75);
		expect(TaskDocument.parse(out).fields().description).toBe(long);
		doc.setDescription("");
		expect(doc.toString()).toBe(text);
	});

	test("a due date is inserted before nested alarms and written with VALUE=DATE", async () => {
		const text = await fixture("tasksorg-completed.ics");
		const doc = TaskDocument.parse(text);
		doc.setDue({ kind: "date", date: "2026-11-02" });
		expect(diff(text, doc.toString())).toEqual({
			removed: [],
			added: ["DUE;VALUE=DATE:20261102\r\n"],
		});
	});
});

describe("due dates keep their form", () => {
	const moved = async (name: string, to: string) => {
		const text = await fixture(name);
		const doc = TaskDocument.parse(text);
		const due = doc.fields().due;
		if (!due) throw new Error("fixture without DUE");
		doc.setDue(moveDue(due, to, TZ, doc));
		return { text, doc, d: diff(text, doc.toString()) };
	};

	test("TZID date-time: same zone, same wall time including seconds", async () => {
		const { d } = await moved("tasksorg-subtask.ics", "2026-10-24");
		expect(d).toEqual({
			removed: ["DUE;TZID=Europe/Berlin:20261022T143001\r\n"],
			added: ["DUE;TZID=Europe/Berlin:20261024T143001\r\n"],
		});
	});

	test("across the DST change the wall time stays and the instant moves", async () => {
		const { doc } = await moved("tasksorg-subtask.ics", "2026-10-26");
		const due = doc.fields().due;
		expect(due && instantOf(due, TZ, doc)).toBe(
			Date.UTC(2026, 9, 26, 13, 30, 1),
		); // 14:30:01 CET
	});

	test("floating date-time (Planify) stays floating", async () => {
		const { d } = await moved("planify-task.ics", "2026-10-23");
		expect(d).toEqual({
			removed: ["DUE:20261021T150000\r\n"],
			added: ["DUE:20261023T150000\r\n"],
		});
	});

	test("all-day stays all-day; DTSTART is never touched", async () => {
		const { d } = await moved("tasksorg-allday.ics", "2026-10-27");
		expect(d).toEqual({
			removed: ["DUE;VALUE=DATE:20261024\r\n"],
			added: ["DUE;VALUE=DATE:20261027\r\n"],
		});
	});

	test("UTC keeps the local wall time across DST", () => {
		// 23 Oct 12:00Z = 14:00 CEST; moved to 26 Oct it must still be 14:00 local = 13:00Z.
		const due = {
			kind: "date-time" as const,
			date: "2026-10-23",
			time: "120000",
			tzid: null,
			utc: true,
		};
		expect(moveDue(due, "2026-10-26", TZ)).toEqual({
			...due,
			date: "2026-10-26",
			time: "130000",
		});
	});

	test("a TZID late in the evening elsewhere lands on the right app day", () => {
		// 23:30 in New York is 05:30 the next day in Berlin.
		const due = {
			kind: "date-time" as const,
			date: "2026-10-21",
			time: "233000",
			tzid: "America/New_York",
			utc: false,
		};
		expect(dueInApp(due, TZ).date).toBe("2026-10-22");
		expect(moveDue(due, "2026-10-24", TZ)).toEqual({
			...due,
			date: "2026-10-23",
		});
	});

	test("non-IANA TZID keeps its name and uses the resource's VTIMEZONE", async () => {
		const { d } = await moved("kitchen-sink.ics", "2026-10-26");
		expect(d).toEqual({
			removed: ["DUE;TZID=W. Europe Standard Time:20261025T170000\r\n"],
			added: ["DUE;TZID=W. Europe Standard Time:20261026T170000\r\n"],
		});
	});

	test("times entered in the app are written in the task's own zone", () => {
		const ny = {
			kind: "date-time" as const,
			date: "2026-10-21",
			time: "100000",
			tzid: "America/New_York",
			utc: false,
		};
		expect(
			dueFromApp({ date: "2026-10-22", minutes: 9 * 60 + 15 }, ny, TZ),
		).toEqual({ ...ny, date: "2026-10-22", time: "031500" });
		const utc = {
			kind: "date-time" as const,
			date: "2026-10-21",
			time: "100000",
			tzid: null,
			utc: true,
		};
		expect(
			dueFromApp({ date: "2026-10-22", minutes: 9 * 60 + 15 }, utc, TZ),
		).toEqual({ ...utc, date: "2026-10-22", time: "071500" });
		expect(dueFromApp({ date: "2026-10-22", minutes: 600 }, null, TZ)).toEqual({
			kind: "date-time",
			date: "2026-10-22",
			time: "100000",
			tzid: null,
			utc: false,
		});
		expect(dueFromApp({ date: "2026-10-22", minutes: null }, ny, TZ)).toEqual({
			kind: "date",
			date: "2026-10-22",
		});
	});

	test("date-time → date drops TZID and adds VALUE=DATE", async () => {
		const text = await fixture("tasksorg-subtask.ics");
		const doc = TaskDocument.parse(text);
		doc.setDue({ kind: "date", date: "2026-10-22" });
		expect(diff(text, doc.toString()).added).toEqual([
			"DUE;VALUE=DATE:20261022\r\n",
		]);
	});

	test("a due date before the start (tasks.org 'hide until') is detected", async () => {
		const doc = TaskDocument.parse(await fixture("tasksorg-allday.ics"));
		const f = doc.fields();
		expect(
			dueBeforeStart({ kind: "date", date: "2026-10-22" }, f.start, TZ),
		).toBe(true);
		expect(
			dueBeforeStart({ kind: "date", date: "2026-10-23" }, f.start, TZ),
		).toBe(false);
	});
});

describe("text helpers and new tasks", () => {
	test("escaping round-trips", () => {
		const s = "a, b; c\\d\nnext";
		expect(unescapeText(escapeText(s))).toBe(s);
	});

	test("folding never splits a UTF-8 sequence", () => {
		const out = fold(`SUMMARY:${"€".repeat(40)}`, "\r\n");
		for (const l of out.split("\r\n").filter(Boolean))
			expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75);
		expect(out.replace(/\r\n /g, "")).toBe(`SUMMARY:${"€".repeat(40)}\r\n`);
	});

	test("a new task is a minimal, valid resource", () => {
		const text = newTaskText({
			uid: "u-1",
			summary: "Write, test; ship",
			now: NOW,
			parentUid: "p-1",
		});
		const f = TaskDocument.parse(text).fields();
		expect(f).toMatchObject({
			uid: "u-1",
			summary: "Write, test; ship",
			status: "NEEDS-ACTION",
			parentUid: "p-1",
		});
		expect(text).toContain("RELATED-TO:p-1\r\n");
		expect(text.endsWith("END:VCALENDAR\r\n")).toBe(true);
	});
});

describe("edge cases", () => {
	const doc = (body: string, eol = "\r\n") =>
		[
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"BEGIN:VTODO",
			"UID:e",
			"DTSTAMP:20261001T000000Z",
			...body.split("|").filter(Boolean),
			"END:VTODO",
			"END:VCALENDAR",
			"",
		].join(eol);

	test("a byte-order mark is kept and doesn't break parsing", () => {
		const text = `﻿${doc("SUMMARY:Old")}`;
		const d = TaskDocument.parse(text);
		expect(d.fields().summary).toBe("Old");
		d.setSummary("New");
		expect(d.toString()).toBe(text.replace("SUMMARY:Old", "SUMMARY:New"));
	});

	test("replacing an already-folded line replaces all of its physical lines", async () => {
		const text = await fixture("kitchen-sink.ics");
		const d = TaskDocument.parse(text);
		d.setDescription("Short now");
		const { removed: all, added } = diff(text, d.toString());
		// Writing DESCRIPTION also drops X-ALT-DESC, as the Tasks app does.
		expect(all.filter((l) => l.startsWith("X-ALT-DESC"))).toHaveLength(1);
		const removed = all.filter((l) => !l.startsWith("X-ALT-DESC"));
		expect(removed).toHaveLength(2); // the folded DESCRIPTION was two physical lines
		expect(removed[0]).toStartWith(
			'DESCRIPTION;ALTREP="cid:part1.0001@example.test":A long',
		);
		expect(added).toEqual([
			'DESCRIPTION;ALTREP="cid:part1.0001@example.test":Short now\r\n',
		]);
	});

	test("a tag with a comma is escaped and reads back as one tag", () => {
		const d = TaskDocument.parse(doc(""));
		d.setCategories(["home, garden", "x"]);
		expect(d.toString()).toContain("CATEGORIES:home\\, garden,x\r\n");
		expect(TaskDocument.parse(d.toString()).fields().categories).toEqual([
			"home, garden",
			"x",
		]);
	});

	test("LF-only files get LF lines", () => {
		const d = TaskDocument.parse(doc("", "\n"));
		d.setSummary("Added");
		d.touch(NOW);
		expect(d.toString()).not.toContain("\r");
		expect(d.toString()).toContain("SUMMARY:Added\nEND:VTODO\n");
	});

	test("with several VTODOs only the first is edited", () => {
		const text =
			"BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:r\r\nSUMMARY:Series\r\nRRULE:FREQ=DAILY\r\nEND:VTODO\r\nBEGIN:VTODO\r\nUID:r\r\nRECURRENCE-ID:20261021T100000Z\r\nSUMMARY:Override\r\nEND:VTODO\r\nEND:VCALENDAR\r\n";
		const d = TaskDocument.parse(text);
		expect(d.fields().summary).toBe("Series");
		d.setSummary("Renamed");
		expect(d.toString()).toBe(
			text.replace("SUMMARY:Series", "SUMMARY:Renamed"),
		);
	});

	test("status transitions keep a partial PERCENT-COMPLETE and drop COMPLETED", () => {
		const d = TaskDocument.parse(doc("STATUS:IN-PROCESS|PERCENT-COMPLETE:40"));
		d.setStatus("CANCELLED", NOW);
		expect(d.toString()).toContain(
			"STATUS:CANCELLED\r\nPERCENT-COMPLETE:40\r\n",
		);
		d.setStatus("COMPLETED", NOW);
		d.setStatus("NEEDS-ACTION", NOW);
		const out = d.toString();
		expect(out).toContain("STATUS:NEEDS-ACTION\r\n");
		expect(out).not.toMatch(/PERCENT-COMPLETE|\r\nCOMPLETED/);
	});

	test("a COMPLETED with parameters is rewritten as plain UTC", () => {
		const d = TaskDocument.parse(
			doc("STATUS:CANCELLED|COMPLETED;TZID=Europe/Berlin:20261001T120000"),
		);
		d.setStatus("COMPLETED", NOW);
		expect(d.toString()).toContain(`COMPLETED:${STAMP}\r\n`);
		expect(d.toString()).not.toContain("TZID=Europe/Berlin");
	});

	test("removing the due date removes only DUE", async () => {
		const text = await fixture("tasksorg-allday.ics");
		const d = TaskDocument.parse(text);
		d.setDue(null);
		expect(diff(text, d.toString())).toEqual({
			removed: ["DUE;VALUE=DATE:20261024\r\n"],
			added: [],
		});
	});
});
