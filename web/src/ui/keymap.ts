// Every keyboard shortcut in one table: the handler and the `?` sheet read it (timesheet's
// keymap.ts pattern). Single keys fire only outside text fields and dialogs, and only while
// "Single-key shortcuts" is on (WCAG 2.1.4). Matching (spec "Keyboard map"): printable keys
// match on `e.key` and ignore Shift (so #, /, ?, +, *, _ work on QWERTZ and US); a key with
// AltGraph held counts as unmodified (Windows reports AltGr as Ctrl+Alt); nothing uses Ctrl+Alt.
import type { TaskView } from "../core/tasks.ts";
import { deleteQuestion, descendants } from "../logic/tasklogic.ts";
import { switcherEntries } from "./components/Header.tsx";
import type { Controller } from "./controller.ts";
import { visibleRows } from "./model.ts";

export const KEY_GROUPS = ["Move", "Tasks", "Views", "App"] as const;
export type KeyGroup = (typeof KEY_GROUPS)[number];

export interface Binding {
	/** `e.key` values, with "Ctrl+", "Alt+" or "Shift+" (for non-printable keys) in front. */
	keys: string[];
	label: string;
	group: KeyGroup;
	/** A chord: the key pressed just before ("g" for g then t). */
	after?: string;
	/** Fires in text fields too (Ctrl/F-keys only). */
	inFields?: boolean;
	when?: (app: Controller) => boolean;
	run: (app: Controller, e: KeyboardEvent) => void;
}

/** Hooks the components register (popovers and sheets the keys open). */
export interface KeyHooks {
	focusQuickAdd: () => void;
	rename: (id: number) => void;
	openPopover: (
		kind: "due" | "start" | "tags" | "list" | "repeat" | "reminder",
		id: number,
	) => void;
	newRow: (kind: "below" | "subtask") => void;
}
let hooks: KeyHooks | null = null;
export function setKeyHooks(h: KeyHooks | null): void {
	hooks = h;
}

const hl = (app: Controller) => {
	const id = app.highlight.get();
	return id === null ? undefined : app.task(id);
};
const hasTask = (app: Controller) => hl(app) !== undefined;
/** Runs `f` with the highlighted task (the binding's `when` makes sure there is one). */
const onTask =
	(f: (a: Controller, t: TaskView, e: KeyboardEvent) => void) =>
	(a: Controller, e: KeyboardEvent) => {
		const t = hl(a);
		if (t) f(a, t, e);
	};
const hasTargets = (app: Controller) => app.targets().length > 0;
const PRIORITY = {
	"1": "high",
	"2": "medium",
	"3": "low",
	"4": "none",
} as const;

