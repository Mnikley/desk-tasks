// The reminder loop on top of the core: each trigger fires once, missed ones become one
// summary, a pause holds them, a snooze brings one back, Done completes the task.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Bridge, type PyApi, type Toast } from "../src/bridge.ts";
import { sync } from "../src/core/sync.ts";
import { Controller } from "../src/ui/controller.ts";
import { Reminders } from "../src/ui/reminders.ts";
import { FakeCaldav, HOME, vtodo } from "./fake-caldav.ts";
import { at, testCore } from "./helpers.ts";
import { DEFAULT_SETTINGS } from "./stub-bridge.ts";

let fake: FakeCaldav;
beforeEach(() => {
	fake = new FakeCaldav();
	fake.addList("work", "Work");
});
afterEach(() => fake.stop());

function rig(now: number) {
	const core = testCore({ url: fake.url, now });
	const toasts: Toast[] = [];
	const trays: string[] = [];
	const api = {
		notify: async (t: Toast) => {
			toasts.push(t);
			return { ok: true };
		},
		tray: async (s: { tooltip: string }) => {
			trays.push(s.tooltip);
			return { ok: true };
		},
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
	const rem = new Reminders(app);
	app.reminders = rem;
	return { core, app, rem, toasts, trays };
}

const alarm = (trigger: string) => [
	"BEGIN:VALARM",
	"ACTION:DISPLAY",
	"DESCRIPTION:x",
	trigger,
	"END:VALARM",
];

describe("the reminder loop", () => {
	test("a due reminder fires once, with Done and Snooze; the tray counts what is due today", async () => {
		fake.put(
			`${HOME}work/a.ics`,
			vtodo("a", [
				"SUMMARY:Call Bob",
				"DUE:20261028T140000",
				...alarm("TRIGGER;RELATED=END:-PT15M"),
			]).replace("SUMMARY:a\r\n", ""),
		);
		const r = rig(at("2026-10-28", "13:46"));
		await sync(r.core.ctx, { force: true });
		await r.rem.tick();
		expect(r.toasts).toEqual([
			{
				title: "Call Bob",
				body: "Due 14:00 · Work",
				href: `${HOME}work/a.ics`,
				actions: ["done", "snooze"],
			},
		]);
		await r.rem.tick();
		expect(r.toasts).toHaveLength(1);
		expect(r.trays.at(-1)).toBe("desk-tasks · 1 due today");
	});

	test("missed while away: the last 12 h become one summary, older ones go silently", async () => {
		const missed: [string, string][] = [
			["x1", "20261028T080000"],
			["x2", "20261028T090000"],
			["old", "20261027T060000"],
		];
		for (const [uid, due] of missed)
			fake.put(`${HOME}work/${uid}.ics`, vtodo(uid, [`DUE:${due}`]));
		const r = rig(at("2026-10-28", "10:00"));
		await sync(r.core.ctx, { force: true });
		await r.rem.tick();
		expect(r.toasts).toEqual([
			{
				title: "2 reminders while you were away",
				body: "Open Today to see them.",
			},
		]);
		await r.rem.tick();
		expect(r.toasts).toHaveLength(1);
	});

	test("nothing fires while notifications are paused; it fires when the pause ends", async () => {
		fake.put(`${HOME}work/a.ics`, vtodo("a", ["DUE:20261028T140000"]));
		const r = rig(at("2026-10-28", "14:01"));
		r.app.settings.set({
			...r.app.settings.get(),
			notificationsPausedUntil: at("2026-10-28", "14:03"),
		});
		await sync(r.core.ctx, { force: true });
		await r.rem.tick();
		expect(r.toasts).toHaveLength(0);
		r.core.clock.now = at("2026-10-28", "14:04");
		await r.rem.tick();
		expect(r.toasts.map((t) => t.title)).toEqual(["a"]);
	});

	test("Snooze 15 min brings it back; Done completes the task in Nextcloud", async () => {
		fake.put(`${HOME}work/a.ics`, vtodo("a", ["DUE:20261028T140000"]));
		const r = rig(at("2026-10-28", "14:00"));
		await sync(r.core.ctx, { force: true });
		await r.rem.tick();
		await r.rem.action("snooze-15m", `${HOME}work/a.ics`);
		r.core.clock.now = at("2026-10-28", "14:10");
		await r.rem.tick();
		expect(r.toasts).toHaveLength(1);
		r.core.clock.now = at("2026-10-28", "14:16");
		await r.rem.tick();
		expect(r.toasts).toHaveLength(2);
		await r.rem.action("done", `${HOME}work/a.ics`);
		expect(fake.get(`${HOME}work/a.ics`)).toContain("STATUS:COMPLETED");
	});

	test("view-only tasks offer Snooze only; lists with reminders off stay quiet", async () => {
		fake.addList("ro", "Family", ["VTODO"], false, {
			owner: "principals/users/bob",
			ownerName: "Bob",
		});
		fake.put(`${HOME}ro/a.ics`, vtodo("a", ["DUE:20261028T140000"]));
		fake.put(`${HOME}work/b.ics`, vtodo("b", ["DUE:20261028T140000"]));
		const r = rig(at("2026-10-28", "14:00"));
		r.app.settings.set({
			...r.app.settings.get(),
			lists: { [`${HOME}work/`]: { notify: false } },
		});
		await sync(r.core.ctx, { force: true });
		await r.rem.tick();
		expect(r.toasts.map((t) => [t.title, t.actions])).toEqual([
			["a", ["snooze"]],
		]);
	});
});
