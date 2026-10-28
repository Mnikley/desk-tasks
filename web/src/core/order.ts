// Manual order (X-APPLE-SORT-ORDER), the way the Nextcloud Tasks app writes it: the moved task
// gets order(next) − 1 if that still lies above order(prev) (and ≥ 0), else order(prev) + 1;
// then each following sibling whose order isn't above the one before it is bumped to prev + 1.
// It works on whatever values are there (Apple-epoch seconds, Planify's small integers) and
// never renumbers a whole list.
import type { Ctx } from "./ctx.ts";
import type { TaskView } from "./tasks.ts";
import { eachOf, updateTask } from "./write.ts";

type Ordered = Pick<TaskView, "href" | "sortOrder" | "createdAt" | "uid">;

/** "My order" among siblings: the effective sort order, then CREATED, then UID. */
export const compareManual = (a: Ordered, b: Ordered) =>
	a.sortOrder - b.sortOrder ||
	(a.createdAt ?? 0) - (b.createdAt ?? 0) ||
	a.uid.localeCompare(b.uid);

/** One sort-order write. `href` "" stands for a task about to be created at that place. */
export interface OrderWrite {
	href: string;
	order: number;
}

/**
 * The writes that put `moved` at index `to` among `siblings` (in their current display order;
 * `moved` may be among them or be a new task, href ""). The moved task's write comes first.
 */
export function reorderPlan(
	siblings: Ordered[],
	moved: Ordered | { href: ""; sortOrder: number },
	to: number,
): OrderWrite[] {
	const rest = siblings.filter(
		(s) => s.href !== moved.href || moved.href === "",
	);
	const at = Math.max(0, Math.min(to, rest.length));
	const arranged = [...rest.slice(0, at), moved, ...rest.slice(at)];
	const orders = arranged.map((s) => s.sortOrder);
	const prev = at > 0 ? (orders[at - 1] as number) : null;
	const next = at < arranged.length - 1 ? (orders[at + 1] as number) : null;
	const floor = prev ?? -1;
	const value =
		next !== null && next - 1 > floor && next - 1 >= 0 ? next - 1 : floor + 1;
	const writes: OrderWrite[] = [];
	if (moved.href === "" || value !== moved.sortOrder)
		writes.push({ href: moved.href, order: value });
	orders[at] = value;
	for (let j = at + 1; j < arranged.length; j++) {
		const before = orders[j - 1] as number;
		if ((orders[j] as number) > before) continue;
		orders[j] = before + 1;
		writes.push({ href: (arranged[j] as Ordered).href, order: before + 1 });
	}
	return writes;
}

/** More than this many writes asks first ("Reordering here updates 14 tasks in Nextcloud."). */
export const CONFIRM_ABOVE = 10;

/**
 * Writes a plan one verified PUT at a time (run inside an undo group by the caller). A failure
 * stops it and says how many were already done.
 */
export async function applyOrder(
	ctx: Ctx,
	writes: OrderWrite[],
	onProgress?: (done: number, total: number) => void,
): Promise<void> {
	let done = 0;
	await eachOf(
		writes.filter((w) => w.href !== ""),
		"reordered",
		async (w) => {
			await updateTask(ctx, w.href, { order: w.order });
			onProgress?.(++done, writes.length);
		},
	);
}
