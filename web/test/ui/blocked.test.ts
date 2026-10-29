// While saving is off (paused, read-only switch, offline) every editing control says so:
// the task sheet's fields, its chips and subtasks, and the multi-select bar.
import { afterAll, describe, expect, test } from "bun:test";
import { closeBrowser, openApp, UI } from "./harness.ts";
import { NOW } from "./seed.ts";

describe.skipIf(!UI)("saving off", () => {
	afterAll(closeBrowser);

	test("paused: the task sheet and the bulk bar are read-only, with the reason", async () => {
		const o = await openApp({
			stub: {
				settings: {
					paused: {
						reason: "A change couldn't be confirmed.",
						at: NOW.getTime() - 600_000,
					},
				},
			},
		});
		try {
			const row = o.page.locator(".row", { hasText: "Call Bob" });
			await row.click();
			await o.page.keyboard.press("Enter");
			const title = o.page.locator(".sheet textarea[aria-label='Title']");
			await title.waitFor();
			expect(await title.getAttribute("readonly")).not.toBeNull();
			await o.page
				.locator(".sheet", { hasText: "Saving to Nextcloud is paused" })
				.waitFor();
			expect(
				await o.page
					.locator(".sheet button.chip[title^='Move to list']")
					.isDisabled(),
			).toBe(true);
			await o.page.keyboard.press("Escape");
			await row.click();
			await o.page.keyboard.press("x");
			const done = o.page.locator(".bulk button", { hasText: "Done" });
			await done.waitFor();
			expect(await done.isDisabled()).toBe(true);
			expect(await done.getAttribute("title")).toContain("paused");
		} finally {
			await o.close();
		}
	});
});
