// The app's state and the actions on it: what the components read (stores) and call (methods).
// Every user action that writes goes through `act`, which runs it as one undo group, offers
// Undo, and turns a failure into the state the spec asks for (conflict dialog, paused banner,
// "Couldn't save · Retry" toast). The sync cadence and the shell's events live here too.
import type { Bridge, Settings, SettingsPatch, ShellEvent } from "../bridge.ts";
import {
	completeTask,
	moveToList,
	reopenTask,
	setParent,
} from "../core/cascade.ts";
import { attempt, type Ctx } from "../core/ctx.ts";
import type { Failure } from "../core/errors.ts";
import {
	applyOrder,
	CONFIRM_ABOVE,
	compareManual,
	reorderPlan,
} from "../core/order.ts";
import type { ListRecord } from "../core/store.ts";
import { type SyncOutcome, sync } from "../core/sync.ts";
import { listTasks, type TaskView } from "../core/tasks.ts";
import {
	addDays,
	dayStart,
	daysBetween,
	fmtDayShort,
	wallToInstant,
	zoned,
} from "../core/time.ts";
import type { TaskPriority } from "../core/types.ts";
import { journaled, leftSteps, partialSteps, undoSteps } from "../core/undo.ts";
import {
	type Change,
	type CreateInput,
	createTask,
	deleteTask,
	eachOf,
	updateTask,
} from "../core/write.ts";
import {
	descendants,
	isOpen,
	PRIORITY_LABEL,
	parentOf,
} from "../logic/tasklogic.ts";
import {
	buildView,
	type Filter,
	NO_FILTER,
	shownLists,
	type ViewId,
	type ViewModel,
	viewKey,
	visibleRows,
} from "./model.ts";
import { createStore } from "./store.ts";

/** How long a ticked task lingers (dimmed, struck through) before it is written and goes. */
export const LINGER_MS = 1500;
/** Sync cadence (spec "Sync cadence"). */
export const SYNC_ACTIVE_MS = 60_000;
export const SYNC_REST_MS = 5 * 60_000;
export const ACTIVE_WINDOW_MS = 10 * 60_000;
export const SETTLE_MS = 2000;
/** "Last synced 14:32" with a warning after this long. */
export const STALE_MS = 15 * 60_000;
const UNDO_TOAST_MS = 6000;
const TOAST_MS = 4000;
const ERROR_TOAST_MS = 9000;
const MAX_TOASTS = 3;

export interface ToastAction {
	label: string;
	run: () => void;
}
export interface Toast {
	id: number;
	text: string;
	tone: "info" | "error";
	actions: ToastAction[];
	ms: number;
}

export type Sheet =
	| { kind: "task"; id: number; restore?: boolean }
	| { kind: "settings" }
	| { kind: "list"; href: string }
	| { kind: "new-list" }
	| { kind: "shortcuts" }
	| { kind: "welcome" };

export interface SyncState {
	running: boolean;
	/** The last run's top-level error (auth, unreachable), or null. */
	error: SyncOutcome["error"];
	/** navigator.onLine said no during the last failure. */
	offline: boolean;
}

export type PopoverKind =
	| "due"
	| "start"
	| "tags"
	| "list"
	| "repeat"
	| "reminder"
	| "priority";

export interface NewRowAt {
	list: string;
	parent: TaskView | null;
	after: number | null;
}

export interface Conflict {
	summary: string;
	failure: Failure;
}

interface UndoEntry {
	label: string;
	steps: number[];
}

export interface UiPrefs {
	view: ViewId;
	folds: [string, boolean][];
	lastList: string | null;
	showDone: boolean;
}

export interface ControllerDeps {
	ctx: Ctx;
	bridge: Bridge;
	settings: Settings;
	prefs?: Partial<UiPrefs>;
	savePrefs?: (p: UiPrefs) => void;
	/** For tests: no timers of its own (the test drives sync and lingers). */
	timers?: boolean;
	version?: string;
	/** After "Log out": the app goes back to the first-run sheet. */
	onLogout?: () => void;
}

export class Controller {
	readonly ctx: Ctx;
	readonly bridge: Bridge;
	readonly settings;
	readonly view;
	readonly filter = createStore<Filter>(NO_FILTER);
	readonly folds;
	readonly showDone;
	readonly lastList;
	readonly syncState = createStore<SyncState>({
		running: false,
		error: null,
		offline: false,
	});
	readonly toasts = createStore<Toast[]>([]);
	readonly highlight = createStore<number | null>(null);
	readonly selection = createStore<ReadonlySet<number>>(new Set());
	readonly lingering = createStore<ReadonlySet<number>>(new Set());
	readonly sheet = createStore<Sheet | null>(null);
	readonly conflict = createStore<Conflict | null>(null);
	/** The one draft that left the detail sheet unsaved ("Restore"). */
	readonly restoreSlot = createStore<{
		id: number;
		base: object;
		draft: object;
	} | null>(null);
	readonly summoned = createStore(false);
	/** The view switcher; "palette" (Ctrl+K) lists the commands too. */
	/** Where focus should go after a summon ("list" or "quick-add"); App does it. */
	readonly focusRequest = createStore<null | "list" | "quick-add">(null);
	readonly switcherOpen = createStore<false | "switcher" | "palette">(false);
	/** The row being renamed inline (F2, double-click). */
	readonly renaming = createStore<number | null>(null);
	/** A one-key popover open on a task (d, D, #, /, r, a). */
	readonly popover = createStore<{
		kind: PopoverKind;
		id: number;
		/** Applies to the whole selection (bulk bar). */
		bulk?: boolean;
	} | null>(null);
	/** The inline new row (o, Shift+N): under `parent` (a task href, or null at top level) of
	 * `list`, placed after `after` (a task id) among its siblings. */
	readonly newRowAt = createStore<NewRowAt | null>(null);
	readonly filterOpen = createStore(false);
	/** Wall clock, refreshed every tick (due chips turn red when their time passes). */
	readonly now;
	/** Bumped by the core store's changes, batched. */
	readonly revision = createStore(0);
	private readonly savePrefs: (p: UiPrefs) => void;
	readonly version: string;
	private readonly onLogout: () => void;
	/** The reminder loop (main.tsx sets it; tests may leave it out). */
	reminders: {
		tick(): Promise<void>;
		action(
			a: "done" | "snooze-15m" | "snooze-1h" | "snooze-tomorrow" | "open",
			href: string,
		): Promise<void>;
		updateTray(): void;
		resumed(): void;
	} | null = null;
	private toastId = 0;
	private undoStack: UndoEntry[] = [];
	private redoEntry: UndoEntry | null = null;
	private lingerTimer: ReturnType<typeof setTimeout> | null = null;
	/** Ticks being written right now, and the flushes queued one after another. */
	private readonly flushing = new Set<number>();
	/** Actions still being written (Undo waits for them). */
	private readonly inflight = new Set<Promise<unknown>>();
	private flushChain: Promise<void> = Promise.resolve();
	private syncTimer: ReturnType<typeof setTimeout> | null = null;
	private settleTimer: ReturnType<typeof setTimeout> | null = null;
	private lastInteraction = 0;
	private disposed = false;
	private nextSyncAt = 0;
	private readonly timers: boolean;
	private cache: { version: number; tasks: TaskView[] } = {
		version: -1,
		tasks: [],
	};

