// Which sheet, popover or dialog is open over the list.
import { KEY_GROUPS, KEYMAP, keyLabel } from "../keymap.ts";
import { useStore } from "../store.ts";
import { ConflictDialog } from "./ConflictDialog.tsx";
import { useApp } from "./context.ts";
import { ListSheet, NewListSheet } from "./ListSheet.tsx";
import { FieldPopover, FilterPopover } from "./Popovers.tsx";
import { SettingsSheet } from "./SettingsSheet.tsx";
import { SheetFrame } from "./Sheet.tsx";
import { dotStyle } from "./TaskList.tsx";
import { TaskSheet } from "./TaskSheet.tsx";

export function Sheets() {
	const app = useApp();
	const sheet = useStore(app.sheet);
	const pop = useStore(app.popover);
	const filter = useStore(app.filterOpen);
	const conflict = useStore(app.conflict);
	const close = () => app.sheet.set(null);
	return (
		<>
			{sheet?.kind === "task" && <TaskSheet id={sheet.id} onClose={close} />}
			{sheet?.kind === "settings" && <SettingsSheet onClose={close} />}
			{sheet?.kind === "list" && (
				<ListSheet href={sheet.href} onClose={close} />
			)}
			{sheet?.kind === "new-list" && <NewListSheet onClose={close} />}
			{sheet?.kind === "shortcuts" && <ShortcutSheet onClose={close} />}
			{sheet?.kind === "welcome" && <WelcomeSheet onClose={close} />}
			{pop && (
				<FieldPopover
					key={`${pop.kind}:${pop.id}`}
					kind={pop.kind}
					id={pop.id}
					bulk={!!pop.bulk}
					onClose={() => app.popover.set(null)}
				/>
			)}
			{filter && <FilterPopover onClose={() => app.filterOpen.set(false)} />}
			{conflict && <ConflictDialog />}
		</>
	);
}

function ShortcutSheet(props: { onClose: () => void }) {
	const app = useApp();
	const singles = app.settings.get().singleKeyShortcuts;
	return (
		<SheetFrame title="Keyboard shortcuts" onClose={props.onClose} scrollOnly>
			{!singles && (
				<p class="help">
					Single-key shortcuts are off (Settings). The ones with Ctrl, Alt or
					F-keys still work.
				</p>
			)}
			<div class="section">
				<h3>Anywhere in Windows</h3>
				<Shortcut keys={["Win+Alt+J"]} label="Show or hide desk-tasks" />
				<Shortcut keys={["Win+Alt+N"]} label="Show desk-tasks and add a task" />
			</div>
			{KEY_GROUPS.map((g) => (
				<div class="section" key={g}>
					<h3>{g}</h3>
					{KEYMAP.filter((b) => b.group === g).map((b) => (
						<Shortcut
							key={b.label}
							keys={b.keys.map((k) =>
								b.after ? `${keyLabel(b.after)} ${keyLabel(k)}` : keyLabel(k),
							)}
							label={b.label}
						/>
					))}
				</div>
			))}
		</SheetFrame>
	);
}

function Shortcut(props: { keys: string[]; label: string }) {
	return (
		<div class="toggle-row" style="min-height: 28px">
			<span>{props.label}</span>
			<span>
				{props.keys.slice(0, 4).map((k, i) => (
					<span key={k}>
						{i > 0 && <span class="muted"> · </span>}
						<kbd>{k}</kbd>
					</span>
				))}
			</span>
		</div>
	);
}

/** After the first login: which lists Today shows, and "Start with Windows?". */
function WelcomeSheet(props: { onClose: () => void }) {
	const app = useApp();
	useStore(app.revision);
	const s = useStore(app.settings);
	const sync = useStore(app.syncState);
	const lists = app.lists();
	const done = () => {
		void app.saveSettings({ firstRunDone: true });
		props.onClose();
	};
	return (
		<SheetFrame
			title="Welcome to desk-tasks"
			onClose={done}
			foot={
				<>
					<span class="grow" />
					<button type="button" class="btn primary" onClick={done}>
						Done
					</button>
				</>
			}
		>
			<div class="section" style="margin-top: 0">
				<h3>Which lists should Today show?</h3>
				{!lists.length && sync.running && (
					<p class="help">Loading your lists…</p>
				)}
				{!lists.length && !sync.running && (
					<>
						<p class="help">
							There are no task lists in your Nextcloud yet. (A new account's
							“Personal” calendar holds events only.)
						</p>
						<button
							type="button"
							class="btn"
							onClick={() => app.sheet.set({ kind: "new-list" })}
						>
							Create a list
						</button>
					</>
				)}
				{lists.map((l) => {
					const flags = s.lists[l.href] ?? {};
					const shown = flags.shown ?? !l.appGenerated;
					return (
						<label class="toggle-row" key={l.href}>
							<span style="display: flex; gap: 8px; align-items: center">
								<span class="list-dot" style={dotStyle(l)} />
								{l.name}
								{l.appGenerated && <span class="help">Deck board</span>}
							</span>
							<input
								type="checkbox"
								class="switch"
								checked={shown}
								onChange={(e) =>
									void app.saveSettings({
										lists: {
											...s.lists,
											[l.href]: { ...flags, shown: e.currentTarget.checked },
										},
									})
								}
							/>
						</label>
					);
				})}
			</div>
			<div class="section">
				<label class="toggle-row">
					<span>
						Start with Windows?
						<br />
						<span class="help">
							desk-tasks sits on your desktop from the moment you log in.
						</span>
					</span>
					<input
						type="checkbox"
						class="switch"
						checked={s.autostart}
						onChange={(e) =>
							void app.saveSettings({ autostart: e.currentTarget.checked })
						}
					/>
				</label>
			</div>
			<p class="help">
				Win+Alt+J shows desk-tasks, Win+Alt+N adds a task. Press ? for every
				shortcut.
			</p>
		</SheetFrame>
	);
}
