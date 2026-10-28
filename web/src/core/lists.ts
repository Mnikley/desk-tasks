// Task lists in Nextcloud: make, rename, recolour, reorder, delete (into Nextcloud's trash) and
// leave; and the trash: deleted lists and tasks, restore (with a task's trashed parents and
// subtasks), delete for good. These aren't journaled; a deleted list's Undo is its restore.
import type { Collection } from "./caldav.ts";
import { CaldavError } from "./caldav.ts";
import { asCore, type Ctx } from "./ctx.ts";
import { CoreError } from "./errors.ts";
import { TaskDocument } from "./ical.ts";
import { reorderPlan } from "./order.ts";
import type { ListRecord } from "./store.ts";
import {
	assertConnectedWritable,
	inflightSync,
	sync,
	upsertCollections,
} from "./sync.ts";
import { ownerOf, parsed } from "./tasks.ts";

const listOf = (ctx: Ctx, href: string): ListRecord => {
	const r = ctx.store.list(href);
	if (!r) throw new CoreError("gone", "That list isn't here any more.");
	return r;
};

/** "Groceries & more" → "groceries-more" (the URI only; Nextcloud shows the display name). */
export function slugOf(name: string): string {
	return (
		name
			.toLowerCase()
			.normalize("NFKD")
			.replace(/[̀-ͯ]/g, "")
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40) || "list"
	);
}

const randomSuffix = () =>
	Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) =>
		"abcdefghijklmnopqrstuvwxyz0123456789".charAt(b % 36),
	).join("");

function validName(name: string): string {
	const n = name.trim();
	if (!n) throw new CoreError("invalid", "Give the list a name.");
	if (n.length > 100) throw new CoreError("invalid", "That name is too long.");
	return n;
}