	constructor(deps: ControllerDeps) {
		this.ctx = deps.ctx;
		this.bridge = deps.bridge;
		this.timers = deps.timers ?? true;
		this.settings = createStore<Settings>(deps.settings);
		this.view = createStore<ViewId>(deps.prefs?.view ?? { kind: "today" });
		this.folds = createStore<ReadonlyMap<string, boolean>>(
			new Map(deps.prefs?.folds ?? []),
		);
		this.showDone = createStore(deps.prefs?.showDone ?? false);
		this.lastList = createStore<string | null>(deps.prefs?.lastList ?? null);
		this.now = createStore(this.ctx.now());
		this.savePrefs = deps.savePrefs ?? (() => {});
		this.version = deps.version ?? "dev";
		this.onLogout = deps.onLogout ?? (() => {});
		for (const s of [this.view, this.folds, this.showDone, this.lastList])
			s.subscribe(() => this.persistPrefs());
		this.ctx.store.subscribe(() => this.revision.set((n) => n + 1));
		// A list that vanished from the view's switcher sends the view back to Today.
		this.revision.subscribe(() => {
			const v = this.view.get();
			if (v.kind === "list" && !this.ctx.store.list(v.href))
				this.view.set({ kind: "today" });
		});
	}

	private persistPrefs(): void {
		this.savePrefs({
			view: this.view.get(),
			folds: [...this.folds.get()],
			lastList: this.lastList.get(),
			showDone: this.showDone.get(),
		});
	}

	// ---------- reading ----------

	tasks(): TaskView[] {
		const v = this.ctx.store.version;
		if (this.cache.version !== v)
			this.cache = { version: v, tasks: listTasks(this.ctx) };
		return this.cache.tasks;
	}

	task(id: number): TaskView | undefined {
		return this.tasks().find((t) => t.id === id);
	}

	/** Lists in list order (the switcher's order); "gone" ones left out. */
	lists(): ListRecord[] {
		return this.ctx.store
			.lists()
			.filter((l) => l.error?.kind !== "gone")
			.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
	}

	today(): string {
		return zoned(this.now.get(), this.ctx.tz).date;
	}

	/** Minutes since local midnight, now. */
	nowMinutes(): number {
		return zoned(this.now.get(), this.ctx.tz).minutes;
	}

	shown(): Set<string> {
		return shownLists(this.lists(), this.settings.get().lists);
	}

	model(view: ViewId = this.view.get()): ViewModel {
		const now = this.now.get();
		const z = zoned(now, this.ctx.tz);
		return buildView(view, {
			tasks: this.tasks(),
			lists: this.lists(),
			shown: this.shown(),
			today: z.date,
			nowMin: z.minutes,
			todayStart: dayStart(z.date, this.ctx.tz),
			filter: this.filter.get(),
			showDone: this.showDone.get(),
			folds: this.folds.get(),
			lingering: this.lingering.get(),
		});
	}

	viewTitle(v: ViewId = this.view.get()): string {
		switch (v.kind) {
			case "today":
				return "Today";
			case "upcoming":
				return "Upcoming";
			case "all":
				return "All";
			case "trash":
				return "Trash";
			case "list":
				return this.ctx.store.list(v.href)?.name ?? "List";
		}
	}

	/** Writes are off (read-only switch, paused, or no connection): the reason, else null. */
	writeBlock(): string | null {
		const s = this.ctx.store.settings;
		if (s.readOnly) return "The read-only switch is on (Settings).";
		if (s.paused)
			return "Saving to Nextcloud is paused because a change couldn't be confirmed.";
		if (this.syncState.get().offline)
			return "Offline · changes are paused until you're back online.";
		return null;
	}

	// ---------- view state ----------

	setView(v: ViewId): void {
		if (viewKey(v) === viewKey(this.view.get())) return;
		this.view.set(v);
		this.selection.set(new Set());
		this.highlight.set(null);
		if (v.kind === "list") this.lastList.set(v.href);
	}

	clearFilter(): void {
		this.filter.set(NO_FILTER);
	}

	toggleSelect(id: number): void {
		const next = new Set(this.selection.get());
		if (next.has(id)) next.delete(id);
		else next.add(id);
		this.selection.set(next);
		this.highlight.set(id);
	}

	/** Shift-click: selects from the highlighted row to this one, in view order. */
	selectTo(id: number): void {
		const rows = visibleRows(this.model()).map((r) => r.task.id);
		const from = rows.indexOf(this.highlight.get() ?? id);
		const to = rows.indexOf(id);
		if (to < 0) return;
		const [a, b] = from < 0 ? [to, to] : from < to ? [from, to] : [to, from];
		this.selection.set(
			new Set([...this.selection.get(), ...rows.slice(a, b + 1)]),
		);
		this.highlight.set(id);
	}

	clearSelection(): boolean {
		if (!this.selection.get().size) return false;
		this.selection.set(new Set());
		return true;
	}

