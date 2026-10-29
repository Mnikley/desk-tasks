// The widget: header, banners, filter chips, the view, the bulk bar, quick add, and the layers
// over them (sheets, popovers, toasts, confirmation, conflict dialog).
import { useEffect, useRef } from "preact/hooks";
import { handleKey, setKeyHooks } from "../keymap.ts";
import { useStore } from "../store.ts";
import { BulkBar } from "./BulkBar.tsx";
import { Banners, Confirmation, FilterChips, Toasts } from "./Chrome.tsx";
import { useApp } from "./context.ts";
import { Header, ListHeader } from "./Header.tsx";
import { QuickAdd } from "./QuickAdd.tsx";
import { Sheets } from "./Sheets.tsx";
import { TaskList } from "./TaskList.tsx";
import { ResizeGrip } from "./WindowChrome.tsx";

export function App() {
	const app = useApp();
	const summoned = useStore(app.summoned);
	const view = useStore(app.view);
	const focusQuick = useRef<(() => void) | null>(null);
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => handleKey(app, e);
		window.addEventListener("keydown", onKey);
		setKeyHooks({
			focusQuickAdd: () => focusQuick.current?.(),
			rename: (id) => app.renaming.set(id),
			openPopover: (kind, id) => app.popover.set({ kind, id }),
			newRow: (kind) => app.newRow(kind),
		});
		// A summon puts focus in the list (the highlighted task, else the first) or quick add.
		const offFocus = app.focusRequest.subscribe(() => {
			const want = app.focusRequest.get();
			if (!want) return;
			app.focusRequest.set(null);
			if (want === "quick-add") {
				focusQuick.current?.();
				return;
			}
			requestAnimationFrame(() => {
				if (app.highlight.get() === null) app.moveHighlight(1);
				requestAnimationFrame(() =>
					document.querySelector<HTMLElement>(".row.hl")?.focus(),
				);
			});
		});
		// Any pointer or key use inside the widget counts as activity (sync cadence).
		const touch = () => app.touch();
		window.addEventListener("pointerdown", touch);
		return () => {
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("pointerdown", touch);
			setKeyHooks(null);
			offFocus();
		};
	}, [app]);
	return (
		<div class={`app${summoned ? " summoned" : ""}`}>
			<Header
				onQuickAdd={() => {
					// Trash has no quick add: back to Today first.
					if (app.view.get().kind === "trash") app.setView({ kind: "today" });
					requestAnimationFrame(() => focusQuick.current?.());
				}}
			/>
			<ListHeader />
			{/* One live region, always there, so a banner that appears is announced once. */}
			<div aria-live="polite" class="banners">
				<Banners />
			</div>
			<FilterChips />
			<TaskList />
			<BulkBar />
			{view.kind !== "trash" && <QuickAdd focusRef={focusQuick} />}
			<Toasts />
			<Sheets />
			<Confirmation />
			<ResizeGrip app={app} />
		</div>
	);
}
