// The Python bridge (src/desk_tasks/bridge.py) as typed calls. pywebview injects
// `window.pywebview.api` with one async function per call; every answer is validated here, so a
// malformed one is a failure the core understands, never an exception in the UI. A dav() answer
// that can't be read counts as `network`: after a write its outcome is unknown and writes pause.
import { z } from "zod";
import type { DavRequest, DavResult, Send } from "./core/transport.ts";

const headers = z.record(z.string(), z.string());

const davResult = z.union([
	z.object({
		ok: z.literal(true),
		status: z.number().int(),
		headers,
		body: z.string(),
		notUtf8: z.boolean(),
	}),
	z.object({
		ok: z.literal(false),
		kind: z.literal("too-large"),
		status: z.number().int(),
		headers,
		message: z.string(),
	}),
	z.object({
		ok: z.literal(false),
		kind: z.enum(["connect", "network", "timeout", "refused"]),
		message: z.string(),
	}),
]);

const hotkey = z.object({
	win: z.boolean(),
	alt: z.boolean(),
	ctrl: z.boolean(),
	shift: z.boolean(),
	key: z.string(),
});

const settings = z.object({
	server: z.string().optional(),
	user: z.string().optional(),
	principal: z.string().optional(),
	connected: z.boolean(),
	hotkeySummon: hotkey,
	hotkeyQuickAdd: hotkey,
	singleKeyShortcuts: z.boolean(),
	autostart: z.boolean(),
	startView: z.string(),
	geometry: z.record(z.string(), z.unknown()).nullable(),
	readOnly: z.boolean(),
	paused: z.object({ reason: z.string(), at: z.number() }).nullable(),
	notifications: z.boolean(),
	dueTimeToasts: z.boolean(),
	missedSummary: z.boolean(),
	notificationsPausedUntil: z.number().nullable(),
	lists: z.record(z.string(), z.record(z.string(), z.boolean())),
	defaultList: z.string().nullable(),
	density: z.enum(["comfortable", "compact"]),
	firstRunDone: z.boolean(),
});
export type Settings = z.infer<typeof settings>;
export type Hotkey = z.infer<typeof hotkey>;
/** What settings_set accepts: everything but the connection (set by logging in). */
export type SettingsPatch = Partial<
	Omit<Settings, "server" | "user" | "principal" | "connected">
>;

const loginState = z.discriminatedUnion("state", [
	z.object({ state: z.literal("idle") }),
	z.object({ state: z.literal("pending"), login: z.string() }),
	z.object({ state: z.literal("done"), server: z.string(), user: z.string() }),
	z.object({
		state: z.literal("failed"),
		reason: z.enum([
			"address",
			"unreachable",
			"not-nextcloud",
			"redirect",
			"mismatch",
			"expired",
			"rejected",
			"vault",
			"cancelled",
		]),
		message: z.string(),
	}),
]);
export type LoginState = z.infer<typeof loginState>;

const summonTarget = z.union([
	z.enum(["list", "quick-add", "settings"]),
	z.object({ task: z.string() }),
]);

const shellEvent = z.discriminatedUnion("type", [
	z.object({ type: z.literal("summoned"), target: summonTarget }),
	z.object({ type: z.literal("dismissed") }),
	z.object({ type: z.literal("theme"), dark: z.boolean() }),
	z.object({ type: z.literal("resumed") }),
	z.object({ type: z.literal("network") }),
	z.object({ type: z.literal("tick") }),
	z.object({ type: z.literal("sync-now") }),
	z.object({
		type: z.literal("toast-action"),
		action: z.enum([
			"done",
			"snooze-15m",
			"snooze-1h",
			"snooze-tomorrow",
			"open",
		]),
		href: z.string(),
	}),
	z.object({ type: z.literal("hotkey-failed"), combo: z.string() }),
	z.object({ type: z.literal("quit") }),
]);
export type ShellEvent = z.infer<typeof shellEvent>;

const okOrMessage = z.union([
	z.object({ ok: z.literal(true) }).loose(),
	z.object({ ok: z.literal(false), message: z.string() }),
]);

export interface Toast {
	title: string;
	body: string;
	href?: string;
	actions?: ("done" | "snooze")[];
}

export type WindowCmd =
	| { cmd: "dismiss" | "geometry" | "quit" }
	| { cmd: "move"; dx: number; dy: number }
	| { cmd: "resize"; w: number; h: number };

