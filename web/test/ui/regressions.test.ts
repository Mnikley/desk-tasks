// Regressions from the UI reviews: each test failed before its fix.
import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { closeBrowser, type Opened, openApp, UI, until } from "./harness.ts";

const row = (o: Opened, text: string) =>
	o.page.locator(".row", { hasText: text });
const server = (o: Opened, href: string) => o.fake.get(href) ?? "";
const putCount = (o: Opened, href: string) =>
	o.fake.log.filter((l) => l === `PUT ${href}`).length;

describe.skipIf(!UI)("UI review regressions", () => {
	afterAll(closeBrowser);

	test("ticking a repeating task, then Esc at once: it advances one occurrence, not two", async () => {
		const o = await openApp();
		try {
			const href = `${o.lists.work}plants.ics`;
			await row(o, "Call Bob").waitFor();
			await o.page.keyboard.press("g");
			await o.page.keyboard.press("u");
			await row(o, "Water the office plants").locator(".check").click();
			await o.page.keyboard.press("Escape"); // dismiss flushes the linger…
			await o.page.waitForTimeout(2500); // …and the linger timer fires too
			await until(() => server(o, href).includes("DUE;VALUE=DATE:20261106"));
			expect(server(o, href)).not.toContain("20261113");
			expect(putCount(o, href)).toBe(1);
		} finally {
			await o.close();
		}
	});

	test("after Enter, quick add keeps focus: the next keys type, they don't act on the new task", async () => {
		const o = await openApp();
		try {
			await row(o, "Call Bob").waitFor();
			await o.page.keyboard.press("n");
			await o.page.keyboard.type("Water the garden");
			await o.page.keyboard.press("Enter");
			await o.page.keyboard.type("2");
			await until(async () => (await row(o, "Water the garden").count()) === 1);
			await until(async () =>
				(await o.page.locator(".quick-field input").inputValue()).endsWith("2"),
			);
			const ics =
				[
					...(o.fake.collections.get(o.lists.work)?.objects.values() ?? []),
				].find((t) => t.includes("Water the garden")) ?? "";
			expect(ics).not.toContain("PRIORITY");
		} finally {
			await o.close();
		}
	});

	test("Esc in an inline rename cancels it", async () => {
		const o = await openApp();
		try {
			const href = `${o.lists.work}call.ics`;
			await row(o, "Call Bob").click();
			await o.page.keyboard.press("F2");
			await o.page.keyboard.type("Something else");
			await o.page.keyboard.press("Escape");
			await o.page.waitForTimeout(800);
			expect(server(o, href)).toContain("SUMMARY:Call Bob about the venue");
			expect(putCount(o, href)).toBe(0);
		} finally {
			await o.close();
		}
	});

	test("going offline while editing keeps the sheet and the edit (read-only) until it can save", async () => {
		let offline = false;
		const o = await openApp({
			stub: {
				dav: async (req, send) =>
					offline
						? { ok: false, kind: "connect", message: "Couldn't connect." }
						: send(req),
			},
		});
		try {
			const href = `${o.lists.work}call.ics`;
			await row(o, "Call Bob").click();
			await o.page.keyboard.press("Enter");
			const title = o.page.locator("textarea[aria-label='Title']");
			await title.fill("Call Bob about the hall");
			offline = true;
			await o.page.context().setOffline(true);
			o.stub.push({ type: "sync-now" });
			await o.page.locator(".sheet", { hasText: "Offline" }).waitFor();
			expect(await title.inputValue()).toBe("Call Bob about the hall");
			expect(await title.getAttribute("readonly")).not.toBeNull();
			expect(await o.page.locator(".sheet[aria-label='Task']").count()).toBe(1);
			offline = false;
			await o.page.context().setOffline(false);
			o.stub.push({ type: "sync-now" });
			await until(async () => (await title.getAttribute("readonly")) === null);
			await title.focus();
			await o.page.keyboard.press("Control+Enter");
			await until(() =>
				server(o, href).includes("SUMMARY:Call Bob about the hall"),
			);
		} finally {
			await o.close();
		}
	});

	test("with single-key shortcuts off, z does nothing and Ctrl+Z still undoes", async () => {
		const o = await openApp({
			stub: { settings: { singleKeyShortcuts: false } },
		});
		try {
			const href = `${o.lists.work}call.ics`;
			await row(o, "Call Bob").locator(".check").click();
			await until(() => server(o, href).includes("STATUS:COMPLETED"));
			await o.page.locator("body").press("z");
			await o.page.waitForTimeout(800);
			expect(server(o, href)).toContain("STATUS:COMPLETED");
			await o.page.locator("body").press("Control+z");
			await until(() => !server(o, href).includes("STATUS:COMPLETED"));
		} finally {
			await o.close();
		}
	});

	test("Space on a focused button is the button's, not 'complete the highlighted task'", async () => {
		const o = await openApp();
		try {
			await row(o, "Call Bob").click();
			await o.page.focus("button[aria-label='More']");
			await o.page.keyboard.press(" ");
			await o.page.locator("[role=menu]").waitFor();
			expect(await row(o, "Call Bob").getAttribute("class")).not.toContain(
				"lingering",
			);
		} finally {
			await o.close();
		}
	});

	test("the confirmation keeps Tab inside, Esc closes it, focus returns to the row", async () => {
		const o = await openApp();
		try {
			await row(o, "Call Bob").click();
			await o.page.keyboard.press("Delete");
			const dialog = o.page.locator("[role=alertdialog]");
			await dialog.waitFor();
			for (let i = 0; i < 4; i++) {
				await o.page.keyboard.press("Tab");
				expect(
					await o.page.evaluate(
						() => !!document.activeElement?.closest("[role=alertdialog]"),
					),
				).toBe(true);
			}
			await o.page.keyboard.press("Escape");
			await until(async () => (await dialog.count()) === 0);
			expect(
				await o.page.evaluate(
					() => document.activeElement?.closest(".row")?.textContent ?? "",
				),
			).toContain("Call Bob");
		} finally {
			await o.close();
		}
	});

	test("axe: All, Upcoming, the date popover, the palette and the overflow menu", async () => {
		const o = await openApp({ bypassCSP: true, height: 700 });
		try {
			await row(o, "Call Bob").waitFor();
			await o.page.addScriptTag({
				path: join(
					import.meta.dir,
					"..",
					"..",
					"..",
					"node_modules",
					"axe-core",
					"axe.min.js",
				),
			});
			const scan = async (where: string) => {
				await o.page.waitForTimeout(400);
				const r = (await o.page.evaluate(async () => {
					const axe = (
						window as unknown as {
							axe: {
								run: (o: unknown) => Promise<{
									violations: {
										id: string;
										impact: string;
										nodes: { target: string[] }[];
									}[];
								}>;
							};
						}
					).axe;
					const res = await axe.run({ resultTypes: ["violations"] });
					return res.violations
						.filter((v) => v.impact === "serious" || v.impact === "critical")
						.map(
							(v) =>
								`${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
						);
				})) as string[];
				expect({ where, violations: r }).toEqual({ where, violations: [] });
			};
			await o.page.keyboard.press("g");
			await o.page.keyboard.press("a");
			await row(o, "Frontend").waitFor();
			await scan("all");
			await o.page.keyboard.press("g");
			await o.page.keyboard.press("u");
			await row(o, "Pay rent").waitFor();
			await scan("upcoming");
			await row(o, "Pay rent").click();
			await o.page.keyboard.press("d");
			await scan("date popover");
			await o.page.keyboard.press("Escape");
			await o.page.keyboard.press("#");
			await scan("tags popover");
			await o.page.keyboard.press("Escape");
			await o.page.keyboard.press("Control+k");
			await scan("palette");
			await o.page.keyboard.press("Escape");
			await o.page.click("button[aria-label='More']");
			await scan("overflow menu");
		} finally {
			await o.close();
		}
	});
});