export const KEYMAP: Binding[] = [
	{
		keys: ["Shift+ArrowDown", "Shift+ArrowUp"],
		label: "Select along",
		group: "Move",
		run: (a, e) => a.moveHighlight(e.key === "ArrowDown" ? 1 : -1, true),
	},
	{
		keys: ["ArrowDown", "j"],
		label: "Next task",
		group: "Move",
		run: (a) => a.moveHighlight(1),
	},
	{
		keys: ["ArrowUp", "k"],
		label: "Previous task",
		group: "Move",
		run: (a) => a.moveHighlight(-1),
	},
	{
		keys: ["ArrowRight"],
		label: "Show subtasks",
		group: "Move",
		when: hasTask,
		run: (a) => foldStep(a, 1),
	},
	{
		keys: ["ArrowLeft"],
		label: "Hide subtasks, else go to the parent",
		group: "Move",
		when: hasTask,
		run: (a) => foldStep(a, -1),
	},
	{
		keys: ["Alt+ArrowRight"],
		label: "Indent (make a subtask)",
		group: "Move",
		when: hasTask,
		run: onTask((a, t) => void a.nest(t, 1)),
	},
	{
		keys: ["Alt+ArrowLeft"],
		label: "Outdent",
		group: "Move",
		when: hasTask,
		run: onTask((a, t) => void a.nest(t, -1)),
	},
	{
		keys: ["Alt+ArrowUp"],
		label: "Move up (My order)",
		group: "Move",
		when: hasTask,
		run: onTask((a, t) => a.moveBy(t, -1)),
	},
	{
		keys: ["Alt+ArrowDown"],
		label: "Move down (My order)",
		group: "Move",
		when: hasTask,
		run: onTask((a, t) => a.moveBy(t, 1)),
	},
	{
		keys: ["x"],
		label: "Select or unselect",
		group: "Move",
		when: hasTask,
		run: (a) => a.toggleSelect(a.highlight.get() as number),
	},
	{
		keys: ["Ctrl+a"],
		label: "Select all",
		group: "Move",
		run: (a) =>
			a.selection.set(new Set(visibleRows(a.model()).map((r) => r.task.id))),
	},

	{
		keys: [" ", "e"],
		label: "Complete or reopen",
		group: "Tasks",
		when: hasTargets,
		run: (a) => {
			for (const t of a.targets()) a.toggleDone(t.id);
		},
	},
	{
		keys: ["Enter"],
		label: "Open the task",
		group: "Tasks",
		when: hasTask,
		run: (a) => a.sheet.set({ kind: "task", id: a.highlight.get() as number }),
	},
	{
		keys: ["F2"],
		label: "Rename",
		group: "Tasks",
		when: hasTask,
		run: (a) => hooks?.rename(a.highlight.get() as number),
	},
	{
		keys: ["n"],
		label: "Add a task (quick add)",
		group: "Tasks",
		run: () => hooks?.focusQuickAdd(),
	},
	{
		keys: ["o"],
		label: "New task below",
		group: "Tasks",
		run: () => hooks?.newRow("below"),
	},
	{
		keys: ["N"],
		label: "New subtask",
		group: "Tasks",
		when: hasTask,
		run: () => hooks?.newRow("subtask"),
	},
	{
		keys: ["d"],
		label: "Due date",
		group: "Tasks",
		when: hasTask,
		run: (a) => hooks?.openPopover("due", a.highlight.get() as number),
	},
	{
		keys: ["D"],
		label: "Start date",
		group: "Tasks",
		when: hasTask,
		run: (a) => hooks?.openPopover("start", a.highlight.get() as number),
	},
	{
		keys: ["+", "-"],
		label: "Due a day later or earlier",
		group: "Tasks",
		when: hasTargets,
		run: (a, e) => a.shiftDue(a.targets(), e.key === "+" ? 1 : -1),
	},
	{
		keys: ["*", "_"],
		label: "Due a week later or earlier",
		group: "Tasks",
		when: hasTargets,
		run: (a, e) => a.shiftDue(a.targets(), e.key === "*" ? 7 : -7),
	},
	{
		keys: ["1", "2", "3", "4"],
		label: "Priority: 1 high … 4 none",
		group: "Tasks",
		when: hasTargets,
		run: (a, e) =>
			a.setPriority(a.targets(), PRIORITY[e.key as keyof typeof PRIORITY]),
	},
	{
		keys: ["#"],
		label: "Tags",
		group: "Tasks",
		when: hasTask,
		run: (a) => hooks?.openPopover("tags", a.highlight.get() as number),
	},
	{
		keys: ["/"],
		label: "Move to list",
		group: "Tasks",
		when: hasTask,
		run: (a) => hooks?.openPopover("list", a.highlight.get() as number),
	},
	{
		keys: ["r"],
		label: "Repeat",
		group: "Tasks",
		when: hasTask,
		run: (a) => hooks?.openPopover("repeat", a.highlight.get() as number),
	},
	{
		keys: ["a"],
		label: "Reminder",
		group: "Tasks",
		when: hasTask,
		run: (a) => hooks?.openPopover("reminder", a.highlight.get() as number),
	},
	{
		keys: ["p"],
		label: "Pin or unpin",
		group: "Tasks",
		when: hasTargets,
		run: (a) => a.togglePin(a.targets()),
	},
	{
		keys: ["Delete"],
		label: "Delete (asks first)",
		group: "Tasks",
		when: hasTargets,
		run: (a) => void confirmDelete(a),
	},
	{
		keys: ["Ctrl+z", "z"],
		label: "Undo",
		group: "Tasks",
		run: (a) => void a.undo(),
	},
	{
		keys: ["Ctrl+y"],
		label: "Redo the last undo",
		group: "Tasks",
		run: (a) => void a.redo(),
	},

	{
		keys: ["t"],
		after: "g",
		label: "Today",
		group: "Views",
		run: (a) => a.setView({ kind: "today" }),
	},
	{
		keys: ["u"],
		after: "g",
		label: "Upcoming",
		group: "Views",
		run: (a) => a.setView({ kind: "upcoming" }),
	},
	{
		keys: ["a"],
		after: "g",
		label: "All",
		group: "Views",
		run: (a) => a.setView({ kind: "all" }),
	},
	{
		keys: ["Ctrl+Tab", "Ctrl+Shift+Tab"],
		label: "Next view (with Shift: previous)",
		group: "Views",
		inFields: true,
		run: (a, e) => stepView(a, e.shiftKey ? -1 : 1),
	},
	{
		keys: [
			"Ctrl+1",
			"Ctrl+2",
			"Ctrl+3",
			"Ctrl+4",
			"Ctrl+5",
			"Ctrl+6",
			"Ctrl+7",
			"Ctrl+8",
			"Ctrl+9",
		],
		label: "The nth entry of the switcher",
		group: "Views",
		inFields: true,
		run: (a, e) => jump(a, Number(e.key) - 1),
	},
	{
		keys: ["Ctrl+k"],
		label: "Go to (views, lists, commands)",
		group: "Views",
		inFields: true,
		run: (a) => a.switcherOpen.set("palette"),
	},
	{
		keys: ["Ctrl+f"],
		label: "Filter (#work !1 …)",
		group: "Views",
		inFields: true,
		run: (a) => a.filterOpen.set(true),
	},
	{
		keys: ["h"],
		label: "Show or hide completed",
		group: "Views",
		run: (a) => a.showDone.set(!a.showDone.get()),
	},

	{
		keys: ["F5"],
		label: "Sync now",
		group: "App",
		inFields: true,
		run: (a) => void a.syncNow(true),
	},
	{
		keys: ["?"],
		label: "Keyboard shortcuts",
		group: "App",
		run: (a) => a.sheet.set({ kind: "shortcuts" }),
	},
	{
		keys: ["Escape"],
		label: "Close · leave · clear selection · back to the desktop",
		group: "App",
		run: (a) => onEscape(a),
	},
];

