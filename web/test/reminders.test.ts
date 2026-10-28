// Reminders: VALARM edits in place, and which triggers fire when (relative to DUE/DTSTART,
// absolute, the due-time default, the missed window, firing once).
import { describe, expect, test } from "bun:test";
import { durationText, parseDuration, TaskDocument } from "../src/core/ical.ts";
import {
	type ReminderEntry,
	reminderEntries,
	snoozeUntil,
	tickPlan,
	triggerLabel,
} from "../src/core/reminders.ts";
import { applyChange } from "../src/core/write.ts";
import { diff, fixture, TZ } from "./helpers.ts";

const NOW = Date.UTC(2026, 9, 28, 8, 0, 0);
const ctx = { now: () => NOW, tz: TZ } as Parameters<typeof applyChange>[0];

describe("editing reminders in place", () => {
	test("a preset adds one DISPLAY VALARM before END:VTODO; nothing else changes", async () => {
		const text = await fixture("tasksorg-subtask.ics");
		const out = applyChange(ctx, text, {
			reminders: { add: [{ kind: "relative", related: "END", seconds: -900 }] },
		});
		const d = diff(text, out);
		expect(d.removed.map((l) => l.split(":")[0]).sort()).toEqual([
			"DTSTAMP",
			"LAST-MODIFIED",
		]);
		expect(d.added.filter((l) => !/^(DTSTAMP|LAST-MODIFIED)/.test(l))).toEqual([
			"BEGIN:VALARM\r\n",
			"ACTION:DISPLAY\r\n",
			"DESCRIPTION:Prepare quarterly report\r\n",
			"TRIGGER;RELATED=END:-PT15M\r\n",
			"END:VALARM\r\n",
		]);
		expect(out.indexOf("END:VALARM\r\nEND:VTODO")).toBeGreaterThan(0);
	});

	test("an absolute reminder is written in UTC", async () => {
		const out = applyChange(ctx, await fixture("tasksorg-allday.ics"), {
			reminders: {
				add: [{ kind: "absolute", at: Date.UTC(2026, 9, 30, 13, 15) }],
			},
		});
		expect(out).toContain("TRIGGER;VALUE=DATE-TIME:20261030T131500Z\r\n");
	});

	test("removing deletes that VALARM only; Planify's LF alarm and other lines stay", async () => {
		const text = await fixture("kitchen-sink.ics");
		const alarms = TaskDocument.parse(text).fields().alarms;
		expect(alarms.length).toBeGreaterThanOrEqual(1);
		const [first] = alarms;
		const out = applyChange(ctx, text, {
			reminders: { remove: [first?.key ?? ""] },
		});
		// Exactly that block is gone; apart from the bookkeeping stamps the rest is unchanged.
		const block = (first?.key ?? "")
			.split("\n")
			.map((l) => `${l}\r\n`)
			.join("");
		const stamps = (t: string) =>
			t.replace(/^(DTSTAMP|LAST-MODIFIED):.*\r\n/gm, "");
		expect(stamps(out)).toBe(stamps(text).replace(block, ""));
		expect(TaskDocument.parse(out).fields().alarms).toHaveLength(
			alarms.length - 1,
		);
	});

	test("relative to due needs a due date", async () => {
		const noDue = (await fixture("tasksorg-allday.ics")).replace(
			"DUE;VALUE=DATE:20261024\r\n",
			"",
		);
		expect(() =>
			applyChange(ctx, noDue, {
				reminders: { add: [{ kind: "relative", related: "END", seconds: 0 }] },
			}),
		).toThrow("Set a due date first.");
	});

	test("durations both ways, and labels", () => {
		expect([-900, -3600, -86_400, 0, 5400].map(durationText)).toEqual([
			"-PT15M",
			"-PT1H",
			"-P1D",
			"PT0S",
			"PT1H30M",
		]);
		expect(
			["-PT15M", "P1W", "-P1DT2H", "PT0S", "P", "xx"].map(parseDuration),
		).toEqual([-900, 604_800, -93_600, 0, null, null]);
		expect(
			triggerLabel({ kind: "relative", related: "END", seconds: -3600 }, TZ),
		).toBe("1 hour before");
		expect(
			triggerLabel({ kind: "relative", related: "START", seconds: 0 }, TZ),
		).toBe("At start");
		expect(
			triggerLabel({ kind: "absolute", at: Date.UTC(2026, 9, 30, 13, 15) }, TZ),
		).toBe("Fri 30 Oct 14:15");
	});
});

