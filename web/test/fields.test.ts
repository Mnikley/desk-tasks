// Fields beyond the basics: DTSTART, X-PINNED, CLASS, LOCATION, URL,
// PERCENT-COMPLETE with STATUS, DESCRIPTION dropping X-ALT-DESC, and their TOUCHES in the merge.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { attempt } from "../src/core/ctx.ts";
import { TaskDocument } from "../src/core/ical.ts";
import { sync } from "../src/core/sync.ts";
import { applyChange, type Change, updateTask } from "../src/core/write.ts";
import { FakeCaldav, vtodo } from "./fake-caldav.ts";
import { at, diff, fixture, type TestCore, testCore } from "./helpers.ts";

const NOW = Date.UTC(2026, 9, 28, 8, 0, 0);
const STAMP = "20261028T080000Z";

describe("in-place writes of the new fields", () => {
	const ctx = { now: () => NOW, tz: "Europe/Berlin" } as Parameters<
		typeof applyChange
	>[0];
	const edit = async (name: string, c: Change) => {
		const text = await fixture(name);
		return diff(text, applyChange(ctx, text, c));
	};

	test("a start date is written in the due date's forms; new timed starts float", async () => {
		const d = await edit("tasksorg-allday.ics", {
			start: { date: "2026-10-21", minutes: null },
		});
		expect(d.removed.sort()).toEqual([
			"DTSTAMP:20261020T091500Z\r\n",
			"DTSTART;VALUE=DATE:20261023\r\n",
			"LAST-MODIFIED:20261020T091458Z\r\n",
		]);
		expect(d.added.sort()).toEqual([
			`DTSTAMP:${STAMP}\r\n`,
			"DTSTART;VALUE=DATE:20261021\r\n",
			`LAST-MODIFIED:${STAMP}\r\n`,
		]);
		const timed = await edit("planify-task.ics", {
			start: { date: "2026-10-20", minutes: 9 * 60 },
		});
		expect(timed.added).toContain("DTSTART:20261020T090000\r\n");
		const gone = await edit("tasksorg-allday.ics", { start: null });
		expect(gone.removed).toContain("DTSTART;VALUE=DATE:20261023\r\n");
	});

	test("a start after the due date is refused, also when both change", async () => {
		const text = await fixture("tasksorg-allday.ics"); // due 24 Oct
		expect(() =>
			applyChange(ctx, text, { start: { date: "2026-10-25", minutes: null } }),
		).toThrow("The start is after the due date");
		expect(() =>
			applyChange(ctx, text, {
				start: { date: "2026-11-01", minutes: null },
				due: { date: "2026-10-30", minutes: null },
			}),
		).toThrow("starts on 01.11.2026");
		// Moving both together the right way round is fine.
		const ok = applyChange(ctx, text, {
			start: { date: "2026-11-01", minutes: null },
			due: { date: "2026-11-03", minutes: null },
		});
		expect(ok).toContain("DUE;VALUE=DATE:20261103\r\n");
	});

	test("pin, privacy, location and link; public removes CLASS", async () => {
		const d = await edit("tasksorg-allday.ics", {
			pinned: true,
			klass: "CONFIDENTIAL",
			location: "Shop, 2nd floor",
			url: "https://example.com/a?b=c,d",
		});
		expect(d.added.sort()).toEqual(
			[
				"CLASS:CONFIDENTIAL\r\n",
				`DTSTAMP:${STAMP}\r\n`,
				`LAST-MODIFIED:${STAMP}\r\n`,
				"LOCATION:Shop\\, 2nd floor\r\n",
				"URL:https://example.com/a?b=c,d\r\n",
				"X-PINNED:true\r\n",
			].sort(),
		);
		const text = await fixture("tasksorg-allday.ics");
		const set = applyChange(ctx, text, { klass: "PRIVATE", pinned: true });
		const back = applyChange(ctx, set, { klass: "PUBLIC", pinned: false });
		expect(back).not.toMatch(/CLASS|X-PINNED/);
		const f = TaskDocument.parse(set).fields();
		expect(f).toMatchObject({ klass: "PRIVATE", pinned: true });
	});

	test("progress moves STATUS along like the Tasks app", async () => {
		const text = await fixture("tasksorg-allday.ics");
		const half = applyChange(ctx, text, { progress: 40 });
		expect(TaskDocument.parse(half).fields()).toMatchObject({
			status: "IN-PROCESS",
			percent: 40,
		});
		const zero = applyChange(ctx, half, { progress: 0 });
		expect(zero).not.toContain("PERCENT-COMPLETE");
		expect(TaskDocument.parse(zero).fields().status).toBe("NEEDS-ACTION");
		const full = applyChange(ctx, half, { progress: 100 });
		expect(TaskDocument.parse(full).fields()).toMatchObject({
			status: "COMPLETED",
			percent: 100,
		});
		expect(full).toContain(`COMPLETED:${STAMP}`);
	});
});

describe("TOUCHES for the new fields", () => {
	let fake: FakeCaldav;
	let core: TestCore;
	let list = "";
	beforeEach(async () => {
		fake = new FakeCaldav();
		list = fake.addList("errands", "Errands");
		fake.put(
			`${list}a.ics`,
			vtodo("a", [
				"DUE;VALUE=DATE:20261030",
				"DTSTART;VALUE=DATE:20261027",
				"LOCATION:Home",
			]),
		);
		core = testCore({ url: fake.url, now: at("2026-10-28", "09:00") });
		await sync(core.ctx, { force: true });
	});
	afterEach(() => fake.stop());

	const cases: [string, (t: string) => string, Change, boolean][] = [
		[
			"location elsewhere, pin here",
			(t) => t.replace("LOCATION:Home", "LOCATION:Office"),
			{ pinned: true },
			true,
		],
		[
			"start elsewhere, start here",
			(t) =>
				t.replace("DTSTART;VALUE=DATE:20261027", "DTSTART;VALUE=DATE:20261026"),
			{ start: { date: "2026-10-28", minutes: null } },
			false,
		],
		[
			"location elsewhere, location here",
			(t) => t.replace("LOCATION:Home", "LOCATION:Office"),
			{ location: "Garden" },
			false,
		],
		[
			"completed elsewhere, progress here",
			(t) => t.replace("SUMMARY:a", "SUMMARY:a\r\nSTATUS:COMPLETED"),
			{ progress: 50 },
			false,
		],
		[
			"privacy elsewhere, link here",
			(t) => t.replace("SUMMARY:a", "SUMMARY:a\r\nCLASS:PRIVATE"),
			{ url: "https://x.example" },
			true,
		],
	];
	for (const [name, remote, change, merges] of cases)
		test(name, async () => {
			fake.edit(`${list}a.ics`, remote);
			const theirs = fake.get(`${list}a.ics`);
			const res = await attempt(() =>
				updateTask(core.ctx, `${list}a.ics`, change),
			);
			if (merges) expect(res.ok).toBe(true);
			else {
				expect(!res.ok && res.error.kind).toBe("conflict");
				expect(fake.get(`${list}a.ics`)).toBe(theirs);
			}
		});
});