/** A key as the sheet shows it: "Ctrl+K", "Shift+↓", "Space". */
export function keyLabel(key: string): string {
	const names: Record<string, string> = {
		ArrowUp: "↑",
		ArrowDown: "↓",
		ArrowLeft: "←",
		ArrowRight: "→",
		" ": "Space",
		Escape: "Esc",
		Delete: "Del",
	};
	const plus = key.lastIndexOf("+", key.length - 2);
	if (plus > 0) return `${key.slice(0, plus)}+${keyLabel(key.slice(plus + 1))}`;
	if (names[key]) return names[key] as string;
	if (/^[A-Z]$/.test(key)) return `Shift+${key}`;
	return key.length === 1 ? key.toUpperCase() : key;
}

/** The keys that act on a task row, in `aria-keyshortcuts` form ("Space", "Shift+D",
 * "Control+A"); without single-key shortcuts only the ones with Ctrl, Alt or F-keys. */
export function rowShortcuts(singles: boolean): string {
	const cached = rowShortcutCache.get(singles);
	if (cached !== undefined) return cached;
	const aria = (k: string): string => {
		if (k === " ") return "Space";
		if (/^[A-Z]$/.test(k)) return `Shift+${k}`;
		if (k.length === 1) return k.toUpperCase();
		const plus = k.lastIndexOf("+", k.length - 2);
		if (plus > 0)
			return `${k.slice(0, plus).replace("Ctrl", "Control")}+${aria(k.slice(plus + 1))}`;
		return k;
	};
	const keys = KEYMAP.filter((b) => b.when === hasTask || b.when === hasTargets)
		.flatMap((b) => b.keys)
		.filter((k) => singles || !isSingleKey(k))
		.map(aria);
	const out = [...new Set(keys)].join(" ");
	rowShortcutCache.set(singles, out);
	return out;
}
const rowShortcutCache = new Map<boolean, string>();

