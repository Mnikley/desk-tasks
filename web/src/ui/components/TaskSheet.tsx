// The detail sheet (Enter or a click on the title area): borderless title, a chip row whose
// popovers write at once (each undoable), notes with clickable links, subtasks, "More"
// (location, URL, privacy), and the origin footer. The text fields are a draft: Save
// (Ctrl+Enter) sends one PUT with only what changed; leaving with changes keeps them in a
// one-slot "Restore" toast; the draft rebases onto a fresher version from Nextcloud.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { compareManual } from "../../core/order.ts";
import type { TaskView } from "../../core/tasks.ts";
import { fmtClock, fmtDayShort, zoned } from "../../core/time.ts";
import type { Change } from "../../core/write.ts";
import { PRIORITY_LABEL, STATUS_LABEL } from "../../logic/tasklogic.ts";
import { dueWords, type PopoverKind, plural } from "../controller.ts";
import { useStore } from "../store.ts";
import { useApp } from "./context.ts";
import { Check, Lock } from "./icons.tsx";
import { SheetFrame } from "./Sheet.tsx";
import { dotStyle } from "./TaskList.tsx";

interface Draft {
	summary: string;
	description: string;
	location: string;
	url: string;
	klass: "PUBLIC" | "CONFIDENTIAL" | "PRIVATE";
}

const draftOf = (t: TaskView): Draft => ({
	summary: t.summary,
	description: t.description,
	location: t.location,
	url: t.url,
	klass:
		t.klass === "CONFIDENTIAL" || t.klass === "PRIVATE" ? t.klass : "PUBLIC",
});

const changeOf = (base: Draft, d: Draft): Change => {
	const c: Change = {};
	for (const k of Object.keys(d) as (keyof Draft)[])
		if (d[k] !== base[k]) (c as Record<string, unknown>)[k] = d[k];
	return c;
};

/** `fresh` with every field the user changed (from `base`) kept as typed. */
const rebaseDraft = (fresh: Draft, base: Draft, d: Draft): Draft => {
	const out = { ...fresh };
	for (const k of Object.keys(d) as (keyof Draft)[])
		if (d[k] !== base[k]) (out as Record<string, unknown>)[k] = d[k];
	return out;
};

const URL_RE = /\b(https?:\/\/[^\s<>"]+|mailto:[^\s<>"]+)/g;

