// A list's settings sheet: rename (per user on a list shared with me), colour, notify and
// "show in Today", sharing (owner), delete (owner) or leave (shared with me); and the
// "New list" sheet (spec "Lists", "Sharing").
import { useEffect, useState } from "preact/hooks";
import type { Sharee } from "../../core/caldav.ts";
import { attempt } from "../../core/ctx.ts";
import {
	changeList,
	createList,
	deleteList,
	leaveList,
	restoreList,
} from "../../core/lists.ts";
import {
	searchSharees,
	setAccess,
	share,
	skippedText,
	unshare,
} from "../../core/sharing.ts";
import { ownerOf } from "../../core/tasks.ts";
import { plural } from "../controller.ts";
import { useStore } from "../store.ts";
import { useApp } from "./context.ts";
import { Close, Lock } from "./icons.tsx";
import { SheetFrame } from "./Sheet.tsx";

/** List colours: distinct in both themes, Nextcloud's blue first. */
export const COLORS = [
	"#0082c9",
	"#3a5bd9",
	"#7b4fc9",
	"#c2368a",
	"#d0476a",
	"#d4572d",
	"#b8860b",
	"#7f9a1a",
	"#2e9e5b",
	"#0e9484",
	"#5c6b7a",
];

function Swatches(props: {
	value: string;
	onPick: (c: string) => void;
	disabled?: boolean;
}) {
	return (
		<div
			role="radiogroup"
			aria-label="Colour"
			style="display: flex; flex-wrap: wrap; gap: 6px"
		>
			{COLORS.map((c) => (
				<button
					key={c}
					type="button"
					role="radio"
					aria-checked={props.value.toLowerCase() === c}
					aria-label={`Colour ${c}`}
					disabled={props.disabled}
					onClick={() => props.onPick(c)}
					style={`width: 24px; height: 24px; border-radius: 50%; background: ${c}; box-shadow: ${props.value.toLowerCase() === c ? "0 0 0 2px var(--surface), 0 0 0 4px var(--ink)" : "none"}`}
				/>
			))}
		</div>
	);
}

export function NewListSheet(props: { onClose: () => void }) {
	const app = useApp();
	const [name, setName] = useState(app.lists().length ? "" : "Tasks");
	const [color, setColor] = useState(COLORS[0] as string);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const make = async () => {
		if (!name.trim()) {
			setError("Give the list a name.");
			return;
		}
		setBusy(true);
		const r = await attempt(() =>
			createList(app.ctx, { name: name.trim(), color }),
		);
		setBusy(false);
		if (!r.ok) {
			setError(r.error.message);
			return;
		}
		props.onClose();
		app.toast(`Created “${name.trim()}”.`);
		app.setView({ kind: "list", href: r.value });
	};
	return (
		<SheetFrame
			title="New list"
			onClose={props.onClose}
			foot={
				<>
					<span class="grow" />
					<button type="button" class="btn" onClick={props.onClose}>
						Cancel
					</button>
					<button
						type="button"
						class="btn primary"
						disabled={busy}
						onClick={() => void make()}
					>
						Create list
					</button>
				</>
			}
		>
			<div class="field">
				<label for="nl-name">Name</label>
				<input
					id="nl-name"
					data-autofocus
					class="input"
					value={name}
					onInput={(e) => {
						setName(e.currentTarget.value);
						setError(null);
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							void make();
						}
					}}
				/>
			</div>
			<div class="field">
				<span class="label">Colour</span>
				<Swatches value={color} onPick={setColor} />
			</div>
			{error && (
				<p class="error-text" role="alert">
					{error}
				</p>
			)}
			<p class="help">
				The list is created in Nextcloud for tasks only; your calendars don't
				show it.
			</p>
		</SheetFrame>
	);
}

