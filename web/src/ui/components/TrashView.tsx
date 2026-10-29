// The trash: deleted lists and tasks, each with Restore and Delete forever (confirmed); the
// header says how long Nextcloud keeps them. Restoring a list is one undo step.
import { useEffect, useState } from "preact/hooks";
import { attempt } from "../../core/ctx.ts";
import type { Failure } from "../../core/errors.ts";
import {
	deleteForever,
	deleteList,
	deleteListForever,
	loadTrash,
	restoreList,
	restoreTask,
	type Trash,
} from "../../core/lists.ts";
import { plural } from "../controller.ts";
import { useApp } from "./context.ts";
import { Trash as TrashIcon, Warning } from "./icons.tsx";
import { dotStyle } from "./TaskList.tsx";

export function TrashView() {
	const app = useApp();
	const [trash, setTrash] = useState<Trash | null>(null);
	const [error, setError] = useState<Failure | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const load = async () => {
		const r = await attempt(() => loadTrash(app.ctx));
		if (r.ok) {
			setTrash(r.value);
			setError(null);
		} else setError(r.error);
	};
	useEffect(() => {
		void load();
	}, []);
	const restore = async (href: string, name: string) => {
		setBusy(href);
		const failure = await app.listAct(
			`Restored “${name}”.`,
			() => restoreList(app.ctx, href),
			{
				undo: async () => {
					await deleteList(app.ctx, href);
					await load();
				},
				redo: async () => {
					await restoreList(app.ctx, href);
					await load();
				},
			},
		);
		setBusy(null);
		if (failure) app.failed(failure);
		await load();
	};
	const run = async (key: string, f: () => Promise<unknown>, done: string) => {
		setBusy(key);
		const r = await attempt(f);
		setBusy(null);
		if (!r.ok) app.failed(r.error);
		else app.toast(done);
		await load();
	};
	if (error)
		return (
			<div class="scroll">
				<div class="empty-state error" role="alert">
					<Warning size={20} />
					<strong>
						{error.status === 404
							? "No trash here."
							: "The trash couldn't be read."}
					</strong>
					{error.status === 404
						? "This Nextcloud doesn't keep deleted tasks in a trash."
						: error.message}
					<div hidden={error.status === 404}>
						<button type="button" class="text-btn" onClick={() => void load()}>
							Retry
						</button>
					</div>
				</div>
			</div>
		);
	if (!trash)
		return (
			<div class="scroll">
				<div class="empty-state" role="status">
					Loading the trash…
				</div>
			</div>
		);
	const empty = !trash.lists.length && !trash.tasks.length;
	return (
		<div class="scroll" role="region" aria-label="Trash">
			<p class="help" style="padding: 0 var(--pad)">
				Items are deleted for good after {plural(trash.retentionDays, "day")}.
			</p>
			{empty && (
				<div class="empty-state" role="status">
					<TrashIcon size={20} />
					<strong>The trash is empty.</strong>
				</div>
			)}
			{trash.lists.length > 0 && <div class="group-head">Lists</div>}
			{trash.lists.map((l) => (
				<div
					key={l.href}
					class="toggle-row"
					style="padding: 0 var(--pad); gap: 6px"
				>
					<span style="display: flex; gap: 8px; align-items: center; min-width: 0; flex: 1">
						<span class="list-dot" style={dotStyle(l)} />
						<span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
							{l.name}
						</span>
					</span>
					<button
						type="button"
						class="text-btn"
						disabled={busy !== null}
						onClick={() => void restore(l.href, l.name)}
					>
						Restore
					</button>
					<button
						type="button"
						class="text-btn danger"
						disabled={busy !== null}
						onClick={async () => {
							if (
								await app.confirm(
									`Delete “${l.name}” and its tasks for good? This can't be undone.`,
									"Delete forever",
								)
							)
								await run(
									l.href,
									() => deleteListForever(app.ctx, l.href),
									`Deleted “${l.name}” for good.`,
								);
						}}
					>
						Delete forever
					</button>
				</div>
			))}
			{trash.tasks.length > 0 && <div class="group-head">Tasks</div>}
			{trash.tasks.map((t) => (
				<div
					key={t.href}
					class="toggle-row"
					style="padding: 0 var(--pad); gap: 6px"
				>
					<span style="min-width: 0; flex: 1">
						<span class="title">{t.summary || "(no title)"}</span>
						<span class="meta">{t.listName}</span>
					</span>
					<button
						type="button"
						class="text-btn"
						disabled={busy !== null || !t.list}
						title={
							t.list ? undefined : "Its list is gone. Restore the list first."
						}
						onClick={() =>
							void run(
								t.href,
								() => restoreTask(app.ctx, trash, t.href),
								`Restored “${t.summary}”.`,
							)
						}
					>
						Restore
					</button>
					<button
						type="button"
						class="text-btn danger"
						disabled={busy !== null}
						onClick={async () => {
							if (
								await app.confirm(
									`Delete “${t.summary}” for good? This can't be undone.`,
									"Delete forever",
								)
							)
								await run(
									t.href,
									() => deleteForever(app.ctx, t.href),
									`Deleted “${t.summary}” for good.`,
								);
						}}
					>
						Delete forever
					</button>
				</div>
			))}
		</div>
	);
}