	/** Moves the highlight by `by` visible rows (j/k, arrows); `extend` selects along. */
	moveHighlight(by: number, extend = false): void {
		const rows = visibleRows(this.model()).map((r) => r.task.id);
		if (!rows.length) return;
		const at = rows.indexOf(this.highlight.get() ?? -1);
		const next = rows[
			at < 0
				? by > 0
					? 0
					: rows.length - 1
				: Math.max(0, Math.min(rows.length - 1, at + by))
		] as number;
		if (extend) {
			const sel = new Set(this.selection.get());
			if (at >= 0) sel.add(rows[at] as number);
			sel.add(next);
			this.selection.set(sel);
		}
		this.highlight.set(next);
	}

	toggleFold(key: string, now: boolean): void {
		this.folds.set((m) => new Map(m).set(key, !now));
	}

	touch(): void {
		this.lastInteraction = this.ctx.now();
	}

	// ---------- toasts ----------

	toast(
		text: string,
		opts: { tone?: Toast["tone"]; actions?: ToastAction[]; ms?: number } = {},
	): number {
		const id = ++this.toastId;
		const tone = opts.tone ?? "info";
		const ms = opts.ms ?? (tone === "error" ? ERROR_TOAST_MS : TOAST_MS);
		this.toasts.set((t) => {
			const next = [...t, { id, text, tone, actions: opts.actions ?? [], ms }];
			// The oldest without an action goes first, so an offered Undo or Retry stays.
			while (next.length > MAX_TOASTS) {
				const plain = next.slice(0, -1).findIndex((x) => !x.actions.length);
				next.splice(Math.max(plain, 0), 1);
			}
			return next;
		});
		return id;
	}

	dismissToast(id: number): void {
		this.toasts.set((t) => t.filter((x) => x.id !== id));
	}

	// ---------- acting ----------

	/**
	 * Runs one user action as an undo group. `done` names it for the toast ("Moved 3 tasks to
	 * Tomorrow"); null: no toast (but still undoable with z). Returns the result, or undefined
	 * after a failure (already shown).
	 */
	async act<T>(
		write: (g: Ctx) => Promise<T>,
		opts: {
			done?: (r: T) => string | null;
			/** The task's title for failure messages ("Couldn't save “Pay rent”."). */
			subject?: string;
			retry?: () => void;
		} = {},
	): Promise<T | undefined> {
		this.touch();
		const running = attempt(() => journaled(this.ctx, write));
		this.inflight.add(running);
		const r = await running;
		this.inflight.delete(running);
		this.settleSoon();
		if (r.ok) {
			void this.reminders?.tick();
			const label = opts.done?.(r.value.result) ?? null;
			if (r.value.steps.length) {
				this.undoStack.push({
					label: label ?? "the last change",
					steps: r.value.steps,
				});
				this.redoEntry = null;
			}
			if (label)
				this.toast(label, {
					actions: r.value.steps.length
						? [{ label: "Undo", run: () => void this.undo() }]
						: [],
					ms: UNDO_TOAST_MS,
				});
			return r.value.result;
		}
		const steps = partialSteps(r.error);
		if (steps.length)
			this.undoStack.push({ label: "the part that went through", steps });
		this.failed(r.error, opts);
		return undefined;
	}

	/** Shows a failure the way the spec asks for its kind. */
	failed(
		e: Failure,
		opts: { subject?: string; retry?: () => void } = {},
	): void {
		const what = opts.subject ? `“${opts.subject}”` : "the change";
		switch (e.kind) {
			case "conflict":
				this.conflict.set({ summary: opts.subject ?? "", failure: e });
				return;
			case "paused":
				// The banner says why; a toast repeats the reason only when nothing else shows it.
				this.toast(e.message, { tone: "error" });
				return;
			case "unreachable":
				if (e.sent) {
					this.toast(
						`Couldn't confirm ${what} was saved. Saving is paused until you review it.`,
						{
							tone: "error",
						},
					);
					return;
				}
				// Discard: the change is dropped; the view already shows Nextcloud's version.
				this.toast(`Couldn't save ${what}.`, {
					tone: "error",
					actions: [
						...(opts.retry ? [{ label: "Retry", run: opts.retry }] : []),
						{ label: "Discard", run: () => {} },
					],
				});
				return;
			default:
				this.toast(e.message, { tone: "error" });
		}
	}

	async undo(): Promise<void> {
		// z during a linger takes the tick back; nothing was written yet.
		const ticked = [...this.lingering.get()].filter(
			(id) => !this.flushing.has(id),
		);
		if (ticked.length) {
			this.clearLinger();
			this.lingering.set(
				(l) => new Set([...l].filter((x) => this.flushing.has(x))),
			);
			this.toast(
				ticked.length === 1
					? "Kept it open."
					: `Kept ${ticked.length} tasks open.`,
			);
			return;
		}
		// An action still being written is the one Undo means.
		await Promise.all([...this.inflight, this.flushChain]);
		const block = this.writeBlock();
		if (block) {
			this.toast(block, { tone: "error" });
			return;
		}
		const top = this.undoStack.pop();
		if (!top) {
			this.toast("Nothing to undo.");
			return;
		}
		this.touch();
		const r = await attempt(() => undoSteps(this.ctx, top.steps));
		this.settleSoon();
		if (r.ok) {
			this.redoEntry = { label: top.label, steps: r.value };
			this.toast(`Undid ${lower(top.label)}.`, {
				actions: r.value.length
					? [{ label: "Redo", run: () => void this.redo() }]
					: [],
			});
			return;
		}
		const left = leftSteps(r.error);
		if (left.length) this.undoStack.push({ label: top.label, steps: left });
		this.toast(`Couldn't undo: ${r.error.message}`, {
			tone: "error",
			actions: left.length
				? [{ label: "Try again", run: () => void this.undo() }]
				: [],
		});
	}