export function ListSheet(props: { href: string; onClose: () => void }) {
	const app = useApp();
	useStore(app.revision);
	const settings = useStore(app.settings);
	const l = app.ctx.store.list(props.href);
	const [name, setName] = useState(l?.name ?? "");
	const [error, setError] = useState<string | null>(null);
	if (!l)
		return (
			<SheetFrame title="List" onClose={props.onClose}>
				<div class="empty-state">This list isn't here any more.</div>
			</SheetFrame>
		);
	const flags = settings.lists[l.href] ?? {};
	const shownNow = flags.shown ?? !l.appGenerated;
	const notifyNow = flags.notify ?? true;
	const setFlag = (k: "shown" | "notify", v: boolean) =>
		void app.saveSettings({
			lists: { ...settings.lists, [l.href]: { ...flags, [k]: v } },
		});
	const rename = async () => {
		const n = name.trim();
		if (!n || n === l.name) return;
		const r = await attempt(() => changeList(app.ctx, l.href, { name: n }));
		if (!r.ok) setError(r.error.message);
		else
			app.toast(
				l.shared ? `Renamed to “${n}” (only for you)` : `Renamed to “${n}”`,
			);
	};
	const recolor = async (color: string) => {
		const r = await attempt(() => changeList(app.ctx, l.href, { color }));
		if (!r.ok) setError(r.error.message);
	};
	const count = app.tasks().filter((t) => t.list === l.href).length;
	const owner = ownerOf(l);
	const remove = async () => {
		if (l.shared) {
			if (
				!(await app.confirm(
					`Leave “${l.name}”? ${owner} still has it; ${owner} can share it with you again.`,
					"Leave list",
				))
			)
				return;
			const r = await attempt(() => leaveList(app.ctx, l.href));
			if (!r.ok) return setError(r.error.message);
			props.onClose();
			app.toast(`Left “${l.name}”.`);
			return;
		}
		if (l.components.includes("VEVENT")) {
			setError(
				`“${l.name}” also holds calendar events. Delete it in Nextcloud Calendar if you're sure.`,
			);
			return;
		}
		if (
			!(await app.confirm(
				`Delete “${l.name}” and its ${plural(count, "task")}? You can restore it from the trash for 30 days.`,
				"Delete list",
			))
		)
			return;
		const r = await attempt(() => deleteList(app.ctx, l.href));
		if (!r.ok) return setError(r.error.message);
		props.onClose();
		app.toast(`Deleted “${l.name}”.`, {
			ms: 6000,
			actions: [
				{
					label: "Undo",
					run: async () => {
						const back = await attempt(() => restoreList(app.ctx, l.href));
						if (!back.ok) app.failed(back.error);
						else app.toast(`Restored “${l.name}”.`);
					},
				},
			],
		});
	};
	return (
		<SheetFrame title={`${l.name} · list`} onClose={props.onClose}>
			{l.shared && (
				<p
					class="help"
					style="display: flex; gap: 6px; align-items: center; margin-top: 0"
				>
					{!l.writable && <Lock size={14} />} Shared by {owner} ·{" "}
					{l.writable ? "Can edit" : "View only"}
				</p>
			)}
			<div class="field">
				<label for="ls-name">{l.shared ? "Name (only for you)" : "Name"}</label>
				<input
					id="ls-name"
					class="input"
					value={name}
					onInput={(e) => {
						setName(e.currentTarget.value);
						setError(null);
					}}
					onBlur={() => void rename()}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							void rename();
						}
					}}
				/>
			</div>
			<div class="field">
				<span class="label">Colour{l.shared ? " (only for you)" : ""}</span>
				<Swatches value={l.color ?? ""} onPick={(c) => void recolor(c)} />
			</div>
			{error && (
				<p class="error-text" role="alert">
					{error}
				</p>
			)}
			<div class="section">
				<label class="toggle-row">
					<span>Show in Today, Upcoming and All</span>
					<input
						type="checkbox"
						role="switch"
						aria-checked={shownNow}
						class="switch"
						checked={shownNow}
						onChange={(e) => setFlag("shown", e.currentTarget.checked)}
					/>
				</label>
				<label class="toggle-row">
					<span>Reminders for this list</span>
					<input
						type="checkbox"
						role="switch"
						aria-checked={notifyNow}
						class="switch"
						checked={notifyNow}
						onChange={(e) => setFlag("notify", e.currentTarget.checked)}
					/>
				</label>
			</div>
			<div class="section">
				<h3>Shared with</h3>
				{l.shared ? (
					<p class="help">Only {owner} can share this list.</p>
				) : l.canShare ? (
					<Sharing href={l.href} />
				) : (
					<p class="help">This list can't be shared.</p>
				)}
			</div>
			<div class="section">
				<button type="button" class="btn danger" onClick={() => void remove()}>
					{l.shared ? "Leave list" : "Delete list"}
				</button>
			</div>
		</SheetFrame>
	);
}

