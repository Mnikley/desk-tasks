// Quick add (bottom of every view; `n`, Win+Alt+N): the quick-entry grammar with live token
// highlighting, view defaults as removable chips, autocomplete for #, / and !, inline errors
// (never a toast), Esc on a token makes it literal, several pasted lines ask first.
import { useEffect, useRef, useState } from "preact/hooks";
import type { RepeatRule } from "../../core/recurrence.ts";
import type { CreateInput } from "../../core/write.ts";
import type { RepeatSpec } from "../../logic/dates.ts";
import {
	literalize,
	parseTaskLine,
	type QuickToken,
	type Suggestion,
	suggestTask,
	type TaskParse,
} from "../../logic/quickentry.ts";
import { knownTags } from "../../logic/tasklogic.ts";
import { plural } from "../controller.ts";
import { useStore } from "../store.ts";
import { useApp } from "./context.ts";
import { Close, Plus } from "./icons.tsx";

const EMPTY_TITLE = "Add what the task is.";

/** The view's defaults, shown as chips the user can remove. */
interface Defaults {
	dueToday: boolean;
	list: string | null;
}

export const ruleOfSpec = (r: RepeatSpec): RepeatRule => ({
	freq: r.freq,
	interval: r.interval,
	byDay: r.byDay ?? [],
	monthDay: "same",
	end: { kind: "never" },
	fromCompletion: false,
});

/** What a parsed line creates, with the view's defaults for what it leaves out. */
export function createInput(
	p: TaskParse,
	d: Defaults,
	today: string,
	fallbackList: string | null,
): CreateInput | null {
	const list = p.list ?? d.list ?? fallbackList;
	if (!list) return null;
	// "Due today" is the view's default, unless the task starts later (a due date before its
	// start isn't valid).
	const startsLater = p.start !== null && p.start > today;
	const due =
		p.due ??
		(d.dueToday && !startsLater ? { date: today, minutes: null } : null);
	return {
		summary: p.summary,
		list,
		...(p.priority !== "none" ? { priority: p.priority } : {}),
		...(p.tags.length ? { tags: p.tags } : {}),
		...(due ? { due } : {}),
		...(p.start ? { start: { date: p.start, minutes: null } } : {}),
		...(p.repeat ? { repeat: ruleOfSpec(p.repeat) } : {}),
		...(p.notes ? { description: p.notes } : {}),
	};
}