/** The functions pywebview injects (one per call in bridge.py's CALLS). */
export interface PyApi {
	dav(req: DavRequest): Promise<unknown>;
	connect_start(url: string): Promise<unknown>;
	connect_poll(): Promise<unknown>;
	connect_manual(
		url: string,
		user: string,
		appPassword: string,
	): Promise<unknown>;
	disconnect(): Promise<unknown>;
	next_event(timeoutS: number): Promise<unknown>;
	notify(toast: Toast): Promise<unknown>;
	tray(status: { tooltip: string; dueToday: number }): Promise<unknown>;
	window(cmd: WindowCmd): Promise<unknown>;
	settings_get(): Promise<unknown>;
	settings_set(patch: SettingsPatch): Promise<unknown>;
	open_url(url: string): Promise<unknown>;
	log(
		level: "debug" | "info" | "warn" | "error",
		msg: string,
	): Promise<unknown>;
}

declare global {
	interface Window {
		pywebview?: { api: PyApi };
	}
}

export class BridgeError extends Error {}

/** The bridge once pywebview has injected it (it fires `pywebviewready`). */
export function waitForBridge(win: Window = window): Promise<Bridge> {
	const ready = () => win.pywebview?.api?.dav !== undefined;
	if (ready()) return Promise.resolve(new Bridge(win.pywebview?.api as PyApi));
	return new Promise((resolve) => {
		win.addEventListener(
			"pywebviewready",
			() => resolve(new Bridge(win.pywebview?.api as PyApi)),
			{ once: true },
		);
	});
}

export class Bridge {
	constructor(private readonly api: PyApi) {}

	/** The core's transport seam. Never rejects. */
	readonly send: Send = async (req) => {
		let raw: unknown;
		try {
			raw = await this.api.dav(req);
		} catch {
			return {
				ok: false,
				kind: "network",
				message: "The app's connection broke.",
			};
		}
		const r = davResult.safeParse(raw);
		if (r.success) return r.data as DavResult;
		this.log("error", `dav: unreadable answer for ${req.method}`);
		return { ok: false, kind: "network", message: "Unreadable answer." };
	};

	async connectStart(url: string): Promise<LoginState> {
		return loginState.parse(await this.api.connect_start(url));
	}

	async connectPoll(): Promise<LoginState> {
		return loginState.parse(await this.api.connect_poll());
	}

	async connectManual(
		url: string,
		user: string,
		appPassword: string,
	): Promise<LoginState> {
		return loginState.parse(
			await this.api.connect_manual(url, user, appPassword),
		);
	}

	async disconnect(): Promise<{ revoked: boolean }> {
		return z
			.object({ ok: z.literal(true), revoked: z.boolean() })
			.parse(await this.api.disconnect());
	}

	/** The next shell event, or null after `timeoutS`. Unknown events are logged and skipped. */
	async nextEvent(timeoutS = 25): Promise<ShellEvent | null> {
		const raw = await this.api.next_event(timeoutS);
		if (raw === null) return null;
		const r = shellEvent.safeParse(raw);
		if (r.success) return r.data;
		this.log("warn", "next_event: unknown event skipped");
		return null;
	}

	async settingsGet(): Promise<Settings> {
		return settings.parse(await this.api.settings_get());
	}

	async settingsSet(patch: SettingsPatch): Promise<Settings> {
		const r = z
			.union([
				z.object({ ok: z.literal(true), settings }),
				z.object({ ok: z.literal(false), message: z.string() }),
			])
			.parse(await this.api.settings_set(patch));
		if (!r.ok) throw new BridgeError(r.message);
		return r.settings;
	}

	async notify(toast: Toast): Promise<void> {
		await this.checked(this.api.notify(toast));
	}

	async tray(tooltip: string, dueToday: number): Promise<void> {
		await this.checked(this.api.tray({ tooltip, dueToday }));
	}

	async window(cmd: WindowCmd): Promise<unknown> {
		const r = await this.checked(this.api.window(cmd));
		return (r as { value?: unknown }).value ?? null;
	}

	/** Links from task notes; false when the bridge refused it (not http/https/mailto). */
	async openUrl(url: string): Promise<boolean> {
		return okOrMessage.parse(await this.api.open_url(url)).ok;
	}

	log(level: "debug" | "info" | "warn" | "error", msg: string): void {
		this.api.log(level, msg).catch(() => undefined);
	}

	private async checked(p: Promise<unknown>): Promise<unknown> {
		const r = okOrMessage.parse(await p);
		if (!r.ok) throw new BridgeError(r.message);
		return r;
	}
}
