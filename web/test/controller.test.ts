// The controller on the core against the fake server: drop order for several tasks, Undo while
// an action is still being written, linger flushes that overlap.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Bridge, type PyApi } from "../src/bridge.ts";
import { sync } from "../src/core/sync.ts";
import { Controller } from "../src/ui/controller.ts";
import { FakeCaldav, HOME, vtodo } from "./fake-caldav.ts";
import { at, testCore } from "./helpers.ts";
import { DEFAULT_SETTINGS } from "./stub-bridge.ts";

let fake: FakeCaldav;
beforeEach(() => {
	fake = new FakeCaldav();
	fake.addList("work", "Work");
});
afterEach(() => fake.stop());

async function rig() {
	const core = testCore({ url: fake.url, now: at("2026-10-28", "10:00") });
	const api = {
		notify: async () => ({ ok: true }),
		tray: async () => ({ ok: true }),
		log: async () => null,
	} as unknown as PyApi;
	const settings = {
		...DEFAULT_SETTINGS,
		server: fake.url,
		user: "u",
		connected: true,
	} as never;
	const app = new Controller({
		ctx: core.ctx,
		bridge: new Bridge(api),
		settings,
		timers: false,
	});
	await sync(core.ctx, { force: true });
	const byName = (n: string) =>
		app.tasks().find((t) => t.summary === n) as NonNullable<
			ReturnType<typeof app.task>
		>;
	return { core, app, byName };
}
const order = (uid: string) =>
	Number(
		/X-APPLE-SORT-ORDER:(\d+)/.exec(
			fake.get(`${HOME}work/${uid}.ics`) ?? "",
		)?.[1],
	);

describe("controller", () => {
	test("dropping two tasks below the last keeps them together, in order", async () => {
		for (const [uid, n] of [
			["a", 10],
			["m0", 20],
			["b", 30],
			["m1", 40],
			["c", 50],
		] as const)
			fake.put(
				`${HOME}work/${uid}.ics`,
				vtodo(uid, [`X-APPLE-SORT-ORDER:${n}`]),
			);
		const r = await rig();
		await r.app.dropAt([r.byName("m0"), r.byName("m1")], {
			list: `${HOME}work/`,
			parent: null,
			index: 3,
		});
		const sorted = ["a", "m0", "b", "m1", "c"].sort(
			(x, y) => order(x) - order(y),
		);
		expect(sorted).toEqual(["a", "b", "c", "m0", "m1"]);
	});

	test("Undo pressed while an action is still writing undoes that action", async () => {
		fake.put(`${HOME}work/a.ics`, vtodo("a"));
		fake.put(`${HOME}work/b.ics`, vtodo("b"));
		const r = await rig();
		await r.app.change(
			[r.byName("b")],
			{ summary: "B renamed" },
			() => "Renamed",
		);
		const pending = r.app.change(
			[r.byName("a")],
			{ priority: "high" },
			() => "High",
		);
		await r.app.undo();
		await pending;
		expect(fake.get(`${HOME}work/a.ics`)).not.toContain("PRIORITY:1");
		expect(fake.get(`${HOME}work/b.ics`)).toContain("SUMMARY:B renamed");
	});

	test("two flushes of the same tick complete a repeating task once", async () => {
		fake.put(
			`${HOME}work/d.ics`,
			vtodo("d", ["DUE;VALUE=DATE:20261028", "RRULE:FREQ=DAILY"]),
		);
		const r = await rig();
		r.app.toggleDone(r.byName("d").id);
		await Promise.all([r.app.flushLinger(), r.app.flushLinger()]);
		expect(fake.get(`${HOME}work/d.ics`)).toContain("DUE;VALUE=DATE:20261029");
		expect(r.app.lingering.get().size).toBe(0);
	});

	test("a tick made while a flush is writing stays and is written by the next flush", async () => {
		fake.put(`${HOME}work/a.ics`, vtodo("a"));
		fake.put(`${HOME}work/b.ics`, vtodo("b"));
		const r = await rig();
		r.app.toggleDone(r.byName("a").id);
		const first = r.app.flushLinger();
		r.app.toggleDone(r.byName("b").id);
		await first;
		expect(r.app.lingering.get().has(r.byName("b").id)).toBe(true);
		await r.app.flushLinger();
		expect(fake.get(`${HOME}work/b.ics`)).toContain("STATUS:COMPLETED");
	});
});
