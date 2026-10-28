// Cascades like the Tasks app: complete a parent with its open subtasks, re-open a subtask with
// its completed parents, re-parent by editing only the parent link, move a subtask alone.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	completeTask,
	moveToList,
	reopenTask,
	setParent,
} from "../src/core/cascade.ts";
import { attempt } from "../src/core/ctx.ts";
import { TaskDocument } from "../src/core/ical.ts";
import { sync } from "../src/core/sync.ts";
import { listTasks } from "../src/core/tasks.ts";
import { journaled, undoSteps } from "../src/core/undo.ts";
import { FakeCaldav, vtodo } from "./fake-caldav.ts";
import { at, diff, type TestCore, testCore } from "./helpers.ts";

let fake: FakeCaldav;
let core: TestCore;
let list = "";
let other = "";
const h = (uid: string) => `${list}${uid}.ics`;
const status = (uid: string) =>
	TaskDocument.parse(fake.get(h(uid)) ?? "").fields().status;
const writes = () => core.log.filter((l) => /^(PUT|DELETE|MOVE) /.test(l));

beforeEach(async () => {
	fake = new FakeCaldav();
	list = fake.addList("home", "Home");
	other = fake.addList("work", "Work");
	// p ─ c1 ─ g1
	//   ├ c2 (done)
	//   └ r (repeats)
	fake.put(h("p"), vtodo("p", ["DUE;VALUE=DATE:20261030"]));
	fake.put(h("c1"), vtodo("c1", ["RELATED-TO:p"]));
	fake.put(h("g1"), vtodo("g1", ["RELATED-TO:c1"]));
	fake.put(
		h("c2"),
		vtodo("c2", [
			"RELATED-TO:p",
			"STATUS:COMPLETED",
			"COMPLETED:20261020T000000Z",
		]),
	);
	fake.put(
		h("r"),
		vtodo("r", ["RELATED-TO:p", "DUE;VALUE=DATE:20261029", "RRULE:FREQ=DAILY"]),
	);
	core = testCore({ url: fake.url, now: at("2026-10-28", "09:00") });
	await sync(core.ctx, { force: true });
});
afterEach(() => fake.stop());

describe("completing and re-opening", () => {
	test("a parent completes its open subtasks, children first; a repeating subtask closes for good", async () => {
		const res = await attempt(() =>
			journaled(core.ctx, (g) => completeTask(g, h("p"))),
		);
		if (!res.ok) throw new Error(res.error.message);
		expect(res.value.result.subtasks).toBe(3);
		expect(["p", "c1", "g1", "r"].map(status)).toEqual([
			"COMPLETED",
			"COMPLETED",
			"COMPLETED",
			"COMPLETED",
		]);
		expect(fake.get(h("r"))).toContain("DUE;VALUE=DATE:20261029"); // closed, not advanced
		const order = writes().map((l) => l.split("/").pop());
		expect(order.indexOf("g1.ics")).toBeLessThan(order.indexOf("c1.ics"));
		expect(order.at(-1)).toBe("p.ics");
		expect(writes().some((l) => l.endsWith("c2.ics"))).toBe(false); // already done
		// One Undo takes it all back.
		const before = fake.get(h("g1"));
		await undoSteps(core.ctx, res.value.steps);
		expect(["p", "c1", "g1", "r"].map(status)).toEqual([
			"NEEDS-ACTION",
			"NEEDS-ACTION",
			"NEEDS-ACTION",
			"NEEDS-ACTION",
		]);
		expect(fake.get(h("g1"))).not.toBe(before);
	});

	test("a repeating parent moves to its next date and leaves its subtasks alone", async () => {
		fake.edit(h("p"), (t) =>
			t.replace(
				"DUE;VALUE=DATE:20261030",
				"DUE;VALUE=DATE:20261030\r\nRRULE:FREQ=WEEKLY",
			),
		);
		await sync(core.ctx, { force: true });
		core.clock.now += 60_000;
		const res = await attempt(() =>
			journaled(core.ctx, (g) => completeTask(g, h("p"))),
		);
		expect(res.ok && res.value.result.subtasks).toBe(0);
		expect(fake.get(h("p"))).toContain("DUE;VALUE=DATE:20261106");
		expect(status("c1")).toBe("NEEDS-ACTION");
	});

	test("one task that can't be changed refuses the whole cascade before any request, naming it", async () => {
		fake.edit(h("g1"), (t) =>
			t.replace(
				"SUMMARY:g1",
				"SUMMARY:Buy tiles\r\nRRULE:FREQ=DAILY\r\nRDATE:20261101",
			),
		);
		await sync(core.ctx, { force: true });
		const n = writes().length;
		const res = await attempt(() =>
			journaled(core.ctx, (g) => completeTask(g, h("p"))),
		);
		expect(!res.ok && res.error.message).toStartWith(
			"“Buy tiles” can't be changed:",
		);
		expect(!res.ok && res.error.message).toEndWith("Nothing was changed.");
		expect(writes().length).toBe(n);
	});

	test("a failure part-way stops it, says how far it got, and the done part is one Undo", async () => {
		fake.before = async (req, path) =>
			req.method === "PUT" && path.endsWith("c1.ics")
				? new Response("no", { status: 403 })
				: undefined;
		const res = await attempt(() =>
			journaled(core.ctx, (g) => completeTask(g, h("p"))),
		);
		expect(!res.ok && res.error.message).toContain(
			"of 4 tasks were already completed",
		);
		const steps = !res.ok ? (res.error.steps ?? []) : [];
		expect(steps.length).toBeGreaterThan(0);
		await undoSteps(core.ctx, steps);
		expect(["g1", "r"].map(status)).toEqual(["NEEDS-ACTION", "NEEDS-ACTION"]);
	});

	test("re-opening a subtask re-opens its completed parents", async () => {
		await journaled(core.ctx, (g) => completeTask(g, h("p")));
		const res = await attempt(() =>
			journaled(core.ctx, (g) => reopenTask(g, h("g1"))),
		);
		expect(res.ok && res.value.result.parents).toBe(2);
		expect(["g1", "c1", "p", "r"].map(status)).toEqual([
			"NEEDS-ACTION",
			"NEEDS-ACTION",
			"NEEDS-ACTION",
			"COMPLETED",
		]);
	});
});

