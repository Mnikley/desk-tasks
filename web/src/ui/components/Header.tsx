// The header: view switcher ("Today ▾ 5"), stale warning, sync dot, quick-add and overflow
// buttons. The switcher popover lists views, then lists, then "New list…" and "Trash", filtered
// by typing.
import {
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "preact/hooks";
import { fmtClock, zoned } from "../../core/time.ts";
import { STALE_MS } from "../controller.ts";
import { paletteCommands } from "../keymap.ts";
import { type ViewId, viewKey } from "../model.ts";
import { useStore } from "../store.ts";
import { useApp } from "./context.ts";
import { Caret, Lock, More, Plus, Shared, Warning } from "./icons.tsx";
import { Scrim, useRestoreFocus } from "./Sheet.tsx";
import { dotStyle } from "./TaskList.tsx";
import { headerDrag } from "./WindowChrome.tsx";

export function Header(props: { onQuickAdd: () => void }) {
	const app = useApp();
	useStore(app.revision);
	const view = useStore(app.view);
	useStore(app.filter);
	useStore(app.now);
	const sync = useStore(app.syncState);
	const drag = useMemo(() => headerDrag(app), [app]);
	const open = useStore(app.switcherOpen);
	const [menu, setMenu] = useState(false);
	const known = app.ctx.store.meta.lastSync !== null || app.lists().length > 0;
	const total = view.kind === "trash" || !known ? null : app.model(view).total;
	const last = app.ctx.store.meta.lastSync;
	const stale = last !== null && app.now.get() - last > STALE_MS;
	const state = sync.running
		? "running"
		: sync.error
			? "error"
			: last
				? "ok"
				: "idle";
	const lastText = last ? fmtClock(zoned(last, app.ctx.tz).minutes) : null;
	const dotLabel = sync.running
		? "Syncing…"
		: sync.error
			? sync.error.message
			: lastText
				? `Synced at ${lastText}`
				: "Not synced yet";
	return (
		<header class="bar" {...drag}>
			<button
				type="button"
				class="switcher-btn"
				aria-haspopup="dialog"
				aria-expanded={!!open}
				aria-keyshortcuts="Control+K"
				onClick={() => app.switcherOpen.set(open ? false : "switcher")}
			>
				<span class="name">{app.viewTitle(view)}</span>
				<Caret />
				{total !== null && (
					<span class="count tnum">
						<span aria-hidden="true">{total}</span>
						<span class="sr-only">{total} open tasks</span>
					</span>
				)}
			</button>
			<span class="grow" />
			{stale && lastText && (
				<span class="stale" title="Nextcloud hasn't answered for a while.">
					<Warning size={12} /> Last synced {lastText}
				</span>
			)}
			<SyncDot state={state} label={dotLabel} />
			<button
				type="button"
				class="icon-btn"
				aria-label="Add a task"
				title="Add a task (N)"
				aria-keyshortcuts="N"
				onClick={props.onQuickAdd}
			>
				<Plus />
			</button>
			<button
				type="button"
				class="icon-btn"
				aria-label="More"
				aria-haspopup="menu"
				aria-expanded={menu}
				onClick={() => setMenu(!menu)}
			>
				<More />
			</button>
			{open && (
				<Switcher
					palette={open === "palette"}
					onClose={() => app.switcherOpen.set(false)}
				/>
			)}
			{menu && <Overflow onClose={() => setMenu(false)} />}
		</header>
	);
}

/** The sync dot shows its spinner only after 300 ms, so quick syncs don't flicker. */
function SyncDot(props: { state: string; label: string }) {
	const app = useApp();
	const [late, setLate] = useState(false);
	useEffect(() => {
		if (props.state !== "running") {
			setLate(false);
			return;
		}
		const t = setTimeout(() => setLate(true), 300);
		return () => clearTimeout(t);
	}, [props.state]);
	const shown = props.state === "running" && !late ? "ok" : props.state;
	return (
		<button
			type="button"
			class="sync-dot"
			data-state={shown}
			title={`${props.label} · Sync now (F5)`}
			aria-label={props.label}
			aria-keyshortcuts="F5"
			onClick={() => void app.syncNow(true)}
		>
			<i />
		</button>
	);
}

export interface SwitchEntry {
	key: string;
	label: string;
	view?: ViewId;
	run?: () => void;
	count?: number;
	color?: string | null;
	readOnly?: boolean;
	shared?: boolean;
	hint?: string;
}

/** The switcher's entries in order: views, lists, then commands. */
export function switcherEntries(app: ReturnType<typeof useApp>): SwitchEntry[] {
	const views: SwitchEntry[] = (
		[{ kind: "today" }, { kind: "upcoming" }, { kind: "all" }] as ViewId[]
	).map((v) => ({
		key: viewKey(v),
		label: app.viewTitle(v),
		view: v,
		count: app.model(v).total,
	}));
	const lists: SwitchEntry[] = app.lists().map((l) => ({
		key: `list:${l.href}`,
		label: l.name,
		view: { kind: "list", href: l.href },
		count: app.model({ kind: "list", href: l.href }).total,
		color: l.color,
		readOnly: !l.writable,
		shared: l.shared,
		hint: l.shared
			? `Shared by ${l.ownerName ?? "someone"}${l.writable ? " · Can edit" : " · View only"}`
			: undefined,
	}));
	const commands: SwitchEntry[] = [
		{
			key: "new-list",
			label: "New list…",
			run: () => app.sheet.set({ kind: "new-list" }),
		},
		{ key: "trash", label: "Trash", view: { kind: "trash" } },
	];
	return [...views, ...lists, ...commands];
}

function Switcher(props: { palette: boolean; onClose: () => void }) {
	const app = useApp();
	useRestoreFocus();
	const [q, setQ] = useState("");
	const [at, setAt] = useState(0);
	const input = useRef<HTMLInputElement>(null);
	useLayoutEffect(() => input.current?.focus(), []);
	const all = [
		...switcherEntries(app),
		...(props.palette
			? paletteCommands(app).map(
					(c): SwitchEntry => ({
						key: `cmd:${c.label}`,
						label: c.label,
						run: c.run,
						hint: c.key,
					}),
				)
			: []),
	];
	const shown = q.trim()
		? all.filter((e) => e.label.toLowerCase().includes(q.trim().toLowerCase()))
		: all;
	const current = viewKey(app.view.get());
	/** Ctrl+1…9 go to the first nine views and lists, unfiltered. */
	const jumps = all
		.filter((e) => e.view && e.key !== "trash")
		.map((e) => e.key);
	const pick = (e: SwitchEntry | undefined) => {
		if (!e) return;
		props.onClose();
		if (e.view) app.setView(e.view);
		else e.run?.();
	};
	let lastGroup = "";
	return (
		<>
			<Scrim onClose={props.onClose} clear />
			<div
				class="popover"
				role="dialog"
				aria-label="Go to"
				style="top: 40px; left: 8px; right: 8px; z-index: 32"
				onKeyDown={(e) => {
					if (e.key === "Escape") {
						e.preventDefault();
						e.stopPropagation();
						props.onClose();
					} else if (e.key === "ArrowDown") {
						e.preventDefault();
						setAt((a) => Math.min(shown.length - 1, a + 1));
					} else if (e.key === "ArrowUp") {
						e.preventDefault();
						setAt((a) => Math.max(0, a - 1));
					} else if (e.key === "Enter") {
						e.preventDefault();
						pick(shown[at]);
					}
				}}
			>
				<input
					ref={input}
					class="filter-input"
					role="combobox"
					aria-expanded="true"
					aria-controls="switcher-list"
					aria-autocomplete="list"
					aria-activedescendant={shown[at] ? `sw-${at}` : undefined}
					placeholder={
						props.palette
							? "Type a command, view or list"
							: "Go to a view or list"
					}
					aria-label={
						props.palette
							? "Find a command, view or list"
							: "Filter views and lists"
					}
					value={q}
					onInput={(e) => {
						setQ(e.currentTarget.value);
						setAt(0);
					}}
				/>
				<div role="listbox" id="switcher-list" aria-label="Views and lists">
					{shown.map((e, i) => {
						const group =
							e.view?.kind === "list"
								? "lists"
								: e.view && e.key !== "trash"
									? "views"
									: e.key.startsWith("cmd:")
										? "commands"
										: "more";
						const sep = lastGroup && group !== lastGroup;
						lastGroup = group;
						return (
							<div key={e.key}>
								{sep && <div class="menu-sep" />}
								<button
									type="button"
									role="option"
									id={`sw-${i}`}
									tabIndex={-1}
									class="menu-item"
									aria-selected={i === at}
									aria-current={e.key === current ? "page" : undefined}
									title={e.key.startsWith("cmd:") ? undefined : e.hint}
									data-drop-list={
										e.view?.kind === "list" && !e.readOnly
											? e.view.href
											: undefined
									}
									onMouseEnter={() => setAt(i)}
									onClick={() => pick(e)}
								>
									{e.view?.kind === "list" && (
										<span
											class="list-dot"
											style={dotStyle({ color: e.color ?? null })}
										/>
									)}
									<span class="grow">{e.label}</span>
									{e.shared && <Shared size={14} label="Shared" />}
									{e.readOnly && <Lock size={14} label="View only" />}
									{e.count !== undefined && e.count > 0 && (
										<span class="n tnum">{e.count}</span>
									)}
									{jumps.indexOf(e.key) >= 0 && jumps.indexOf(e.key) < 9 && (
										<kbd>Ctrl+{jumps.indexOf(e.key) + 1}</kbd>
									)}
									{e.key.startsWith("cmd:") && e.hint && <kbd>{e.hint}</kbd>}
								</button>
							</div>
						);
					})}
					{!shown.length && (
						<div class="menu-label">Nothing matches “{q}”.</div>
					)}
				</div>
			</div>
		</>
	);
}

function Overflow(props: { onClose: () => void }) {
	const app = useApp();
	useRestoreFocus();
	const showDone = useStore(app.showDone);
	const v = app.view.get();
	const items: { label: string; key?: string; run: () => void }[] = [
		{ label: "Sync now", key: "F5", run: () => void app.syncNow(true) },
		{
			label: showDone ? "Hide completed" : "Show completed",
			key: "H",
			run: () => app.showDone.set(!showDone),
		},
		{ label: "Filter…", key: "Ctrl+F", run: () => app.filterOpen.set(true) },
		...(v.kind === "list"
			? [
					{
						label: "List settings…",
						run: () => app.sheet.set({ kind: "list", href: v.href }),
					},
				]
			: []),
		{
			label: "Keyboard shortcuts",
			key: "?",
			run: () => app.sheet.set({ kind: "shortcuts" }),
		},
		{ label: "Settings", run: () => app.sheet.set({ kind: "settings" }) },
	];
	return (
		<>
			<Scrim onClose={props.onClose} clear />
			<div
				class="popover"
				role="menu"
				style="top: 40px; right: 8px; z-index: 32"
				onKeyDown={(e) => {
					const items = [
						...e.currentTarget.querySelectorAll<HTMLElement>("[role=menuitem]"),
					];
					const at = items.indexOf(document.activeElement as HTMLElement);
					const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
					if (step) {
						e.preventDefault();
						items[(at + step + items.length) % items.length]?.focus();
						return;
					}
					if (e.key === "Home" || e.key === "End") {
						e.preventDefault();
						(e.key === "Home" ? items[0] : items.at(-1))?.focus();
						return;
					}
					if (e.key === "Escape") {
						e.stopPropagation();
						props.onClose();
					}
				}}
			>
				{items.map((it, i) => (
					<button
						key={it.label}
						type="button"
						role="menuitem"
						class="menu-item"
						ref={(el) => {
							if (i === 0) el?.focus();
						}}
						onClick={() => {
							props.onClose();
							it.run();
						}}
					>
						<span class="grow">{it.label}</span>
						{it.key && <kbd>{it.key}</kbd>}
					</button>
				))}
			</div>
		</>
	);
}

/** Under the bar in a list view: its colour, and who shares it with what access. */
export function ListHeader() {
	const app = useApp();
	useStore(app.revision);
	const view = useStore(app.view);
	if (view.kind !== "list") return null;
	const l = app.ctx.store.list(view.href);
	if (!l) return null;
	const sharedWith =
		!l.shared && l.sharees.length
			? `Shared with ${l.sharees.map((s) => s.name).join(", ")}`
			: null;
	const text = l.shared
		? `Shared by ${l.ownerName ?? "someone"} · ${l.writable ? "Can edit" : "View only"}`
		: l.appGenerated
			? "Deck board · view only"
			: sharedWith;
	return (
		<div class="list-head" style={dotStyle(l)}>
			<span class="list-bar" aria-hidden="true" />
			{text && (
				<span class="list-note">
					{!l.writable && <Lock size={12} label="View only" />}
					{l.shared && l.writable && <Shared size={12} />}
					{!l.shared && sharedWith && <Shared size={12} />}
					{text}
				</span>
			)}
		</div>
	);
}