function Sharing(props: { href: string }) {
	const app = useApp();
	useStore(app.revision);
	const l = app.ctx.store.list(props.href);
	const [q, setQ] = useState("");
	const [found, setFound] = useState<
		{ href: string; name: string; kind: "user" | "group" }[]
	>([]);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		if (q.trim().length < 2) {
			setFound([]);
			return;
		}
		const t = setTimeout(async () => {
			const r = await attempt(() => searchSharees(app.ctx, props.href, q));
			if (r.ok) setFound(r.value);
		}, 250);
		return () => clearTimeout(t);
	}, [q]);
	if (!l) return null;
	const run = async (f: () => Promise<{ skipped: string[] }>) => {
		setBusy(true);
		setError(null);
		const r = await attempt(f);
		setBusy(false);
		if (!r.ok) setError(r.error.message);
		else if (r.value.skipped.length)
			setError(r.value.skipped.map(skippedText).join(" "));
	};
	return (
		<div>
			{l.sharees.map((s: Sharee) => (
				<div key={s.href} class="toggle-row" style="gap: 8px">
					<span style="display: flex; align-items: center; gap: 8px; min-width: 0">
						<span
							aria-hidden="true"
							style="width: 24px; height: 24px; border-radius: 50%; background: var(--surface-sunken); display: grid; place-items: center; font-size: 12px; font-weight: 600; flex: none"
						>
							{s.name.slice(0, 1).toUpperCase()}
						</span>
						<span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
							{s.name}{" "}
							<span class="help">{s.kind === "group" ? "group" : "user"}</span>
						</span>
					</span>
					<span style="display: flex; align-items: center; gap: 4px; flex: none">
						<select
							class="input"
							style="width: auto"
							aria-label={`Access for ${s.name}`}
							disabled={busy}
							value={s.access}
							onChange={(e) =>
								void run(() =>
									setAccess(
										app.ctx,
										l.href,
										s,
										e.currentTarget.value === "read-write",
									),
								)
							}
						>
							<option value="read">View only</option>
							<option value="read-write">Can edit</option>
						</select>
						<button
							type="button"
							class="icon-btn"
							aria-label={`Stop sharing with ${s.name}`}
							disabled={busy}
							onClick={() => void run(() => unshare(app.ctx, l.href, s))}
						>
							<Close />
						</button>
					</span>
				</div>
			))}
			{!l.sharees.length && <p class="help">Not shared with anyone.</p>}
			<input
				class="input"
				placeholder="Add people or groups"
				aria-label="Add people or groups to share with"
				value={q}
				onInput={(e) => setQ(e.currentTarget.value)}
			/>
			{found.length > 0 && (
				<div
					role="listbox"
					aria-label="People and groups"
					style="margin-top: 4px"
				>
					{found.map((f) => (
						<button
							key={f.href}
							type="button"
							role="option"
							class="menu-item"
							disabled={busy}
							onClick={() => {
								setQ("");
								setFound([]);
								void run(() => share(app.ctx, l.href, [f]));
							}}
						>
							<span class="grow">{f.name}</span>
							<span class="n">
								{f.kind === "group" ? "group" : "user"} · view only
							</span>
						</button>
					))}
				</div>
			)}
			{q.trim().length >= 2 && !found.length && (
				<p class="help">Nobody found for “{q.trim()}”.</p>
			)}
			{error && (
				<p class="error-text" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}
