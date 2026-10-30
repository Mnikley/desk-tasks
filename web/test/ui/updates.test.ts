// Updates in the widget: the banner for a new version (Update, What's new, Not now), the
// download and restart, a failed update, Settings → Updates, and "Updated to …" after one.
import { afterAll, describe, expect, test } from "bun:test";
import { UPDATE_STATE } from "../stub-bridge.ts";
import { closeBrowser, type Opened, openApp, UI, until } from "./harness.ts";

const PAGE = "https://github.com/Mnikley/desk-tasks/releases/tag/v0.3.0";
const AVAILABLE = { version: "0.3.0", page: PAGE, installable: true };
const banner = (o: Opened) => o.page.locator(".banners .banner");
const called = (o: Opened, name: string) =>
	o.stub.calls.filter((c) => c.name === name).map((c) => c.args);
const push = (o: Opened, state: Record<string, unknown>) =>
	o.stub.push({ type: "update", state: { ...UPDATE_STATE, ...state } });

describe.skipIf(!UI)("updates (stub bridge)", () => {
	afterAll(closeBrowser);

	test("a new version: the banner, Update with progress, then the restart", async () => {
		const o = await openApp();
		try {
			await o.page.locator(".row", { hasText: "Call Bob" }).waitFor();
			expect(await banner(o).count()).toBe(0);
			push(o, { available: AVAILABLE, checkedAt: Date.now() });
			await banner(o).getByText("desk-tasks 0.3.0 is available.").waitFor();
			await banner(o).getByRole("button", { name: "What's new" }).click();
			await until(() => called(o, "open_url").some((a) => a[0] === PAGE));
			await banner(o).getByRole("button", { name: "Update" }).click();
			await until(() => called(o, "update_install").length === 1);
			expect(called(o, "update_install")[0]).toEqual(["0.3.0"]);

			push(o, { available: AVAILABLE, phase: "downloading", progress: 0.42 });
			await banner(o)
				.getByText("Downloading desk-tasks 0.3.0 · 42 %")
				.waitFor();
			expect(
				await o.page.getByRole("progressbar").getAttribute("aria-valuenow"),
			).toBe("42");
			push(o, { available: AVAILABLE, phase: "installing", progress: 1 });
			await banner(o).getByText("Restarting to finish the update").waitFor();
			expect(o.errors).toEqual([]);
		} finally {
			await o.close();
		}
	});

	test("Not now hides the banner for that version; a failed update offers Try again", async () => {
		const o = await openApp();
		try {
			await o.page.locator(".row", { hasText: "Call Bob" }).waitFor();
			push(o, { available: AVAILABLE });
			await banner(o).getByRole("button", { name: "Not now" }).click();
			await until(() => called(o, "update_dismiss").length === 1);
			expect(called(o, "update_dismiss")[0]).toEqual(["0.3.0"]);
			push(o, { available: AVAILABLE, dismissed: "0.3.0" });
			await until(async () => (await banner(o).count()) === 0);

			push(o, {
				available: AVAILABLE,
				error: "The download was damaged. Try again.",
			});
			await banner(o).getByText("The download was damaged.").waitFor();
			await banner(o).getByRole("button", { name: "Try again" }).click();
			await until(() => called(o, "update_install").length === 1);
		} finally {
			await o.close();
		}
	});

	test("a copy the installer didn't install gets the release page, not Update", async () => {
		const o = await openApp({
			stub: { update: { canInstall: false, available: AVAILABLE } },
		});
		try {
			await banner(o).getByText("desk-tasks 0.3.0 is available.").waitFor();
			await banner(o).getByRole("button", { name: "Download" }).click();
			await until(() => called(o, "open_url").some((a) => a[0] === PAGE));
			expect(called(o, "update_install")).toEqual([]);
		} finally {
			await o.close();
		}
	});

	test("Settings → Updates: Check now, the result, and the automatic check switch", async () => {
		const o = await openApp({ height: 760 });
		try {
			await o.page.locator(".row", { hasText: "Call Bob" }).waitFor();
			await o.page.click("button[aria-label='More']");
			await o.page.click("[role=menuitem] >> text=Settings");
			const section = o.page.locator(".section", {
				has: o.page.getByRole("heading", { name: "Updates" }),
			});
			await section.getByText("desk-tasks 0.2.0.").waitFor();
			await section.getByRole("button", { name: "Check now" }).click();
			await until(() => called(o, "update_check").length === 1);
			push(o, { checking: true });
			await section.getByText("Checking for updates…").waitFor();
			push(o, { checkedAt: Date.now() });
			await section
				.getByText("desk-tasks 0.2.0 is the latest version.")
				.waitFor();
			push(o, { checkedAt: Date.now(), available: AVAILABLE });
			await section.getByRole("button", { name: "Update to 0.3.0" }).click();
			await until(() => called(o, "update_install").length === 1);

			await section
				.getByRole("switch", { name: /Check for updates automatically/ })
				.click();
			await until(() => o.stub.settings.updateCheck === false);
		} finally {
			await o.close();
		}
	});

	test("after an update: Updated to …, with What's new", async () => {
		const o = await openApp({ stub: { update: { updatedFrom: "0.1.0" } } });
		try {
			const toast = o.page.locator(".toast", {
				hasText: "Updated to desk-tasks 0.2.0.",
			});
			await toast.waitFor();
			await toast.getByRole("button", { name: "What's new" }).click();
			await until(() =>
				called(o, "open_url").some((a) => a[0] === UPDATE_STATE.page),
			);
		} finally {
			await o.close();
		}
	});
});
