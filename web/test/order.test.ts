// Manual order: the Tasks app's neighbour rule, the bump, Apple-epoch and small-integer scales
// mixed, and a reorder written to the server touching only the moved and bumped tasks.
import { afterEach, describe, expect, test } from "bun:test";
import { attempt } from "../src/core/ctx.ts";
import { applyOrder, compareManual, reorderPlan } from "../src/core/order.ts";
import { sync } from "../src/core/sync.ts";
import { listTasks } from "../src/core/tasks.ts";
import { journaled } from "../src/core/undo.ts";
import { FakeCaldav, vtodo } from "./fake-caldav.ts";
import { at, diff, testCore } from "./helpers.ts";

const t = (href: string, sortOrder: number) => ({
	href,
	sortOrder,
	createdAt: 0,
	uid: href,
});

describe("the reorder rule", () => {
	test("between two siblings: next − 1 when it still lies above prev", () => {
		const s = [t("a", 100), t("b", 200), t("c", 300)];
		// c between a and b.
		expect(reorderPlan(s, s[2] as never, 1)).toEqual([
			{ href: "c", order: 199 },
		]);
	});

	test("no room below next: prev + 1, then the following ones are bumped", () => {
		const s = [t("a", 100), t("b", 101), t("c", 102), t("d", 500)];
		// d between a and b: 101 − 1 = 100 isn't above 100, so 101; b and c bump to 102, 103.
		expect(reorderPlan(s, s[3] as never, 1)).toEqual([
			{ href: "d", order: 101 },
			{ href: "b", order: 102 },
			{ href: "c", order: 103 },
		]);
	});

	test("to the top and to the bottom", () => {
		const s = [t("a", 5), t("b", 9), t("c", 12)];
		expect(reorderPlan(s, s[2] as never, 0)).toEqual([{ href: "c", order: 4 }]);
		expect(reorderPlan(s, s[0] as never, 2)).toEqual([
			{ href: "a", order: 13 },
		]);
		// Next is 0: next − 1 would be negative, so prev + 1 (= 0) and everything after bumps.
		const z = [t("a", 0), t("b", 1)];
		expect(reorderPlan(z, z[1] as never, 0)).toEqual([
			{ href: "b", order: 0 },
			{ href: "a", order: 1 },
		]);
	});

	test("Planify's all-zero orders: one drag bumps every following sibling", () => {
		const s = ["a", "b", "c", "d", "e"].map((h) => t(h, 0));
		expect(reorderPlan(s, s[4] as never, 1)).toEqual([
			{ href: "e", order: 1 },
			{ href: "b", order: 2 },
			{ href: "c", order: 3 },
			{ href: "d", order: 4 },
		]);
	});

	test("Apple-epoch seconds next to small integers: works on the values as they are", () => {
		// tasks.org / Nextcloud write Apple-epoch seconds, Planify small integers.
		const s = [
			t("p1", 1),
			t("p2", 2),
			t("n1", 782_563_200),
			t("n2", 782_563_900),
		];
		expect(reorderPlan(s, s[0] as never, 2)).toEqual([
			{ href: "p1", order: 782_563_899 },
		]);
		expect(reorderPlan(s, s[3] as never, 1)).toEqual([
			{ href: "n2", order: 2 },
			{ href: "p2", order: 3 },
		]);
	});

	test("a new task created at a place gets an order there", () => {
		const s = [t("a", 10), t("b", 20)];
		expect(reorderPlan(s, { href: "", sortOrder: 0 }, 1)).toEqual([
			{ href: "", order: 19 },
		]);
	});

	test("My order ties break by CREATED, then UID", () => {
		const list = [
			{ href: "x", sortOrder: 5, createdAt: 2, uid: "b" },
			{ href: "y", sortOrder: 5, createdAt: 1, uid: "c" },
			{ href: "z", sortOrder: 5, createdAt: 2, uid: "a" },
		].sort(compareManual);
		expect(list.map((x) => x.href)).toEqual(["y", "z", "x"]);
	});
});

let fake: FakeCaldav;
afterEach(() => fake?.stop());

test("a reorder writes only the moved and bumped tasks, each only in its sort order, as one undo", async () => {
	fake = new FakeCaldav();
	const list = fake.addList("l", "L");
	for (const [uid, order] of [
		["a", 0],
		["b", 0],
		["c", 0],
		["d", 7],
	] as const)
		fake.put(`${list}${uid}.ics`, vtodo(uid, [`X-APPLE-SORT-ORDER:${order}`]));
	const core = testCore({ url: fake.url, now: at("2026-10-28", "09:00") });
	await sync(core.ctx, { force: true });
	const sibs = listTasks(core.ctx).sort(compareManual);
	expect(sibs.map((x) => x.uid)).toEqual(["a", "b", "c", "d"]);
	const before = new Map(sibs.map((x) => [x.uid, fake.get(x.href) ?? ""]));
	const plan = reorderPlan(sibs, sibs[2] as never, 0); // c to the top
	const res = await attempt(() =>
		journaled(core.ctx, (g) => applyOrder(g, plan)),
	);
	if (!res.ok) throw new Error(res.error.message);
	expect(
		listTasks(core.ctx)
			.sort(compareManual)
			.map((x) => x.uid),
	).toEqual(["c", "a", "b", "d"]);
	expect(res.value.steps).toHaveLength(plan.length);
	for (const x of sibs) {
		const d = diff(before.get(x.uid) ?? "", fake.get(x.href) ?? "");
		const touched = plan.some((p) => p.href === x.href);
		expect(d.added.map((l) => l.split(":")[0]).sort()).toEqual(
			touched ? ["DTSTAMP", "X-APPLE-SORT-ORDER"] : [],
		);
	}
	expect(fake.get(sibs[3]?.href ?? "")).toContain("X-APPLE-SORT-ORDER:7\r\n"); // d untouched
});
