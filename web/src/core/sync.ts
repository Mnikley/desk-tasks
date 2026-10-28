// The task mirror: list discovery, sync-collection per list with every reported deletion
// confirmed, the ETag listing fallback, a periodic full reconcile, and run coalescing.
// Lists are made, renamed and deleted here too (they race with syncs).
import {
	type CaldavClient,
	CaldavError,
	CaldavUnreachable,
	type Collection,
	type Listed,
	principalKey,
} from "./caldav.ts";
import { AUTH_HELP, type Ctx, client } from "./ctx.ts";
import { CoreError } from "./errors.ts";
import { TaskDocument } from "./ical.ts";
import { assertWritable } from "./journal.ts";
import type { ListError, ListRecord } from "./store.ts";

/** Full ETag listing per list: catches what a pruned or reset sync token would hide. */
export const RECONCILE_EVERY_MS = 30 * 60_000;
/** A list not synced for this long gets a full reconcile (pruned tokens give silent deltas). */
const STALE_LIST_MS = 7 * 24 * 60 * 60_000;
/** Syncs asked for within this time of the last one are served by it. */
export const COALESCE_MS = 20_000;
const FETCH_CONCURRENCY = 6;

/** Stores (or replaces) a task exactly as fetched. */
export function storeTask(
	ctx: Ctx,
	list: string,
	href: string,
	got: { text: string; etag: string; binary?: boolean },
	/** From a sync: don't overwrite a copy stored after this instant (by a write meanwhile). */
	syncStarted?: number,
): void {
	let uid = "";
	try {
		uid = TaskDocument.parse(got.text).fields().uid;
	} catch (err) {
		// Kept so the list can say so; never edited.
		ctx.log.warn(`Task ${href} can't be read: ${(err as Error).message}`);
	}
	ctx.store.putTask(
		{
			href,
			list,
			etag: got.etag,
			ics: got.text,
			notUtf8: got.binary ?? false,
			uid,
		},
		ctx.now(),
		syncStarted,
	);
}

/** Runs `fn` over `items` with at most `n` in flight; the first failure stops the rest. */
async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
	let i = 0;
	let failed = false;
	await Promise.all(
		Array.from({ length: Math.min(n, items.length) }, async () => {
			while (!failed && i < items.length) {
				try {
					await fn(items[i++] as T);
				} catch (err) {
					failed = true;
					throw err;
				}
			}
		}),
	);
}

const localEtags = (ctx: Ctx, list: string) =>
	new Map(ctx.store.tasksOf(list).map((r) => [r.href, r.etag]));

async function fetchInto(
	ctx: Ctx,
	dc: CaldavClient,
	list: string,
	hrefs: string[],
	started: number,
): Promise<void> {
	await pool(hrefs, FETCH_CONCURRENCY, async (href) => {
		const got = await dc.get(href);
		if (got) storeTask(ctx, list, href, got, started);
		else ctx.store.dropTask(href, started);
	});
}

/** Full comparison of the list with the local copy (ETag listing). */
async function reconcileList(
	ctx: Ctx,
	dc: CaldavClient,
	r: ListRecord,
	listed: Listed[],
	started: number,
): Promise<void> {
	const local = localEtags(ctx, r.href);
	const seen = new Set(listed.map((l) => l.href));
	await fetchInto(
		ctx,
		dc,
		r.href,
		listed.filter((l) => local.get(l.href) !== l.etag).map((l) => l.href),
		started,
	);
	const gone = [...local.keys()].filter((h) => !seen.has(h));
	for (const h of gone) ctx.store.dropTask(h, started);
	if (gone.length) ctx.log.info(`List ${r.href}: ${gone.length} task(s) gone.`);
}

