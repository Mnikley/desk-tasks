// Settings, a sheet inside the widget: Account, Lists, Shortcuts, Notifications, Appearance,
// Windows, About (spec "Settings").
import { useState } from "preact/hooks";
import type { Hotkey, SettingsPatch } from "../../bridge.ts";
import { attempt } from "../../core/ctx.ts";
import { reorderLists } from "../../core/lists.ts";
import { fmtClock, zoned } from "../../core/time.ts";
import { useStore } from "../store.ts";
import { useApp } from "./context.ts";
import { SheetFrame } from "./Sheet.tsx";
import { dotStyle } from "./TaskList.tsx";

export function SettingsSheet(props: { onClose: () => void }) {
	const app = useApp();
	useStore(app.revision);
	const s = useStore(app.settings);
	const store = app.ctx.store;
	const paused = store.settings.paused;
	const set = (p: SettingsPatch) => void app.saveSettings(p);
	const lists = app.lists();
	const host = (() => {
		try {
			return new URL(s.server ?? "").host;
		} catch {
			return s.server ?? "";
		}
	})();
	const version = store.meta.version;
	const pausedUntil = s.notificationsPausedUntil;
	return (
		<SheetFrame title="Settings" onClose={props.onClose}>
			<div class="section">
				<h3>Account</h3>
				<p style="margin: 0 0 6px">
					{s.user} on <strong>{host}</strong>
					{version ? <span class="help"> · Nextcloud {version}</span> : null}
				</p>
				{paused && (
					<div class="banner" style="margin: 0 0 8px">
						<span class="text">
							Saving is paused since{" "}
							{fmtClock(zoned(paused.at, app.ctx.tz).minutes)}: {paused.reason}{" "}
							Check the task in Nextcloud, then resume.
						</span>
						<span class="actions">
							<button
								type="button"
								class="text-btn"
								onClick={() => app.resumeWrites()}
							>
								Resume
							</button>
						</span>
					</div>
				)}
				<label class="toggle-row">
					<span>
						Read-only mode
						<br />
						<span class="help">
							Nothing is saved to Nextcloud while it is on.
						</span>
					</span>
					<input
						type="checkbox"
						class="switch"
						checked={store.settings.readOnly}
						onChange={(e) =>
							app.ctx.store.patchSettings({ readOnly: e.currentTarget.checked })
						}
					/>
				</label>
				<button
					type="button"
					class="btn"
					onClick={async () => {
						if (
							await app.confirm(
								`Log out of ${host}? desk-tasks forgets its app password and asks Nextcloud to revoke it.`,
								"Log out",
							)
						)
							await app.logOut();
					}}
				>
					Log out
				</button>
			</div>

			<div class="section">
				<h3>Lists</h3>
				{lists.map((l, i) => {
					const flags = s.lists[l.href] ?? {};
					const shown = flags.shown ?? !l.appGenerated;
					return (
						<div key={l.href} class="toggle-row" style="gap: 6px">
							<span style="display: flex; gap: 8px; align-items: center; min-width: 0; flex: 1">
								<span class="list-dot" style={dotStyle(l)} />
								<span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
									{l.name}
								</span>
							</span>
							<button
								type="button"
								class="icon-btn"
								aria-label={`Move ${l.name} up`}
								disabled={i === 0}
								onClick={() => void moveList(app, l.href, i - 1)}
							>
								↑
							</button>
							<button
								type="button"
								class="icon-btn"
								aria-label={`Move ${l.name} down`}
								disabled={i === lists.length - 1}
								onClick={() => void moveList(app, l.href, i + 1)}
							>
								↓
							</button>
							<input
								type="checkbox"
								class="switch"
								aria-label={`Show ${l.name} in Today, Upcoming and All`}
								checked={shown}
								onChange={(e) =>
									set({
										lists: {
											...s.lists,
											[l.href]: { ...flags, shown: e.currentTarget.checked },
										},
									})
								}
							/>
						</div>
					);
				})}
				<div class="field" style="margin-top: 8px">
					<label for="st-default">Quick add puts tasks in</label>
					<select
						id="st-default"
						class="input"
						value={s.defaultList ?? ""}
						onChange={(e) =>
							set({ defaultList: e.currentTarget.value || null })
						}
					>
						<option value="">The list used last</option>
						{lists
							.filter((l) => l.writable)
							.map((l) => (
								<option key={l.href} value={l.href}>
									{l.name}
								</option>
							))}
					</select>
				</div>
			</div>

			<div class="section">
				<h3>Shortcuts</h3>
				<HotkeyField
					label="Show or hide desk-tasks"
					value={s.hotkeySummon}
					onChange={(h) => set({ hotkeySummon: h })}
				/>
				<HotkeyField
					label="Show and add a task"
					value={s.hotkeyQuickAdd}
					onChange={(h) => set({ hotkeyQuickAdd: h })}
				/>
				<label class="toggle-row">
					<span>
						Single-key shortcuts
						<br />
						<span class="help">
							N, E, D, 1–4 and the others. Off: only keys with Ctrl, Alt or
							F-keys.
						</span>
					</span>
					<input
						type="checkbox"
						class="switch"
						checked={s.singleKeyShortcuts}
						onChange={(e) =>
							set({ singleKeyShortcuts: e.currentTarget.checked })
						}
					/>
				</label>
			</div>

			<div class="section">
				<h3>Notifications</h3>
				<label class="toggle-row">
					<span>Reminders</span>
					<input
						type="checkbox"
						class="switch"
						checked={s.notifications}
						onChange={(e) => set({ notifications: e.currentTarget.checked })}
					/>
				</label>
				<label class="toggle-row">
					<span>Notify at due time when a task has no reminder</span>
					<input
						type="checkbox"
						class="switch"
						checked={s.dueTimeToasts}
						onChange={(e) => set({ dueTimeToasts: e.currentTarget.checked })}
					/>
				</label>
				<label class="toggle-row">
					<span>Summarise reminders missed while the PC was off</span>
					<input
						type="checkbox"
						class="switch"
						checked={s.missedSummary}
						onChange={(e) => set({ missedSummary: e.currentTarget.checked })}
					/>
				</label>
				{pausedUntil && pausedUntil > app.now.get() ? (
					<div class="toggle-row">
						<span>
							Paused until {fmtClock(zoned(pausedUntil, app.ctx.tz).minutes)}
						</span>
						<button
							type="button"
							class="btn"
							onClick={() => set({ notificationsPausedUntil: null })}
						>
							Resume
						</button>
					</div>
				) : (
					<button
						type="button"
						class="btn"
						onClick={() =>
							set({ notificationsPausedUntil: app.now.get() + 3_600_000 })
						}
					>
						Pause for 1 hour
					</button>
				)}
			</div>

			<div class="section">
				<h3>Appearance</h3>
				<div class="field">
					<label for="st-density">Rows</label>
					<select
						id="st-density"
						class="input"
						value={s.density}
						onChange={(e) =>
							set({
								density: e.currentTarget.value as "comfortable" | "compact",
							})
						}
					>
						<option value="comfortable">Comfortable</option>
						<option value="compact">Compact</option>
					</select>
				</div>
				<div class="field">
					<label for="st-start">Start with</label>
					<select
						id="st-start"
						class="input"
						value={s.startView}
						onChange={(e) => set({ startView: e.currentTarget.value })}
					>
						<option value="today">Today</option>
						<option value="upcoming">Upcoming</option>
						<option value="all">All</option>
						<option value="last">The view I used last</option>
					</select>
				</div>
			</div>

			<div class="section">
				<h3>Windows</h3>
				<label class="toggle-row">
					<span>Start with Windows</span>
					<input
						type="checkbox"
						class="switch"
						checked={s.autostart}
						onChange={(e) => set({ autostart: e.currentTarget.checked })}
					/>
				</label>
			</div>

			<div class="section">
				<h3>About</h3>
				<p class="help" style="margin: 0">
					desk-tasks {app.version}. Logs: %LOCALAPPDATA%\desk-tasks\logs. Uses
					Preact (MIT), ical.js (MPL 2.0), zod (MIT), pywebview (BSD), keyring
					(MIT), pystray (LGPL), windows-toasts (Apache 2.0).
				</p>
			</div>
		</SheetFrame>
	);
}

