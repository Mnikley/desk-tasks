// Fixes from the core review: oversized answers to writes, undo-group attribution, storage
// failures, a slow sync reviving a deleted task, and requests refused before they're sent.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { attempt } from "../src/core/ctx.ts";
import { combine } from "../src/core/idb.ts";
import { Store } from "../src/core/store.ts";
import { storeTask, sync } from "../src/core/sync.ts";
import { listTasks } from "../src/core/tasks.ts";
import { journaled } from "../src/core/undo.ts";
import { deleteTask, updateTask } from "../src/core/write.ts";
import { FakeCaldav, vtodo } from "./fake-caldav.ts";
import { at, type TestCore, testCore } from "./helpers.ts";

let fake: FakeCaldav;
let core: TestCore;
let list = "";
const href = (uid: string) => `${list}${uid}.ics`;
const big = "x".repeat(70 * 1024);

beforeEach(async () => {
	fake = new FakeCaldav();
	list = fake.addList("errands", "Errands");
	for (const uid of ["a", "b", "c"]) fake.put(href(uid), vtodo(uid));
	core = testCore({ url: fake.url, now: at("2026-10-28", "09:00") });
	await sync(core.ctx, { force: true });
});
afterEach(() => fake.stop());

describe("an oversized answer to a write", () => {
	const answerPutWith = (status: number) => {
		fake.before = async (req, path) => {
			if (req.method !== "PUT") return undefined;
			// Apply the write like the server would, then answer with a body over the 64 KB cap.
			fake.put(path, await req.text());
			return new Response(big, { status, headers: { etag: '"x"' } });
		};
	};

	test("with a 2xx went through: verified by the read-back, not reported as refused", async () => {
		answerPutWith(200);
		const res = await attempt(() =>
			updateTask(core.ctx, href("a"), { summary: "A2" }),
		);
		expect(res.ok).toBe(true);
		expect(core.ctx.store.settings.paused).toBeNull();
		expect(fake.get(href("a"))).toContain("SUMMARY:A2");
	});

	test("with a 5xx is an unknown outcome and pauses writes", async () => {
		answerPutWith(500);
		const res = await attempt(() =>
			updateTask(core.ctx, href("a"), { summary: "A2" }),
		);
		expect(!res.ok && res.error.kind).toBe("paused");
		expect(core.ctx.store.settings.paused).not.toBeNull();
	});

	test("with a 4xx is a refusal and doesn't pause", async () => {
		fake.before = async (req) =>
			req.method === "PUT" ? new Response(big, { status: 403 }) : undefined;
		const res = await attempt(() =>
			updateTask(core.ctx, href("a"), { summary: "A2" }),
		);
		expect(!res.ok && res.error.kind).toBe("refused");
		expect(core.ctx.store.settings.paused).toBeNull();
	});
});

describe("undo groups", () => {
	test("a group's undo covers its own writes only, not a write that ran beside it", async () => {
		let release = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const group = journaled(core.ctx, async (g) => {
			await updateTask(g, href("a"), { priority: "high" });
			await gate;
			await updateTask(g, href("b"), { priority: "high" });
		});
		await Bun.sleep(30);
		// Not in the group (e.g. a direct write elsewhere): must not join its Undo.
		await updateTask(core.ctx, href("c"), { priority: "low" });
		release();
		const { steps } = await group;
		const targets = steps.map((id) => core.ctx.store.journalEntry(id)?.target);
		expect(targets).toEqual([href("b"), href("a")]);
	});

	test("a group inside a group is refused instead of waiting for itself", async () => {
		const res = await journaled(core.ctx, async (g) => {
			try {
				await journaled(g, async () => 1);
				return "nested ran";
			} catch (err) {
				return (err as Error).message;
			}
		});
		expect(res.result).toContain("inside another one");
		// The chain is free again.
		expect((await journaled(core.ctx, async () => 2)).result).toBe(2);
	});

	test("a failure part-way keeps the steps that went through in the Failure", async () => {
		fake.before = async (req, path) =>
			req.method === "PUT" && path.endsWith("b.ics")
				? new Response("no", { status: 403 })
				: undefined;
		const res = await attempt(() =>
			journaled(core.ctx, async (g) => {
				await updateTask(g, href("a"), { priority: "high" });
				await updateTask(g, href("b"), { priority: "high" });
			}),
		);
		expect(!res.ok && res.error.steps?.length).toBe(1);
	});
});

describe("storage and sync races", () => {
	test("a failed write-through is reported by flush, and every persister still gets the batch", async () => {
		const seen: string[] = [];
		const store = new Store(
			combine(
				{
					write: async () => {
						throw new Error("disk full");
					},
				},
				{ write: async (c) => void seen.push(...c.map((x) => x.type)) },
			),
		);
		store.patchMeta({ lastSync: 1 });
		await expect(store.flush()).rejects.toThrow("disk full");
		expect(store.storageError?.message).toBe("disk full");
		expect(seen).toEqual(["meta"]);
		await expect(store.flush()).resolves.toBeUndefined();
	});

	test("a sync that began before a delete doesn't bring the task back", async () => {
		const started = core.ctx.now();
		const stale = core.ctx.store.task(href("a"));
		core.clock.now += 1000;
		expect((await attempt(() => deleteTask(core.ctx, href("a")))).ok).toBe(
			true,
		);
		// The slow sync now stores the copy it fetched before the delete.
		storeTask(
			core.ctx,
			list,
			href("a"),
			{ text: stale?.ics ?? "", etag: stale?.etag ?? "" },
			started,
		);
		expect(listTasks(core.ctx).some((t) => t.uid === "a")).toBe(false);
	});

	test("a status.php the bridge refuses doesn't stop the sync", async () => {
		fake.before = async (_req, path) =>
			path === "/status.php" ? new Response(big, { status: 200 }) : undefined;
		core.clock.now += 60_000;
		const outcome = await sync(core.ctx, { force: true });
		expect(outcome.ok).toBe(true);
		expect(core.ctx.store.meta.version).toBeNull();
	});

	test("a request refused before it is sent (href outside the DAV root) doesn't pause writes", async () => {
		core.ctx.store.putList({
			...(core.ctx.store.list(list) ?? (null as never)),
			href: "/elsewhere/list/",
		});
		core.ctx.store.putTask(
			{
				href: "/elsewhere/list/x.ics",
				list: "/elsewhere/list/",
				etag: '"e"',
				ics: vtodo("x"),
				notUtf8: false,
				uid: "x",
			},
			core.ctx.now(),
		);
		const res = await attempt(() =>
			updateTask(core.ctx, "/elsewhere/list/x.ics", { summary: "y" }),
		);
		expect(!res.ok && res.error.kind).toBe("refused");
		expect(core.ctx.store.settings.paused).toBeNull();
	});
});
