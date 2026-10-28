// Boot: wait for the bridge, read the durable settings, then either the first-run sheet or the
// app (IndexedDB mirror shown instantly, then a sync). The settings column of the store
// (read-only switch, paused writes) is written through to Python's settings.json.
import { render } from "preact";
import { type Bridge, type Settings, waitForBridge } from "../bridge.ts";
import { CaldavClient } from "../core/caldav.ts";
import type { Ctx, Logger } from "../core/ctx.ts";
import {
	combine,
	IdbPersister,
	loadKv,
	openMirror,
	saveKv,
} from "../core/idb.ts";
import { type Change, type Persister, Store } from "../core/store.ts";
import { App } from "./components/App.tsx";
import { AppContext } from "./components/context.ts";
import { FirstRun } from "./components/FirstRun.tsx";
import { Controller, type UiPrefs } from "./controller.ts";
import type { ViewId } from "./model.ts";

const VERSION = "0.1.0";

/** Durable settings go to Python, not IndexedDB (they must survive a lost WebView profile). */
function settingsPersister(bridge: Bridge): Persister {
	return {
		async write(changes: Change[]) {
			const last = changes.filter((c) => c.type === "settings").at(-1);
			if (last?.type === "settings")
				await bridge.settingsSet({
					readOnly: last.settings.readOnly,
					paused: last.settings.paused,
				});
		},
	};
}

function logger(bridge: Bridge): Logger {
	return {
		info: (m) => bridge.log("info", m),
		warn: (m) => bridge.log("warn", m),
		error: (m) => bridge.log("error", m),
	};
}

function startView(s: Settings, prefs: Partial<UiPrefs> | undefined): ViewId {
	if (s.startView === "last" && prefs?.view) return prefs.view;
	if (s.startView === "upcoming") return { kind: "upcoming" };
	if (s.startView === "all") return { kind: "all" };
	return { kind: "today" };
}

export async function boot(
	root: HTMLElement,
	bridge?: Bridge,
): Promise<Controller | null> {
	const b = bridge ?? (await waitForBridge());
	window.addEventListener("error", (e) =>
		b.log("error", `${e.message} at ${e.filename}:${e.lineno}`),
	);
	window.addEventListener("unhandledrejection", (e) =>
		b.log("error", `Unhandled: ${String(e.reason?.stack ?? e.reason)}`),
	);
	const settings = await b.settingsGet();
	document.documentElement.dataset.density = settings.density;
	if (!settings.connected || !settings.server) {
		render(
			<FirstRun bridge={b} onConnected={() => void boot(root, b)} />,
			root,
		);
		return null;
	}
	let db: IDBDatabase | null = null;
	try {
		db = await openMirror();
	} catch (err) {
		b.log("error", `IndexedDB unavailable: ${String(err)}`);
	}
	const idb = db ? new IdbPersister(db) : null;
	const snapshot = idb ? await idb.load().catch(() => ({})) : {};
	const prefs = db
		? await loadKv<UiPrefs>(db, "ui").catch(() => undefined)
		: undefined;
	const persister = combine(...(idb ? [idb] : []), settingsPersister(b));
	const store = new Store(persister, {
		...snapshot,
		settings: { readOnly: settings.readOnly, paused: settings.paused },
	});
	const ctx: Ctx = {
		store,
		dav: new CaldavClient(settings.server, b.send),
		now: () => Date.now(),
		tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
		log: logger(b),
	};
	let saveTimer: ReturnType<typeof setTimeout> | null = null;
	const app = new Controller({
		ctx,
		bridge: b,
		settings,
		prefs: { ...prefs, view: startView(settings, prefs) },
		version: VERSION,
		savePrefs: (p) => {
			if (!db) return;
			if (saveTimer) clearTimeout(saveTimer);
			saveTimer = setTimeout(
				() => void saveKv(db as IDBDatabase, "ui", p).catch(() => undefined),
				300,
			);
		},
		onLogout: () => void boot(root, b),
	});
	render(
		<AppContext.Provider value={app}>
			<App />
		</AppContext.Provider>,
		root,
	);
	if (!settings.firstRunDone) app.sheet.set({ kind: "welcome" });
	void app.syncNow(true);
	void app.listen();
	return app;
}

const root = document.getElementById("app");
if (root && !(window as { __deskTasksNoBoot?: boolean }).__deskTasksNoBoot)
	void boot(root);
