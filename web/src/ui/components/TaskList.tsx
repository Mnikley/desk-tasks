// The view's groups and rows, as a treegrid (aria-level, -expanded, -selected), with a roving
// tabindex on the highlighted row. Rows: checkbox (32 px hit area), title, meta line, priority
// bars, pin.
import type { JSX } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ListRecord } from "../../core/store.ts";
import { PRIORITY_LABEL } from "../../logic/tasklogic.ts";
import { type NewRowAt, plural } from "../controller.ts";
import { rowShortcuts } from "../keymap.ts";
import {
	dueChip,
	type Group,
	type Row,
	viewKey,
	visibleRows,
} from "../model.ts";
import { useStore } from "../store.ts";
import { useApp } from "./context.ts";
import { useDrag } from "./drag.ts";
import {
	Bell,
	Check,
	Chevron,
	Close,
	Lock,
	Notes,
	Pin,
	Repeat,
} from "./icons.tsx";
import { TrashView } from "./TrashView.tsx";

const MAX_INDENT = 4;
const PRIORITY_BARS = { high: 3, medium: 2, low: 1, none: 0 } as const;

export function TaskList() {
	const app = useApp();
	const v = useStore(app.view);
	return v.kind === "trash" ? <TrashView /> : <Tasks />;
}

function Tasks() {
	const app = useApp();
	useStore(app.revision);
	const view = useStore(app.view);
	useStore(app.now);
	useStore(app.filter);
	useStore(app.folds);
	useStore(app.showDone);
	const lingering = useStore(app.lingering);
	const highlight = useStore(app.highlight);
	const selection = useStore(app.selection);
	const summoned = useStore(app.summoned);
	useStore(app.newRowAt);
	const model = app.model(view);
	const lists = new Map(app.lists().map((l) => [l.href, l]));
	// In Today and Upcoming a row says its list; in All and a list the section or view does.
	const mixed = view.kind === "today" || view.kind === "upcoming";
	const scroller = useRef<HTMLDivElement>(null);
	const [below, setBelow] = useState(0);
	useDrag(app, scroller);

	// Keep the highlighted row in view (clear of the sticky parts) and focused when summoned.
	useLayoutEffect(() => {
		if (highlight === null) return;
		const el = scroller.current?.querySelector<HTMLElement>(
			`[data-id="${highlight}"]`,
		);
		el?.scrollIntoView({ block: "nearest" });
		if (
			el &&
			!el.contains(document.activeElement) &&
			(document.activeElement?.closest(".scroll") ||
				(summoned && document.activeElement === document.body))
		)
			el.focus({ preventScroll: true });
	}, [highlight, summoned]);

	// "+12 more" when resting and rows are cut off below.
	useEffect(() => {
		const el = scroller.current;
		if (!el) return;
		const measure = () => {
			const bottom = el.scrollTop + el.clientHeight;
			const rows = [...el.querySelectorAll<HTMLElement>(".row")];
			setBelow(
				rows.filter((r) => r.offsetTop + r.offsetHeight / 2 > bottom).length,
			);
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		el.addEventListener("scroll", measure, { passive: true });
		return () => {
			ro.disconnect();
			el.removeEventListener("scroll", measure);
		};
	});

	const empty = model.groups.every((g) => g.rows.length === 0);
	return (
		<div
			class={`scroll${below ? " overflows" : ""}`}
			ref={scroller}
			data-view={viewKey(view)}
			data-tree={view.kind === "list" || view.kind === "all" ? "" : undefined}
		>
			{empty ? (
				<EmptyState doneToday={model.doneToday} />
			) : (
				<div
					role="treegrid"
					aria-label={`${app.viewTitle(view)} tasks`}
					aria-multiselectable="true"
				>
					{model.groups.map((g) => (
						<GroupView
							key={g.key}
							group={g}
							lists={lists}
							mixed={mixed}
							lingering={lingering}
							highlight={highlight}
							selection={selection}
							showHead={g.title !== null}
							firstId={
								highlight === null
									? (visibleRows(model)[0]?.task.id ?? null)
									: null
							}
						/>
					))}
				</div>
			)}
			{below > 0 && !summoned && (
				<div class="more-below" aria-hidden="true">
					+{below} more
				</div>
			)}
		</div>
	);
}

function GroupView(props: {
	group: Group;
	lists: Map<string, ListRecord>;
	mixed: boolean;
	lingering: ReadonlySet<number>;
	highlight: number | null;
	selection: ReadonlySet<number>;
	showHead: boolean;
	/** With nothing highlighted, the first row is the list's Tab stop. */
	firstId: number | null;
}) {
	const app = useApp();
	const g = props.group;
	const foldKey =
		g.kind === "overdue"
			? "group:overdue"
			: g.kind === "done" && g.key === "done"
				? app.view.get().kind === "list"
					? `group:done:${(app.view.get() as { href: string }).href}`
					: "group:done-today"
				: `group:${g.key}`;
	const list = g.list ? props.lists.get(g.list) : undefined;
	return (
		<div role="rowgroup" data-group={g.key}>
			{props.showHead && (
				<div role="row" class="group-row" aria-expanded={!g.folded}>
					<div role="columnheader" aria-colspan={3}>
						<button
							type="button"
							class="group-head"
							data-kind={g.kind}
							data-date={g.date}
							data-empty={g.rows.length === 0 ? "" : undefined}
							aria-expanded={!g.folded}
							onClick={() => app.toggleFold(foldKey, g.folded)}
						>
							{g.rows.length > 0 && <Chevron open={!g.folded} size={12} />}
							{list && <span class="list-dot" style={dotStyle(list)} />}
							<span class="label">{g.title}</span>
							{g.count > 0 && <span class="n">{g.count}</span>}
						</button>
					</div>
				</div>
			)}
			{!g.folded &&
				withNewRow(g, app.newRowAt.get()).map((r) =>
					r === "new" ? (
						<NewRow key="new" />
					) : (
						<TaskRow
							key={r.task.id}
							row={r}
							list={props.lists.get(r.task.list)}
							mixed={props.mixed}
							lingering={props.lingering.has(r.task.id)}
							highlighted={props.highlight === r.task.id}
							selected={props.selection.has(r.task.id)}
							dayGrouped={g.kind === "day"}
							tabbable={props.firstId === r.task.id}
						/>
					),
				)}
		</div>
	);
}

/** The group's rows with the inline new row ("new") at its place, if it belongs here. */
function withNewRow(g: Group, at: NewRowAt | null): (Row | "new")[] {
	if (!at) return g.rows;
	const anchor = at.after ?? at.parent?.id ?? null;
	if (anchor === null) {
		const here =
			g.list === at.list ||
			(g.kind === "plain" && g.rows.every((r) => r.task.list === at.list));
		return here ? [...g.rows, "new"] : g.rows;
	}
	const i = g.rows.findIndex((r) => r.task.id === anchor);
	if (i < 0) return g.rows;
	const depth = (g.rows[i] as Row).depth;
	let end = i + 1;
	while (end < g.rows.length && (g.rows[end] as Row).depth > depth) end++;
	return [...g.rows.slice(0, end), "new", ...g.rows.slice(end)];
}

/** The inline new row: Enter saves and opens the next sibling row, Enter on an empty row
 * closes it, Esc discards it, Tab / Shift+Tab nest and un-nest it. */
function NewRow() {
	const app = useApp();
	const at = useStore(app.newRowAt);
	const ref = useRef<HTMLInputElement>(null);
	const [busy, setBusy] = useState(false);
	useLayoutEffect(() => ref.current?.focus(), [at]);
	if (!at) return null;
	const all = app.tasks();
	const depthOf = (
		t: { parentUid: string | null; uid: string; list: string } | null,
	): number => {
		let d = 0;
		let p = t;
		const seen = new Set<string>();
		while (p?.parentUid && !seen.has(p.uid)) {
			seen.add(p.uid);
			const up = all.find((x) => x.uid === p?.parentUid && x.list === p?.list);
			if (!up) break;
			d++;
			p = up;
		}
		return d;
	};
	const tree = app.view.get().kind === "list" || app.view.get().kind === "all";
	const depth = tree && at.parent ? depthOf(at.parent) + 1 : 0;
	const close = () => app.newRowAt.set(null);
	return (
		<div
			class="row"
			role="row"
			aria-level={depth + 1}
			style={`--depth: ${Math.min(depth, MAX_INDENT)}`}
		>
			<div role="gridcell">
				<span class="check" aria-hidden="true">
					<span class="ring" />
				</span>
			</div>
			<div role="gridcell" class="body">
				<input
					ref={ref}
					class="rename"
					aria-label={
						at.parent ? `New subtask of “${at.parent.summary}”` : "New task"
					}
					placeholder={
						at.parent ? `Subtask of ${at.parent.summary}` : "New task"
					}
					disabled={busy}
					onKeyDown={async (e) => {
						const input = e.currentTarget;
						const v = input.value.trim();
						if (e.key === "Escape") {
							e.preventDefault();
							e.stopPropagation();
							close();
						} else if (e.key === "Enter") {
							e.preventDefault();
							if (!v) {
								close();
								return;
							}
							setBusy(true);
							const t = await app.createAt(at, v);
							setBusy(false);
							if (t) {
								input.value = "";
								app.newRowAt.set({ ...at, after: t.id });
							}
						} else if (e.key === "Tab") {
							e.preventDefault();
							if (!e.shiftKey && at.after !== null) {
								const above = app.task(at.after);
								if (above)
									app.newRowAt.set({
										list: at.list,
										parent: above,
										after: null,
									});
							} else if (e.shiftKey && at.parent) {
								const up =
									all.find(
										(x) => x.uid === at.parent?.parentUid && x.list === at.list,
									) ?? null;
								app.newRowAt.set({
									list: at.list,
									parent: up,
									after: at.parent.id,
								});
							}
						}
					}}
					onBlur={(e) => {
						if (!e.currentTarget.value.trim() && !busy) close();
					}}
				/>
			</div>
			<div role="gridcell" class="side" />
		</div>
	);
}

/** A list's colour for CSS; only #rrggbb[aa] from the server is used. */
export const listColor = (l: Pick<ListRecord, "color">) =>
	l.color && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(l.color)
		? l.color
		: "var(--ring)";

/** A list's colour as the `--dot` custom property. */
export const dotStyle = (l: Pick<ListRecord, "color">) =>
	`--dot: ${listColor(l)}`;

function TaskRow(props: {
	row: Row;
	list: ListRecord | undefined;
	mixed: boolean;
	lingering: boolean;
	highlighted: boolean;
	selected: boolean;
	dayGrouped?: boolean;
	tabbable?: boolean;
}) {
	const app = useApp();
	const { task: t, depth } = props.row;
	const done = t.status === "COMPLETED" || props.lingering;
	const renaming = useStore(app.renaming) === t.id;
	const setRenaming = (on: boolean) => app.renaming.set(on ? t.id : null);
	const z = app.today();
	const chip = dueChip(t, z, app.nowMinutes(), {
		inToday: app.view.get().kind === "today",
		dayGrouped: props.dayGrouped,
	});
	const readOnly = t.readOnly ?? app.writeBlock();
	const title = t.redacted ? "Busy" : t.summary || "(no title)";
	const onRowClick = (e: MouseEvent) => {
		app.touch();
		if (e.ctrlKey || e.metaKey) {
			app.toggleSelect(t.id);
			return;
		}
		if (e.shiftKey) {
			app.selectTo(t.id);
			return;
		}
		app.highlight.set(t.id);
	};
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: rows take their keys from the keymap (roving tabindex)
		<div
			class={[
				"row",
				done && "done",
				props.lingering && "lingering",
				props.highlighted && "hl",
			]
				.filter(Boolean)
				.join(" ")}
			role="row"
			data-id={t.id}
			aria-level={depth + 1}
			aria-expanded={
				props.row.expanded === null ? undefined : props.row.expanded
			}
			aria-selected={props.selected}
			aria-keyshortcuts={rowShortcuts(app.settings.get().singleKeyShortcuts)}
			tabIndex={props.highlighted || props.tabbable ? 0 : -1}
			style={`--depth: ${Math.min(depth, MAX_INDENT)}`}
			onClick={onRowClick}
			onDblClick={() => {
				if (!readOnly) setRenaming(true);
			}}
			onFocus={() => app.highlight.get() !== t.id && app.highlight.set(t.id)}
		>
			<div role="gridcell">
				{props.row.expanded !== null && (
					<button
						type="button"
						class="fold"
						tabIndex={-1}
						aria-label={props.row.expanded ? "Hide subtasks" : "Show subtasks"}
						onClick={(e) => {
							e.stopPropagation();
							app.toggleFold(`task:${t.id}`, !props.row.expanded);
						}}
					>
						<Chevron open={props.row.expanded} size={12} />
					</button>
				)}
				<button
					type="button"
					class="check"
					role="checkbox"
					aria-checked={done}
					aria-disabled={readOnly ? "true" : undefined}
					aria-label={`Complete: ${title}`}
					title={readOnly ?? undefined}
					data-status={t.status}
					tabIndex={-1}
					onClick={(e) => {
						e.stopPropagation();
						app.toggleDone(t.id);
					}}
				>
					<span class="ring">
						{t.status === "CANCELLED" ? (
							<Close size={12} />
						) : (
							<Check size={12} />
						)}
					</span>
				</button>
			</div>
			<div role="gridcell" class="body">
				{renaming ? (
					<Rename
						value={t.summary}
						onDone={(v) => {
							setRenaming(false);
							if (v?.trim() && v !== t.summary) app.rename(t.id, v.trim());
						}}
					/>
				) : (
					<span class="title" title={title}>
						{title}
					</span>
				)}
				{props.row.crumb && <span class="crumb">{props.row.crumb}</span>}
				<Meta
					row={props.row}
					list={props.list}
					mixed={props.mixed}
					chip={chip}
				/>
			</div>
			<div role="gridcell" class="side">
				{t.pinned && <Pin size={14} label="Pinned" />}
				{PRIORITY_BARS[t.priority] > 0 && (
					<span
						class="prio"
						role="img"
						aria-label={`${PRIORITY_LABEL[t.priority]} priority`}
					>
						{[1, 2, 3].map((n) => (
							<i key={n} class={n <= PRIORITY_BARS[t.priority] ? "on" : ""} />
						))}
					</span>
				)}
			</div>
		</div>
	);
}