	async redo(): Promise<void> {
		const e = this.redoEntry;
		if (!e?.steps.length) {
			this.toast("Nothing to redo.");
			return;
		}
		const block = this.writeBlock();
		if (block) {
			this.toast(block, { tone: "error" });
			return;
		}
		this.redoEntry = null;
		const r = await attempt(() => undoSteps(this.ctx, e.steps));
		this.settleSoon();
		if (r.ok) {
			this.undoStack.push({ label: e.label, steps: r.value });
			this.toast(`Redid ${lower(e.label)}.`);
		} else this.toast(`Couldn't redo: ${r.error.message}`, { tone: "error" });
	}

	// ---------- completing ----------

	/** Ticks a task: it lingers, then is written; ticking again within the linger cancels. */
	toggleDone(id: number): void {
		const t = this.task(id);
		if (!t) return;
		if (t.readOnly) {
			this.toast(t.readOnly, { tone: "error" });
			return;
		}
		const block = this.writeBlock();
		if (block) {
			this.toast(block, { tone: "error" });
			return;
		}
		this.touch();
		const now = this.lingering.get();
		// Already being written: the tick can't be taken back any more (Undo can).
		if (this.flushing.has(id)) return;
		if (now.has(id)) {
			const next = new Set(now);
			next.delete(id);
			this.lingering.set(next);
			if (!next.size) this.clearLinger();
			return;
		}
		if (!isOpen(t)) {
			void this.act((g) => reopenTask(g, t.href), {
				subject: t.summary,
				done: (r) =>
					r.parents
						? `Reopened “${t.summary}” and ${plural(r.parents, "parent task")}`
						: `Reopened “${t.summary}”`,
			});
			return;
		}
		this.lingering.set(new Set(now).add(id));
		// Ticking another during a linger extends all of them.
		this.clearLinger();
		if (this.timers)
			this.lingerTimer = setTimeout(() => void this.flushLinger(), LINGER_MS);
	}

	private clearLinger(): void {
		if (this.lingerTimer) clearTimeout(this.lingerTimer);
		this.lingerTimer = null;
	}

	/**
	 * Writes the lingering ticks now (the linger ended, or the widget is dismissed or quits).
	 * Each tick is written once: ticks already being written are left to that flush, and only
	 * the flushed ones leave the lingering set when it is done (a tick made meanwhile stays).
	 */
	async flushLinger(): Promise<void> {
		this.clearLinger();
		const ids = [...this.lingering.get()].filter(
			(id) => !this.flushing.has(id),
		);
		if (!ids.length) {
			await this.flushChain;
			return;
		}
		for (const id of ids) this.flushing.add(id);
		const run = this.flushChain.then(() => this.writeTicks(ids));
		this.flushChain = run.catch(() => undefined);
		await run;
	}

	private async writeTicks(ids: number[]): Promise<void> {
		const done = () => {
			for (const id of ids) this.flushing.delete(id);
			this.lingering.set(
				(l) => new Set([...l].filter((x) => !ids.includes(x))),
			);
		};
		const tasks = ids
			.map((id) => this.task(id))
			.filter((t): t is TaskView => !!t && isOpen(t));
		if (!tasks.length) {
			done();
			return;
		}
		const names = tasks.map((t) => t.summary);
		await this.act(
			async (g) => {
				const results = [];
				// By session id: an earlier group may have moved a task (new href).
				for (const t of tasks)
					results.push(await completeTask(g, (this.task(t.id) ?? t).href));
				return results;
			},
			{
				subject: names.length === 1 ? names[0] : undefined,
				retry: () => {
					for (const t of tasks) this.toggleDone(t.id);
				},
				done: (rs) => {
					const next = rs.length === 1 ? rs[0]?.task : null;
					if (next && isOpen(next) && next.due)
						return `Next: ${fmtDayShort(next.due.date)} · “${next.summary}”`;
					if (rs.length > 1) return `Completed ${rs.length} tasks`;
					const subs = rs[0]?.subtasks ?? 0;
					return subs
						? `Completed “${names[0]}” and ${plural(subs, "subtask")}`
						: `Completed “${names[0]}”`;
				},
			},
		);
		done();
	}

	// ---------- task actions ----------

	/** The tasks an action applies to: the selection, else the highlighted task. */
	targets(): TaskView[] {
		const sel = this.selection.get();
		const ids = sel.size
			? [...sel]
			: [this.highlight.get()].filter((x): x is number => x !== null);
		return ids.map((id) => this.task(id)).filter((t): t is TaskView => !!t);
	}

	/** The task as it is now (an earlier group may have moved it: same id, new href). */
	fresh(t: TaskView): TaskView {
		return this.task(t.id) ?? t;
	}

	/**
	 * Changes `tasks`; read-only ones are skipped and named. One undo group. True when the
	 * change was saved (false: blocked, refused or failed, and the reason was shown).
	 */
	async change(
		tasks: TaskView[],
		c: Change,
		label: (n: number) => string,
	): Promise<boolean> {
		const block = this.writeBlock();
		if (block) {
			this.toast(block, { tone: "error" });
			return false;
		}
		const writable = tasks.filter((t) => !t.readOnly);
		const skipped = tasks.length - writable.length;
		if (!writable.length) {
			if (tasks[0]?.readOnly) this.toast(tasks[0].readOnly, { tone: "error" });
			return false;
		}
		const ok = await this.act(
			async (g) => {
				await eachOf(
					writable,
					"changed",
					async (t) => void (await updateTask(g, this.fresh(t).href, c)),
				);
				return true;
			},
			{
				subject: writable.length === 1 ? writable[0]?.summary : undefined,
				retry: () => void this.change(tasks, c, label),
				done: () =>
					`${label(writable.length)}${skipped ? ` · ${plural(skipped, "view-only task")} skipped` : ""}`,
			},
		);
		return ok === true;
	}

	rename(id: number, summary: string): void {
		const t = this.task(id);
		if (t) void this.change([t], { summary }, () => `Renamed to “${summary}”`);
	}

	setPriority(tasks: TaskView[], priority: TaskPriority): void {
		void this.change(tasks, { priority }, (n) =>
			priority === "none"
				? `Priority removed${n > 1 ? ` from ${n} tasks` : ""}`
				: `${PRIORITY_LABEL[priority]} priority${n > 1 ? ` for ${n} tasks` : ""}`,
		);
	}

