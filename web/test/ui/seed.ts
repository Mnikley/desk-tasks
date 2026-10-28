// A believable account on the fake server for the UI tests and screenshots, dated around a
// fixed "today" (2026-10-28, a Wednesday) so every run looks the same.
import { addDays } from "../../src/core/time.ts";
import { type FakeCaldav, HOME, vtodo } from "../fake-caldav.ts";

export const TODAY = "2026-10-28";
/** 10:30 in Vienna (CET after the DST change). */
export const NOW = new Date("2026-10-28T10:30:00+01:00");
export const TZ = "Europe/Vienna";

const d = (offset: number) => addDays(TODAY, offset).replaceAll("-", "");
const task = (uid: string, summary: string, lines: string[] = []) =>
	vtodo(uid, [`CREATED:20261001T080000Z`, ...lines]).replace(
		`SUMMARY:${uid}`,
		`SUMMARY:${summary}`,
	);

const INVITE =
	"<o:user><d:href>principal:principals/users/alice</d:href><o:common-name>Alice</o:common-name><o:invite-accepted/><o:access><o:read-write/></o:access></o:user>";

export interface Seeded {
	work: string;
	home: string;
	groceries: string;
}

export function seed(fake: FakeCaldav): Seeded {
	const work = fake.addList("work", "Work", ["VTODO"], true, {
		color: "#3A5BD9FF",
		invite: INVITE,
	});
	const home = fake.addList("home", "Home", ["VTODO"], true, {
		color: "#2E9E5BFF",
	});
	const groceries = fake.addList(
		"groceries_shared_by_bob",
		"Groceries",
		["VTODO"],
		false,
		{
			color: "#D4572DFF",
			owner: "principals/users/bob",
			ownerName: "Bob",
		},
	);
	fake.addList(
		"app-generated--deck--board-3",
		"Deck: Launch",
		["VTODO"],
		true,
		{ color: "#7B4FC9FF" },
	);
	const put = (list: string, uid: string, text: string) =>
		fake.put(`${list}${uid}.ics`, text);

	put(
		work,
		"invoice",
		task("invoice", "Send invoice to Acme", [
			`DUE;VALUE=DATE:${d(-2)}`,
			"PRIORITY:1",
			"CATEGORIES:billing",
			"X-APPLE-SORT-ORDER:100",
		]),
	);
	put(
		work,
		"report",
		task("report", "Prepare quarterly report", [
			`DUE:${d(0)}T090000`,
			"PRIORITY:5",
			"X-APPLE-SORT-ORDER:200",
		]),
	);
	put(
		work,
		"call",
		task("call", "Call Bob about the venue", [
			`DUE:${d(0)}T140000`,
			"DESCRIPTION:Ask about the projector and the late check-out. Details: https://example.com/venue",
			"X-APPLE-SORT-ORDER:300",
			"BEGIN:VALARM",
			"ACTION:DISPLAY",
			"DESCRIPTION:Call Bob about the venue",
			"TRIGGER;RELATED=END:-PT15M",
			"END:VALARM",
		]),
	);
	put(
		work,
		"prs",
		task("prs", "Review pull requests", [
			`DUE;VALUE=DATE:${d(0)}`,
			"CATEGORIES:code,review,team",
			"X-APPLE-SORT-ORDER:400",
		]),
	);
	put(
		work,
		"prs-fe",
		task("prs-fe", "Frontend", ["RELATED-TO:prs", "X-APPLE-SORT-ORDER:1"]),
	);
	put(
		work,
		"prs-be",
		task("prs-be", "Backend", [
			"RELATED-TO:prs",
			"STATUS:COMPLETED",
			"COMPLETED:20261027T150000Z",
			"PERCENT-COMPLETE:100",
			"X-APPLE-SORT-ORDER:2",
		]),
	);
	put(
		work,
		"prs-docs",
		task("prs-docs", "Docs", ["RELATED-TO:prs", "X-APPLE-SORT-ORDER:3"]),
	);
	put(
		work,
		"plants",
		task("plants", "Water the office plants", [
			`DUE;VALUE=DATE:${d(2)}`,
			"RRULE:FREQ=WEEKLY;BYDAY=FR",
			"X-APPLE-SORT-ORDER:500",
		]),
	);
	put(
		work,
		"flights",
		task("flights", "Book flights for the offsite", [
			`DUE;VALUE=DATE:${d(8)}`,
			"PRIORITY:5",
			"X-APPLE-SORT-ORDER:600",
		]),
	);
	put(
		work,
		"ideas",
		task("ideas", "Ideas for 2027", ["X-APPLE-SORT-ORDER:700"]),
	);

	put(
		home,
		"rent",
		task("rent", "Pay rent", [
			`DUE;VALUE=DATE:${d(4)}`,
			"PRIORITY:1",
			"RRULE:FREQ=MONTHLY",
		]),
	);
	put(
		home,
		"gift",
		task("gift", "Buy a birthday present for Mia", [
			`DUE;VALUE=DATE:${d(1)}`,
			"X-PINNED:TRUE",
			"CATEGORIES:family",
		]),
	);
	put(
		home,
		"bike",
		task("bike", "Fix the bike light", [
			`DTSTART;VALUE=DATE:${d(-1)}`,
			"PRIORITY:9",
		]),
	);
	put(
		home,
		"books",
		task("books", "Return library books", [
			"STATUS:COMPLETED",
			`COMPLETED:${d(0)}T081500Z`,
			"PERCENT-COMPLETE:100",
		]),
	);

	put(groceries, "oat", task("oat", "Oat milk", [`DUE;VALUE=DATE:${d(0)}`]));
	put(groceries, "coffee", task("coffee", "Coffee beans"));
	return { work, home, groceries };
}

export { HOME };