async function moveList(
	app: ReturnType<typeof useApp>,
	href: string,
	to: number,
): Promise<void> {
	const r = await attempt(() => reorderLists(app.ctx, href, to));
	if (!r.ok) app.failed(r.error);
}

const KEYS = /^([A-Z0-9]|F([1-9]|1[0-2])|Space)$/;

/** Modifier checkboxes plus a key field (Win combinations never reach the page as keys). */
function HotkeyField(props: {
	label: string;
	value: Hotkey;
	onChange: (h: Hotkey) => void;
}) {
	const [key, setKey] = useState(props.value.key);
	const [ctrlAlt, setCtrlAlt] = useState(false);
	const v = props.value;
	/** Never Ctrl+Alt: Windows reports AltGr as Ctrl+Alt on German and Austrian layouts. */
	const save = (h: Hotkey) => {
		if (h.ctrl && h.alt) {
			setCtrlAlt(true);
			return;
		}
		setCtrlAlt(false);
		props.onChange(h);
	};
	const bad = !KEYS.test(key.trim().toUpperCase());
	const mods = (["win", "ctrl", "alt", "shift"] as const).map((m) => (
		<label
			key={m}
			style="display: inline-flex; gap: 4px; align-items: center; font-size: 12px"
		>
			<input
				type="checkbox"
				checked={v[m]}
				onChange={(e) => save({ ...v, [m]: e.currentTarget.checked })}
			/>
			{m === "win" ? "Win" : m[0]?.toUpperCase() + m.slice(1)}
		</label>
	));
	return (
		<div class="field">
			<span class="label">{props.label}</span>
			<div style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap">
				{mods}
				<input
					class="input"
					style="width: 64px"
					aria-label={`${props.label}: key`}
					value={key}
					onInput={(e) => setKey(e.currentTarget.value)}
					onBlur={() => !bad && save({ ...v, key: key.trim().toUpperCase() })}
				/>
			</div>
			{bad && (
				<span class="error-text">Use a letter, a digit, F1–F12 or Space.</span>
			)}
			{ctrlAlt && (
				<span class="error-text">
					Ctrl+Alt is AltGr on German keyboards. Pick Win or Shift instead.
				</span>
			)}
			{!v.win && !v.ctrl && !v.alt && (
				<span class="error-text">Add Win, Ctrl or Alt.</span>
			)}
		</div>
	);
}
