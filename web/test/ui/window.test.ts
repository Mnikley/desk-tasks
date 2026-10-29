// The frameless window's own chrome: the header drags, the grip resizes (Python gets physical
// pixels), the tray's "Pause notifications 1 h" reaches the settings.
import { afterAll, describe, expect, test } from "bun:test";
import { closeBrowser, type Opened, openApp, UI, until } from "./harness.ts";

type Cmd = { cmd: string; dx?: number; dy?: number; w?: number; h?: number };
const windowCalls = (o: Opened) =>
	o.stub.calls.filter((c) => c.name === "window").map((c) => c.args[0] as Cmd);

describe.skipIf(!UI)("window chrome", () => {
	afterAll(closeBrowser);

	test("dragging the header's empty space moves the window by the physical distance", async () => {
		const o = await openApp({ scale: 1.5 });
		try {
			await o.page.locator(".row").first().waitFor();
			const box = await o.page.locator(".bar .grow").boundingBox();
			if (!box) throw new Error("no header space");
			const x = box.x + box.width / 2;
			const y = box.y + box.height / 2;
			await o.page.mouse.move(x, y);
			await o.page.mouse.down();
			await o.page.mouse.move(x + 10, y + 4, { steps: 2 });
			await o.page.mouse.move(x + 30, y + 20, { steps: 3 });
			await o.page.mouse.up();
			await until(() => {
				const m = windowCalls(o).filter((c) => c.cmd === "move");
				return m.reduce((s, c) => s + (c.dx ?? 0), 0) === 45;
			});
			const moves = windowCalls(o).filter((c) => c.cmd === "move");
			expect(moves.reduce((s, c) => s + (c.dy ?? 0), 0)).toBe(30);
		} finally {
			await o.close();
		}
	});

	test("a press on a header button doesn't drag", async () => {
		const o = await openApp();
		try {
			await o.page.locator(".row").first().waitFor();
			const box = await o.page.locator(".switcher-btn").boundingBox();
			if (!box) throw new Error("no switcher");
			await o.page.mouse.move(box.x + 5, box.y + 5);
			await o.page.mouse.down();
			await o.page.mouse.move(box.x + 60, box.y + 40, { steps: 4 });
			await o.page.mouse.up();
			await o.page.waitForTimeout(200);
			expect(windowCalls(o).filter((c) => c.cmd === "move")).toEqual([]);
		} finally {
			await o.close();
		}
	});

	test("a menu opened from the header still takes clicks (its rows aren't drag space)", async () => {
		const o = await openApp();
		try {
			await o.page.locator(".row").first().waitFor();
			await o.page.click("button[aria-label='More']");
			await o.page.click("[role=menuitem] >> text=Settings");
			await o.page.locator(".sheet h2", { hasText: "Settings" }).waitFor();
			expect(windowCalls(o).filter((c) => c.cmd === "move")).toEqual([]);
		} finally {
			await o.close();
		}
	});

	test("the grip resizes to the window's physical size plus the drag", async () => {
		const o = await openApp({ scale: 2 });
		try {
			await o.page.locator(".row").first().waitFor();
			const box = await o.page.locator(".grip").boundingBox();
			if (!box) throw new Error("no grip");
			const x = box.x + box.width / 2;
			const y = box.y + box.height / 2;
			await o.page.mouse.move(x, y);
			await o.page.mouse.down();
			await o.page.mouse.move(x + 40, y + 30, { steps: 4 });
			await o.page.mouse.up();
			await until(() => {
				const r = windowCalls(o)
					.filter((c) => c.cmd === "resize")
					.at(-1);
				return r?.w === 880 && r?.h === 1180;
			});
		} finally {
			await o.close();
		}
	});

	test("a click on the missed-reminders summary opens Today", async () => {
		const o = await openApp();
		try {
			await o.page.locator(".row").first().waitFor();
			await o.page.keyboard.press("g");
			await o.page.keyboard.press("a");
			await o.page.locator(".switcher-btn .name", { hasText: "All" }).waitFor();
			o.stub.push({ type: "summoned", target: "today" });
			await o.page
				.locator(".switcher-btn .name", { hasText: "Today" })
				.waitFor();
		} finally {
			await o.close();
		}
	});

	test("tray “Pause notifications 1 h” pauses them for an hour", async () => {
		const o = await openApp();
		try {
			await o.page.locator(".row").first().waitFor();
			const now = await o.page.evaluate(() => Date.now());
			o.stub.push({ type: "pause-notifications" });
			await until(
				() => typeof o.stub.settings.notificationsPausedUntil === "number",
			);
			const until1h = o.stub.settings.notificationsPausedUntil as number;
			expect(until1h - now).toBeGreaterThanOrEqual(3_600_000);
			expect(until1h - now).toBeLessThan(3_660_000);
			await o.page.getByText("Notifications paused for 1 hour.").waitFor();
		} finally {
			await o.close();
		}
	});
});