describe("when reminders fire", () => {
	const task = (
		lines: string[],
		o: Partial<{
			status: string;
			due: { date: string; minutes: number | null; at: number | null } | null;
			readOnly: string | null;
		}> = {},
	) => ({
		view: {
			href: "/l/t.ics",
			uid: "t",
			list: "/l/",
			summary: "Pay rent",
			status: "NEEDS-ACTION",
			readOnly: null,
			due: null,
			...o,
		},
		ics: [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"BEGIN:VTODO",
			"UID:t",
			"SUMMARY:Pay rent",
			...lines,
			"END:VTODO",
			"END:VCALENDAR",
			"",
		].join("\r\n"),
	});
	const alarm = (trigger: string, action = "DISPLAY") => [
		"BEGIN:VALARM",
		`ACTION:${action}`,
		trigger,
		"END:VALARM",
	];
	const window = (tasks: ReturnType<typeof task>[], dueTime = true) =>
		reminderEntries(
			tasks,
			{ tz: TZ, dueTime, notify: () => true },
			NOW - 12 * 3600_000,
			NOW + 48 * 3600_000,
		);

	test("relative to DUE and DTSTART, absolute, AUDIO; EMAIL ignored; same instant once", () => {
		const e = window([
			task([
				"DUE;TZID=Europe/Berlin:20261028T140000", // 13:00Z
				"DTSTART;TZID=Europe/Berlin:20261028T100000", // 09:00Z
				...alarm("TRIGGER;RELATED=END:-PT15M"),
				...alarm("TRIGGER:PT0S"), // RELATED defaults to START
				...alarm("TRIGGER;VALUE=DATE-TIME:20261029T070000Z", "AUDIO"),
				...alarm("TRIGGER;RELATED=END:-PT30M", "EMAIL"),
				...alarm("TRIGGER;RELATED=END:-PT15M"),
			]),
		]);
		expect(e.map((x) => new Date(x.at).toISOString())).toEqual([
			"2026-10-28T09:00:00.000Z",
			"2026-10-28T12:45:00.000Z",
			"2026-10-29T07:00:00.000Z",
		]);
	});

	test("the due time of a timed task without alarms, when that setting is on; all-day at 09:00", () => {
		const timed = task(["DUE:20261028T150000"], {
			due: { date: "2026-10-28", minutes: 900, at: Date.UTC(2026, 9, 28, 14) },
		});
		expect(window([timed]).map((x) => x.kind)).toEqual(["due"]);
		expect(window([timed], false)).toEqual([]);
		const allDay = task([
			"DUE;VALUE=DATE:20261029",
			...alarm("TRIGGER;RELATED=END:PT0S"),
		]);
		expect(window([allDay]).map((x) => new Date(x.at).toISOString())).toEqual([
			"2026-10-29T08:00:00.000Z",
		]);
		expect(
			window([
				task(["DUE:20261028T150000", ...alarm("TRIGGER;RELATED=END:PT0S")], {
					status: "COMPLETED",
				}),
			]),
		).toEqual([]);
	});

	test("a tick fires what is due, gathers what was missed, drops what is too old, fires once", () => {
		const at = (minutesAgo: number): ReminderEntry => ({
			key: `k${minutesAgo}`,
			href: "/l/t.ics",
			uid: "t",
			at: NOW - minutesAgo * 60_000,
			summary: "x",
			list: "/l/",
			kind: "alarm",
			dueText: "",
			readOnly: false,
		});
		const entries = [at(1), at(30), at(13 * 60), at(-5), at(2)];
		const plan = tickPlan(entries, NOW, {
			fired: new Set(["k2"]),
			snoozes: [],
			pausedUntil: null,
		});
		expect(plan.fire.map((e) => e.key)).toEqual(["k1"]);
		expect(plan.missed.map((e) => e.key)).toEqual(["k30"]);
		expect(plan.expire).toEqual(["k780"]);
		const paused = tickPlan(entries, NOW, {
			fired: new Set(),
			snoozes: [],
			pausedUntil: NOW + 1,
		});
		expect(paused.fire).toEqual([]);
	});

	test("snooze choices: 15 min, 1 h, tomorrow 9:00 local", () => {
		expect(snoozeUntil("15m", NOW, TZ)).toBe(NOW + 900_000);
		expect(snoozeUntil("1h", NOW, TZ)).toBe(NOW + 3_600_000);
		expect(new Date(snoozeUntil("tomorrow", NOW, TZ)).toISOString()).toBe(
			"2026-10-29T08:00:00.000Z",
		);
	});
});