export function TaskSheet(props: {
	id: number;
	/** Opened from the Restore toast: the unsaved draft comes back. */
	restore?: boolean;
	onClose: () => void;
}) {
	const app = useApp();
	useStore(app.revision);
	// Offline or paused makes the fields read-only too, with the reason.
	useStore(app.syncState);
	const t = app.task(props.id);
	const restored = app.restoreSlot.get();
	const [base, setBase] = useState<Draft | null>(t ? draftOf(t) : null);
	const [draft, setDraft] = useState<Draft | null>(
		t
			? props.restore && restored?.id === props.id
				? rebaseDraft(
						draftOf(t),
						restored.base as Draft,
						restored.draft as Draft,
					)
				: draftOf(t)
			: null,
	);
	const [saving, setSaving] = useState(false);
	const [more, setMore] = useState(false);
	const [editNotes, setEditNotes] = useState(false);
	const title = useRef<HTMLTextAreaElement>(null);

	// A fresher version from Nextcloud: the fields not touched in the draft follow it.
	const fresh = t ? draftOf(t) : null;
	const freshKey = JSON.stringify(fresh);
	useEffect(() => {
		if (!fresh || !base || !draft) return;
		if (JSON.stringify(base) === freshKey) return;
		setDraft(rebaseDraft(fresh, base, draft));
		setBase(fresh);
	}, [freshKey]);
	useEffect(() => {
		if (props.restore && restored?.id === props.id) app.restoreSlot.set(null);
		autoGrow(title.current);
	}, []);
	// However the sheet goes away (Esc, another sheet over it, a reminder opening a task),
	// unsaved changes go to the Restore slot, unless they were saved.
	const latest = useRef<{
		dirty: boolean;
		summary: string;
		base: Draft | null;
		draft: Draft | null;
	}>({ dirty: false, summary: "", base: null, draft: null });
	const saved = useRef(false);
	useEffect(
		() => () => {
			const l = latest.current;
			if (l.dirty && !saved.current && l.base && l.draft)
				app.keepForRestore(props.id, l.summary, l.base, l.draft);
		},
		[],
	);

	if (!t || !draft || !base) {
		return (
			<SheetFrame title="Task" onClose={props.onClose}>
				<div class="empty-state">This task isn't here any more.</div>
			</SheetFrame>
		);
	}
	const readOnly = app.blockOf(t);
	const change = changeOf(base, draft);
	const dirty = Object.keys(change).length > 0;
	latest.current = { dirty, summary: t.summary, base, draft };
	const list = app.ctx.store.list(t.list);
	const kids = app
		.tasks()
		.filter((k) => k.parentUid === t.uid && k.list === t.list)
		.sort(compareManual);

	const save = async () => {
		if (!dirty) {
			props.onClose();
			return;
		}
		if (!draft.summary.trim()) return;
		if (
			change.klass === "PRIVATE" &&
			list?.shared === false &&
			list.sharees.length
		) {
			if (
				!(await app.confirm(
					`Private tasks are hidden from everyone you share “${list.name}” with.`,
					"Make private",
				))
			)
				return;
		}
		if (change.klass === "PRIVATE" && list?.shared) {
			if (
				!(await app.confirm(
					`Private tasks are hidden from everyone you share “${list.name}” with, including you, once saved.`,
					"Make private",
				))
			)
				return;
		}
		setSaving(true);
		const ok = await app.change(
			[t],
			{
				...change,
				...(change.summary !== undefined
					? { summary: change.summary.trim() }
					: {}),
			},
			() => "Saved",
		);
		setSaving(false);
		// Not saved (blocked, refused, a conflict): the sheet stays with the edit in it.
		if (!ok) return;
		saved.current = true;
		props.onClose();
	};
	const leave = () => props.onClose();
	const set = (p: Partial<Draft>) => setDraft({ ...draft, ...p });
	const chip = (
		label: string,
		value: string | null,
		kind: PopoverKind,
		keyHint: string,
	) => (
		<button
			type="button"
			class={value ? "chip" : "chip empty"}
			disabled={!!readOnly}
			title={`${label} (${keyHint} in the list)`}
			onClick={() => app.popover.set({ kind, id: t.id })}
		>
			{value ?? label}
		</button>
	);
	const today = app.today();
	const dueText = t.due
		? `${cap(dueWords(t.due.date, today))}${t.due.minutes !== null ? ` ${fmtClock(t.due.minutes)}` : ""}`
		: null;
	const startText = t.start ? `Starts ${dueWords(t.start.date, today)}` : null;
	const remindText =
		t.reminders.length === 1
			? (t.reminders[0]?.label ?? null)
			: t.reminders.length
				? plural(t.reminders.length, "reminder")
				: null;
	return (
		<SheetFrame
			title={t.readOnly ? "Task (view only)" : "Task"}
			onClose={leave}
			onKeyDown={(e) => {
				if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
					e.preventDefault();
					void save();
				}
			}}
			foot={
				<>
					<span class="grow">{footer(app, t)}</span>
					{!readOnly && (
						<>
							<button
								type="button"
								class="btn danger"
								onClick={async () => {
									const subs = kids.length;
									if (
										await app.confirm(
											`Delete “${t.summary}”${subs ? ` and its ${plural(subs, "subtask")}` : ""}?`,
											"Delete",
										)
									) {
										props.onClose();
										await app.deleteTasks([t]);
									}
								}}
							>
								Delete
							</button>
							<button
								type="button"
								class="btn primary"
								disabled={saving || !draft.summary.trim()}
								onClick={() => void save()}
								title="Save (Ctrl+Enter)"
								aria-keyshortcuts="Control+Enter"
							>
								{dirty ? "Save" : "Done"}
							</button>
						</>
					)}
				</>
			}
		>
			<div>
				{readOnly && (
					<p
						class="help"
						style="display: flex; gap: 6px; align-items: center; margin-top: 0"
					>
						<Lock size={14} /> {readOnly}
					</p>
				)}
				<textarea
					ref={title}
					data-autofocus
					class="rename"
					rows={1}
					aria-label="Title"
					readOnly={!!readOnly}
					value={t.redacted ? "Busy" : draft.summary}
					style="font-size: 16px; line-height: 22px; font-weight: 600; resize: none; box-shadow: none; overflow: hidden; margin-bottom: 8px"
					onInput={(e) => {
						set({ summary: e.currentTarget.value.replace(/\n/g, " ") });
						autoGrow(e.currentTarget);
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.ctrlKey) {
							e.preventDefault();
							void save();
						}
					}}
				/>
				{!draft.summary.trim() && (
					<div class="error-text">Add what the task is.</div>
				)}
				<div style="display: flex; flex-wrap: wrap; gap: 4px">
					<button
						type="button"
						class="chip"
						disabled={!!readOnly}
						title="Move to list (/)"
						onClick={() => app.popover.set({ kind: "list", id: t.id })}
					>
						{list && <span class="list-dot" style={dotStyle(list)} />}
						{list?.name ?? "List"}
					</button>
					{chip("Due", dueText, "due", "D")}
					{chip("Start", startText, "start", "Shift+D")}
					{chip(
						"Repeat",
						t.repeat ? `↻ ${t.repeat.text}` : null,
						"repeat",
						"R",
					)}
					{chip(
						"Remind me",
						remindText
							? `Remind ${remindText.charAt(0).toLowerCase()}${remindText.slice(1)}`
							: null,
						"reminder",
						"A",
					)}
					{chip(
						"Priority",
						t.priority === "none"
							? null
							: `${PRIORITY_LABEL[t.priority]} priority`,
						"priority",
						"1–4",
					)}
					{chip(
						"Tags",
						t.tags.length ? t.tags.map((g) => `#${g}`).join(" ") : null,
						"tags",
						"#",
					)}
					<StatusChip task={t} />
					<button
						type="button"
						class="chip"
						disabled={!!readOnly}
						aria-pressed={t.pinned}
						title="Pin (P)"
						onClick={() => app.togglePin([t])}
					>
						{t.pinned ? "Pinned" : "Pin"}
					</button>
				</div>

				<div class="section">
					<h3>Notes</h3>
					{editNotes || !draft.description ? (
						<textarea
							class="textarea"
							aria-label="Notes"
							readOnly={!!readOnly}
							placeholder={readOnly ? "No notes" : "Add notes"}
							value={t.redacted ? "" : draft.description}
							onInput={(e) => {
								set({ description: e.currentTarget.value });
								autoGrow(e.currentTarget);
							}}
							ref={(el) => {
								autoGrow(el);
								if (
									editNotes &&
									el &&
									document.activeElement !== el &&
									!el.dataset.focused
								) {
									el.dataset.focused = "1";
									el.focus();
								}
							}}
							onBlur={() => setEditNotes(false)}
						/>
					) : (
						<>
							{/* Plain text with real links; editing is a button of its own. */}
							<div
								class="textarea notes-read"
								style="white-space: pre-wrap; min-height: 0"
							>
								<Linked text={draft.description} />
							</div>
							{!readOnly && (
								<button
									type="button"
									class="text-btn"
									style="padding: 0; margin-top: 4px"
									onClick={() => setEditNotes(true)}
								>
									Edit notes
								</button>
							)}
						</>
					)}
				</div>

				<Subtasks task={t} kids={kids} />

				<div class="section">
					<button
						type="button"
						class="text-btn"
						style="padding: 0"
						aria-expanded={more}
						onClick={() => setMore(!more)}
					>
						{more ? "Less" : "More: location, link, privacy"}
					</button>
					{more && (
						<div style="margin-top: 8px">
							<div class="field">
								<label for="ts-loc">Location</label>
								<input
									id="ts-loc"
									class="input"
									readOnly={!!readOnly}
									value={draft.location}
									onInput={(e) => set({ location: e.currentTarget.value })}
								/>
							</div>
							<div class="field">
								<label for="ts-url">Link</label>
								<input
									id="ts-url"
									class="input"
									readOnly={!!readOnly}
									value={draft.url}
									placeholder="https://"
									onInput={(e) => set({ url: e.currentTarget.value })}
								/>
							</div>
							<div class="field">
								<label for="ts-class">Privacy</label>
								<select
									id="ts-class"
									class="input"
									disabled={!!readOnly}
									value={draft.klass}
									onChange={(e) =>
										set({ klass: e.currentTarget.value as Draft["klass"] })
									}
								>
									<option value="PUBLIC">Public</option>
									<option value="CONFIDENTIAL">
										Show as busy (confidential)
									</option>
									<option value="PRIVATE">Private</option>
								</select>
								<span class="help">
									Applies to people you share the list with.
								</span>
							</div>
						</div>
					)}
				</div>
			</div>
		</SheetFrame>
	);
}

