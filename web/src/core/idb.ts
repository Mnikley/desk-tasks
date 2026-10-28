// IndexedDB behind the store: the task and list mirror, the journal and the sync meta, written
// through in batches and read once at start. Durable settings are not kept here (they live in
// the bridge's settings file), so a lost WebView profile only costs a full sync and the undo log.
import type {
	Change,
	JournalEntry,
	ListRecord,
	Persister,
	StoreSnapshot,
	SyncMeta,
	TaskRecord,
} from "./store.ts";

const DB_NAME = "desk-tasks";
const VERSION = 1;
const STORES = ["tasks", "lists", "journal", "kv"] as const;

function req<T>(r: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		r.onsuccess = () => resolve(r.result);
		r.onerror = () => reject(r.error);
	});
}

function done(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
		tx.onabort = () =>
			reject(tx.error ?? new Error("IndexedDB transaction aborted"));
	});
}

export async function openMirror(
	factory: IDBFactory = indexedDB,
): Promise<IDBDatabase> {
	const open = factory.open(DB_NAME, VERSION);
	open.onupgradeneeded = () => {
		const db = open.result;
		if (!db.objectStoreNames.contains("tasks"))
			db.createObjectStore("tasks", { keyPath: "href" });
		if (!db.objectStoreNames.contains("lists"))
			db.createObjectStore("lists", { keyPath: "href" });
		if (!db.objectStoreNames.contains("journal"))
			db.createObjectStore("journal", { keyPath: "id" });
		if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
	};
	return req(open);
}

export class IdbPersister implements Persister {
	constructor(private readonly db: IDBDatabase) {}

	/** Everything stored, for the store to start from. */
	async load(): Promise<Partial<StoreSnapshot>> {
		const tx = this.db.transaction([...STORES], "readonly");
		const [tasks, lists, journal, meta] = await Promise.all([
			req(tx.objectStore("tasks").getAll() as IDBRequest<TaskRecord[]>),
			req(tx.objectStore("lists").getAll() as IDBRequest<ListRecord[]>),
			req(tx.objectStore("journal").getAll() as IDBRequest<JournalEntry[]>),
			req(tx.objectStore("kv").get("meta") as IDBRequest<SyncMeta | undefined>),
		]);
		return { tasks, lists, journal, ...(meta ? { meta } : {}) };
	}

	async write(changes: Change[]): Promise<void> {
		const relevant = changes.filter((c) => c.type !== "settings");
		if (!relevant.length) return;
		const tx = this.db.transaction([...STORES], "readwrite");
		for (const c of relevant) {
			if (c.type === "task") {
				const s = tx.objectStore("tasks");
				if (c.record) s.put(c.record);
				else s.delete(c.href);
			} else if (c.type === "list") {
				const s = tx.objectStore("lists");
				if (c.record) s.put(c.record);
				else s.delete(c.href);
			} else if (c.type === "journal") tx.objectStore("journal").put(c.entry);
			else if (c.type === "journal-prune")
				tx.objectStore("journal").delete(
					IDBKeyRange.upperBound(c.keepFrom, true),
				);
			else if (c.type === "meta") tx.objectStore("kv").put(c.meta, "meta");
		}
		await done(tx);
	}
}

/** Sends every change to each persister, in order. */
export function combine(...ps: Persister[]): Persister {
	return {
		async write(changes) {
			// Every persister gets the batch, even when one fails; the first failure is reported.
			const results = await Promise.allSettled(ps.map((p) => p.write(changes)));
			const failed = results.find((r) => r.status === "rejected");
			if (failed) throw (failed as PromiseRejectedResult).reason;
		},
	};
}
