// What every core function works with: the store, the CalDAV client (null until connected),
// the clock and the app's time zone, and the log.
import { type CaldavClient, CaldavError, CaldavUnreachable } from "./caldav.ts";
import { CoreError, type Failure, type Result } from "./errors.ts";
import type { Store } from "./store.ts";

export interface Logger {
	info(msg: string): void;
	warn(msg: string): void;
	error(msg: string): void;
}

export interface Ctx {
	store: Store;
	dav: CaldavClient | null;
	now: () => number;
	/** IANA zone for floating times, DATE values and "today" (the Windows zone in the app). */
	tz: string;
	log: Logger;
	/** Set inside an undo group (see undo.ts `journaled`): its journal entries carry it. */
	group?: number;
}

export const consoleLogger: Logger = {
	info: (m) => console.info(m),
	warn: (m) => console.warn(m),
	error: (m) => console.error(m),
};

export const AUTH_HELP = "Nextcloud rejected the app password.";

export function client(ctx: Ctx): CaldavClient {
	if (!ctx.dav)
		throw new CoreError(
			"not-connected",
			"Nextcloud isn't connected yet. Connect it in Settings.",
		);
	return ctx.dav;
}

/** Adapter errors as core failures, Nextcloud's own wording kept. */
export function asCore(err: unknown): never {
	if (err instanceof CoreError) throw err;
	if (err instanceof CaldavUnreachable)
		throw new CoreError("unreachable", err.message, {
			sent: err.kind !== "connect",
		});
	if (err instanceof CaldavError) {
		if (err.status === 401)
			throw new CoreError("auth", AUTH_HELP, { status: 401 });
		if (err.status === 429)
			throw new CoreError(
				"rate-limited",
				"Nextcloud asks to slow down (too many requests). Try again in a few minutes.",
				{ status: 429 },
			);
		throw new CoreError(
			"refused",
			`${err.status >= 500 ? "Nextcloud failed" : "Nextcloud refused"}: ${err.message}`,
			{ status: err.status },
		);
	}
	throw err;
}

/** Runs a core operation and reports its outcome as a Result. */
export async function attempt<T>(fn: () => Promise<T>): Promise<Result<T>> {
	try {
		return { ok: true, value: await fn() };
	} catch (err) {
		try {
			asCore(err);
		} catch (e) {
			const steps = (err as { steps?: number[] }).steps;
			const left = (err as { left?: number[] }).left;
			if (e instanceof CoreError)
				return {
					ok: false,
					error: {
						...e.failure,
						...(steps?.length ? { steps } : {}),
						...(left?.length ? { left } : {}),
					},
				};
			const failure: Failure = {
				kind: "refused",
				message: `Something went wrong: ${(e as Error).message}`,
			};
			console.error(e);
			return { ok: false, error: failure };
		}
		throw err;
	}
}
