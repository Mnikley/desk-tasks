// What the core reports instead of HTTP errors: a failure kind the UI can act on, and
// Nextcloud's own wording where there is one. Core functions throw CoreError internally; the
// public entry points turn it into a Result.
import type { TaskSide } from "./tasks.ts";

export type FailureKind =
	/** Nextcloud (or a local rule) refused; nothing was changed. */
	| "refused"
	/** The task changed elsewhere; `conflict` carries both sides. */
	| "conflict"
	/** Writes are paused or the read-only switch is on; nothing was sent. */
	| "paused"
	/** The input isn't valid (e.g. a due date before the start); nothing was sent. */
	| "invalid"
	/** No answer. `sent` false: nothing reached the server ("Couldn't save · Retry"). */
	| "unreachable"
	/** Nextcloud rejected the app password. */
	| "auth"
	/** Too many requests. */
	| "rate-limited"
	/** The task or list isn't there any more. */
	| "gone"
	/** No Nextcloud connected yet. */
	| "not-connected";

export interface Failure {
	kind: FailureKind;
	message: string;
	/** HTTP status from Nextcloud, when it answered. */
	status?: number;
	conflict?: { mine: TaskSide | null; theirs: TaskSide | null };
	/** For "unreachable": whether the request may have reached the server. */
	sent?: boolean;
}

export class CoreError extends Error {
	constructor(
		readonly kind: FailureKind,
		message: string,
		readonly extra: Omit<Failure, "kind" | "message"> = {},
	) {
		super(message);
	}

	get failure(): Failure {
		return { kind: this.kind, message: this.message, ...this.extra };
	}
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: Failure };