	setDue(
		tasks: TaskView[],
		due: { date: string; minutes: number | null } | null,
	): void {
		void this.change(tasks, { due }, (n) => {
			const what = n === 1 ? `“${tasks[0]?.summary}”` : `${n} tasks`;
			return due
				? `Moved ${what} to ${dueWords(due.date, this.today())}`
				: `Removed the due date of ${what}`;
		});
	}

	/** +/-: the due date moves by `days` (no due date: from today), keeping its time. */
	shiftDue(tasks: TaskView[], days: number): void {
		const today = this.today();
		const block = this.writeBlock();
		if (block) {
			this.toast(block, { tone: "error" });
			return;
		}
		const writable = tasks.filter((t) => !t.readOnly);
		if (!writable.length) {
			if (tasks[0]?.readOnly) this.toast(tasks[0].readOnly, { tone: "error" });
			return;
		}
		void this.act(
			(g) =>
				eachOf(writable, "moved", async (t0) => {
					const t = this.fresh(t0);
					const date = addDays(
						t.due?.date ?? today,
						t.due ? days : Math.max(0, days),
					);
					await updateTask(
						g,
						t.href,
						t.due ? { dueDate: date } : { due: { date, minutes: null } },
					);
				}),
			{
				subject: writable.length === 1 ? writable[0]?.summary : undefined,
				done: () => {
					const one = tasks.length === 1 ? tasks[0] : null;
					const d = one
						? addDays(
								one.due?.date ?? today,
								one.due ? days : Math.max(0, days),
							)
						: null;
					return one && d
						? `Due ${dueWords(d, today)}`
						: `Moved ${tasks.length} tasks by ${days} days`;
				},
			},
		);
	}

	setStart(
		tasks: TaskView[],
		start: { date: string; minutes: number | null } | null,
	): void {
		void this.change(tasks, { start }, () =>
			start
				? `Starts ${dueWords(start.date, this.today())}`
				: "Start date removed",
		);
	}

	togglePin(tasks: TaskView[]): void {
		const pin = !tasks.every((t) => t.pinned);
		void this.change(
			tasks,
			{ pinned: pin },
			(n) => `${pin ? "Pinned" : "Unpinned"}${n > 1 ? ` ${n} tasks` : ""}`,
		);
	}

	setTags(tasks: TaskView[], tags: string[]): void {
		void this.change(tasks, { tags }, () =>
			tags.length
				? `Tags: ${tags.map((t) => `#${t}`).join(" ")}`
				: "Tags removed",
		);
	}

	/** Adds and removes tags on each task, keeping its other tags (bulk tags). */
	async editTags(
		tasks: TaskView[],
		add: string[],
		remove: string[],
	): Promise<void> {
		const block = this.writeBlock();
		if (block) {
			this.toast(block, { tone: "error" });
			return;
		}
		const lower = new Set(remove.map((r) => r.toLowerCase()));
		const writable = tasks.filter((t) => !t.readOnly);
		if (!writable.length) {
			if (tasks[0]?.readOnly) this.toast(tasks[0].readOnly, { tone: "error" });
			return;
		}
		await this.act(
			(g) =>
				eachOf(writable, "changed", async (t0) => {
					const t = this.fresh(t0);
					const next = [...t.tags.filter((x) => !lower.has(x.toLowerCase()))];
					for (const a of add)
						if (!next.some((x) => x.toLowerCase() === a.toLowerCase()))
							next.push(a);
					if (next.join("\n") !== t.tags.join("\n"))
						await updateTask(g, t.href, { tags: next });
				}),
			{
				subject: writable.length === 1 ? writable[0]?.summary : undefined,
				done: () =>
					add.length
						? `Tagged #${add.join(" #")}`
						: `Removed #${remove.join(" #")}`,
			},
		);
	}

	/** Leaving the sheet with changes keeps them in a one-slot "Restore" toast. */
	keepForRestore(
		id: number,
		summary: string,
		base: object,
		draft: object,
	): void {
		this.restoreSlot.set({ id, base, draft });
		this.toast(`Your edit of “${summary}” wasn't saved.`, {
			actions: [
				{
					label: "Restore",
					run: () => this.sheet.set({ kind: "task", id, restore: true }),
				},
			],
			ms: 8000,
		});
	}

	/** A wall-clock date and time in the app's zone as an instant. */
	instantOf(date: string, minutes: number): number {
		return wallToInstant(date, minutes, this.ctx.tz);
	}

	async deleteTasks(tasks: TaskView[]): Promise<void> {
		const block = this.writeBlock();
		if (block) {
			this.toast(block, { tone: "error" });
			return;
		}
		const writable = tasks.filter((t) => !t.readOnly);
		if (!writable.length) {
			if (tasks[0]?.readOnly) this.toast(tasks[0].readOnly, { tone: "error" });
			return;
		}
		this.selection.set(new Set());
		await this.act(
			async (g) => {
				let n = 0;
				for (const t of writable) {
					// By session id: a task moved meanwhile has a new href; one deleted elsewhere is gone.
					const now = this.task(t.id);
					if (now && g.store.task(now.href))
						n += (await deleteTask(g, now.href)).deleted;
				}
				return n;
			},
			{
				subject: writable.length === 1 ? writable[0]?.summary : undefined,
				done: (n) =>
					n === 0
						? "Nothing was deleted: the tasks aren't there any more."
						: writable.length === 1
							? `Deleted “${writable[0]?.summary}”${n > 1 ? ` and ${plural(n - 1, "subtask")}` : ""}`
							: `Deleted ${plural(n, "task")}`,
			},
		);
	}

