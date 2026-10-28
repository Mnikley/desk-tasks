// More UI flows: the date popover's keys, bulk changes as one undo, lists and sharing,
// the conflict dialog, and a keyboard-only pass with an axe-core scan.
import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { closeBrowser, type Opened, openApp, UI, until } from "./harness.ts";

const row = (o: Opened, text: string) =>
	o.page.locator(".row", { hasText: text });
const server = (o: Opened, href: string) => o.fake.get(href) ?? "";
const press = async (o: Opened, ...keys: string[]) => {
	for (const k of keys) await o.page.keyboard.press(k);
};

describe.skipIf(!UI)("more UI flows (fake server)", () => {
	afterAll(closeBrowser);

	test("d then m: due tomorrow, keeping the time", async () => {
		const o = await openApp();
		try {
			await row(o, "Call Bob").click();
			await press(o, "d");
			await o.page.locator("[role=dialog][aria-label='Due date']").waitFor();
			await press(o, "m");
			await until(() =>
				server(o, `${o.lists.work}call.ics`).includes("DUE:20261029T140000"),
			);
			// Its reminder hangs on the due date, so it moved with it, untouched.
			expect(server(o, `${o.lists.work}call.ics`)).toContain(
				"TRIGGER;RELATED=END:-PT15M",
			);
		} finally {
			await o.close();
		}
	});

	test("typing a date in words in the popover", async () => {
		const o = await openApp();
		try {
			await row(o, "Fix the bike light").click();
			await press(o, "d");
			await o.page.keyboard.type("30.11.");
			await press(o, "Enter");
			await until(() =>
				server(o, `${o.lists.home}bike.ics`).includes(
					"DUE;VALUE=DATE:20261130",
				),
			);
		} finally {
			await o.close();
		}
	});

	test("bulk: select three, priority 1 for all, one Undo takes all three back", async () => {
		const o = await openApp();
		try {
			await row(o, "Prepare quarterly report").click();
			await press(o, "x", "Shift+ArrowDown", "Shift+ArrowDown");
			await o.page.locator(".bulk", { hasText: "3" }).waitFor();
			await press(o, "1");
			const hrefs = ["report", "call", "bike"].map(
				(u) => `${u === "bike" ? o.lists.home : o.lists.work}${u}.ics`,
			);
			await until(() =>
				hrefs.every((h) => server(o, h).includes("PRIORITY:1")),
			);
			await press(o, "z");
			await until(() =>
				hrefs.every((h) => !server(o, h).includes("PRIORITY:1")),
			);
			expect(server(o, hrefs[0] as string)).toContain("PRIORITY:5");
		} finally {
			await o.close();
		}
	});

	test("lists: create one, rename it, share it with Alice (view only), make it editable", async () => {
		const o = await openApp({ height: 760 });
		try {
			await row(o, "Call Bob").waitFor();
			await press(o, "Control+k");
			await o.page.keyboard.type("new list");
			await press(o, "Enter");
			await o.page.locator("#nl-name").fill("Garden");
			await press(o, "Enter");
			await until(() =>
				[...o.fake.collections.values()].some((c) => c.name === "Garden"),
			);
			const href = [...o.fake.collections].find(
				([, c]) => c.name === "Garden",
			)?.[0] as string;
			expect(href).toMatch(/\/garden-[a-z0-9]{6}\/$/);
			expect(o.fake.collections.get(href)?.components).toEqual(["VTODO"]);
			await o.page
				.locator(".app .switcher-btn .name", { hasText: "Garden" })
				.waitFor();
			await o.page.click("button[aria-label='More']");
			await o.page.click("text=List settings…");
			await o.page.locator("#ls-name").fill("Yard");
			await press(o, "Enter");
			await until(() => o.fake.collections.get(href)?.name === "Yard");
			await o.page
				.locator("input[aria-label='Add people or groups to share with']")
				.fill("ali");
			await o.page.locator("[role=option]", { hasText: "Alice" }).click();
			await until(() =>
				(o.fake.collections.get(href)?.invite ?? "").includes(
					"principals/users/alice",
				),
			);
			expect(o.fake.collections.get(href)?.invite).toContain("<o:read/>");
			await o.page
				.locator("select[aria-label='Access for Alice']")
				.selectOption("read-write");
			await until(() =>
				(o.fake.collections.get(href)?.invite ?? "").includes(
					"<o:read-write/>",
				),
			);
		} finally {
			await o.close();
		}
	});

	test("changed on another device: the conflict dialog shows both sides, nothing is overwritten", async () => {
		const o = await openApp();
		try {
			const href = `${o.lists.work}call.ics`;
			await row(o, "Call Bob").click();
			await press(o, "Enter");
			const title = o.page.locator("textarea[aria-label='Title']");
			await title.fill("Call Bob about the hall");
			o.fake.edit(href, (t) =>
				t.replace(
					"SUMMARY:Call Bob about the venue",
					"SUMMARY:Call Bob and Ann",
				),
			);
			await press(o, "Control+Enter");
			await o.page
				.locator(".sheet[aria-label='Changed on another device']")
				.waitFor();
			await expect(
				o.page.locator(".sheet").last().textContent(),
			).resolves.toContain("Call Bob about the hall");
			await expect(
				o.page.locator(".sheet").last().textContent(),
			).resolves.toContain("Call Bob and Ann");
			expect(server(o, href)).toContain("SUMMARY:Call Bob and Ann");
		} finally {
			await o.close();
		}
	});

	test("keyboard only: add, open, edit, save, complete; axe finds nothing serious", async () => {
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
				// Popovers and toasts fade in; axe would measure them half transparent.
				await o.page.waitForTimeout(400);
				const r = (await o.page.evaluate(async () =>
					(
						await (
							window as unknown as {
								axe: {
									run: (o: unknown) => Promise<{
										violations: {
											id: string;
											impact: string;
											nodes: unknown[];
										}[];
									}>;
								};
							}
						).axe.run({
							resultTypes: ["violations"],
						})
					).violations
						.filter((v) => v.impact === "serious" || v.impact === "critical")
						.map(
							(v) =>
								`${v.id}: ${(v.nodes as { target: string[] }[]).map((n) => n.target.join(" ")).join(", ")}`,
						),
				)) as string[];
				expect({ where, violations: r }).toEqual({ where, violations: [] });
			};
			await scan("today");
			await press(o, "n");
			await o.page.keyboard.type("Write the minutes");
			await press(o, "Enter");
			await until(
				async () => (await row(o, "Write the minutes").count()) === 1,
			);
			// The new task is highlighted; Enter opens it, Ctrl+Enter saves the title.
			await press(o, "Escape"); // leave quick add
			await o.page
				.locator(".row.hl", { hasText: "Write the minutes" })
				.waitFor();
			await o.page.locator(".row.hl").focus();
			await press(o, "Enter");
			await o.page.locator(".sheet").waitFor();
			await scan("detail sheet");
			await o.page.keyboard.press("End");
			await o.page.keyboard.type(" for Tuesday");
			await press(o, "Control+Enter");
			await row(o, "Write the minutes for Tuesday").waitFor();
			await press(o, "e");
			await until(() =>
				[
					...(o.fake.collections.get(o.lists.home)?.objects.values() ?? []),
					...(o.fake.collections.get(o.lists.work)?.objects.values() ?? []),
				].some(
					(t) =>
						t.includes("SUMMARY:Write the minutes for Tuesday") &&
						t.includes("STATUS:COMPLETED"),
				),
			);
			await press(o, "?");
			await o.page.locator(".sheet[aria-label='Keyboard shortcuts']").waitFor();
			await scan("shortcuts");
			await press(o, "Escape");
			await press(o, "Control+k");
			await scan("palette");
		} finally {
			await o.close();
		}
	});
});