function Meta(props: {
	row: Row;
	list: ListRecord | undefined;
	mixed: boolean;
	chip: ReturnType<typeof dueChip>;
}) {
	const t = props.row.task;
	const parts: JSX.Element[] = [];
	if (props.mixed && props.list)
		parts.push(
			<span key="list">
				<span
					class="list-dot"
					style={dotStyle(props.list)}
					aria-hidden="true"
				/>
				{props.list.name}
			</span>,
		);
	if (props.chip)
		parts.push(
			<span
				key="due"
				class={`tnum ${props.chip.tone === "late" ? "late" : props.chip.tone === "accent" ? "accent" : ""}`}
				title={props.chip.label}
			>
				{props.chip.text}
			</span>,
		);
	if (t.recurring)
		parts.push(
			<span key="rep" title={t.repeat?.text}>
				<Repeat label="Repeats" />
			</span>,
		);
	if (props.row.progress)
		parts.push(
			<span key="sub" class="tnum" title="Subtasks done">
				{props.row.progress.done}/{props.row.progress.total}
			</span>,
		);
	if (t.description && !t.redacted)
		parts.push(
			<span key="notes">
				<Notes label="Has notes" />
			</span>,
		);
	if (t.reminders.length)
		parts.push(
			<span key="bell">
				<Bell label="Has a reminder" />
			</span>,
		);
	if (t.tags.length)
		parts.push(
			<span key="tags">
				{t.tags
					.slice(0, 2)
					.map((g) => `#${g}`)
					.join(" ")}
				{t.tags.length > 2 ? ` +${t.tags.length - 2}` : ""}
			</span>,
		);
	if (t.readOnly)
		parts.push(
			<span key="lock" title={t.readOnly}>
				<Lock label="Can't be changed" />
			</span>,
		);
	if (props.row.doneKids > 0)
		parts.push(<span key="dk">{plural(props.row.doneKids, "done")}</span>);
	return parts.length ? <span class="meta">{parts}</span> : null;
}

