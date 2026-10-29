// Opens the built bundle in Chromium with the stub bridge against a seeded fake server.
import { join } from "node:path";
import { type Browser, chromium, type Page } from "playwright-core";
import { FakeCaldav } from "../fake-caldav.ts";
import {
	APP_ORIGIN,
	installStub,
	type Stub,
	type StubOptions,
	serveBundle,
} from "../stub-bridge.ts";
import { NOW, type Seeded, seed, TZ } from "./seed.ts";

export const BUNDLE = join(
	import.meta.dir,
	"..",
	"..",
	"..",
	"src",
	"desk_tasks",
	"web",
);
/** UI tests run with `bun run test:ui` (it builds the bundle first). */
export const UI = process.env.DESK_TASKS_UI === "1";

let browser: Browser | null = null;
export async function getBrowser(): Promise<Browser> {
	browser ??= await chromium.launch();
	return browser;
}
export async function closeBrowser(): Promise<void> {
	await browser?.close();
	browser = null;
}

export interface Opened {
	page: Page;
	fake: FakeCaldav;
	stub: Stub;
	lists: Seeded;
	errors: string[];
	close(): Promise<void>;
}

export async function openApp(
	opts: {
		width?: number;
		height?: number;
		stub?: Partial<StubOptions>;
		scheme?: "light" | "dark";
		/** devicePixelRatio (Windows display scaling). */
		scale?: number;
		seed?: boolean;
		/** Lets a test inject axe-core (the app's CSP refuses inline scripts). */
		bypassCSP?: boolean;
	} = {},
): Promise<Opened> {
	const fake = new FakeCaldav();
	const lists = opts.seed === false ? ({} as Seeded) : seed(fake);
	const b = await getBrowser();
	const ctx = await b.newContext({
		viewport: { width: opts.width ?? 400, height: opts.height ?? 560 },
		colorScheme: opts.scheme ?? "light",
		deviceScaleFactor: opts.scale ?? 1,
		timezoneId: TZ,
		locale: "en-GB",
		bypassCSP: opts.bypassCSP ?? false,
	});
	const page = await ctx.newPage();
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await page.clock.install({ time: NOW });
	await serveBundle(page, BUNDLE);
	const stub = await installStub(page, { server: fake.url, ...opts.stub });
	await page.goto(`${APP_ORIGIN}/index.html`);
	return {
		page,
		fake,
		stub,
		lists,
		errors,
		async close() {
			await ctx.close();
			fake.stop();
		},
	};
}

/** Waits until `f` holds (the server got a write, the page changed). */
export async function until(
	f: () => boolean | Promise<boolean>,
	ms = 5000,
): Promise<void> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await f()) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error("timed out waiting");
}