function validColor(color: string): string {
	if (!/^#[0-9a-f]{6}$/i.test(color))
		throw new CoreError("invalid", "Pick a colour like #3a5bd9.");
	return color.toLowerCase();
}

const home = (ctx: Ctx) => {
	const h = ctx.store.meta.home;
	if (!h)
		throw new CoreError(
			"not-connected",
			"Nextcloud isn't synced yet. Try again in a moment.",
		);
	return h;
};

/** Makes a task list (VTODO only, after the others) and returns its href, read back from Nextcloud. */
export async function createList(
	ctx: Ctx,
	input: { name: string; color: string },
): Promise<string> {
	const dc = assertConnectedWritable(ctx);
	const name = validName(input.name);
	const color = validColor(input.color);
	let at = "";
	let h = ctx.store.meta.home ?? "";
	try {
		if (!h) h = (await dc.discover()).home;
		at = `${h.replace(/\/*$/, "/")}${slugOf(name)}-${randomSuffix()}/`;
		const last = Math.max(-1, ...ctx.store.lists().map((l) => l.order));
		await dc.createList(at, name, color, last + 1);
	} catch (err) {
		if (err instanceof CaldavError && err.status === 429)
			throw new CoreError(
				"rate-limited",
				"Nextcloud allows 10 new lists per hour. Try again later.",
			);
		if (
			err instanceof CaldavError &&
			err.status === 403 &&
			/limit/i.test(err.message)
		)
			throw new CoreError(
				"refused",
				"You've reached Nextcloud's list limit (lists in the trash count too). Empty the trash or ask your admin.",
			);
		asCore(err);
	}
	// The list exists from here on: a failed read-back must not invite making it twice.
	let listed: Collection[] | null = null;
	try {
		listed = await dc.collections(h);
	} catch (err) {
		ctx.log.error(`Reading back a new list failed: ${(err as Error).message}`);
	}
	// A sync that listed the lists before this one would otherwise mark it gone.
	await inflightSync(ctx);
	if (listed) upsertCollections(ctx, listed);
	const path = (x: string) => x.replace(/\/*$/, "");
	const r = ctx.store.lists().find((x) => path(x.href) === path(at));
	if (!r)
		throw new CoreError(
			"unreachable",
			`“${name}” is made in Nextcloud but couldn't be read back yet. It appears with the next sync; don't add it again.`,
			{ sent: true },
		);
	return r.href;
}

/**
 * Renames or recolours a list. On a list shared with me the change is mine only (Nextcloud
 * keeps it per user), so view-only sharees may do it too.
 */
export async function changeList(
	ctx: Ctx,
	href: string,
	p: { name?: string; color?: string },
): Promise<void> {
	const dc = assertConnectedWritable(ctx);
	const r = listOf(ctx, href);
	const patch = {
		...(p.name === undefined ? {} : { name: validName(p.name) }),
		...(p.color === undefined ? {} : { color: validColor(p.color) }),
	};
	try {
		await dc.proppatch(href, patch);
	} catch (err) {
		asCore(err);
	}
	ctx.store.patchList(r.href, patch);
}

/**
 * Moves a list to position `to` with the Tasks app's rule on calendar-order (one PROPPATCH per
 * list that changes). Returns how many lists were written.
 */
export async function reorderLists(
	ctx: Ctx,
	href: string,
	to: number,
): Promise<number> {
	const dc = assertConnectedWritable(ctx);
	const lists = ctx.store.lists().filter((l) => l.error?.kind !== "gone");
	const moved = listOf(ctx, href);
	const plan = reorderPlan(
		lists.map((l) => ({
			href: l.href,
			sortOrder: l.order,
			createdAt: 0,
			uid: l.href,
		})),
		{ href: moved.href, sortOrder: moved.order, createdAt: 0, uid: moved.href },
		to,
	);
	let done = 0;
	for (const w of plan) {
		try {
			await dc.proppatch(w.href, { order: w.order });
		} catch (err) {
			try {
				asCore(err);
			} catch (e) {
				if (done && e instanceof CoreError)
					throw new CoreError(
						e.kind,
						`${done} of ${plan.length} lists were already moved. ${e.message}`,
					);
				throw e;
			}
		}
		ctx.store.patchList(w.href, { order: w.order });
		done++;
	}
	return done;
}

/**
 * Deletes a list I own: Nextcloud moves it to its trash with its tasks (restorable for the
 * retention time). A list that also holds events isn't deleted here.
 */
export async function deleteList(ctx: Ctx, href: string): Promise<void> {
	const dc = assertConnectedWritable(ctx);
	const r = listOf(ctx, href);
	if (r.shared)
		throw new CoreError(
			"refused",
			`“${r.name}” belongs to ${ownerOf(r)}. Leave it instead.`,
		);
	if (r.appGenerated)
		throw new CoreError(
			"refused",
			`“${r.name}” comes from another app (Deck). Remove it there.`,
		);
	if (r.components.includes("VEVENT"))
		throw new CoreError(
			"refused",
			`“${r.name}” also holds calendar events. Delete it in Nextcloud if you mean to.`,
		);
	try {
		await dc.deleteList(href);
	} catch (err) {
		asCore(err);
	}
	// A sync that listed the lists before the delete would otherwise add it back.
	await inflightSync(ctx);
	ctx.store.removeList(href);
}

/** Leaves a list shared with me (my share ends; the owner still has it). */
export async function leaveList(ctx: Ctx, href: string): Promise<void> {
	const dc = assertConnectedWritable(ctx);
	const r = listOf(ctx, href);
	if (!r.shared)
		throw new CoreError("refused", `“${r.name}” is yours. Delete it instead.`);
	try {
		await dc.deleteList(href);
	} catch (err) {
		asCore(err);
	}
	await inflightSync(ctx);
	ctx.store.removeList(href);
}

// ---------- the trash ----------

export interface TrashedTask {
	href: string;
	uid: string;
	summary: string;
	parentUid: string | null;
	/** The list it was in (href), when it still exists. */
	list: string | null;
	listName: string;
	deletedAt: string | null;
}

export interface Trash {
	/** Days Nextcloud keeps them ("Items are deleted for good after 30 days."). */
	retentionDays: number;
	lists: {
		href: string;
		name: string;
		color: string | null;
		deletedAt: string | null;
	}[];
	tasks: TrashedTask[];
}

/**
 * What's in Nextcloud's trash. Tasks whose UID is live in the same list are left out: an undone
 * delete re-created them there, and restoring the trashed copy would fail (no-uid-conflict).
 */
export async function loadTrash(ctx: Ctx): Promise<Trash> {
	const dc = assertConnectedWritable(ctx);
	const h = home(ctx);
	try {
		const [retention, lists, objects] = await Promise.all([
			dc.trashRetention(h),
			dc.deletedLists(h),
			dc.deletedTasks(h),
		]);
		const byUri = new Map(
			ctx.store
				.lists()
				.map((l) => [l.href.replace(/\/+$/, "").split("/").pop() ?? "", l]),
		);
		const live = new Set(ctx.store.tasks().map((t) => `${t.list}\n${t.uid}`));
		const tasks = objects.flatMap((o) => {
			let f: ReturnType<TaskDocument["fields"]>;
			try {
				f = TaskDocument.parse(o.text).fields();
			} catch {
				return [];
			}
			const list = o.calendarUri ? (byUri.get(o.calendarUri) ?? null) : null;
			if (list && live.has(`${list.href}\n${f.uid}`)) return [];
			return [
				{
					href: o.href,
					uid: f.uid,
					summary: f.summary,
					parentUid: f.parentUid,
					list: list?.href ?? null,
					listName: list?.name ?? o.calendarUri ?? "",
					deletedAt: o.deletedAt,
				},
			];
		});
		return {
			retentionDays: Math.round((retention ?? 30 * 86_400) / 86_400),
			lists,
			tasks,
		};
	} catch (err) {
		return asCore(err);
	}
}

/** Restores a deleted list with its tasks. */
export async function restoreList(ctx: Ctx, href: string): Promise<void> {
	const dc = assertConnectedWritable(ctx);
	try {
		await dc.restore(href, home(ctx));
	} catch (err) {
		asCore(err);
	}
	await sync(ctx, { force: true });
}

/**
 * Restores a deleted task, and with it its trashed parents (so it lands under them) and its
 * trashed subtasks, as the Tasks app does. Returns how many tasks came back.
 */
export async function restoreTask(
	ctx: Ctx,
	trash: Trash,
	href: string,
): Promise<number> {
	const dc = assertConnectedWritable(ctx);
	const t = trash.tasks.find((x) => x.href === href);
	if (!t) throw new CoreError("gone", "That task isn't in the trash any more.");
	const same = trash.tasks.filter(
		(x) => x.list === t.list && x.listName === t.listName,
	);
	const byUid = new Map(same.map((x) => [x.uid, x]));
	const chain = new Map<string, TrashedTask>([[t.href, t]]);
	for (
		let p = t.parentUid ? byUid.get(t.parentUid) : undefined;
		p && !chain.has(p.href);
		p = p.parentUid ? byUid.get(p.parentUid) : undefined
	)
		chain.set(p.href, p);
	const below = (uid: string) => {
		for (const c of same)
			if (c.parentUid === uid && !chain.has(c.href)) {
				chain.set(c.href, c);
				below(c.uid);
			}
	};
	below(t.uid);
	let done = 0;
	for (const x of chain.values()) {
		try {
			await dc.restore(x.href, home(ctx));
			done++;
		} catch (err) {
			if (done) await sync(ctx, { force: true });
			try {
				asCore(err);
			} catch (e) {
				if (done && e instanceof CoreError)
					throw new CoreError(
						e.kind,
						`${done} of ${chain.size} tasks were restored. ${e.message}`,
					);
				throw e;
			}
		}
	}
	await sync(ctx, { force: true });
	return done;
}

/** Deletes a trashed task for good (no way back). */
export async function deleteForever(ctx: Ctx, href: string): Promise<void> {
	const dc = assertConnectedWritable(ctx);
	try {
		await dc.deleteForever(href);
	} catch (err) {
		asCore(err);
	}
}

/** Deletes a trashed list for good. */
export async function deleteListForever(ctx: Ctx, href: string): Promise<void> {
	const dc = assertConnectedWritable(ctx);
	try {
		await dc.deleteList(href, { forever: true });
	} catch (err) {
		asCore(err);
	}
}

/** For the UI: whether a list's tasks can be written, and whether it is mine. */
export const isOwn = (l: ListRecord) => !l.shared;
export const writableTaskCount = (ctx: Ctx, href: string) =>
	ctx.store.tasksOf(href).filter((t) => parsed(t)).length;
