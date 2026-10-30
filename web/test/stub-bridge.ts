// The Python bridge, stubbed for the UI tests and screenshots: the page gets the same
// `window.pywebview.api` calls; each one goes to Node through one Playwright binding. dav()
// is forwarded to the fake CalDAV server (or Docker Nextcloud) by the test transport, with the
// same rules as the real bridge; shell events are queued by the test.
import type { Page } from "playwright-core";
import type { DavRequest, DavResult } from "../src/core/transport.ts";
import { fetchTransport } from "./transport.ts";

export const APP_ORIGIN = "https://app.desk-tasks.example";

export const CALLS = [
	"dav",
	"connect_start",
	"connect_poll",
	"connect_manual",
	"disconnect",
	"next_event",
	"notify",
	"tray",
	"window",
	"settings_get",
	"settings_set",
	"open_url",
	"log",
	"update_get",
	"update_check",
	"update_install",
	"update_dismiss",
] as const;

export const DEFAULT_SETTINGS = {
	hotkeySummon: { win: true, alt: true, ctrl: false, shift: false, key: "J" },
	hotkeyQuickAdd: { win: true, alt: true, ctrl: false, shift: false, key: "N" },
	singleKeyShortcuts: true,
	autostart: false,
	startView: "today",
	geometry: null,
	readOnly: false,
	paused: null,
	notifications: true,
	dueTimeToasts: true,
	missedSummary: true,
	notificationsPausedUntil: null,
	lists: {},
	defaultList: null,
	density: "comfortable",
	firstRunDone: true,
	updateCheck: true,
};

/** What update_get answers by default: up to date, never checked. */
export const UPDATE_STATE = {
	current: "0.2.0",
	canInstall: true,
	checking: false,
	checkedAt: null,
	available: null,
	dismissed: null,
	phase: "idle",
	progress: 0,
	error: null,
	updatedFrom: null,
	page: "https://github.com/Mnikley/desk-tasks/releases/tag/v0.2.0",
};

export interface StubOptions {
	/** The fake server or Docker Nextcloud; null: not connected (first run). */
	server: string | null;
	user?: string;
	password?: string;
	settings?: Record<string, unknown>;
	/** update_get's state (merged into UPDATE_STATE). */
	update?: Record<string, unknown>;
	/** Replaces dav() (offline, failures). */
	dav?: (
		req: DavRequest,
		real: (r: DavRequest) => Promise<DavResult>,
	) => Promise<DavResult>;
}

export interface Stub {
	/** Calls the page made, by name (dav excluded). */
	calls: { name: string; args: unknown[] }[];
	settings: Record<string, unknown>;
	/** Queues a shell event for the page's next_event long-poll. */
	push(event: Record<string, unknown>): void;
	connected: boolean;
	update: Record<string, unknown>;
}

export async function installStub(
	page: Page,
	opts: StubOptions,
): Promise<Stub> {
	const send = fetchTransport({
		user: opts.user ?? "u",
		password: opts.password ?? "app-password",
	});
	const queue: Record<string, unknown>[] = [];
	let wake: (() => void) | null = null;
	const stub: Stub = {
		calls: [],
		settings: {
			...DEFAULT_SETTINGS,
			...(opts.server ? { server: opts.server, user: opts.user ?? "u" } : {}),
			...opts.settings,
		},
		push(e) {
			queue.push(e);
			wake?.();
		},
		connected: opts.server !== null,
		update: { ...UPDATE_STATE, ...opts.update },
	};
	let login: "idle" | "pending" | "done" = "idle";
	await page.exposeBinding(
		"__stubCall",
		async (_src, name: string, args: unknown[]) => {
			if (name !== "dav" && name !== "next_event")
				stub.calls.push({ name, args });
			switch (name) {
				case "dav": {
					const req = args[0] as DavRequest;
					return opts.dav ? opts.dav(req, send) : send(req);
				}
				case "settings_get":
					return { ...stub.settings, connected: stub.connected };
				case "settings_set":
					Object.assign(stub.settings, args[0]);
					return {
						ok: true,
						settings: { ...stub.settings, connected: stub.connected },
					};
				case "next_event": {
					if (!queue.length)
						await new Promise<void>((r) => {
							wake = r;
							setTimeout(r, Math.min(Number(args[0]) || 0, 2) * 1000);
						});
					wake = null;
					return queue.shift() ?? null;
				}
				case "connect_start":
					login = "pending";
					return {
						state: "pending",
						login: `${args[0]}/index.php/login/v2/flow/x`,
					};
				case "connect_poll":
					return login === "pending"
						? { state: "pending", login: "x" }
						: { state: login };
				case "connect_manual":
					return {
						state: "failed",
						reason: "rejected",
						message: "Nextcloud rejected the app password.",
					};
				case "disconnect":
					stub.connected = false;
					return { ok: true, revoked: true };
				case "window":
					return { ok: true, value: null };
				case "update_get":
					return { ok: true, state: stub.update };
				default:
					return { ok: true };
			}
		},
	);
	await page.addInitScript(
		({ calls }) => {
			const api: Record<string, (...a: unknown[]) => Promise<unknown>> = {};
			for (const c of calls)
				api[c] = (...a: unknown[]) =>
					(
						window as unknown as {
							__stubCall: (n: string, a: unknown[]) => Promise<unknown>;
						}
					).__stubCall(c, a);
			(window as unknown as { pywebview: unknown }).pywebview = { api };
		},
		{ calls: [...CALLS] },
	);
	return stub;
}

/** Serves the built bundle at the app's origin (as the WebView2 virtual host does). */
export async function serveBundle(page: Page, dir: string): Promise<void> {
	await page.route(`${APP_ORIGIN}/**`, async (route) => {
		const path =
			new URL(route.request().url()).pathname.replace(/^\/+/, "") ||
			"index.html";
		const file = Bun.file(`${dir}/${path}`);
		if (!(await file.exists())) return route.fulfill({ status: 404, body: "" });
		const type = path.endsWith(".js")
			? "text/javascript"
			: path.endsWith(".css")
				? "text/css"
				: "text/html";
		return route.fulfill({
			status: 200,
			body: Buffer.from(await file.arrayBuffer()),
			contentType: `${type}; charset=utf-8`,
		});
	});
}
