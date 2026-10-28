// Renders every view and state, light and dark, 360 and 480 px wide, into .screenshots/
// (gitignored), against a seeded fake CalDAV server and the stub bridge.
// Usage: bun run screenshots [name-filter]
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { FakeCaldav } from "../test/fake-caldav.ts";
import {
	APP_ORIGIN,
	installStub,
	type StubOptions,
	serveBundle,
} from "../test/stub-bridge.ts";
import { NOW, seed, TZ } from "../test/ui/seed.ts";

const root = join(import.meta.dir, "..", "..");
const bundle = join(root, "src", "desk_tasks", "web");
const out = join(root, ".screenshots");
const only = process.argv[2] ?? "";

interface Shot {
	name: string;
	stub?: Partial<StubOptions>;
	/** Before the shot: put the page into the state. */
	run?: (p: Page) => Promise<void>;
	height?: number;
}

const rows = async (p: Page) => {
	await p.waitForSelector(".row", { timeout: 10_000 });
};
const key = async (p: Page, k: string) => {
	await p.keyboard.press(k);
	await p.waitForTimeout(250);
};

const SHOTS: Shot[] = [
	{ name: "today", run: rows },
	{
		name: "today-summoned",
		run: async (p) => {
			await rows(p);
			await p.locator(".row").nth(1).click();
			await p.evaluate(() =>
				document.querySelector(".app")?.classList.add("summoned"),
			);
		},
	},
	{
		name: "upcoming",
		run: async (p) => {
			await rows(p);
			await p.keyboard.press("g");
			await key(p, "u");
		},
	},
	{
		name: "all",
		run: async (p) => {
			await rows(p);
			await p.keyboard.press("g");
			await key(p, "a");
		},
	},
	{
		name: "list-work",
		run: async (p) => {
			await rows(p);
			await key(p, "Control+2");
			await key(p, "Control+4");
		},
	},
	{
		name: "list-view-only",
		run: async (p) => {
			await rows(p);
			await p.click(".switcher-btn");
			await p.fill(".filter-input", "groc");
			await key(p, "Enter");
		},
	},
	{
		name: "switcher",
		run: async (p) => {
			await rows(p);
			await p.click(".switcher-btn");
			await p.waitForTimeout(200);
		},
	},
	{
		name: "quick-add",
		run: async (p) => {
			await rows(p);
			await p.keyboard.press("n");
			await p.keyboard.type("Call the dentist tomorrow 9:30 #health !2 /hom", {
				delay: 5,
			});
			await p.waitForTimeout(250);
		},
	},
	{
		name: "quick-add-error",
		run: async (p) => {
			await rows(p);
			await p.keyboard.press("n");
			await p.keyboard.type("Buy stamps /wrk", { delay: 5 });
			await key(p, "Enter");
		},
	},
	{
		name: "detail",
		run: async (p) => {
			await rows(p);
			await p.locator(".row", { hasText: "Call Bob" }).click();
			await key(p, "Enter");
		},
	},
	{
		name: "date-popover",
		run: async (p) => {
			await rows(p);
			await p.locator(".row", { hasText: "Call Bob" }).click();
			await key(p, "d");
		},
	},
	{
		name: "selection",
		run: async (p) => {
			await rows(p);
			await p.locator(".row").nth(0).click();
			await p.keyboard.press("x");
			await p.keyboard.press("Shift+ArrowDown");
			await key(p, "Shift+ArrowDown");
		},
	},
	{
		name: "settings",
		height: 900,
		run: async (p) => {
			await rows(p);
			await p.click("button[aria-label='More']");
			await p.click("text=Settings");
			await p.waitForTimeout(250);
		},
	},
	{
		name: "shortcuts",
		height: 900,
		run: async (p) => {
			await rows(p);
			await key(p, "?");
		},
	},
	{
		name: "list-settings",
		height: 760,
		run: async (p) => {
			await rows(p);
			await key(p, "Control+4");
			await p.click("button[aria-label='More']");
			await p.click("text=List settings…");
			await p.waitForTimeout(250);
		},
	},
	{
		name: "offline",
		stub: {
			dav: async () => ({
				ok: false,
				kind: "connect",
				message: "Couldn't connect to Nextcloud.",
			}),
		},
		run: async (p) => {
			await p.waitForSelector(".banner, .empty", { timeout: 10_000 });
			await p.waitForTimeout(400);
		},
	},
	{
		name: "paused",
		stub: {
			settings: {
				paused: {
					reason: "A change to “Pay rent” couldn't be confirmed.",
					at: NOW.getTime() - 600_000,
				},
			},
		},
		run: rows,
	},
	{ name: "first-run", stub: { server: null } },
	{
		name: "welcome",
		stub: { settings: { firstRunDone: false } },
		run: async (p) => {
			await p.waitForSelector(".sheet .switch", { timeout: 10_000 });
		},
	},
	{
		name: "today-empty",
		stub: { dav: undefined },
		run: async (p) => {
			await rows(p);
			await key(p, "Control+f");
			await p.keyboard.type("#nothing");
			await key(p, "Enter");
		},
	},
	{
		name: "trash",
		run: async (p) => {
			await rows(p);
			await p.click(".switcher-btn");
			await p.fill(".filter-input", "trash");
			await key(p, "Enter");
			await p.waitForTimeout(400);
		},
	},
];

await mkdir(out, { recursive: true });
const browser = await chromium.launch();
let n = 0;
try {
	for (const shot of SHOTS.filter((s) => s.name.includes(only))) {
		for (const scheme of ["light", "dark"] as const)
			for (const width of [360, 480]) {
				const fake = new FakeCaldav();
				seed(fake);
				const ctx = await browser.newContext({
					viewport: { width, height: shot.height ?? 560 },
					colorScheme: scheme,
					timezoneId: TZ,
					locale: "en-GB",
					reducedMotion: "reduce",
				});
				const page = await ctx.newPage();
				const errors: string[] = [];
				page.on("pageerror", (e) => errors.push(e.message));
				page.on(
					"console",
					(m) => m.type() === "error" && errors.push(m.text()),
				);
				await page.clock.install({ time: NOW });
				await serveBundle(page, bundle);
				await installStub(page, { server: fake.url, ...shot.stub });
				await page.goto(`${APP_ORIGIN}/index.html`);
				try {
					if (shot.run) await shot.run(page);
					else await page.waitForTimeout(800);
				} catch (err) {
					errors.push(`state: ${(err as Error).message}`);
				}
				await page.waitForTimeout(150);
				const file = join(out, `${shot.name}-${scheme}-${width}.png`);
				await page.screenshot({ path: file });
				if (errors.length)
					console.error(
						`${shot.name} ${scheme} ${width}: ${errors.join(" | ")}`,
					);
				n++;
				await ctx.close();
				fake.stop();
			}
	}
} finally {
	await browser.close();
}
console.log(`${n} screenshots in ${out}`);