export function QuickAdd(props: {
	focusRef: { current: (() => void) | null };
}) {
	const app = useApp();
	useStore(app.revision);
	const view = useStore(app.view);
	useStore(app.now);
	const [line, setLine] = useState("");
	const [caret, setCaret] = useState(0);
	const [removed, setRemoved] = useState<Set<string>>(new Set());
	const [tried, setTried] = useState(false);
	const [pick, setPick] = useState(0);
	const [busy, setBusy] = useState(false);
	const [focused, setFocused] = useState(false);
	const [blocked, setBlocked] = useState<string | null>(null);
	const input = useRef<HTMLInputElement>(null);
	const mirror = useRef<HTMLDivElement>(null);
	props.focusRef.current = () => input.current?.focus();

	// A new view brings its own defaults.
	useEffect(() => setRemoved(new Set()), [view]);

	const today = app.today();
	const lists = app
		.lists()
		.map((l) => ({ href: l.href, name: l.name, writable: l.writable }));
	const parse = parseTaskLine(line, { today, lists });
	const viewList = view.kind === "list" ? view.href : null;
	const defaults: Defaults = {
		dueToday: view.kind === "today" && !removed.has("today"),
		list: viewList && !removed.has("list") ? viewList : null,
	};
	const fallback = app.defaultList();
	const target = parse.list ?? defaults.list ?? fallback?.href ?? null;
	const targetList = target ? app.ctx.store.list(target) : null;
	const viewOnly = view.kind === "list" && targetList && !targetList.writable;
	const errors = parse.errors.filter(
		(e) => e !== EMPTY_TITLE || (tried && line.trim() !== ""),
	);
	const emptyTried = tried && !line.trim();
	const suggest = suggestTask(line, caret, {
		tags: knownTags(app.tasks()),
		lists: lists.filter((l) => l.writable),
	});

	const chips: { key: string; label: string }[] = [];
	if (defaults.dueToday && !parse.due)
		chips.push({ key: "today", label: "Due today" });
	if (!parse.list && targetList && (defaults.list || view.kind !== "list"))
		chips.push({
			key: "list",
			label:
				view.kind === "list" ? targetList.name : `Adding to ${targetList.name}`,
		});

	const accept = (s: Suggestion) => {
		if (!suggest) return;
		const next = `${line.slice(0, suggest.from)}${s.insert} ${line.slice(suggest.to).trimStart()}`;
		const pos = suggest.from + s.insert.length + 1;
		setLine(next);
		setPick(0);
		requestAnimationFrame(() => {
			input.current?.setSelectionRange(pos, pos);
			setCaret(pos);
		});
	};

	const submit = async () => {
		if (busy) return;
		setTried(true);
		// Saving is off (paused, read-only, offline): said here, not as a toast.
		const block = app.writeBlock();
		if (block) {
			setBlocked(block);
			return;
		}
		if (!line.trim() || parse.errors.length) return;
		const inp = createInput(parse, defaults, today, fallback?.href ?? null);
		if (!inp) {
			app.toast("There's no list you can add tasks to.", { tone: "error" });
			return;
		}
		setBusy(true);
		const sent = line;
		const created = await app.create(inp);
		setBusy(false);
		if (created) {
			// What was typed while it saved stays: only the sent line goes.
			setLine((cur) =>
				cur.startsWith(sent) ? cur.slice(sent.length).trimStart() : cur,
			);
			setTried(false);
		}
	};

	const pasteLines = async (text: string) => {
		const rows = text
			.split(/\r?\n/)
			.map((l) => l.trim())
			.filter(Boolean);
		if (rows.length < 2) return false;
		const name = targetList?.name ?? "your list";
		if (
			!(await app.confirm(
				`Add ${rows.length} tasks to ${name}?`,
				`Add ${rows.length} tasks`,
			))
		)
			return true;
		let made = 0;
		for (const r of rows) {
			const p = parseTaskLine(r, { today, lists });
			if (p.errors.length) continue;
			const inp = createInput(p, defaults, today, fallback?.href ?? null);
			if (inp && (await app.create(inp))) made++;
		}
		if (made < rows.length)
			app.toast(`${plural(rows.length - made, "line")} couldn't be added.`, {
				tone: "error",
			});
		return true;
	};

	const tokenAtCaret = (): QuickToken | undefined =>
		parse.tokens.find((t) => caret >= t.from && caret <= t.to);

	return (
		<div class="quick">
			{suggest && (
				<div
					class="suggest"
					role="listbox"
					id="quick-suggest"
					aria-label="Suggestions"
				>
					{suggest.items.map((s, i) => (
						<div
							key={s.insert}
							role="option"
							id={`qs-${i}`}
							aria-selected={i === pick}
							onMouseDown={(e) => {
								e.preventDefault();
								accept(s);
							}}
						>
							{s.label}
						</div>
					))}
				</div>
			)}
			<div class="quick-row">
				<Plus />
				<div class="quick-field">
					<div class="mirror" ref={mirror} aria-hidden="true">
						{highlight(line, parse.tokens)}
					</div>
					<input
						ref={input}
						type="text"
						aria-label="Add a task"
						aria-describedby="quick-msg"
						aria-keyshortcuts="N"
						role="combobox"
						aria-autocomplete="list"
						aria-expanded={!!suggest}
						aria-controls={suggest ? "quick-suggest" : undefined}
						aria-activedescendant={suggest ? `qs-${pick}` : undefined}
						aria-invalid={errors.length > 0 || emptyTried}
						placeholder={
							viewOnly ? `“${targetList?.name}” is view only` : "Add a task"
						}
						disabled={!!viewOnly}
						aria-busy={busy}
						value={line}
						spellcheck={false}
						autocomplete="off"
						onInput={(e) => {
							setBlocked(null);
							setLine(e.currentTarget.value);
							setCaret(e.currentTarget.selectionStart ?? 0);
							setPick(0);
						}}
						onFocus={() => setFocused(true)}
						onBlur={() => setFocused(false)}
						onScroll={(e) => {
							if (mirror.current)
								mirror.current.scrollLeft = e.currentTarget.scrollLeft;
						}}
						onKeyUp={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
						onClick={(e) => {
							// A click on a highlighted token makes it literal text.
							const at = e.currentTarget.selectionStart ?? 0;
							const tok = parse.tokens.find((t) => at > t.from && at < t.to);
							if (tok && e.detail === 1) setLine(literalize(line, tok));
							setCaret(at);
						}}
						onPaste={(e) => {
							const text = e.clipboardData?.getData("text/plain") ?? "";
							if (/\n/.test(text.trim())) {
								e.preventDefault();
								void pasteLines(text);
							}
						}}
						onKeyDown={(e) => {
							if (suggest && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
								e.preventDefault();
								const n = suggest.items.length;
								setPick((p) => (p + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
								return;
							}
							if (suggest && (e.key === "Tab" || e.key === "Enter")) {
								const s = suggest.items[pick];
								if (s) {
									e.preventDefault();
									accept(s);
									return;
								}
							}
							if (e.key === "Enter") {
								e.preventDefault();
								void submit();
								return;
							}
							if (e.key === "Backspace" && line === "" && chips.length) {
								e.preventDefault();
								const last = chips.at(-1);
								if (last) setRemoved((r) => new Set(r).add(last.key));
								return;
							}
							if (e.key === "Escape") {
								const tok = tokenAtCaret();
								if (tok) {
									// The token becomes text; the Esc chain stops here.
									e.preventDefault();
									e.stopPropagation();
									setLine(literalize(line, tok));
									return;
								}
								// Leave the field (the draft stays) for the list; the Esc chain goes on there.
								e.preventDefault();
								e.stopPropagation();
								const row =
									document.querySelector<HTMLElement>(".row.hl") ??
									document.querySelector<HTMLElement>(".row[data-id]");
								if (row) row.focus();
								else e.currentTarget.blur();
							}
						}}
					/>
				</div>
			</div>
			{/* Calm at rest: the defaults show while quick add is in use. */}
			{chips.length > 0 && !viewOnly && (focused || line !== "") && (
				<div class="quick-chips">
					{chips.map((c) => (
						<span class="chip" key={c.key}>
							{c.label}
							<button
								type="button"
								aria-label={`Remove “${c.label}”`}
								onClick={() => setRemoved((r) => new Set(r).add(c.key))}
							>
								<Close size={12} />
							</button>
						</span>
					))}
				</div>
			)}
			<div id="quick-msg" aria-live="polite">
				{blocked && line.trim() ? (
					<div class="quick-error">{blocked}</div>
				) : errors[0] ? (
					<div class="quick-error">{errors[0]}</div>
				) : emptyTried ? (
					<div class="quick-error">{EMPTY_TITLE}</div>
				) : focused && !line ? (
					<div class="quick-hint">
						{"tomorrow 14:00 · #tag · !1 · /list · every monday · // notes"}
					</div>
				) : null}
			</div>
		</div>
	);
}

/** The line with its recognised tokens marked (clicking one in the field makes it literal). */
function highlight(line: string, tokens: QuickToken[]) {
	const out: (string | preact.JSX.Element)[] = [];
	let at = 0;
	for (const t of [...tokens].sort((a, b) => a.from - b.from)) {
		if (t.from < at) continue;
		out.push(line.slice(at, t.from));
		out.push(
			<mark key={t.from} data-kind={t.kind}>
				{line.slice(t.from, t.to)}
			</mark>,
		);
		at = t.to;
	}
	out.push(line.slice(at));
	// A trailing space would collapse; keep the mirror as wide as the field's text.
	return [...out, "​"];
}