async function syncList(
	ctx: Ctx,
	dc: CaldavClient,
	r: ListRecord,
	started: number,
) {
	const now = ctx.now();
	const dueReconcile =
		!r.lastReconcileAt ||
		now - r.lastReconcileAt > RECONCILE_EVERY_MS ||
		!r.lastOkAt ||
		now - r.lastOkAt > STALE_LIST_MS;
	let token = r.syncToken;
	let res: Awaited<ReturnType<CaldavClient["changes"]>> | null = null;
	try {
		res = await dc.changes(r.href, token);
	} catch (err) {
		if (!(err instanceof CaldavError)) throw err;
		if (err.condition === "valid-sync-token") {
			token = null;
			res = await dc.changes(r.href, null);
		} else if ([400, 403, 405, 415, 501].includes(err.status)) {
			// No sync-collection here (Deck boards): the ETag listing below does the work.
			res = null;
		} else throw err;
	}
	// A full listing replaces the change list: no sync-collection, a first sync, or reconcile time.
	const listed = !res
		? await dc.list(r.href)
		: token === null
			? res.changed
			: dueReconcile
				? await dc.list(r.href)
				: null;
	if (listed) {
		await reconcileList(ctx, dc, r, listed, started);
		ctx.store.patchList(r.href, { lastReconcileAt: ctx.now() });
	} else if (res) {
		const local = localEtags(ctx, r.href);
		await fetchInto(
			ctx,
			dc,
			r.href,
			res.changed
				.filter((c) => local.get(c.href) !== c.etag)
				.map((c) => c.href),
			started,
		);
		// Nextcloud can report a re-created href as deleted; confirm before forgetting a task.
		for (const d of res.deleted.filter((h) => local.has(h))) {
			const etag = await dc.etag(d);
			if (etag === null) ctx.store.dropTask(d, started);
			else if (etag !== local.get(d))
				await fetchInto(ctx, dc, r.href, [d], started);
		}
	}
	const changed = !!res && (res.changed.length > 0 || res.deleted.length > 0);
	const bad = ctx.store.tasksOf(r.href).filter((t) => t.uid === "").length;
	ctx.store.patchList(r.href, {
		syncToken: res?.token ?? null,
		lastOkAt: ctx.now(),
		...(changed ? { lastChangedAt: ctx.now() } : {}),
		error: bad
			? {
					kind: "invalid",
					message: `${bad} task${bad === 1 ? "" : "s"} in “${r.name}” couldn't be read.`,
					action: "The log names them; change them in another app.",
				}
			: null,
	});
}

/** Creates or updates one list record per collection that holds tasks. */
export function upsertCollections(
	ctx: Ctx,
	collections: Collection[],
	principal: string | null = ctx.store.meta.principal,
): string[] {
	const me = principalKey(principal);
	const existing = new Map(ctx.store.lists().map((r) => [r.href, r]));
	const gone: string[] = [];
	for (const c of collections) {
		if (!c.components.includes("VTODO")) continue;
		const r = existing.get(c.href);
		existing.delete(c.href);
		ctx.store.putList({
			href: c.href,
			name: c.name,
			color: c.color,
			order: c.order,
			ctag: c.ctag,
			components: c.components,
			writable: c.writable,
			shared: !!c.owner && !!me && c.owner !== me,
			owner: c.owner,
			ownerName: c.ownerName,
			sharees: c.sharees,
			canShare: c.canShare,
			appGenerated: c.appGenerated,
			syncToken: r?.syncToken ?? null,
			lastReconcileAt: r?.lastReconcileAt ?? null,
			lastOkAt: r?.lastOkAt ?? null,
			lastChangedAt: r?.lastChangedAt ?? ctx.now(),
			error: r?.error?.kind === "gone" ? null : (r?.error ?? null),
		});
	}
	for (const r of existing.values()) {
		if (r.error?.kind === "gone") continue;
		for (const t of ctx.store.tasksOf(r.href)) ctx.store.dropTask(t.href);
		ctx.store.putList({
			...r,
			syncToken: null,
			error: {
				kind: "gone",
				message: r.shared
					? `“${r.name}” is no longer shared with you.`
					: `“${r.name}” no longer exists in Nextcloud.`,
				action: "Nothing to do; it leaves desk-tasks.",
			},
		});
		gone.push(r.href);
	}
	return gone;
}

// ---------- lists ----------

/** Nextcloud is connected and may be written (not read-only, not paused). */
export function assertConnectedWritable(ctx: Ctx): CaldavClient {
	const dc = client(ctx);
	assertWritable(ctx.store.settings);
	return dc;
}

// ---------- the sync run ----------

/** Per store: the sync in flight and when the last one ended. */
const runs = new WeakMap<
	Ctx["store"],
	{
		inflight: Promise<SyncOutcome> | null;
		/** A forced run queued behind the one in flight. */
		next: Promise<SyncOutcome> | null;
		last: number;
		lastOutcome: SyncOutcome;
	}
>();

export interface SyncOutcome {
	/** Lists that disappeared in this run (the UI says “X is no longer shared with you.”). */
	gone: string[];
	/** Lists that failed, by href. */
	failed: string[];
	ok: boolean;
	/** Why the whole run failed (nothing could be read), for the banner; null otherwise. */
	error: { kind: "auth" | "unreachable" | "invalid"; message: string } | null;
}

const NOTHING: SyncOutcome = { gone: [], failed: [], ok: true, error: null };

