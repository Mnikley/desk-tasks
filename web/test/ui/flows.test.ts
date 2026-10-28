// The UI against the fake server, end to end: what a click or key writes to Nextcloud.
// Run with `bun run test:ui` (builds the bundle, sets DESK_TASKS_UI=1).
import { afterAll, describe, expect, test } from "bun:test";
import { closeBrowser, type Opened, openApp, UI, until } from "./harness.ts";

const row = (o: Opened, text: string) =>
	o.page.locator(".row", { hasText: text });
const server = (o: Opened, href: string) => o.fake.get(href) ?? "";

describe.skipIf(!UI)("UI flows (fake server)", () => {
	afterAll(closeBrowser);

	test("quick add highlights its tokens and creates the task with them", async () => {
		const o = await openApp();
		try {
			await row(o, "Call Bob").waitFor();
			await o.page.keyboard.press("n");
			await o.page.keyboard.type("Renew passport tomorrow #admin !1 /home");
			await expect(
				o.page.locator(".mirror mark").allInnerTexts(),
			).resolves.toEqual(["tomorrow", "#admin", "!1", "/home"]);
			await o.page.keyboard.press("Enter");
			await until(() =>
				[
					...(o.fake.collections.get(o.lists.home)?.objects.values() ?? []),
				].some((t) => t.includes("SUMMARY:Renew passport")),
			);
			const ics =
				[
					...(o.fake.collections.get(o.lists.home)?.objects.values() ?? []),
				].find((t) => t.includes("Renew passport")) ?? "";
			expect(ics).toContain("DUE;VALUE=DATE:20261029");
			expect(ics).toContain("CATEGORIES:admin");
			expect(ics).toContain("PRIORITY:1");
			// The field clears once Nextcloud's copy is read back.
			await until(
				async () =>
					(await o.page.locator(".quick-field input").inputValue()) === "",
			);
			expect(o.errors).toEqual([]);
		} finally {
			await o.close();
		}
	});

	test("quick add says what is wrong inline, never as a toast", async () => {
		const o = await openApp();
		try {
			await row(o, "Call Bob").waitFor();
			await o.page.keyboard.press("n");
			await o.page.keyboard.type("Buy stamps /wrk");
			await expect(o.page.locator(".quick-error").textContent()).resolves.toBe(
				"No list “wrk”. Did you mean Work?",
			);
			await o.page.locator(".quick-field input").fill("Coffee /groceries");
			await expect(o.page.locator(".quick-error").textContent()).resolves.toBe(
				"“Groceries” is view only. Pick another list with /.",
			);
			await o.page.keyboard.press("Enter");
			expect(await o.page.locator(".toast").count()).toBe(0);
		} finally {
			await o.close();
		}
	});

	test("ticking lingers, then completes in Nextcloud; Undo reopens it", async () => {
		const o = await openApp();
		try {
			const href = `${o.lists.work}call.ics`;
			await row(o, "Call Bob").locator(".check").click();
			await expect(row(o, "Call Bob").getAttribute("class")).resolves.toContain(
				"lingering",
			);
			expect(server(o, href)).not.toContain("STATUS:COMPLETED"); // not yet: the linger is the undo window
			await until(() => server(o, href).includes("STATUS:COMPLETED"));
			await o.page
				.locator(".toast", { hasText: "Completed “Call Bob about the venue”" })
				.waitFor();
			await o.page.locator(".toast button", { hasText: "Undo" }).click();
			await until(() => !server(o, href).includes("STATUS:COMPLETED"));
			await row(o, "Call Bob").waitFor();
		} finally {
			await o.close();
		}
	});

	test("unticking within the linger writes nothing", async () => {
		const o = await openApp();
		try {
			const href = `${o.lists.work}call.ics`;
			const before = server(o, href);
			await row(o, "Call Bob").locator(".check").click();
			await row(o, "Call Bob").locator(".check").click();
			await o.page.waitForTimeout(2000);
			expect(server(o, href)).toBe(before);
		} finally {
			await o.close();
		}
	});

	test("a view-only task explains itself and isn't written", async () => {
		const o = await openApp();
		try {
			const href = `${o.lists.groceries}oat.ics`;
			const before = server(o, href);
			await row(o, "Oat milk").locator(".check").click({ force: true });
			await o.page.locator(".toast", { hasText: "view only" }).waitFor();
			await o.page.waitForTimeout(1800);
			expect(server(o, href)).toBe(before);
		} finally {
			await o.close();
		}
	});

	test("keyboard: j/k move, Alt+→ nests under the task above (in a list), Delete asks then deletes", async () => {
		const o = await openApp();
		try {
			await row(o, "Call Bob").waitFor();
			await o.page.keyboard.press("Control+4"); // Work
			await row(o, "Ideas for 2027").click();
			await o.page.keyboard.press("k");
			await expect(
				o.page.locator(".row.hl .title").textContent(),
			).resolves.toBe("Book flights for the offsite");
			await o.page.keyboard.press("j");
			await o.page.keyboard.press("Alt+ArrowRight");
			await until(() =>
				server(o, `${o.lists.work}ideas.ics`).includes("RELATED-TO:flights"),
			);
			await o.page.keyboard.press("Delete");
			await o.page
				.locator("[role=alertdialog]", { hasText: "Delete “Ideas for 2027”?" })
				.waitFor();
			await o.page.keyboard.press("Enter");
			await until(() => o.fake.get(`${o.lists.work}ideas.ics`) === undefined);
		} finally {
			await o.close();
		}
	});

	test("no connection: the banner says so, the cache stays", async () => {
		let fail = false;
		const o = await openApp({
			stub: {
				dav: async (req, real) =>
					fail
						? { ok: false, kind: "connect", message: "Couldn't connect." }
						: real(req),
			},
		});
		try {
			await row(o, "Call Bob").waitFor();
			fail = true;
			await o.page.keyboard.press("F5");
			await o.page.locator(".banner", { hasText: "Can't reach" }).waitFor();
			expect(await row(o, "Call Bob").count()).toBe(1);
		} finally {
			await o.close();
		}
	});
});
