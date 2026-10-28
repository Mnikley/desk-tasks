// Shared test helpers: fixtures read as exact bytes, the Berlin clock, and a line diff.
import { wallToInstant } from "../src/core/time.ts";

export const TZ = "Europe/Berlin";

/** Instant for a Berlin wall time. */
export const at = (date: string, hhmm: string) => {
	const [h = 0, m = 0] = hhmm.split(":").map(Number);
	return wallToInstant(date, h * 60 + m, TZ);
};

/** A fixture's exact text: decoded strictly, a byte-order mark kept (like the bridge does). */
export async function fixture(name: string): Promise<string> {
	const bytes = await Bun.file(
		new URL(`../../test/fixtures/tasks/${name}`, import.meta.url),
	).bytes();
	return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
		bytes,
	);
}

/** Awaits a promise that must reject and returns the error. */
export async function rejection(p: Promise<unknown>): Promise<Error> {
	try {
		await p;
	} catch (e) {
		return e as Error;
	}
	throw new Error("Expected a failure, but it succeeded.");
}

/** Physical lines with their own line endings. */
export const physical = (s: string) =>
	s.match(/[^\r\n]*(\r\n|\n|\r|$)/g)?.filter((l) => l !== "") ?? [];

/** Lines removed from `a` and added in `b` (LCS diff over physical lines, endings included). */
export function diff(
	a: string,
	b: string,
): { removed: string[]; added: string[] } {
	const x = physical(a);
	const y = physical(b);
	const w = y.length + 1;
	const lcs = new Int32Array((x.length + 1) * w);
	const at = (i: number, j: number) => lcs[i * w + j] ?? 0;
	for (let i = x.length - 1; i >= 0; i--)
		for (let j = y.length - 1; j >= 0; j--)
			lcs[i * w + j] =
				x[i] === y[j]
					? at(i + 1, j + 1) + 1
					: Math.max(at(i + 1, j), at(i, j + 1));
	const removed: string[] = [];
	const added: string[] = [];
	let i = 0;
	let j = 0;
	while (i < x.length || j < y.length) {
		if (i < x.length && j < y.length && x[i] === y[j]) {
			i++;
			j++;
		} else if (j < y.length && (i === x.length || at(i, j + 1) >= at(i + 1, j)))
			added.push(y[j++] ?? "");
		else removed.push(x[i++] ?? "");
	}
	return { removed, added };
}

// ---------- a core wired to a server ----------

import { CaldavClient } from "../src/core/caldav.ts";
import type { Ctx } from "../src/core/ctx.ts";
import { Store } from "../src/core/store.ts";
import { fetchTransport, type RequestLog } from "./transport.ts";

export interface TestCore {
	ctx: Ctx;
	clock: { now: number };
	/** Every request the core sent, as "METHOD path". */
	log: RequestLog;
	/** Warnings and errors the core logged. */
	logged: string[];
}

/** A core with a memory store, connected to `url` with a fixed clock. */
export function testCore(opts: {
	url: string;
	now: number;
	user?: string;
	password?: string;
}): TestCore {
	const clock = { now: opts.now };
	const log: RequestLog = [];
	const logged: string[] = [];
	const ctx: Ctx = {
		store: new Store(),
		dav: new CaldavClient(
			opts.url,
			fetchTransport({
				user: opts.user ?? "u",
				password: opts.password ?? "app-password",
				log,
			}),
		),
		now: () => clock.now,
		tz: TZ,
		log: {
			info: () => {},
			warn: (m) => logged.push(m),
			error: (m) => logged.push(m),
		},
	};
	return { ctx, clock, log, logged };
}

/** A list record as discovery would store it. */
export const listRecord = (
	o: Partial<import("../src/core/store.ts").ListRecord> = {},
): import("../src/core/store.ts").ListRecord => ({
	href: "/remote.php/dav/calendars/u/errands/",
	name: "Errands",
	color: "#0e9484",
	order: 0,
	ctag: null,
	components: ["VTODO"],
	writable: true,
	shared: false,
	owner: "principals/users/u",
	ownerName: "U",
	sharees: [],
	canShare: true,
	appGenerated: false,
	syncToken: null,
	lastReconcileAt: null,
	lastOkAt: null,
	lastChangedAt: null,
	error: null,
	...o,
});
