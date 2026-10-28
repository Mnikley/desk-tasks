// One-key popovers for single fields (d due, D start, # tags, / list, r repeat, a reminder,
// priority), each writing immediately and undoable, and the Ctrl+F filter (spec "Editing",
// "Rescheduling"). They open next to the highlighted row and take the keys while open.
import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { RepeatRule } from "../../core/recurrence.ts";
import { PRESETS, triggerLabel } from "../../core/reminders.ts";
import type { TaskView } from "../../core/tasks.ts";
import {
	addDays,
	addMonths,
	fmtClock,
	monthEnd,
	monthKey,
	monthName,
	monthStart,
	parseClock,
	startOfWeek,
	weekday,
	weekdayName,
} from "../../core/time.ts";
import type { TaskPriority } from "../../core/types.ts";
import { BYDAY, nextWeekday, parseDatePhrase } from "../../logic/dates.ts";
import { parseDateToken } from "../../logic/quickentry.ts";
import {
	knownTags,
	PRIORITY_LABEL,
	PRIORITY_ORDER,
} from "../../logic/tasklogic.ts";
import type { Controller, PopoverKind } from "../controller.ts";
import { type Filter, NO_FILTER } from "../model.ts";
import { useApp } from "./context.ts";
import { Close, Lock } from "./icons.tsx";
import { Scrim, useRestoreFocus } from "./Sheet.tsx";
import { dotStyle } from "./TaskList.tsx";

/** Places a popover under the highlighted row (or above it near the bottom). */
function usePlace(
	id: number,
): [preact.RefObject<HTMLDivElement | null>, string] {
	const ref = useRef<HTMLDivElement>(null);
	const [style, setStyle] = useState("left: 8px; right: 8px; bottom: 64px");
	useLayoutEffect(() => {
		const row = document.querySelector<HTMLElement>(`.row[data-id="${id}"]`);
		const pop = ref.current;
		if (!row || !pop || document.querySelector(".sheet")) return;
		const r = row.getBoundingClientRect();
		const h = pop.offsetHeight;
		const below = r.bottom + 4;
		const top =
			below + h < window.innerHeight - 8 ? below : Math.max(8, r.top - h - 4);
		setStyle(`left: 8px; right: 8px; top: ${Math.round(top)}px`);
	}, [id]);
	return [ref, style];
}

function Pop(props: {
	id: number;
	label: string;
	onClose: () => void;
	children: ComponentChildren;
	onKey?: (e: KeyboardEvent) => boolean;
}) {
	const [ref, style] = usePlace(props.id);
	useLayoutEffect(() => {
		const back = document.activeElement as HTMLElement | null;
		const first =
			ref.current?.querySelector<HTMLElement>("[data-autofocus]") ??
			ref.current?.querySelector<HTMLElement>("input, button");
		first?.focus();
		return () => back?.isConnected && back.focus();
	}, []);
	return (
		<>
			<Scrim onClose={props.onClose} clear z={33} />
			<div
				class="popover"
				role="dialog"
				aria-label={props.label}
				ref={ref}
				style={`${style}; z-index: 34`}
				onKeyDown={(e) => {
					if (e.key === "Escape") {
						e.preventDefault();
						e.stopPropagation();
						props.onClose();
						return;
					}
					if (props.onKey?.(e)) {
						e.preventDefault();
						e.stopPropagation();
					}
				}}
			>
				{props.children}
			</div>
		</>
	);
}

export function FieldPopover(props: {
	kind: PopoverKind;
	id: number;
	bulk: boolean;
	onClose: () => void;
}) {
	const app = useApp();
	const t = app.task(props.id);
	if (!t) return null;
	const tasks = props.bulk ? app.targets() : [t];
	const ro = tasks.every((x) => x.readOnly) ? tasks[0]?.readOnly : null;
	if (ro)
		return (
			<Pop id={props.id} label="Can't be changed" onClose={props.onClose}>
				<div
					class="menu-label"
					style="display: flex; gap: 6px; align-items: center"
				>
					<Lock size={14} /> {ro}
				</div>
			</Pop>
		);
	switch (props.kind) {
		case "due":
		case "start":
			return (
				<DatePop
					app={app}
					task={t}
					tasks={tasks}
					which={props.kind}
					onClose={props.onClose}
				/>
			);
		case "tags":
			return (
				<TagsPop app={app} task={t} tasks={tasks} onClose={props.onClose} />
			);
		case "list":
			return (
				<ListPop app={app} task={t} tasks={tasks} onClose={props.onClose} />
			);
		case "priority":
			return (
				<PriorityPop app={app} task={t} tasks={tasks} onClose={props.onClose} />
			);
		case "repeat":
			return <RepeatPop app={app} task={t} onClose={props.onClose} />;
		case "reminder":
			return <ReminderPop app={app} task={t} onClose={props.onClose} />;
	}
}

