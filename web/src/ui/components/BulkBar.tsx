// The multi-select bar: Done · Date · Priority · List · Tags · Delete, applied to the whole
// selection as one undo group.
import { useStore } from "../store.ts";
import { useApp } from "./context.ts";
import { Close } from "./icons.tsx";

export function BulkBar() {
	const app = useApp();
	const sel = useStore(app.selection);
	useStore(app.revision);
	useStore(app.syncState);
	if (!sel.size) return null;
	const first = [...sel][0] as number;
	// Saving is off (read-only switch, paused, offline): the actions say why instead.
	const block = app.writeBlock();
	const off = { disabled: !!block, title: block ?? undefined };
	const act = (kind: "due" | "list" | "tags") =>
		app.popover.set({ kind, id: first, bulk: true });
	return (
		<div class="bulk" role="toolbar" aria-label={`${sel.size} selected`}>
			<span class="n">
				{sel.size}
				<span class="word"> selected</span>
			</span>
			<button
				type="button"
				class="text-btn"
				{...off}
				onClick={() => {
					for (const t of app.targets()) app.toggleDone(t.id);
				}}
			>
				Done
			</button>
			<button
				type="button"
				class="text-btn"
				{...off}
				onClick={() => act("due")}
			>
				Date
			</button>
			<button
				type="button"
				class="text-btn"
				{...off}
				onClick={() =>
					app.popover.set({ kind: "priority", id: first, bulk: true })
				}
			>
				Priority
			</button>
			<button
				type="button"
				class="text-btn"
				{...off}
				onClick={() => act("list")}
			>
				List
			</button>
			<button
				type="button"
				class="text-btn"
				{...off}
				onClick={() => act("tags")}
			>
				Tags
			</button>
			<button
				type="button"
				class="text-btn danger"
				{...off}
				onClick={async () => {
					const tasks = app.targets();
					if (await app.confirm(`Delete ${tasks.length} tasks?`, "Delete"))
						await app.deleteTasks(tasks);
				}}
			>
				Delete
			</button>
			<button
				type="button"
				class="icon-btn"
				aria-label="Clear the selection"
				onClick={() => app.clearSelection()}
			>
				<Close />
			</button>
		</div>
	);
}
