// The change log and the write gate: the read-only switch and "paused after something
// unexpected". Both refuse before any request is sent.
import type { Ctx } from "./ctx.ts";
import { CoreError } from "./errors.ts";
import type {
	DurableSettings,
	JournalEntry,
	JournalOp,
	VersionRecord,
} from "./store.ts";

/** Refuses a write before anything is sent: read-only switch or paused writes. */
export function assertWritable(st: DurableSettings): void {
	if (st.readOnly)
		throw new CoreError(
			"paused",
			"desk-tasks is set to read-only. Switch it off in Settings to make changes.",
		);
	if (st.paused)
		throw new CoreError(
			"paused",
			`Saving to Nextcloud is paused: ${st.paused.reason} Review the change, then resume in Settings.`,
		);
}

export function addJournal(
	ctx: Ctx,
	e: {
		op: JournalOp;
		target: string | null;
		before: VersionRecord | null;
		after: VersionRecord | null;
		status: JournalEntry["status"];
		message?: string;
		undoOf?: number;
	},
): number {
	return ctx.store.addJournal({
		at: ctx.now(),
		...e,
		...(ctx.group === undefined ? {} : { group: ctx.group }),
	});
}

/** Looks up an entry for undo and refuses the cases that can't be undone. */
export function undoable(ctx: Ctx, id: number): JournalEntry {
	const entry = ctx.store.journalEntry(id);
	if (!entry)
		throw new CoreError("gone", "That change isn't in the change log.");
	if (entry.status !== "ok")
		throw new CoreError("refused", "Only successful changes can be undone.");
	if (entry.undoneBy)
		throw new CoreError("refused", "This change was already undone.");
	return entry;
}

/**
 * After a write that went wrong in a way nobody can explain yet (read-back differs, no answer,
 * still there after delete): pause all writes, journal the evidence, and tell the user.
 */
export async function haltWrites(
	ctx: Ctx,
	e: {
		op: JournalOp;
		target: string | null;
		before: VersionRecord | null;
		after: VersionRecord | null;
		/** Becomes the pause reason and the change-log message. */
		reason: string;
		/** Technical detail for the change log only. */
		detail?: string;
		undoOf?: number;
	},
	userMessage: string,
): Promise<never> {
	ctx.store.patchSettings({ paused: { reason: e.reason, at: ctx.now() } });
	addJournal(ctx, {
		op: e.op,
		target: e.target,
		before: e.before,
		after: e.after,
		status: "mismatch",
		message: e.detail ? `${e.reason} (${e.detail})` : e.reason,
		...(e.undoOf === undefined ? {} : { undoOf: e.undoOf }),
	});
	ctx.log.warn(`Writes paused: ${e.reason}`);
	// The pause must outlive a crash or quit right after this: wait until it is stored.
	await ctx.store
		.flush()
		.catch((err: unknown) =>
			ctx.log.error(`Storing the pause failed: ${(err as Error).message}`),
		);
	throw new CoreError("paused", userMessage);
}