type P = {
	app: Controller;
	task: TaskView;
	tasks: TaskView[];
	onClose: () => void;
};

// ---------- dates ----------

function DatePop(props: P & { which: "due" | "start" }) {
	const { app, task, which } = props;
	const today = app.today();
	const current = which === "due" ? task.due : task.start;
	const [text, setText] = useState("");
	const [time, setTime] = useState(
		current?.minutes != null ? fmtClock(current.minutes) : "",
	);
	const [cursor, setCursor] = useState(current?.date ?? today);
	const [error, setError] = useState<string | null>(null);
	const phrase = useRef<HTMLInputElement>(null);
	const typed = text.trim()
		? (parseDatePhrase(text, today) ?? parseDateToken(text.trim(), today))
		: null;
	const apply = (date: string | null) => {
		let minutes: number | null = null;
		if (date && time.trim()) {
			minutes = parseClock(time);
			if (minutes === null) {
				setError("The time must look like 14:30.");
				return;
			}
		}
		props.onClose();
		const v = date ? { date, minutes } : null;
		if (which === "due") app.setDue(props.tasks, v);
		else app.setStart(props.tasks, v);
	};
	const keys: Record<string, () => void> = {
		t: () => apply(today),
		m: () => apply(addDays(today, 1)),
		w: () => apply(nextWeekday(today, 0)),
		s: () => {
			props.onClose();
			void app.change(
				props.tasks,
				{ due: null, start: null },
				() => "Moved to someday (no dates)",
			);
		},
		Backspace: () => apply(null),
	};
	return (
		<Pop
			id={task.id}
			label={which === "due" ? "Due date" : "Start date"}
			onClose={props.onClose}
			onKey={(e) => {
				const el = e.target as HTMLElement;
				if (el.matches("input")) return false;
				if (keys[e.key] && !e.ctrlKey && !e.altKey) {
					keys[e.key]?.();
					return true;
				}
				// Any other letter starts typing a date in words.
				if (e.key.length === 1 && !e.ctrlKey && !e.altKey && /\S/.test(e.key))
					phrase.current?.focus();
				return false;
			}}
		>
			<div class="menu-label">
				{which === "due" ? "Due" : "Start"} ·{" "}
				{props.tasks.length > 1 ? `${props.tasks.length} tasks` : task.summary}
			</div>
			<input
				ref={phrase}
				class="filter-input"
				aria-label={
					which === "due" ? "Due date, in words" : "Start date, in words"
				}
				placeholder="tomorrow, fri, 30.11., in 3 days"
				value={text}
				onInput={(e) => {
					setText(e.currentTarget.value);
					setError(null);
					const d =
						parseDatePhrase(e.currentTarget.value, today) ??
						parseDateToken(e.currentTarget.value.trim(), today);
					if (d) setCursor(d);
				}}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						if (typed) apply(typed);
						else if (text.trim())
							setError(`“${text.trim()}” isn't a date I know.`);
					} else if (e.key === "ArrowDown") {
						e.preventDefault();
						(
							e.currentTarget.parentElement?.querySelector(
								".cal [tabindex='0']",
							) as HTMLElement | null
						)?.focus();
					}
				}}
			/>
			{typed && (
				<div class="menu-label">
					Enter: {weekdayName(weekday(typed), true)}, {Number(typed.slice(8))}{" "}
					{monthName(Number(typed.slice(5, 7)), true)}
				</div>
			)}
			{error && (
				<div class="error-text" style="padding: 0 8px 4px">
					{error}
				</div>
			)}
			<div style="display: flex; gap: 4px; flex-wrap: wrap; padding: 2px 2px 6px">
				<button type="button" class="chip" onClick={() => apply(today)}>
					Today <kbd>T</kbd>
				</button>
				<button
					type="button"
					class="chip"
					onClick={() => apply(addDays(today, 1))}
				>
					Tomorrow <kbd>M</kbd>
				</button>
				<button
					type="button"
					class="chip"
					onClick={() => apply(nextWeekday(today, 0))}
				>
					Next Monday <kbd>W</kbd>
				</button>
				<button type="button" class="chip" onClick={() => keys.s?.()}>
					Someday <kbd>S</kbd>
				</button>
				{current && (
					<button type="button" class="chip" onClick={() => apply(null)}>
						No date <kbd>⌫</kbd>
					</button>
				)}
			</div>
			<Calendar
				today={today}
				cursor={cursor}
				selected={current?.date ?? null}
				onCursor={setCursor}
				onPick={apply}
			/>
			<div class="toggle-row" style="padding: 4px 6px 2px">
				<label for="pop-time" class="help">
					Time (optional)
				</label>
				<input
					id="pop-time"
					class="input tnum"
					style="width: 84px"
					placeholder="14:30"
					value={time}
					onInput={(e) => {
						setTime(e.currentTarget.value);
						setError(null);
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							apply(cursor);
						}
					}}
				/>
			</div>
		</Pop>
	);
}

