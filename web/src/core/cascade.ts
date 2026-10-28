// Changes that reach beyond one task, like the Tasks app does them: completing a parent
// completes its open subtasks; re-opening a subtask re-opens its completed parents; re-parenting
// edits only the child's parent link; moving a subtask alone to another list detaches it first.
// Every node is checked before the first write; children go first, the parent last.
import type { Ctx } from "./ctx.ts";
import { CoreError } from "./errors.ts";
import type { TaskRecord } from "./store.ts";
import {
	parsed,
	readOnlyReason,
	type TaskView,
	taskRow,
	taskView,
} from "./tasks.ts";
import {
	checkAll,
	eachOf,
	gate,
	moveTask,
	subtree,
	updateTask,
} from "./write.ts";

const isOpen = (r: TaskRecord) => {
	const s = parsed(r)?.f.status;
	return s === "NEEDS-ACTION" || s === "IN-PROCESS";
};

/**
 * Completes a task. A non-repeating parent takes its open subtasks along (children first); a
 * repeating subtask in there is closed for good, not advanced. A repeating parent moves to its
 * next occurrence and leaves its subtasks as they are. Returns how many subtasks were completed.
 * Run it inside an undo group: the subtasks and the task are one Undo.
 */
export async function completeTask(
	ctx: Ctx,
	href: string,
): Promise<{ task: TaskView | null; subtasks: number }> {
	const { row, list } = taskRow(ctx, href);
	const f = parsed(row)?.f;
	const open = f?.rrule
		? []
		: subtree(ctx, row).filter((n) => n.href !== row.href && isOpen(n));
	checkAll(ctx, list, [...open, row]);
	await eachOf([...open, row], "completed (subtasks first)", async (n) => {
		const repeats = !!parsed(n)?.f.rrule;
		await updateTask(ctx, n.href, {
			status: "COMPLETED",
			...(n.href !== row.href && repeats ? { close: true } : {}),
		});
	});
	return {
		task: ctx.store.task(href) ? taskView(ctx, href) : null,
		subtasks: open.length,
	};
}

/** The completed tasks above `row` in its list, nearest first (a parent loop ends the climb). */
function closedAncestors(ctx: Ctx, row: TaskRecord): TaskRecord[] {
	const byUid = new Map(
		ctx.store.tasksOf(row.list).flatMap((r) => {
			const uid = parsed(r)?.f.uid;
			return uid ? [[uid, r] as const] : [];
		}),
	);
	const out: TaskRecord[] = [];
	const seen = new Set([row.href]);
	for (
		let p = byUid.get(parsed(row)?.f.parentUid ?? "");
		p && !seen.has(p.href);
		p = byUid.get(parsed(p)?.f.parentUid ?? "")
	) {
		seen.add(p.href);
		if (!isOpen(p)) out.push(p);
	}
	return out;
}

/** Re-opens a task and the completed parents above it (the task first, then up). */
export async function reopenTask(
	ctx: Ctx,
	href: string,
): Promise<{ task: TaskView | null; parents: number }> {
	const { row, list } = taskRow(ctx, href);
	const parents = closedAncestors(ctx, row);
	checkAll(ctx, list, [row, ...parents]);
	await eachOf([row, ...parents], "re-opened", async (n) => {
		await updateTask(ctx, n.href, { status: "NEEDS-ACTION" });
	});
	return { task: taskView(ctx, href), parents: parents.length };
}

/**
 * Makes `href` a subtask of `parentHref` (null: top level). Only the child's parent link
 * changes. Both must be in one list (tasks.org and Planify only link within a list), and the
 * new parent can't be below the child.
 */
export async function setParent(
	ctx: Ctx,
	href: string,
	parentHref: string | null,
): Promise<TaskView | null> {
	const { row, list } = taskRow(ctx, href);
	let uid: string | null = null;
	if (parentHref) {
		const p = taskRow(ctx, parentHref);
		if (p.list.href !== list.href)
			throw new CoreError(
				"refused",
				`Subtasks live in their parent's list. Move it to “${p.list.name}” first.`,
			);
		if (subtree(ctx, row).some((n) => n.href === parentHref))
			throw new CoreError(
				"invalid",
				"A task can't go below one of its own subtasks.",
			);
		uid = parsed(p.row)?.f.uid ?? null;
		if (!uid)
			throw new CoreError("refused", "The parent task couldn't be read.");
	}
	return updateTask(ctx, href, { parent: uid });
}

/**
 * Moves a task with its subtasks to another list. A subtask moves without its parent: its
 * parent link is removed first (one PUT), then it moves, and it arrives as a top-level task.
 * Run it inside an undo group.
 */
export async function moveToList(
	ctx: Ctx,
	href: string,
	to: string,
): Promise<TaskView> {
	const { row, list } = taskRow(ctx, href);
	const parentUid = parsed(row)?.f.parentUid;
	const hasParentHere =
		!!parentUid &&
		ctx.store.tasksOf(list.href).some((r) => parsed(r)?.f.uid === parentUid);
	if (to !== list.href) {
		checkAll(ctx, list, subtree(ctx, row));
		const target = ctx.store.list(to);
		if (target) gate(ctx, target);
	}
	if (hasParentHere && to !== list.href)
		await updateTask(ctx, href, { parent: null });
	return moveTask(ctx, href, to);
}
