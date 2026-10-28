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
		// Any pointer or key use inside the widget counts as activity (sync cadence).
		const touch = () => app.touch();
		window.addEventListener("pointerdown", touch);
		return () => {
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("pointerdown", touch);
			setKeyHooks(null);
		};
	}, [app]);
	return (
		<div class={`app${summoned ? " summoned" : ""}`}>
			<Header onQuickAdd={() => focusQuick.current?.()} />
			<ListHeader />
			<Banners />
			<FilterChips />
			<TaskList />
			<BulkBar />
			{view.kind !== "trash" && <QuickAdd focusRef={focusQuick} />}
			<Toasts />
			<Sheets />
			<Confirmation />
		</div>
	);
}