/** A month grid, Monday first; arrows move by a day or a week, PageUp/Down by a month. */
export function Calendar(props: {
	today: string;
	cursor: string;
	selected: string | null;
	onCursor: (d: string) => void;
	onPick: (d: string) => void;
}) {
	const month = monthKey(props.cursor);
	const first = startOfWeek(monthStart(month));
	const last = monthEnd(month);
	const days: string[] = [];
	for (let d = first; d <= last || weekday(d) !== 0; d = addDays(d, 1))
		days.push(d);
	const weeks: string[][] = [];
	for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
	const grid = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (grid.current?.contains(document.activeElement))
			grid.current.querySelector<HTMLElement>("[tabindex='0']")?.focus();
	}, [props.cursor]);
	const [y, m] = month.split("-").map(Number) as [number, number];
	return (
		<div class="cal" style="padding: 0 4px">
			<div class="toggle-row" style="min-height: 28px">
				<button
					type="button"
					class="icon-btn"
					aria-label="Previous month"
					onClick={() => props.onCursor(monthStart(addMonths(month, -1)))}
				>
					‹
				</button>
				<strong style="font-size: 13px">
					{monthName(m, true)} {y}
				</strong>
				<button
					type="button"
					class="icon-btn"
					aria-label="Next month"
					onClick={() => props.onCursor(monthStart(addMonths(month, 1)))}
				>
					›
				</button>
			</div>
			<div
				ref={grid}
				role="grid"
				aria-label={`${monthName(m, true)} ${y}`}
				style="display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; text-align: center"
				onKeyDown={(e) => {
					const step: Record<string, number> = {
						ArrowLeft: -1,
						ArrowRight: 1,
						ArrowUp: -7,
						ArrowDown: 7,
					};
					if (step[e.key] !== undefined) {
						e.preventDefault();
						e.stopPropagation();
						props.onCursor(addDays(props.cursor, step[e.key] as number));
					} else if (e.key === "PageUp" || e.key === "PageDown") {
						e.preventDefault();
						e.stopPropagation();
						const next = addMonths(
							monthKey(props.cursor),
							e.key === "PageUp" ? -1 : 1,
						);
						props.onCursor(
							`${next}-${String(Math.min(Number(props.cursor.slice(8)), Number(monthEnd(next).slice(8)))).padStart(2, "0")}`,
						);
					} else if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						e.stopPropagation();
						props.onPick(props.cursor);
					}
				}}
			>
				<div role="row" style="display: contents">
					{[0, 1, 2, 3, 4, 5, 6].map((d) => (
						<span key={d} class="help" role="columnheader">
							{weekdayName(d).slice(0, 2)}
						</span>
					))}
				</div>
				{weeks.map((week) => (
					<div role="row" style="display: contents" key={week[0]}>
						{week.map((d) => {
							const out = monthKey(d) !== month;
							const isSel = d === props.selected;
							const isToday = d === props.today;
							return (
								<button
									key={d}
									type="button"
									role="gridcell"
									tabIndex={d === props.cursor ? 0 : -1}
									data-autofocus={d === props.cursor ? "" : undefined}
									aria-selected={isSel}
									aria-current={isToday ? "date" : undefined}
									aria-label={`${weekdayName(weekday(d), true)}, ${Number(d.slice(8))} ${monthName(Number(d.slice(5, 7)), true)}`}
									class="tnum"
									style={`height: 28px; border-radius: 5px; ${out ? "color: var(--muted);" : ""} ${isSel ? "background: var(--accent); color: var(--accent-ink);" : d === props.cursor ? "background: var(--hover);" : ""} ${isToday && !isSel ? "font-weight: 700; color: var(--accent);" : ""}`}
									onClick={() => props.onPick(d)}
									onFocus={() => d !== props.cursor && props.onCursor(d)}
								>
									{Number(d.slice(8))}
								</button>
							);
						})}
					</div>
				))}
			</div>
		</div>
	);
}

