import { expect, test } from "bun:test";
import {
	changeOf,
	dueOf,
	type Form,
	formOf,
	liftMarks,
	rebase,
} from "../src/logic/draft.ts";

const form = (o: Partial<Form> = {}): Form => ({
	...formOf(null, "/l/"),
	...o,
});

test("rebase keeps a summary edited in the drawer over a fresh form with a new priority", () => {
	const from = form({ summary: "Call Anna" });
	const draft = { ...from, summary: "Call Anna back" };
	const fresh = { ...from, priority: "high" as const };
	expect(rebase(fresh, from, draft)).toEqual({
		...from,
		summary: "Call Anna back",
		priority: "high",
	});
});

test("changeOf sends due only when the date or time changed", () => {
	const base = form({ summary: "A", dueDate: "2026-10-26", dueTime: "09:00" });
	const due = { date: "2026-10-26", minutes: 540 };
	expect(changeOf(base, { ...base, summary: "B" }, due)).toEqual({
		summary: "B",
	});
	expect(changeOf(base, { ...base, dueTime: "10:00" }, due)).toEqual({ due });
	expect(changeOf(base, { ...base, dueDate: "2026-10-27" }, due)).toEqual({
		due,
	});
});

test("dueOf rejects a malformed time and a time without a date", () => {
	expect(dueOf(form({ dueDate: "2026-10-26", dueTime: "25:99" }))).toEqual({
		error: "The due time must look like 14:30.",
	});
	expect(dueOf(form({ dueTime: "14:30" }))).toEqual({
		error: "Pick a due date for the time.",
	});
	expect(dueOf(form({ dueDate: "2026-10-26", dueTime: "14:30" }))).toEqual({
		due: { date: "2026-10-26", minutes: 870 },
	});
});

test("liftMarks moves the #tags and !priority typed into a title into the fields", () => {
	const saved = form();
	const f = form({ summary: "Pay rent #home !1 #money", tags: ["home"] });
	expect(liftMarks(f, saved)).toEqual({
		...f,
		summary: "Pay rent",
		priority: "high",
		tags: ["home", "money"],
	});
	const plain = form({ summary: "Pay rent" });
	expect(liftMarks(plain, saved)).toBe(plain);
	expect(liftMarks(form({ summary: "#home !1" }), saved)).toBeNull();
	// A #word the saved title already has stays in it when the title is edited.
	const had = form({ summary: "Read #rust book" });
	expect(
		liftMarks({ ...had, summary: "Read #rust books #learn" }, had),
	).toMatchObject({ summary: "Read #rust books", tags: ["learn"] });
});
