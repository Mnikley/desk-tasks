// Undo groups: a user action may make several writes (a bulk change, a cascade, a subtree
// move); `journaled` runs it and returns the journal entries it made, newest first, so one Undo
// takes them all back in order. Groups run one at a time, and each one's entries carry its own
// group id, so a group never takes in another action's entries.
import type { Ctx } from "./ctx.ts";
import { undo } from "./write.ts";

/** Per store: the chain groups queue on. */
const busy = new WeakMap<Ctx["store"], Promise<unknown>>();

export interface Journaled<T> {
	result: T;
	/** Journal ids to undo, newest first; empty when nothing was written. */
	steps: number[];
}

/** The entries a group made: its successful writes that aren't themselves undos. */
const madeBy = (ctx: Ctx, group: number) =>
	ctx.store
		.journal()
		.filter((e) => e.group === group && e.status === "ok" && e.undoOf === null)
		.map((e) => e.id);

/**
 * Runs `write` after every earlier group has finished, with a ctx whose writes are stamped with
 * this group, and returns its result with the journal entries it made. When `write` fails after
 * some entries were made, the error carries them as `steps` (and `attempt` passes them on in
 * `Failure.steps`) so the caller can still offer to undo the part that went through.
 * A group can't contain another one: calling `journaled` with a group's ctx throws.
 */
export function journaled<T>(
	ctx: Ctx,
	write: (g: Ctx) => Promise<T>,
): Promise<Journaled<T>> {
	if (ctx.group !== undefined)
		throw new Error("Broken invariant: an undo group inside another one.");
	const prev = busy.get(ctx.store) ?? Promise.resolve();
	const run = prev.then(async () => {
		const g: Ctx = { ...ctx, group: ctx.store.newGroup() };
		try {
			const result = await write(g);
			return { result, steps: madeBy(ctx, g.group as number) };
		} catch (err) {
			throw Object.assign(err as Error, {
				steps: madeBy(ctx, g.group as number),
			});
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
 * Undoes the steps in order. Stops at the first failure and throws it with the steps still to
 * do attached as `left`, so "Try again" continues where it stopped.
 */
export async function undoSteps(ctx: Ctx, steps: number[]): Promise<void> {
	const left = [...steps];
	await journaled(ctx, async (g) => {
		try {
			while (left[0] !== undefined) {
				await undo(g, left[0]);
				left.shift();
			}
		} catch (err) {
			throw Object.assign(err as Error, { left: [...left] });
		}
	});
}

export const leftSteps = (err: unknown): number[] =>
	(err as { left?: number[] }).left ?? [];