	/** Moves tasks (with their subtasks) to another list. */
	async moveToList(tasks: TaskView[], to: string): Promise<void> {
		const target = this.ctx.store.list(to);
		if (!target) return;
		if (!target.writable) {
			this.toast(`“${target.name}” is view only. Pick another list.`, {
				tone: "error",
			});
			return;
		}
		const writable = tasks.filter((t) => !t.readOnly && t.list !== to);
		if (!writable.length) {
			if (tasks[0]?.readOnly) this.toast(tasks[0].readOnly, { tone: "error" });
			return;
		}
		const subs = writable.reduce(
			(n, t) => n + descendants(t, this.tasks()).length,
			0,
		);
		await this.act(
			(g) =>
				eachOf(
					writable,
					"moved",
					async (t) => void (await moveToList(g, this.fresh(t).href, to)),
				),
			{
				subject: writable.length === 1 ? writable[0]?.summary : undefined,
				done: () =>
					`Moved ${writable.length === 1 ? `“${writable[0]?.summary}”` : plural(writable.length, "task")} to ${target.name}${subs ? ` · ${plural(subs, "subtask")} with it` : ""}`,
			},
		);
	}

	/** Alt+→: the task goes under the sibling above it; Alt+←: up one level. */
	async nest(t: TaskView, dir: 1 | -1): Promise<void> {
		if (t.readOnly) {
			this.toast(t.readOnly, { tone: "error" });
			return;
		}
		const block = this.writeBlock();
		if (block) {
			this.toast(block, { tone: "error" });
			return;
		}
		const all = this.tasks();
		if (dir === -1) {
			const p = parentOf(t, all);
			if (!p) return;
			const gp = parentOf(p, all);
			await this.act(
				(g) =>
					setParent(g, this.fresh(t).href, gp ? this.fresh(gp).href : null),
				{
					subject: t.summary,
					done: () =>
						gp
							? `Moved under “${gp.summary}”`
							: `“${t.summary}” is a top-level task now`,
				},
			);
			return;
		}
		const siblings = this.siblings(t);
		const above = siblings[siblings.findIndex((s) => s.id === t.id) - 1];
		if (!above) {
			this.toast("There's no task above to nest it under.");
			return;
		}
		await this.act(
			(g) => setParent(g, this.fresh(t).href, this.fresh(above).href),
			{
				subject: t.summary,
				done: () => `Moved under “${above.summary}”`,
			},
		);
		this.folds.set((m) => new Map(m).set(`task:${above.id}`, false));
	}

	/** Open siblings of a task in My order (same list, same parent). */
	siblings(t: TaskView): TaskView[] {
		return this.tasks()
			.filter(
				(s) => s.list === t.list && s.parentUid === t.parentUid && isOpen(s),
			)
			.sort(compareManual);
	}

	/** Alt+↑/↓ and drags: puts `t` at `index` among its siblings (Tasks app's order rule). */
	async reorder(t: TaskView, index: number, anyView = false): Promise<void> {
		if (
			!anyView &&
			this.view.get().kind !== "list" &&
			this.view.get().kind !== "all"
		) {
			this.toast(
				`${this.viewTitle()} is sorted by time and priority. Reorder in a list.`,
			);
			return;
		}
		if (t.readOnly) {
			this.toast(t.readOnly, { tone: "error" });
			return;
		}
		const block = this.writeBlock();
		if (block) {
			this.toast(block, { tone: "error" });
			return;
		}
		const sibs = this.siblings(t);
		const plan = reorderPlan(sibs, t, index);
		if (!plan.length) return;
		if (
			plan.length > CONFIRM_ABOVE &&
			!(await this.confirm(
				`Reordering here updates ${plan.length} tasks in Nextcloud.`,
				"Reorder",
			))
		)
			return;
		await this.act((g) => applyOrder(g, plan), {
			subject: t.summary,
			done: () =>
				plan.length > 1
					? `Reordered · ${plural(plan.length, "task")} updated`
					: null,
		});
	}

	/**
	 * A drop in a list view: the tasks go under `parent` (null: top level) at `index` among its
	 * open subtasks, in their order. A new parent is one PUT, the position the order rule's
	 * writes. One undo group.
	 */
	async dropAt(
		tasks: TaskView[],
		to: { list: string; parent: TaskView | null; index: number },
	): Promise<void> {
		const block = this.writeBlock();
		if (block) {
			this.toast(block, { tone: "error" });
			return;
		}
		const movable = tasks.filter((t) => !t.readOnly);
		if (!movable.length) {
			if (tasks[0]?.readOnly) this.toast(tasks[0].readOnly, { tone: "error" });
			return;
		}
		if (movable.some((t) => t.list !== to.list)) {
			await this.moveToList(movable, to.list);
			return;
		}
		const first = movable[0] as TaskView;
		const estimate = reorderPlan(
			this.siblingsOf(to.list, to.parent?.uid ?? null).filter(
				(s) => !movable.some((m) => m.id === s.id),
			),
			{ href: "", sortOrder: 0 },
			to.index,
		);
		if (estimate.length + movable.length - 1 > CONFIRM_ABOVE)
			if (
				!(await this.confirm(
					`Reordering here updates ${estimate.length + movable.length - 1} tasks in Nextcloud.`,
					"Reorder",
				))
			)
				return;
		await this.act(
			async (g) => {
				for (const [i, m] of movable.entries()) {
					const now =
						this.tasks().find((x) => x.uid === m.uid && x.list === m.list) ?? m;
					if (now.parentUid !== (to.parent?.uid ?? null))
						await setParent(
							g,
							now.href,
							to.parent ? this.fresh(to.parent).href : null,
						);
					const fresh =
						this.tasks().find((x) => x.uid === m.uid && x.list === m.list) ??
						now;
					// The index counts siblings without the dragged tasks: the ones not placed yet
					// are left out (the ones placed already sit at index…index+i-1).
					const later = new Set(movable.slice(i + 1).map((x) => x.uid));
					const sibs = this.siblingsOf(to.list, to.parent?.uid ?? null).filter(
						(x) => !later.has(x.uid),
					);
					const plan = reorderPlan(sibs, fresh, to.index + i);
					if (plan.length) await applyOrder(g, plan);
				}
			},
			{
				subject: movable.length === 1 ? first.summary : undefined,
				done: () =>
					to.parent
						? `Moved ${movable.length === 1 ? `“${first.summary}”` : plural(movable.length, "task")} under “${to.parent.summary}”`
						: null,
			},
		);
		if (to.parent)
			this.folds.set((m) => new Map(m).set(`task:${to.parent?.id}`, false));
	}