// ---------- tags, list, priority ----------

function TagsPop(props: P) {
	const { app, tasks } = props;
	const all = knownTags(app.tasks());
	const [q, setQ] = useState("");
	const has = (g: string) => tasks.every((t) => t.tags.includes(g));
	const toggle = (g: string) => {
		const on = !has(g);
		props.onClose();
		void app.editTags(tasks, on ? [g] : [], on ? [] : [g]);
	};
	const shown = all.filter((g) =>
		g.toLowerCase().includes(q.trim().toLowerCase().replace(/^#/, "")),
	);
	const fresh = q.trim().replace(/^[#*]/, "");
	return (
		<Pop id={props.task.id} label="Tags" onClose={props.onClose}>
			<input
				class="filter-input"
				data-autofocus
				aria-label="Find or add a tag"
				placeholder="Find or add a tag"
				value={q}
				onInput={(e) => setQ(e.currentTarget.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter" && fresh && !/\s/.test(fresh)) {
						e.preventDefault();
						toggle(
							shown.find((g) => g.toLowerCase() === fresh.toLowerCase()) ??
								fresh,
						);
					}
				}}
			/>
			{fresh && !all.some((g) => g.toLowerCase() === fresh.toLowerCase()) && (
				<button type="button" class="menu-item" onClick={() => toggle(fresh)}>
					<span class="grow">Add tag #{fresh}</span>
				</button>
			)}
			<div role="listbox" aria-label="Tags" aria-multiselectable="true">
				{shown.map((g) => (
					<button
						key={g}
						type="button"
						class="menu-item"
						role="option"
						aria-selected={has(g)}
						onClick={() => toggle(g)}
					>
						<span class="grow">#{g}</span>
						{has(g) && <span aria-hidden="true">✓</span>}
					</button>
				))}
			</div>
			{!all.length && !fresh && (
				<div class="menu-label">No tags yet. Type one to add it.</div>
			)}
		</Pop>
	);
}

function ListPop(props: P) {
	const { app, tasks } = props;
	const lists = app.lists();
	const [q, setQ] = useState("");
	const shown = lists.filter((l) =>
		l.name.toLowerCase().includes(q.trim().toLowerCase()),
	);
	const pick = (href: string) => {
		props.onClose();
		void app.moveToList(tasks, href);
	};
	return (
		<Pop id={props.task.id} label="Move to list" onClose={props.onClose}>
			<input
				class="filter-input"
				data-autofocus
				aria-label="Find a list"
				placeholder="Move to…"
				value={q}
				onInput={(e) => setQ(e.currentTarget.value)}
				onKeyDown={(e) => {
					const first = shown.find(
						(l) => l.writable && l.href !== props.task.list,
					);
					if (e.key === "Enter" && first) {
						e.preventDefault();
						pick(first.href);
					}
				}}
			/>
			{shown.map((l) => {
				const here = tasks.every((t) => t.list === l.href);
				return (
					<button
						key={l.href}
						type="button"
						class="menu-item"
						aria-disabled={!l.writable || here ? "true" : undefined}
						title={!l.writable ? `“${l.name}” is view only.` : undefined}
						onClick={() => l.writable && !here && pick(l.href)}
					>
						<span class="list-dot" style={dotStyle(l)} />
						<span class="grow">{l.name}</span>
						{!l.writable && <Lock size={14} label="View only" />}
						{here && <span class="n">Here</span>}
					</button>
				);
			})}
		</Pop>
	);
}

function PriorityPop(props: P) {
	const { app, tasks } = props;
	const pick = (p: TaskPriority) => {
		props.onClose();
		app.setPriority(tasks, p);
	};
	return (
		<Pop
			id={props.task.id}
			label="Priority"
			onClose={props.onClose}
			onKey={(e) => {
				const p = (
					{ "1": "high", "2": "medium", "3": "low", "4": "none" } as const
				)[e.key as "1"];
				if (p) pick(p);
				return !!p;
			}}
		>
			<div role="listbox" aria-label="Priority">
				{PRIORITY_ORDER.map((p, i) => (
					<button
						key={p}
						type="button"
						class="menu-item"
						aria-selected={props.task.priority === p}
						role="option"
						onClick={() => pick(p)}
					>
						<span class="grow">
							{p === "none" ? "No priority" : `${PRIORITY_LABEL[p]} priority`}
						</span>
						<kbd>{i + 1}</kbd>
					</button>
				))}
			</div>
		</Pop>
	);
}

// ---------- repeat ----------

const FREQS = [
	["DAILY", "Daily", "day"],
	["WEEKLY", "Weekly", "week"],
	["MONTHLY", "Monthly", "month"],
	["YEARLY", "Yearly", "year"],
] as const;

export function RepeatEditor(props: {
	app: Controller;
	task: TaskView;
	onDone?: () => void;
}) {
	const { app, task } = props;
	const anchor = task.due?.date ?? task.start?.date ?? null;
	const rule = task.repeat?.rule ?? null;
	const [r, setR] = useState<RepeatRule>(
		rule ?? {
			freq: "WEEKLY",
			interval: 1,
			byDay: anchor ? [BYDAY[weekday(anchor)] as string] : [],
			monthDay: "same",
			end: { kind: "never" },
			fromCompletion: false,
		},
	);
	if (!anchor) return <div class="menu-label">Set a due date to repeat.</div>;
	if (task.repeat && !rule)
		return (
			<div class="menu-label">
				Custom repeat: {task.repeat.text}. desk-tasks keeps it as written;
				change it in the app that made it.
			</div>
		);
	const save = (next: RepeatRule | null) => {
		props.onDone?.();
		void app.change([task], { repeat: next }, () =>
			next ? "Repeat saved" : "Doesn't repeat any more",
		);
	};
	const unit = FREQS.find((f) => f[0] === r.freq)?.[2] ?? "week";
	return (
		<div style="padding: 4px 6px; display: grid; gap: 8px">
			<div
				style="display: flex; gap: 4px; flex-wrap: wrap"
				role="radiogroup"
				aria-label="Repeats"
			>
				{FREQS.map(([f, label]) => (
					<button
						key={f}
						type="button"
						class="chip"
						role="radio"
						aria-checked={r.freq === f}
						style={
							r.freq === f
								? "border-color: var(--accent); color: var(--accent)"
								: ""
						}
						onClick={() => setR({ ...r, freq: f })}
					>
						{label}
					</button>
				))}
			</div>
			<label class="toggle-row" style="min-height: 30px">
				<span>Every</span>
				<span style="display: flex; gap: 6px; align-items: center">
					<input
						class="input tnum"
						style="width: 56px"
						type="number"
						min={1}
						max={99}
						value={r.interval}
						onInput={(e) =>
							setR({
								...r,
								interval: Math.max(
									1,
									Math.min(99, Number(e.currentTarget.value) || 1),
								),
							})
						}
					/>
					{unit}
					{r.interval === 1 ? "" : "s"}
				</span>
			</label>
			{r.freq === "WEEKLY" && (
				<div
					style="display: flex; gap: 2px"
					role="group"
					aria-label="On these days"
				>
					{BYDAY.map((d, i) => {
						const on = r.byDay.includes(d);
						return (
							<button
								key={d}
								type="button"
								class="chip"
								aria-pressed={on}
								style={`flex: 1; justify-content: center; padding: 0; ${on ? "background: var(--accent); color: var(--accent-ink); border-color: var(--accent)" : ""}`}
								onClick={() =>
									setR({
										...r,
										byDay: on
											? r.byDay.filter((x) => x !== d)
											: [...r.byDay, d],
									})
								}
							>
								{weekdayName(i).slice(0, 2)}
							</button>
						);
					})}
				</div>
			)}
			{r.freq === "MONTHLY" && (
				<label class="toggle-row">
					<span>On the last day of the month</span>
					<input
						type="checkbox"
						role="switch"
						aria-checked={r.monthDay === "last"}
						class="switch"
						checked={r.monthDay === "last"}
						onChange={(e) =>
							setR({
								...r,
								monthDay: e.currentTarget.checked ? "last" : "same",
							})
						}
					/>
				</label>
			)}
			<div class="field" style="margin: 0">
				<span class="label">Ends</span>
				<select
					class="input"
					value={r.end.kind}
					onChange={(e) => {
						const k = e.currentTarget.value;
						setR({
							...r,
							end:
								k === "until"
									? { kind: "until", date: addDays(anchor, 30) }
									: k === "count"
										? { kind: "count", count: 10 }
										: { kind: "never" },
						});
					}}
				>
					<option value="never">Never</option>
					<option value="until">On a date</option>
					<option value="count">After a number of times</option>
				</select>
				{r.end.kind === "until" && (
					<input
						class="input tnum"
						type="date"
						value={r.end.date}
						onInput={(e) =>
							e.currentTarget.value &&
							setR({
								...r,
								end: { kind: "until", date: e.currentTarget.value },
							})
						}
						aria-label="Last date"
					/>
				)}
				{r.end.kind === "count" && (
					<input
						class="input tnum"
						type="number"
						min={1}
						max={999}
						value={r.end.count}
						aria-label="Times"
						onInput={(e) =>
							setR({
								...r,
								end: {
									kind: "count",
									count: Math.max(1, Number(e.currentTarget.value) || 1),
								},
							})
						}
					/>
				)}
			</div>
			<label class="toggle-row">
				<span>Repeat from the completion date</span>
				<input
					type="checkbox"
					role="switch"
					aria-checked={r.fromCompletion}
					class="switch"
					checked={r.fromCompletion}
					onChange={(e) =>
						setR({ ...r, fromCompletion: e.currentTarget.checked })
					}
				/>
			</label>
			<div style="display: flex; gap: 8px; justify-content: flex-end">
				{task.recurring && (
					<button type="button" class="btn" onClick={() => save(null)}>
						Don't repeat
					</button>
				)}
				<button
					type="button"
					class="btn primary"
					onClick={() => save(r)}
					disabled={r.freq === "WEEKLY" && !r.byDay.length}
				>
					Save
				</button>
			</div>
		</div>
	);
}

function RepeatPop(props: Omit<P, "tasks">) {
	return (
		<Pop id={props.task.id} label="Repeat" onClose={props.onClose}>
			<RepeatEditor app={props.app} task={props.task} onDone={props.onClose} />
		</Pop>
	);
}

// ---------- reminders ----------

export function ReminderEditor(props: {
	app: Controller;
	task: TaskView;
	onDone?: () => void;
}) {
	const { app, task } = props;
	const [date, setDate] = useState(task.due?.date ?? app.today());
	const [time, setTime] = useState("09:00");
	const [error, setError] = useState<string | null>(null);
	const add = (trigger: Parameters<typeof triggerLabel>[0]) => {
		props.onDone?.();
		void app.change(
			[task],
			{ reminders: { add: [trigger] } },
			() => `Reminder set: ${triggerLabel(trigger, app.ctx.tz)}`,
		);
	};
	const remove = (key: string, label: string) => {
		props.onDone?.();
		void app.change(
			[task],
			{ reminders: { remove: [key] } },
			() => `Reminder removed: ${label}`,
		);
	};
	return (
		<div style="padding: 2px">
			{task.reminders.map((r) => (
				<div key={r.key} class="menu-item">
					<span class="grow">{r.label}</span>
					<button
						type="button"
						class="icon-btn"
						style="width: 24px; height: 24px"
						aria-label={`Remove reminder ${r.label}`}
						onClick={() => remove(r.key, r.label)}
					>
						<Close size={12} />
					</button>
				</div>
			))}
			{task.reminders.length > 0 && <div class="menu-sep" />}
			{PRESETS.map((p) => (
				<button
					key={p.label}
					type="button"
					class="menu-item"
					aria-disabled={task.due ? undefined : "true"}
					title={task.due ? undefined : "Set a due date first"}
					onClick={() => task.due && add(p.trigger)}
				>
					<span class="grow">{p.label}</span>
				</button>
			))}
			{!task.due && (
				<div class="menu-label">Set a due date first for these.</div>
			)}
			<div class="menu-sep" />
			<div class="menu-label">On date…</div>
			<div style="display: flex; gap: 6px; padding: 2px 6px 6px">
				<input
					class="input tnum"
					type="date"
					value={date}
					aria-label="Reminder date"
					onInput={(e) => setDate(e.currentTarget.value)}
				/>
				<input
					class="input tnum"
					style="width: 76px"
					value={time}
					aria-label="Reminder time"
					onInput={(e) => setTime(e.currentTarget.value)}
				/>
				<button
					type="button"
					class="btn"
					onClick={() => {
						const m = parseClock(time);
						if (!date || m === null) {
							setError("Pick a date and a time like 09:00.");
							return;
						}
						add({ kind: "absolute", at: app.instantOf(date, m) });
					}}
				>
					Add
				</button>
			</div>
			{error && (
				<div class="error-text" style="padding: 0 8px 6px">
					{error}
				</div>
			)}
		</div>
	);
}

function ReminderPop(props: Omit<P, "tasks">) {
	return (
		<Pop id={props.task.id} label="Reminder" onClose={props.onClose}>
			<ReminderEditor
				app={props.app}
				task={props.task}
				onDone={props.onClose}
			/>
		</Pop>
	);
}

// ---------- filter ----------

/** "#work !1 rent" → tags, Important (High priority), text. */
export function parseFilter(text: string): Filter {
	const f: Filter = { ...NO_FILTER, tags: [] };
	const words: string[] = [];
	for (const w of text.trim().split(/\s+/).filter(Boolean)) {
		if (/^[#*][^#*\s]+$/.test(w)) f.tags.push(w.slice(1));
		else if (w === "!1" || w.toLowerCase() === "!important") f.important = true;
		else words.push(w);
	}
	f.text = words.join(" ");
	return f;
}

export function FilterPopover(props: { onClose: () => void }) {
	const app = useApp();
	useRestoreFocus();
	const cur = app.filter.get();
	const [text, setText] = useState(
		[cur.important ? "!1" : "", ...cur.tags.map((t) => `#${t}`), cur.text]
			.filter(Boolean)
			.join(" "),
	);
	return (
		<>
			<Scrim onClose={props.onClose} clear z={33} />
			<div
				class="popover"
				role="dialog"
				aria-label="Filter"
				style="left: 8px; right: 8px; top: 40px; z-index: 34"
			>
				<input
					class="filter-input"
					ref={(el) => {
						if (el && !el.dataset.focused) {
							el.dataset.focused = "1";
							el.focus();
						}
					}}
					aria-label="Filter: #tag, !1 for important, or words"
					placeholder="#work !1 rent"
					value={text}
					onInput={(e) => {
						setText(e.currentTarget.value);
						app.filter.set(parseFilter(e.currentTarget.value));
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							props.onClose();
						} else if (e.key === "Escape") {
							e.preventDefault();
							e.stopPropagation();
							props.onClose();
						}
					}}
				/>
				<div class="help" style="padding: 0 6px 4px">
					#tag · !1 Important · words in the title or notes. Enter keeps the
					filter; remove it with its chip.
				</div>
			</div>
		</>
	);
}
