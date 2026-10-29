// The reminder loop: on every 30 s tick from Python, and after syncs and
// writes, compute the next 48 h of triggers and fire what is due as toasts; triggers missed
// while the PC was off or asleep (≤ 12 h) become one summary. Fired keys and snoozes are kept
// in IndexedDB (href + UID + instant: each fires once). The tray shows "n due today".
import { completeTask } from "../core/cascade.ts";
import {
	AHEAD_MS,
	MISSED_WINDOW_MS,
	missedText,
	type ReminderEntry,
	reminderEntries,
	type Snooze,
	snoozeUntil,
	tickPlan,
	toastBody,
} from "../core/reminders.ts";
import type { Controller } from "./controller.ts";

export interface ReminderState {
	fired: string[];
	snoozes: Snooze[];
}

/** Fired keys older than this are forgotten (their instant can't come back into the window). */
const KEEP_MS = 3 * 24 * 60 * 60_000;

export class Reminders {
	private fired: Set<string>;
	private snoozes: Snooze[];
	private trayText = "";
	private running = false;
	/** The next pass may summarise missed reminders: at start and after a resume only. */
	private summarise = true;
	/** What each toast was about: a Done on an old toast mustn't complete the next occurrence. */
	private readonly shown = new Map<string, string>();

	constructor(
		private readonly app: Controller,
		state: Partial<ReminderState> = {},
		private readonly save: (s: ReminderState) => void = () => {},
	) {
		this.fired = new Set(state.fired ?? []);
		this.snoozes = state.snoozes ?? [];
	}

	private persist(): void {
		const now = this.app.ctx.now();
		const keep = [...this.fired].filter(
			(k) => Number(k.split("\n")[2]) > now - KEEP_MS,
		);
		this.fired = new Set(keep);
		this.save({ fired: keep, snoozes: this.snoozes });
	}

	/** The entries from the tasks in the mirror (DISPLAY/AUDIO alarms, due times). */
	entries(now: number): ReminderEntry[] {
		const s = this.app.settings.get();
		const tasks = this.app.tasks().flatMap((view) => {
			const rec = this.app.ctx.store.task(view.href);
			return rec && !rec.notUtf8 ? [{ view, ics: rec.ics }] : [];
		});
		return reminderEntries(
			tasks,
			{
				tz: this.app.ctx.tz,
				dueTime: s.dueTimeToasts,
				notify: (list) => s.lists[list]?.notify ?? true,
			},
			now - MISSED_WINDOW_MS,
			now + AHEAD_MS,
		);
	}