	/** Open tasks under one parent (null: top level) of a list, in My order. */
	siblingsOf(list: string, parentUid: string | null): TaskView[] {
		return this.tasks()
			.filter((s) => s.list === list && s.parentUid === parentUid && isOpen(s))
			.sort(compareManual);
	}

	/** A drop on an Upcoming day header: that due date, each keeping its time and form. */
	async moveToDay(tasks: TaskView[], date: string): Promise<void> {
		const block = this.writeBlock();
		if (block) {
			this.toast(block, { tone: "error" });
			return;
		}
		const movable = tasks.filter((t) => !t.readOnly);
		if (!movable.length) {
			if (tasks[0]?.readOnly) this.toast(tasks[0].readOnly, { tone: "error" });
			return;
		}
		await this.act(
			(g) =>
				eachOf(movable, "moved", async (t0) => {
					const t = this.fresh(t0);
					await updateTask(
						g,
						t.href,
						t.due ? { dueDate: date } : { due: { date, minutes: null } },
					);
				}),
			{
				subject: movable.length === 1 ? movable[0]?.summary : undefined,
				done: () =>
					`Moved ${movable.length === 1 ? `“${movable[0]?.summary}”` : plural(movable.length, "task")} to ${dueWords(date, this.today())}`,
			},
		);
	}

	/** Alt+↑/↓: one place up or down among its siblings (the detail sheet's subtasks: any view). */
	moveBy(t: TaskView, by: number, anyView = false): void {
		const sibs = this.siblings(t);
		const at = sibs.findIndex((s) => s.id === t.id);
		const to = at + by;
		if (at < 0 || to < 0 || to >= sibs.length) return;
		void this.reorder(t, to, anyView);
	}

	/** Opens the inline new row below the highlighted task, or as its subtask. */
	newRow(kind: "below" | "subtask"): void {
		const t =
			this.highlight.get() === null
				? undefined
				: this.task(this.highlight.get() as number);
		const v = this.view.get();
		if (!t) {
			const l = this.defaultList();
			if (!l) return;
			this.newRowAt.set({ list: l.href, parent: null, after: null });
			return;
		}
		if (v.kind !== "list" && v.kind !== "all" && kind === "below") {
			// Smart views aren't in My order: a new task goes in through quick add instead.
			this.toast(
				`${this.viewTitle()} is sorted by time and priority. Add tasks below, or in a list.`,
			);
			return;
		}
		const list = this.ctx.store.list(t.list);
		if (!list?.writable) {
			this.toast(
				`“${list?.name ?? "This list"}” is view only. You can see these tasks but not change them.`,
				{ tone: "error" },
			);
			return;
		}
		if (kind === "subtask") {
			this.newRowAt.set({ list: t.list, parent: t, after: null });
			this.folds.set((m) => new Map(m).set(`task:${t.id}`, false));
		} else
			this.newRowAt.set({
				list: t.list,
				parent: parentOf(t, this.tasks()) ?? null,
				after: t.id,
			});
	}

	/** Saves the inline new row at its place (the order rule, bumping following siblings). */
	async createAt(at: NewRowAt, summary: string): Promise<TaskView | undefined> {
		const block = this.writeBlock();
		if (block) {
			this.toast(block, { tone: "error" });
			return undefined;
		}
		const sibs = this.tasks()
			.filter(
				(s) =>
					s.list === at.list &&
					s.parentUid === (at.parent?.uid ?? null) &&
					isOpen(s),
			)
			.sort(compareManual);
		const index =
			at.after === null
				? sibs.length
				: sibs.findIndex((s) => s.id === at.after) + 1;
		const plan = reorderPlan(sibs, { href: "", sortOrder: 0 }, index);
		const mine = plan.find((w) => w.href === "");
		const bumps = plan.filter((w) => w.href !== "");
		const t = await this.act(
			async (g) => {
				const made = await createTask(g, {
					summary,
					list: at.list,
					...(at.parent ? { parent: this.fresh(at.parent).href } : {}),
					...(mine && at.after !== null ? { order: mine.order } : {}),
				});
				if (at.after !== null && bumps.length) await applyOrder(g, bumps);
				return made;
			},
			{ subject: summary },
		);
		if (t) this.highlight.set(t.id);
		return t;
	}

	/** Creates a task from a parsed quick-add line. */
	async create(input: CreateInput): Promise<TaskView | undefined> {
		const block = this.writeBlock();
		if (block) {
			this.toast(block, { tone: "error" });
			return undefined;
		}
		const t = await this.act((g) => createTask(g, input), {
			subject: input.summary,
			done: (t) => {
				const l = this.ctx.store.list(t.list);
				return `Added “${t.summary}”${l && this.view.get().kind !== "list" ? ` to ${l.name}` : ""}`;
			},
		});
		if (t) {
			if (!input.parent && input.list) this.lastList.set(input.list);
			this.highlight.set(t.id);
		}
		return t;
	}

	/** The list quick-add uses without /list: the view's list, the last used, else the first writable. */
	defaultList(): ListRecord | null {
		const v = this.view.get();
		const lists = this.lists();
		const writable = (h: string | null | undefined) => {
			const l = h ? this.ctx.store.list(h) : undefined;
			return l?.writable && l.error?.kind !== "gone" ? l : null;
		};
		if (v.kind === "list") return writable(v.href);
		return (
			writable(this.settings.get().defaultList) ??
			writable(this.lastList.get()) ??
			lists.find((l) => l.writable && !l.appGenerated) ??
			null
		);
	}

	/** Writes durable settings through the bridge; a refusal is a toast. */
	async saveSettings(patch: SettingsPatch): Promise<void> {
		try {
			const next = await this.bridge.settingsSet(patch);
			this.settings.set(next);
			if (patch.density)
				document.documentElement.dataset.density = patch.density;
		} catch (err) {
			this.toast(`Couldn't save the setting: ${(err as Error).message}`, {
				tone: "error",
			});
		}
	}

