// Undo groups: a user action may make several writes (a bulk change, a cascade, a subtree
// move); `journaled` runs it and returns the journal entries it made, newest first, so one Undo
// takes them all back in order. Writes run one at a time, so a group never takes in another
// action's entries.
import type { Ctx } from "./ctx.ts";
import { undo } from "./write.ts";

/** Per store: the chain writes queue on. */
const busy = new WeakMap<Ctx["store"], Promise<unknown>>();

export interface Journaled<T> {
	result: T;
	/** Journal ids to undo, newest first; empty when nothing was written. */
	steps: number[];
}

/** The entries a group made: successful writes that aren't themselves undos. */
const madeSince = (ctx: Ctx, before: number) =>
	ctx.store
		.journal()
		.filter((e) => e.id > before && e.status === "ok" && e.undoOf === null)
		.map((e) => e.id);

/**
 * Runs `write` after every earlier write has finished, and returns its result with the journal
 * entries it made. When `write` fails after some entries were made, the error carries them as
 * `steps` so the caller can still offer to undo the part that went through.
 */
export function journaled<T>(
	ctx: Ctx,
	write: () => Promise<T>,
): Promise<Journaled<T>> {
	const prev = busy.get(ctx.store) ?? Promise.resolve();
	const run = prev.then(async () => {
		const before = ctx.store.lastJournalId();
		try {
			const result = await write();
			return { result, steps: madeSince(ctx, before) };
		} catch (err) {
			throw Object.assign(err as Error, { steps: madeSince(ctx, before) });
		}
	});
	busy.set(
		ctx.store,
		run.catch(() => undefined),
	);
	return run;
}

/** The entries a failed group already made (see `journaled`). */
export const partialSteps = (err: unknown): number[] =>
	(err as { steps?: number[] }).steps ?? [];

/**
 * Undoes the steps in order. Stops at the first failure and returns the steps still to do, so
 * "Try again" continues where it stopped; throws that failure with `left` attached.
 */
export async function undoSteps(ctx: Ctx, steps: number[]): Promise<void> {
	const left = [...steps];
	await journaled(ctx, async () => {
		try {
			while (left[0] !== undefined) {
				await undo(ctx, left[0]);
				left.shift();
			}
		} catch (err) {
			throw Object.assign(err as Error, { left: [...left] });
		}
	});
}

export const leftSteps = (err: unknown): number[] =>
	(err as { left?: number[] }).left ?? [];