function StatusChip(props: { task: TaskView }) {
	const app = useApp();
	const t = props.task;
	const next =
		t.status === "IN-PROCESS" ? 0 : t.status === "NEEDS-ACTION" ? 50 : null;
	return (
		<button
			type="button"
			class="chip"
			disabled={!!app.blockOf(t) || next === null}
			title={
				next === null
					? undefined
					: next
						? "Mark as in progress"
						: "Mark as not started"
			}
			onClick={() =>
				next !== null &&
				void app.change([t], { progress: next }, () =>
					next ? "In progress" : "Not started",
				)
			}
		>
			{STATUS_LABEL[t.status]}
		</button>
	);
}

function Subtasks(props: { task: TaskView; kids: TaskView[] }) {
	const app = useApp();
	const [adding, setAdding] = useState("");
	const t = props.task;
	return (
		<div class="section">
			<h3>
				Subtasks
				{props.kids.length
					? ` · ${props.kids.filter((k) => k.status === "COMPLETED").length}/${props.kids.length}`
					: ""}
			</h3>
			{props.kids.map((k) => (
				<div
					key={k.id}
					class="toggle-row"
					style="min-height: 30px; justify-content: flex-start; gap: 4px"
				>
					<button
						type="button"
						class="check"
						role="checkbox"
						style="height: 30px"
						aria-checked={k.status === "COMPLETED"}
						aria-label={`Complete: ${k.summary}`}
						disabled={!!app.blockOf(k)}
						onClick={() => app.toggleDone(k.id)}
					>
						<span class="ring">
							<Check size={12} />
						</span>
					</button>
					<button
						type="button"
						class="menu-item"
						style="padding: 0 4px; min-height: 28px"
						title="Alt+↑/↓ move · Alt+→/← nest"
						aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Alt+ArrowRight Alt+ArrowLeft"
						onClick={() => app.sheet.set({ kind: "task", id: k.id })}
						onKeyDown={(e) => {
							if (!e.altKey || app.blockOf(k)) return;
							if (e.key === "ArrowUp" || e.key === "ArrowDown") {
								e.preventDefault();
								app.moveBy(k, e.key === "ArrowUp" ? -1 : 1, true);
							} else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
								e.preventDefault();
								void app.nest(k, e.key === "ArrowRight" ? 1 : -1);
							}
						}}
					>
						<span
							class="grow"
							style={
								k.status === "COMPLETED"
									? "text-decoration: line-through; color: var(--muted)"
									: ""
							}
						>
							{k.summary}
						</span>
					</button>
				</div>
			))}
			{!app.blockOf(t) && (
				<input
					class="input"
					placeholder="Add a subtask"
					aria-label={`Add a subtask to “${t.summary}”`}
					value={adding}
					onInput={(e) => setAdding(e.currentTarget.value)}
					onKeyDown={async (e) => {
						if (e.key === "Enter" && adding.trim()) {
							e.preventDefault();
							e.stopPropagation();
							const made = await app.create({
								summary: adding.trim(),
								parent: t.href,
							});
							if (made) setAdding("");
							app.highlight.set(t.id);
						}
					}}
				/>
			)}
		</div>
	);
}