	async logOut(): Promise<void> {
		await this.flushLinger();
		try {
			const r = await this.bridge.disconnect();
			if (!r.revoked)
				this.toast(
					"Logged out. Nextcloud couldn't be reached to revoke the app password; remove it under Settings → Security there.",
				);
		} catch {
			this.toast("Logged out.", { tone: "error" });
		}
		this.ctx.store.forget();
		await this.ctx.store.flush().catch(() => undefined);
		this.dispose();
		this.onLogout();
	}

	/** Settings → "Resume": writes go out again after the user reviewed the paused change. */
	resumeWrites(): void {
		this.ctx.store.patchSettings({ paused: null });
		this.toast("Saving to Nextcloud resumed.");
		void this.syncNow(true);
	}

	// ---------- confirmation ----------

	readonly confirmation = createStore<{
		text: string;
		action: string;
		resolve: (ok: boolean) => void;
	} | null>(null);

	confirm(text: string, action: string): Promise<boolean> {
		return new Promise((resolve) => {
			this.confirmation.get()?.resolve(false);
			this.confirmation.set({ text, action, resolve });
		});
	}

	answer(ok: boolean): void {
		this.confirmation.get()?.resolve(ok);
		this.confirmation.set(null);
	}

	// ---------- sync ----------

	/** Runs a sync now (`force`: even within 20 s of the last). */
	async syncNow(force = true): Promise<void> {
		if (!this.ctx.dav) return;
		this.syncState.set((s) => ({ ...s, running: true }));
		const r = await attempt(() => sync(this.ctx, { force }));
		const outcome: SyncOutcome = r.ok
			? r.value
			: {
					gone: [],
					failed: [],
					ok: false,
					error: { kind: "invalid", message: r.error.message },
				};
		const offline =
			outcome.error?.kind === "unreachable" &&
			globalThis.navigator?.onLine === false;
		this.syncState.set({ running: false, error: outcome.error, offline });
		void this.reminders?.tick();
		for (const href of outcome.gone) {
			const name = this.ctx.store.list(href)?.name ?? "A list";
			this.toast(`“${name}” is no longer shared with you.`);
		}
		this.schedule();
	}

	/** Arms the next sync by the cadence: 60 s while active, 5 min at rest. */
	schedule(): void {
		const now = this.ctx.now();
		const active =
			this.summoned.get() || now - this.lastInteraction < ACTIVE_WINDOW_MS;
		this.nextSyncAt = now + (active ? SYNC_ACTIVE_MS : SYNC_REST_MS);
		if (!this.timers || this.disposed) return;
		if (this.syncTimer) clearTimeout(this.syncTimer);
		this.syncTimer = setTimeout(
			() => void this.syncNow(false),
			this.nextSyncAt - now,
		);
	}

	/** After a write burst settles (2 s), sync to pick up what Nextcloud made of it. */
	private settleSoon(): void {
		if (!this.timers) return;
		if (this.settleTimer) clearTimeout(this.settleTimer);
		this.settleTimer = setTimeout(() => void this.syncNow(true), SETTLE_MS);
	}

	// ---------- shell events ----------

	/** Stops this controller's timers (after Log out a new one takes over). */
	dispose(): void {
		this.disposed = true;
		this.clearLinger();
		if (this.syncTimer) clearTimeout(this.syncTimer);
		if (this.settleTimer) clearTimeout(this.settleTimer);
		this.syncTimer = null;
		this.settleTimer = null;
	}

	handle(ev: ShellEvent): void {
		switch (ev.type) {
			case "tick":
				this.now.set(this.ctx.now());
				void this.reminders?.tick();
				// WebView timers may be throttled while covered: the tick is the heartbeat.
				if (this.ctx.now() >= this.nextSyncAt) void this.syncNow(false);
				return;
			case "summoned":
				this.summoned.set(true);
				this.touch();
				void this.syncNow(true);
				if (ev.target === "settings") {
					this.sheet.set({ kind: "settings" });
					return;
				}
				// The missed-reminders summary toast opens Today.
				if (ev.target === "today") this.setView({ kind: "today" });
				if (typeof ev.target === "object") {
					const href = ev.target.task;
					const t = this.tasks().find((x) => x.href === href);
					if (t) this.highlight.set(t.id);
				}
				this.focusRequest.set(ev.target === "quick-add" ? "quick-add" : "list");
				return;
			case "dismissed":
				this.summoned.set(false);
				void this.flushLinger();
				return;
			case "resumed":
				this.reminders?.resumed();
				void this.syncNow(true);
				return;
			case "network":
			case "sync-now":
				void this.syncNow(true);
				return;
			case "theme":
				document.documentElement.dataset.theme = ev.dark ? "dark" : "light";
				return;
			case "hotkey-failed":
				this.toast(
					`${ev.combo} is used by another app. Choose another shortcut in Settings.`,
					{
						tone: "error",
					},
				);
				return;
			case "quit":
				void this.quit();
				return;
			case "pause-notifications":
				// Tray "Pause notifications 1 h" (Settings shows it and can resume).
				void this.saveSettings({
					notificationsPausedUntil: this.ctx.now() + 3_600_000,
				});
				this.toast("Notifications paused for 1 hour.");
				return;
			case "toast-action":
				void this.reminders?.action(ev.action, ev.href);
				return;
		}
	}

	/** Back to the desktop layer (Esc at top level); pending ticks are written, drafts kept. */
	async dismiss(): Promise<void> {
		this.summoned.set(false);
		await this.flushLinger();
		await this.bridge.window({ cmd: "dismiss" }).catch(() => undefined);
	}

	/** Flushes pending ticks and the local copy, then lets Python exit. */
	async quit(): Promise<void> {
		await this.flushLinger();
		await this.ctx.store.flush().catch(() => undefined);
		await this.bridge.window({ cmd: "quit" }).catch(() => undefined);
	}
}

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
export const plural = (n: number, word: string) =>
	`${n} ${word}${n === 1 ? "" : "s"}`;

/** "today", "tomorrow", "Fri", "12 Nov". */
export function dueWords(date: string, today: string): string {
	const n = daysBetween(today, date);
	if (n === 0) return "today";
	if (n === 1) return "tomorrow";
	if (n === -1) return "yesterday";
	return fmtDayShort(date);
}
