// The store seam: the sync/write race guard, session ids across a move, and write-through to
// IndexedDB that rebuilds the same mirror after a restart.
import { expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { IdbPersister, openMirror } from "../src/core/idb.ts";
import { type ListRecord, Store, type TaskRecord } from "../src/core/store.ts";

const LIST = "/remote.php/dav/calendars/u/l/";
const list = (o: Partial<ListRecord> = {}): ListRecord => ({
	href: LIST,
	name: "L",
	color: null,
	order: 0,
	ctag: null,
	components: ["VTODO"],
	writable: true,
	syncToken: "t1",
	lastReconcileAt: 1,
	lastOkAt: 2,
	lastChangedAt: 3,
	error: null,
	...o,
});
const task = (href: string, ics = "x"): Omit<TaskRecord, "syncedAt"> => ({
	href,
	list: LIST,
	etag: `"${ics}"`,
	ics,
	notUtf8: false,
	uid: href,
});

test("a sync's copy never replaces one a write stored after the sync began", () => {
	const s = new Store();
	s.putTask(task(`${LIST}a.ics`, "written"), 200);
	expect(s.putTask(task(`${LIST}a.ics`, "stale"), 300, 100)).toBe(false);
	expect(s.dropTask(`${LIST}a.ics`, 100)).toBe(false);
	expect(s.task(`${LIST}a.ics`)?.ics).toBe("written");
	expect(s.putTask(task(`${LIST}a.ics`, "fresh"), 300, 250)).toBe(true);
	expect(s.task(`${LIST}a.ics`)?.ics).toBe("fresh");
});

test("a task keeps its session id when it moves to another href", () => {
	const s = new Store();
	s.putTask(task(`${LIST}a.ics`), 1);
	const id = s.idOf(`${LIST}a.ics`);
	s.moveTask(`${LIST}a.ics`, task("/remote.php/dav/calendars/u/m/b.ics"), 2);
	expect(s.idOf("/remote.php/dav/calendars/u/m/b.ics")).toBe(id);
	expect(s.task(`${LIST}a.ics`)).toBeUndefined();
});

test("every change is written through to IndexedDB and a restart rebuilds the same mirror", async () => {
	const factory = new IDBFactory();
	const persister = new IdbPersister(await openMirror(factory));
	const s = new Store(persister);
	let notified = 0;
	s.subscribe(() => notified++);
	s.putList(list());
	s.putTask(task(`${LIST}a.ics`, "BEGIN:VCALENDAR\r\nä\r\n"), 10);
	s.putTask(task(`${LIST}b.ics`), 11);
	s.dropTask(`${LIST}b.ics`);
	const id = s.addJournal({
		at: 5,
		op: "update",
		target: `${LIST}a.ics`,
		before: null,
		after: null,
		status: "ok",
	});
	s.patchMeta({ lastSync: 42, version: "35.0.2" });
	s.patchSettings({ readOnly: true }); // durable settings don't go to IndexedDB
	await s.flush();
	await Promise.resolve();
	expect(notified).toBe(1); // batched

	const again = new Store(
		null,
		await new IdbPersister(await openMirror(factory)).load(),
	);
	expect(again.lists()).toEqual(s.lists());
	expect(again.tasks()).toEqual(s.tasks());
	expect(again.task(`${LIST}a.ics`)?.ics).toBe("BEGIN:VCALENDAR\r\nä\r\n");
	expect(again.journalEntry(id)?.target).toBe(`${LIST}a.ics`);
	expect(again.meta).toMatchObject({ lastSync: 42, version: "35.0.2" });
	expect(again.settings.readOnly).toBe(false);
	// New journal ids continue after the stored ones.
	expect(
		again.addJournal({
			at: 6,
			op: "create",
			target: null,
			before: null,
			after: null,
			status: "ok",
		}),
	).toBe(id + 1);
});