/** Waits for a sync in flight, if any (writes that must not race a listing use it). */
export const inflightSync = (ctx: Ctx) => runs.get(ctx.store)?.inflight ?? null;

/**
 * Discovery plus every list. Concurrent callers share one run, and calls within 20 s of the
 * last run are served by it unless `force` is set.
 */
export function sync(
	ctx: Ctx,
	opts: { force?: boolean } = {},
): Promise<SyncOutcome> {
	if (!ctx.dav) return Promise.resolve(NOTHING);
	let run = runs.get(ctx.store);
	if (!run) {
		run = {
			inflight: null,
			next: null,
			last: Number.NEGATIVE_INFINITY,
			lastOutcome: NOTHING,
		};
		runs.set(ctx.store, run);
	}
	// A forced sync must not be answered by a run that started earlier.
	const current = run.inflight;
	if (current) {
		if (!opts.force) return current;
		// All forced callers during a run share one fresh run after it ("Sync now" twice).
		const r = run;
		r.next ??= current.then(() => {
			r.next = null;
			return sync(ctx, opts);
		});
		return r.next;
	}
	const since = ctx.now() - run.last;
	if (!opts.force && since >= 0 && since < COALESCE_MS)
		return Promise.resolve(run.lastOutcome);
	const r = run;
	r.inflight = runSync(ctx).finally(() => {
		r.inflight = null;
		r.last = ctx.now();
	});
	void r.inflight.then((o) => {
		r.lastOutcome = { ...o, gone: [] };
	});
	return r.inflight;
}

async function runSync(ctx: Ctx): Promise<SyncOutcome> {
	const started = ctx.now();
	try {
		const dc = client(ctx);
		const version = await dc.version();
		const { principal, home, collections } = await dc.discover();
		const gone = upsertCollections(ctx, collections, principal);
		const lists = ctx.store.lists().filter((x) => x.error?.kind !== "gone");
		const failed: string[] = [];
		for (const r of lists) {
			try {
				await syncList(ctx, dc, r, started);
			} catch (err) {
				if (err instanceof CaldavError && err.status === 401) throw err;
				ctx.store.patchList(r.href, { error: listError(err, r.name) });
				failed.push(r.href);
			}
		}
		// A sync in which nothing could be read is not "synced".
		const names = failed.map((h) => ctx.store.list(h)?.name ?? h);
		ctx.store.patchMeta({
			version,
			principal,
			home,
			error: failed.length
				? `${failed.length} of ${lists.length} lists couldn't be synced (${names.join(", ")}).`
				: null,
			...(failed.length < lists.length || !lists.length
				? { lastSync: ctx.now() }
				: {}),
		});
		return { gone, failed, ok: failed.length === 0, error: null };
	} catch (err) {
		const known =
			err instanceof CaldavError || err instanceof CaldavUnreachable;
		const auth = err instanceof CaldavError && err.status === 401;
		const message = auth
			? AUTH_HELP
			: known
				? (err as Error).message
				: `Sync failed unexpectedly: ${(err as Error).message}`;
		if (known) ctx.log.warn(`Sync failed: ${message}`);
		else ctx.log.error(`Sync failed: ${(err as Error).stack ?? err}`);
		ctx.store.patchMeta({ error: message });
		const failed: string[] = [];
		for (const r of ctx.store.lists().filter((x) => x.error?.kind !== "gone")) {
			failed.push(r.href);
			ctx.store.patchList(r.href, {
				error: {
					kind: auth ? "auth" : known ? "unreachable" : "invalid",
					message,
					action: auth
						? "Log in again."
						: known
							? "Nothing to do now; it's retried automatically."
							: "Check the log.",
				},
			});
		}
		if (err instanceof CoreError) throw err;
		return {
			gone: [],
			failed,
			ok: false,
			error: {
				kind: auth ? "auth" : known ? "unreachable" : "invalid",
				message,
			},
		};
	}
}

/** Maps adapter errors onto the per-list error vocabulary. */
function listError(err: unknown, name: string): ListError {
	if (err instanceof CaldavUnreachable)
		return {
			kind: "unreachable",
			message: err.message,
			action: "Nothing to do now; it's retried automatically.",
		};
	if (err instanceof CaldavError)
		return {
			// A 404 here is confirmed by the next discovery, which drops the list properly.
			kind: "unreachable",
			message: `Nextcloud answered ${err.status} for “${name}”: ${err.message}`,
			action: "Check the list in Nextcloud; it's retried automatically.",
		};
	return {
		kind: "invalid",
		message: `“${name}” couldn't be synced: ${(err as Error).message}`,
		action: "Check the log.",
	};
}
