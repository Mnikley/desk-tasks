// The TS side of the bridge: answers are validated, dav() never rejects, and an answer it
// can't read is `network` (a write's outcome is then unknown, so the core pauses writes).
import { describe, expect, test } from "bun:test";
import { Bridge, type PyApi } from "../src/bridge.ts";

function api(over: Partial<PyApi>): PyApi {
	const no = () => Promise.reject(new Error("not stubbed"));
	return {
		dav: no,
		connect_start: no,
		connect_poll: no,
		connect_manual: no,
		disconnect: no,
		next_event: no,
		notify: no,
		tray: no,
		window: no,
		settings_get: no,
		settings_set: no,
		open_url: no,
		log: () => Promise.resolve(null),
		update_get: no,
		update_check: no,
		update_install: no,
		update_dismiss: no,
		...over,
	};
}

const req = {
	method: "PUT" as const,
	url: "https://x/remote.php/dav/a.ics",
	headers: {},
};

describe("bridge", () => {
	test("dav answers pass through; malformed or failed calls become network", async () => {
		const ok = {
			ok: true,
			status: 201,
			headers: { etag: '"1"' },
			body: "",
			notUtf8: false,
		} as const;
		expect(await new Bridge(api({ dav: async () => ok })).send(req)).toEqual(
			ok,
		);
		const big = {
			ok: false,
			kind: "too-large",
			status: 200,
			headers: {},
			message: "m",
		} as const;
		expect(await new Bridge(api({ dav: async () => big })).send(req)).toEqual(
			big,
		);
		for (const bad of [
			null,
			{ ok: true, status: "201" },
			{ ok: false, kind: "boom", message: "" },
		])
			expect(
				await new Bridge(api({ dav: async () => bad })).send(req),
			).toMatchObject({ ok: false, kind: "network" });
		const thrown = await new Bridge(
			api({ dav: () => Promise.reject(new Error("pywebview")) }),
		).send(req);
		expect(thrown).toMatchObject({ ok: false, kind: "network" });
	});

	test("events: known ones typed, unknown ones skipped, timeout is null", async () => {
		const queue: unknown[] = [
			{ type: "summoned", target: { task: "/a.ics" } },
			{ type: "mystery" },
			null,
		];
		const b = new Bridge(
			api({ next_event: async () => queue.shift() ?? null }),
		);
		expect(await b.nextEvent()).toEqual({
			type: "summoned",
			target: { task: "/a.ics" },
		});
		expect(await b.nextEvent()).toBeNull();
		expect(await b.nextEvent()).toBeNull();
	});

	test("a refused settings patch throws with Python's message", async () => {
		const b = new Bridge(
			api({
				settings_set: async () => ({
					ok: false,
					message: "bad value for readOnly",
				}),
			}),
		);
		await expect(b.settingsSet({ readOnly: true })).rejects.toThrow(
			"bad value for readOnly",
		);
	});

	test("a long-poll whose answer never comes ends as null (the event loop goes on)", async () => {
		const b = new Bridge(api({ next_event: () => new Promise(() => {}) }));
		const t = performance.now();
		expect(await b.nextEvent(0, 50)).toBeNull();
		expect(performance.now() - t).toBeLessThan(1000);
	});
});
