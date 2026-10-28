// Sharing a list I own, as the Tasks app does it over DAV: add people (view only by default),
// switch between view only and can edit, remove. Nextcloud answers 200 even when it skipped a
// sharee (unknown user, sharing restrictions, group sharing off), so every change is followed by
// a fresh read of who the list is shared with, and a missing sharee is reported by name.
import type { Sharee } from "./caldav.ts";
import { CaldavError } from "./caldav.ts";
import { asCore, type Ctx } from "./ctx.ts";
import { CoreError } from "./errors.ts";
import { assertConnectedWritable } from "./sync.ts";
import { ownerOf } from "./tasks.ts";

export interface ShareResult {
	sharees: Sharee[];
	/** Names Nextcloud didn't share with ("Couldn't share with Carol. …"). */
	skipped: string[];
}

function ownedList(ctx: Ctx, href: string) {
	const l = ctx.store.list(href);
	if (!l) throw new CoreError("gone", "That list isn't here any more.");
	if (l.shared || !l.canShare)
		throw new CoreError(
			"refused",
			`Only ${l.shared ? ownerOf(l) : "its owner"} can share this list.`,
		);
	return l;
}

async function change(
	ctx: Ctx,
	href: string,
	sets: { href: string; readWrite: boolean; name: string }[],
	removes: string[],
): Promise<ShareResult> {
	const dc = assertConnectedWritable(ctx);
	ownedList(ctx, href);
	try {
		await dc.share(href, sets, removes);
	} catch (err) {
		if (err instanceof CaldavError && err.status === 429)
			throw new CoreError(
				"rate-limited",
				"Too many sharing changes. Try again in a few minutes.",
			);
		asCore(err);
	}
	let sharees: Sharee[];
	try {
		sharees = await dc.sharees(href);
	} catch (err) {
		return asCore(err);
	}
	ctx.store.patchList(href, { sharees });
	const there = new Map(sharees.map((s) => [s.href, s]));
	const skipped = sets
		.filter((s) => {
			const now = there.get(s.href);
			return !now || (now.access === "read-write") !== s.readWrite;
		})
		.map((s) => s.name);
	return { sharees, skipped };
}

/** Shares with people or groups, view only unless `readWrite`. */
export function share(
	ctx: Ctx,
	list: string,
	who: { href: string; name: string }[],
	readWrite = false,
): Promise<ShareResult> {
	return change(
		ctx,
		list,
		who.map((w) => ({ ...w, readWrite })),
		[],
	);
}

/** Switches a sharee between view only and can edit. */
export function setAccess(
	ctx: Ctx,
	list: string,
	sharee: Sharee,
	readWrite: boolean,
): Promise<ShareResult> {
	return change(
		ctx,
		list,
		[{ href: sharee.href, name: sharee.name, readWrite }],
		[],
	);
}

/** Stops sharing with someone. */
export function unshare(
	ctx: Ctx,
	list: string,
	sharee: Sharee,
): Promise<ShareResult> {
	return change(ctx, list, [], [sharee.href]);
}

/** The message for a skipped sharee. */
export const skippedText = (name: string) =>
	`Couldn't share with ${name}. Your Nextcloud's sharing settings may not allow it.`;

/**
 * People and groups to share with: at least 2 characters (the UI debounces 250 ms). Me and
 * those already on the list are left out.
 */
export async function searchSharees(
	ctx: Ctx,
	list: string,
	query: string,
): Promise<{ href: string; name: string; kind: "user" | "group" }[]> {
	const q = query.trim();
	if (q.length < 2) return [];
	const dc = assertConnectedWritable(ctx);
	const l = ownedList(ctx, list);
	const me = ctx.store.meta.principal
		?.replace(/^.*?(principals\/)/, "$1")
		.replace(/\/+$/, "");
	try {
		const found = await dc.searchPrincipals(q);
		const taken = new Set(l.sharees.map((s) => s.href));
		return found.filter(
			(f) => !taken.has(f.href) && f.href !== `principal:${me}`,
		);
	} catch (err) {
		return asCore(err);
	}
}