/** Whether `e` presses `key` (see the matching rules at the top). */
export function matches(key: string, e: KeyboardEvent): boolean {
	const altGr = e.getModifierState?.("AltGraph") ?? false;
	const ctrl = (e.ctrlKey || e.metaKey) && !altGr;
	const alt = e.altKey && !altGr;
	const want = key.split("+");
	// "+" itself is a key: "Ctrl++" never occurs; a lone "+" is the key.
	const bare = key === "+" ? "+" : (want.pop() as string);
	const mods = key === "+" ? [] : want;
	const wantCtrl = mods.includes("Ctrl");
	const wantAlt = mods.includes("Alt");
	const wantShift = mods.includes("Shift");
	if (ctrl !== wantCtrl || alt !== wantAlt) return false;
	const printable = bare.length === 1 && bare !== " ";
	if (printable) {
		// Shift is part of the character; letters keep their case ("N" is Shift+N).
		if (/^[a-z]$/i.test(bare))
			return e.key === bare || (ctrl && e.key.toLowerCase() === bare);
		return e.key === bare;
	}
	if (e.shiftKey !== wantShift) return false;
	return e.key === bare;
}

const FIELD =
	"input, textarea, select, [contenteditable]:not([contenteditable='false'])";
/** Layers that take the keys themselves (sheets, popovers, dialogs). */
const LAYER = ".sheet, .popover, [role='dialog'], [role='alertdialog']";
const CHORD_MS = 1000;
/** Things Enter and Space activate. */
const CONTROL =
	"button, a[href], select, summary, [role='button'], [role='option'], [role='menuitem'], [role='switch'], [role='checkbox'], [role='tab']";
let pending: { key: string; at: number } | null = null;

/** A single key: printable, without Ctrl or Alt (not F-keys, Escape or arrows). */
const isSingleKey = (k: string) => k.length === 1 || /^Shift\+.$/.test(k);

/** The window's keydown handler. */
export function handleKey(app: Controller, e: KeyboardEvent): void {
	if (e.defaultPrevented || e.isComposing) return;
	if (["Shift", "Control", "Alt", "Meta", "AltGraph"].includes(e.key)) return;
	const target = e.target instanceof Element ? e.target : null;
	const inField = !!target?.closest(FIELD);
	const inLayer =
		!!target?.closest(LAYER) || !!document.querySelector(".scrim");
	const singles = app.settings.get().singleKeyShortcuts;
	const chord =
		pending && Date.now() - pending.at < CHORD_MS ? pending.key : null;
	pending = null;
	const applies = (b: Binding) =>
		b.keys.some((k) => matches(k, e)) &&
		(b.after ? b.after === chord : true) &&
		(!b.when || b.when(app));
	const b =
		KEYMAP.find((x) => x.after && applies(x)) ??
		KEYMAP.find((x) => !x.after && applies(x));
	// Single or not is decided by the key pressed: Undo is Ctrl+Z and z, and only z is single.
	const pressed = b?.keys.find((k) => matches(k, e));
	const isSingle = pressed ? isSingleKey(pressed) : e.key.length === 1;
	// A chord's first key waits for the second.
	if (
		!b &&
		!inField &&
		!inLayer &&
		singles &&
		KEYMAP.some((x) => x.after === e.key)
	) {
		pending = { key: e.key, at: Date.now() };
		e.preventDefault();
		return;
	}
	if (!b) return;
	if (b.keys.includes("Escape")) {
		if (inLayer || inField) return;
		app.touch();
		b.run(app, e);
		return;
	}
	if (inField && !b.inFields) return;
	if (inLayer && !b.inFields) return;
	if (isSingle && !singles) return;
	// Enter and Space on a focused control are the control's (activation keys); letters still
	// work there, so the keyboard stays usable after a click on a header button.
	if (
		(e.key === "Enter" || e.key === " ") &&
		target?.closest(CONTROL) &&
		!target.closest(".row")
	)
		return;
	e.preventDefault();
	app.touch();
	b.run(app, e);
}