describe("re-parenting and moving", () => {
	test("indent edits only the first parent link; CHILD and SIBLING relations stay", async () => {
		fake.edit(h("c1"), (t) =>
			t.replace(
				"RELATED-TO:p",
				"RELATED-TO;RELTYPE=SIBLING:x\r\nRELATED-TO;RELTYPE=PARENT:p\r\nRELATED-TO;RELTYPE=CHILD:g1",
			),
		);
		await sync(core.ctx, { force: true });
		const before = fake.get(h("c1")) ?? "";
		expect(
			(await attempt(() => setParent(core.ctx, h("c1"), h("c2")))).ok,
		).toBe(true);
		const d = diff(before, fake.get(h("c1")) ?? "");
		expect(d.removed.filter((l) => !l.startsWith("DTSTAMP"))).toEqual([
			"RELATED-TO;RELTYPE=PARENT:p\r\n",
		]);
		expect(d.added.filter((l) => !l.startsWith("DTSTAMP"))).toEqual([
			"RELATED-TO;RELTYPE=PARENT:c2\r\n",
		]);
		// Outdent to the top removes just that line.
		expect((await attempt(() => setParent(core.ctx, h("c1"), null))).ok).toBe(
			true,
		);
		expect(fake.get(h("c1"))).toContain("RELATED-TO;RELTYPE=CHILD:g1");
		expect(fake.get(h("c1"))).not.toContain("RELTYPE=PARENT");
		// A task without a parent gets a plain line.
		expect((await attempt(() => setParent(core.ctx, h("c1"), h("p")))).ok).toBe(
			true,
		);
		expect(fake.get(h("c1"))).toContain("RELATED-TO:p\r\n");
	});

	test("no parent in another list, and none below the task itself", async () => {
		fake.put(`${other}w.ics`, vtodo("w"));
		await sync(core.ctx, { force: true });
		const cross = await attempt(() =>
			setParent(core.ctx, h("c1"), `${other}w.ics`),
		);
		expect(!cross.ok && cross.error.message).toBe(
			"Subtasks live in their parent's list. Move it to “Work” first.",
		);
		const loop = await attempt(() => setParent(core.ctx, h("c1"), h("g1")));
		expect(!loop.ok && loop.error.kind).toBe("invalid");
	});

	test("a subtask moved alone loses its parent link first, arrives top-level with its own subtasks, one Undo", async () => {
		const res = await attempt(() =>
			journaled(core.ctx, (g) => moveToList(g, h("c1"), other)),
		);
		if (!res.ok) throw new Error(res.error.message);
		const moved = listTasks(core.ctx).filter((t) => t.list === other);
		expect(moved.map((t) => t.uid).sort()).toEqual(["c1", "g1"]);
		expect(moved.find((t) => t.uid === "c1")?.parentUid).toBeNull();
		expect(moved.find((t) => t.uid === "g1")?.parentUid).toBe("c1");
		const original = fake.get(h("g1"));
		expect(original).toBeUndefined();
		await undoSteps(core.ctx, res.value.steps);
		expect(fake.get(h("c1"))).toContain("RELATED-TO:p\r\n");
		expect(fake.get(h("g1"))).toContain("RELATED-TO:c1\r\n");
	});
});