/** Notes with http(s)/mailto links that open in the default browser through the bridge. */
function Linked(props: { text: string }) {
	const app = useApp();
	const parts = useMemo(() => props.text.split(URL_RE), [props.text]);
	return (
		<>
			{parts.map((p, i) =>
				i % 2 === 1 ? (
					<a
						key={i}
						href={p}
						style="color: var(--accent)"
						onClick={(e) => {
							e.preventDefault();
							void app.bridge.openUrl(p).then(
								(ok) =>
									!ok &&
									app.toast("Only web and mail links can be opened.", {
										tone: "error",
									}),
							);
						}}
					>
						{p}
					</a>
				) : (
					p
				),
			)}
		</>
	);
}

function footer(app: ReturnType<typeof useApp>, t: TaskView): string {
	const parts: string[] = [];
	if (t.createdAt)
		parts.push(
			`Created ${fmtDayShort(zoned(t.createdAt, app.ctx.tz).date).replace(/^\w+ /, "")}`,
		);
	if (t.modifiedAt)
		parts.push(
			`Modified ${ago(app.now.get() - t.modifiedAt)}${t.origin ? ` in ${t.origin}` : ""}`,
		);
	return parts.join(" · ");
}

function ago(ms: number): string {
	const m = Math.round(ms / 60_000);
	if (m < 1) return "just now";
	if (m < 60) return `${m} min ago`;
	const h = Math.round(m / 60);
	if (h < 24) return `${h} h ago`;
	const d = Math.round(h / 24);
	return `${d} d ago`;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function autoGrow(el: HTMLTextAreaElement | null): void {
	if (!el) return;
	el.style.height = "auto";
	el.style.height = `${el.scrollHeight}px`;
}