function foldStep(app: Controller, dir: 1 | -1): void {
	const rows = visibleRows(app.model());
	const id = app.highlight.get();
	const row = rows.find((r) => r.task.id === id);
	if (!row) return;
	if (row.expanded !== null && (dir === 1) !== row.expanded) {
		app.toggleFold(`task:${row.task.id}`, !row.expanded);
		return;
	}
	if (dir === 1 && row.expanded) {
		app.moveHighlight(1);
		return;
	}
	if (dir === -1 && row.task.parentUid) {
		const parent = rows.find(
			(r) => r.task.uid === row.task.parentUid && r.task.list === row.task.list,
		);
		if (parent) app.highlight.set(parent.task.id);
	}
}

async function confirmDelete(app: Controller): Promise<void> {
	const tasks = app.targets();
	const all = app.tasks();
	const subs = tasks.reduce((n, t) => n + descendants(t, all).length, 0);
	const q =
		tasks.length === 1
			? deleteQuestion(tasks[0] as TaskView, subs)
			: `Delete ${tasks.length} tasks${subs ? ` and their ${subs} subtasks` : ""}?`;
	if (await app.confirm(q, "Delete")) await app.deleteTasks(tasks);
}

function stepView(app: Controller, by: number): void {
	const entries = switcherEntries(app).filter((e) => e.view);
	const now = entries.findIndex(
		(e) => JSON.stringify(e.view) === JSON.stringify(app.view.get()),
	);
	const next = entries[(now + by + entries.length) % entries.length];
	if (next?.view) app.setView(next.view);
}

function jump(app: Controller, n: number): void {
	const e = switcherEntries(app).filter((x) => x.view && x.key !== "trash")[n];
	if (e?.view) app.setView(e.view);
}

/** Esc at top level: clear the selection, else back to the desktop (keeping drafts). */
function onEscape(app: Controller): void {
	if (app.clearSelection()) return;
	void app.dismiss();
}

/** Commands for the Ctrl+K palette: the bindings that make sense without a key press, with
 * their shortcut as the hint. Those that need a task are offered while one is highlighted. */
export function paletteCommands(
	app: Controller,
): { label: string; key: string; run: () => void }[] {
	const skip = new Set(["Move", "Escape"]);
	return KEYMAP.filter(
		(b) =>
			b.group !== "Move" &&
			!b.keys.some((k) => skip.has(k)) &&
			b.keys.length <= 2 &&
			(!b.when || b.when(app)),
	)
		.filter(
			(b) =>
				!b.label.startsWith("Priority") &&
				!b.label.startsWith("Due a") &&
				!b.label.startsWith("The nth"),
		)
		.map((b) => {
			const k = b.keys[0] as string;
			return {
				label: b.label,
				key: b.after ? `${keyLabel(b.after)} ${keyLabel(k)}` : keyLabel(k),
				run: () =>
					b.run(app, { key: k.split("+").pop() ?? k } as KeyboardEvent),
			};
		});
}