	/** One pass: fire what is due, summarise what was missed, remember both. */
	async tick(): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			await this.run();
		} finally {
			this.running = false;
		}
		this.updateTray();
	}

	private async run(): Promise<void> {
		const s = this.app.settings.get();
		if (!s.notifications) return;
		const now = this.app.ctx.now();
		const plan = tickPlan(this.entries(now), now, {
			fired: this.fired,
			snoozes: this.snoozes,
			pausedUntil: s.notificationsPausedUntil,
		});
		let changed = false;
		for (const e of plan.fire) {
			await this.show(e);
			this.fired.add(e.key);
			changed = true;
		}
		const summarise = this.summarise;
		this.summarise = false;
		if (plan.missed.length) {
			// While running, a trigger already past (a task just created with an old due
			// time) is remembered quietly; the summary is for time the PC was off or asleep.
			if (s.missedSummary && summarise)
				await this.app.bridge
					.notify({
						title: missedText(plan.missed.length),
						body: "Open Today to see them.",
					})
					.catch(() => undefined);
			for (const e of plan.missed) this.fired.add(e.key);
			changed = true;
		}
		for (const k of plan.expire) {
			this.fired.add(k);
			changed = true;
		}
		for (const sn of plan.snoozesDue) {
			// A snoozed task that was completed meanwhile doesn't come back.
			const t = this.app.tasks().find((x) => x.href === sn.entry.href);
			if (t && t.status !== "COMPLETED" && t.status !== "CANCELLED")
				await this.show(sn.entry);
			this.snoozes = this.snoozes.filter((x) => x !== sn);
			changed = true;
		}
		if (changed) this.persist();
	}

	/** After sleep: the next pass summarises what was missed meanwhile. */
	resumed(): void {
		this.summarise = true;
	}

	private async show(e: ReminderEntry): Promise<void> {
		this.shown.set(
			e.href,
			occurrence(this.app.tasks().find((t) => t.href === e.href)),
		);
		const list = this.app.ctx.store.list(e.list)?.name ?? "";
		await this.app.bridge
			.notify({
				title: e.summary || "(no title)",
				body: toastBody(e, list),
				href: e.href,
				actions: e.readOnly ? ["snooze"] : ["done", "snooze"],
			})
			.catch(() => undefined);
	}

	/** A toast button: Done completes the task, Snooze brings the reminder back later. */
	async action(
		action: "done" | "snooze-15m" | "snooze-1h" | "snooze-tomorrow" | "open",
		href: string,
	): Promise<void> {
		const t = this.app.tasks().find((x) => x.href === href);
		if (action === "open") {
			if (t) {
				this.app.highlight.set(t.id);
				this.app.sheet.set({ kind: "task", id: t.id });
			}
			return;
		}
		if (action === "done") {
			if (!t) return;
			// The task moved on to its next occurrence (or was ticked) since the toast showed.
			const was = this.shown.get(href);
			if (
				t.status === "COMPLETED" ||
				(was !== undefined && was !== occurrence(t))
			) {
				this.app.toast(`“${t.summary}” was already done.`);
				return;
			}
			await this.app.act((g) => completeTask(g, href), {
				subject: t.summary,
				done: () => `Completed “${t.summary}”`,
			});
			return;
		}
		const choice =
			action === "snooze-15m"
				? "15m"
				: action === "snooze-1h"
					? "1h"
					: "tomorrow";
		const now = this.app.ctx.now();
		const entry =
			this.entries(now).find((e) => e.href === href && this.fired.has(e.key)) ??
			(t ? fallbackEntry(t, now) : null);
		if (!entry) return;
		this.snoozes = [
			...this.snoozes.filter((s) => s.entry.href !== href),
			{ entry, until: snoozeUntil(choice, now, this.app.ctx.tz) },
		];
		this.persist();
	}

	/** Tooltip and badge: "desk-tasks · 3 due today". Sent only when it changes. */
	updateTray(): void {
		const today = this.app.today();
		const n = this.app
			.tasks()
			.filter(
				(t) =>
					this.app.shown().has(t.list) &&
					(t.status === "NEEDS-ACTION" || t.status === "IN-PROCESS") &&
					t.due &&
					t.due.date <= today,
			).length;
		const text = n ? `desk-tasks · ${n} due today` : "desk-tasks";
		if (text === this.trayText) return;
		this.trayText = text;
		void this.app.bridge.tray(text, n).catch(() => undefined);
	}
}

function fallbackEntry(
	t: {
		href: string;
		uid: string;
		summary: string;
		list: string;
		readOnly: string | null;
	},
	now: number,
): ReminderEntry {
	return {
		key: `${t.href}\n${t.uid}\n${now}`,
		href: t.href,
		uid: t.uid,
		at: now,
		summary: t.summary,
		list: t.list,
		kind: "alarm",
		dueText: "",
		readOnly: t.readOnly !== null,
	};
}

/** Which occurrence a task is at: its due (or start) date and status. */
function occurrence(
	t:
		| {
				due: { date: string } | null;
				start: { date: string } | null;
				status: string;
		  }
		| undefined,
): string {
	return t ? `${t.due?.date ?? t.start?.date ?? ""}|${t.status}` : "";
}