function Rename(props: { value: string; onDone: (v: string | null) => void }) {
	const ref = useRef<HTMLInputElement>(null);
	// Enter, Esc or leaving ends it once: Esc unmounts the field, and the blur that follows
	// must not save what Esc cancelled.
	const ended = useRef(false);
	const end = (v: string | null) => {
		if (ended.current) return;
		ended.current = true;
		props.onDone(v);
	};
	useLayoutEffect(() => {
		ref.current?.focus();
		ref.current?.select();
	}, []);
	return (
		<input
			ref={ref}
			class="rename"
			aria-label="Task title"
			value={props.value}
			onKeyDown={(e) => {
				if (e.key === "Enter") {
					e.preventDefault();
					end(e.currentTarget.value);
				} else if (e.key === "Escape") {
					e.preventDefault();
					e.stopPropagation();
					end(null);
				}
			}}
			onBlur={(e) => end(e.currentTarget.value)}
			onClick={(e) => e.stopPropagation()}
		/>
	);
}

function EmptyState(props: { doneToday: number }) {
	const app = useApp();
	const v = app.view.get();
	const f = app.filter.get();
	const sync = useStore(app.syncState);
	const hasCache =
		app.ctx.store.meta.lastSync !== null || app.lists().length > 0;
	if (!hasCache && sync.running) return <Skeleton />;
	if (!hasCache && sync.error)
		return (
			<div class="empty-state error" role="status">
				<strong>No tasks to show yet.</strong>
				The banner above says why. Details are in the log
				(%LOCALAPPDATA%\desk-tasks\logs).
			</div>
		);
	const filtered = f.important || f.tags.length || f.text.trim();
	if (filtered) {
		const what = [
			f.important ? "Important" : "",
			...f.tags.map((t) => `#${t}`),
			f.text.trim() ? `“${f.text.trim()}”` : "",
		]
			.filter(Boolean)
			.join(" ");
		return (
			<div class="empty-state" role="status">
				<strong>
					No tasks match {what} in {app.viewTitle(v)}.
				</strong>
				<button
					type="button"
					class="text-btn"
					onClick={() => app.clearFilter()}
				>
					Clear filter
				</button>
			</div>
		);
	}
	if (v.kind === "today")
		return props.doneToday > 0 ? (
			<div class="empty-state" role="status">
				<strong>All done for today · {props.doneToday} completed.</strong>
			</div>
		) : (
			<div class="empty-state" role="status">
				<strong>Nothing due today.</strong>
				Press n to add a task.
			</div>
		);
	if (v.kind === "list") {
		const l = app.ctx.store.list(v.href);
		return (
			<div class="empty-state" role="status">
				<strong>No tasks in {l?.name ?? "this list"} yet.</strong>
				{l?.writable ? "Type below to add one." : ""}
			</div>
		);
	}
	if (v.kind === "upcoming")
		return (
			<div class="empty-state" role="status">
				<strong>Nothing coming up this week.</strong>
				Tasks with a due date after today show here.
			</div>
		);
	return (
		<div class="empty-state" role="status">
			<strong>No open tasks.</strong>
		</div>
	);
}

function Skeleton() {
	const [show, setShow] = useState(false);
	useEffect(() => {
		const t = setTimeout(() => setShow(true), 300);
		return () => clearTimeout(t);
	}, []);
	if (!show) return null;
	return (
		<div role="status" aria-label="Loading your tasks…">
			{[64, 48, 72].map((w) => (
				<div class="skeleton" key={w}>
					<i />
					<i style={{ width: `${w}%` }} />
				</div>
			))}
			<div class="empty-state">Loading your tasks…</div>
		</div>
	);
}
