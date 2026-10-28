// The status banners (writes paused, offline, unreachable, auth), toasts, the in-place
// confirmation and the filter chips (spec "States and microcopy").
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import { fmtClock, zoned } from "../../core/time.ts";
import { filtering } from "../model.ts";
import { useStore } from "../store.ts";
import { useApp } from "./context.ts";
import { Close, Warning } from "./icons.tsx";
import { Scrim } from "./Sheet.tsx";

export function Banners() {
	const app = useApp();
	useStore(app.revision);
	const sync = useStore(app.syncState);
	const s = app.ctx.store.settings;
	const last = app.ctx.store.meta.lastSync;
	const at = last ? fmtClock(zoned(last, app.ctx.tz).minutes) : null;
	const host = (() => {
		try {
			return new URL(app.settings.get().server ?? "").host;
		} catch {
			return "Nextcloud";
		}
	})();
	if (s.paused)
		return (
			<div class="banner" role="alert">
				<Warning />
				<span class="text">
					Saving to Nextcloud is paused because a change couldn't be confirmed.
				</span>
				<span class="actions">
					<button
						type="button"
						class="text-btn"
						onClick={() => app.sheet.set({ kind: "settings" })}
					>
						Review
					</button>
					<button
						type="button"
						class="text-btn"
						onClick={() => app.resumeWrites()}
					>
						Resume
					</button>
				</span>
			</div>
		);
	if (sync.error?.kind === "auth")
		return (
			<div class="banner" role="alert">
				<Warning />
				<span class="text">Nextcloud rejected the app password.</span>
				<span class="actions">
					<button
						type="button"
						class="text-btn"
						onClick={() => app.sheet.set({ kind: "settings" })}
					>
						Log in again
					</button>
				</span>
			</div>
		);
	if (sync.offline)
		return (
			<div class="banner" role="status">
				<Warning />
				<span class="text">
					Offline{at ? ` · showing tasks from ${at}` : ""}. Changes are paused
					until you're back online.
				</span>
			</div>
		);
	if (sync.error?.kind === "unreachable")
		return (
			<div class="banner" role="status">
				<Warning />
				<span class="text">
					Can't reach {host}
					{at ? ` · last synced ${at}` : ""}.
				</span>
				<span class="actions">
					<button
						type="button"
						class="text-btn"
						onClick={() => void app.syncNow(true)}
					>
						Retry
					</button>
				</span>
			</div>
		);
	if (s.readOnly)
		return (
			<div class="banner" role="status">
				<Warning />
				<span class="text">
					Read-only mode is on: nothing is saved to Nextcloud.
				</span>
				<span class="actions">
					<button
						type="button"
						class="text-btn"
						onClick={() => app.sheet.set({ kind: "settings" })}
					>
						Settings
					</button>
				</span>
			</div>
		);
	const broken = app.lists().filter((l) => l.error && l.error.kind !== "gone");
	if (broken.length && !sync.error) {
		const one = broken.length === 1 ? broken[0]?.error : null;
		const unreadable = broken.every((l) => l.error?.kind === "invalid");
		return (
			<div class="banner" role="status">
				<Warning />
				<span class="text">
					{one
						? `${one.message} ${one.action}`
						: unreadable
							? `Tasks in ${broken.length} lists couldn't be read.`
							: `${broken.length} lists couldn't be synced.`}
				</span>
				{unreadable && (
					<span class="actions">
						<button
							type="button"
							class="text-btn"
							onClick={() =>
								app.toast(
									"The log names them: %LOCALAPPDATA%\\desk-tasks\\logs. They stay as they are in Nextcloud.",
								)
							}
						>
							Details
						</button>
					</span>
				)}
			</div>
		);
	}
	return null;
}

export function FilterChips() {
	const app = useApp();
	const f = useStore(app.filter);
	if (!filtering(f)) return null;
	const chips: { label: string; clear: () => void }[] = [];
	if (f.important)
		chips.push({
			label: "Important",
			clear: () => app.filter.set({ ...f, important: false }),
		});
	for (const t of f.tags)
		chips.push({
			label: `#${t}`,
			clear: () =>
				app.filter.set({ ...f, tags: f.tags.filter((x) => x !== t) }),
		});
	if (f.text.trim())
		chips.push({
			label: `“${f.text.trim()}”`,
			clear: () => app.filter.set({ ...f, text: "" }),
		});
	return (
		<div class="chips" role="group" aria-label="Filters">
			{chips.map((c) => (
				<span class="chip" key={c.label}>
					{c.label}
					<button
						type="button"
						aria-label={`Remove filter ${c.label}`}
						onClick={c.clear}
					>
						<Close size={12} />
					</button>
				</span>
			))}
		</div>
	);
}

export function Toasts() {
	const app = useApp();
	const toasts = useStore(app.toasts);
	return (
		<div class="toasts" aria-live="polite" aria-relevant="additions">
			{toasts.map((t) => (
				<ToastView key={t.id} id={t.id} />
			))}
		</div>
	);
}

function ToastView(props: { id: number }) {
	const app = useApp();
	const t = app.toasts.get().find((x) => x.id === props.id);
	const el = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!t) return;
		let timer: ReturnType<typeof setTimeout>;
		// A toast being pointed at or tabbed into stays until it is left, so its action can be reached.
		const end = () => {
			if (el.current?.matches(":hover, :focus-within"))
				timer = setTimeout(end, 1000);
			else app.dismissToast(props.id);
		};
		timer = setTimeout(end, t.ms);
		return () => clearTimeout(timer);
	}, [props.id]);
	if (!t) return null;
	return (
		<div
			class={`toast ${t.tone}`}
			ref={el}
			role={t.tone === "error" ? "alert" : "status"}
			data-toast={t.id}
		>
			<span class="text">{t.text}</span>
			{t.actions.map((a) => (
				<button
					type="button"
					class="text-btn"
					key={a.label}
					onClick={() => {
						app.dismissToast(t.id);
						a.run();
					}}
				>
					{a.label}
				</button>
			))}
			<button
				type="button"
				class="x"
				aria-label="Dismiss"
				onClick={() => app.dismissToast(t.id)}
			>
				<Close size={12} />
			</button>
		</div>
	);
}

/** "Delete “X” and its 3 subtasks?" in place, over the bottom of the widget. */
export function Confirmation() {
	const app = useApp();
	const c = useStore(app.confirmation);
	const ok = useRef<HTMLButtonElement>(null);
	useLayoutEffect(() => ok.current?.focus(), [c]);
	if (!c) return null;
	return (
		<>
			<Scrim onClose={() => app.answer(false)} />
			<div
				class="popover"
				role="alertdialog"
				aria-modal="true"
				aria-label={c.text}
				style="left: 12px; right: 12px; bottom: 12px; z-index: 35; padding: 12px"
				onKeyDown={(e) => {
					if (e.key === "Escape") {
						e.preventDefault();
						e.stopPropagation();
						app.answer(false);
					}
				}}
			>
				<p style="margin: 0 0 12px">{c.text}</p>
				<div style="display: flex; gap: 8px; justify-content: flex-end">
					<button type="button" class="btn" onClick={() => app.answer(false)}>
						Cancel
					</button>
					<button
						type="button"
						class={`btn ${/delete|leave/i.test(c.action) ? "danger" : "primary"}`}
						ref={ok}
						onClick={() => app.answer(true)}
					>
						{c.action}
					</button>
				</div>
			</div>
		</>
	);
}
