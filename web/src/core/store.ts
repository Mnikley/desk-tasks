// The store seam: the task mirror, the list mirror, the journal and the durable settings,
// read synchronously from memory and written through to a `Persister` (IndexedDB plus the
// bridge's settings file in the app; nothing in tests). Reads never wait for disk.

/** Why a list didn't sync, with a next step; "gone" lists no longer exist in Nextcloud. */
export interface ListError {
	kind: "auth" | "unreachable" | "invalid" | "gone";
	message: string;
	action: string;
}

/** A task exactly as fetched from Nextcloud. */
export interface TaskRecord {
	href: string;
	/** Href of the list (collection) it lives in. */
	list: string;
	etag: string;
	ics: string;
	/** The body wasn't valid UTF-8: shown read-only, never written. */
	notUtf8: boolean;
	/** When this copy was stored (the race guard of syncs against writes). */
	syncedAt: number;
	/** "" when the task couldn't be parsed. */
	uid: string;
}

/** A task list (calendar collection with VTODO) as discovered. */
export interface ListRecord {
	href: string;
	name: string;
	/** Server colour "#rrggbb", or null when it has none. */
	color: string | null;
	order: number;
	ctag: string | null;
	components: string[];
	writable: boolean;
	syncToken: string | null;
	lastReconcileAt: number | null;
	lastOkAt: number | null;
	lastChangedAt: number | null;
	error: ListError | null;
}

/** Before/after of a write: exact bytes and where they were. */
export interface VersionRecord {
	href: string;
	list: string;
	etag: string;
	ics: string;
}

export type JournalOp = "create" | "update" | "delete" | "move";
export type JournalStatus = "ok" | "failed" | "mismatch";

export interface JournalEntry {
	id: number;
	at: number;
	op: JournalOp;
	target: string | null;
	before: VersionRecord | null;
	after: VersionRecord | null;
	status: JournalStatus;
	message: string;
	undoOf: number | null;
	undoneBy: number | null;
}

/** The durable part of the state (the bridge's settings.json in the app). */
export interface DurableSettings {
	/** Read-only switch: no write is sent while it is on. */
	readOnly: boolean;
	/** Writes paused after a write whose outcome couldn't be confirmed. */
	paused: { reason: string; at: number } | null;
}

/** Connection state kept with the mirror (rebuildable). */
export interface SyncMeta {
	version: string | null;
	lastSync: number | null;
	error: string | null;
	principal: string | null;
	home: string | null;
}

export type Change =
	| { type: "task"; href: string; record: TaskRecord | null }
	| { type: "list"; href: string; record: ListRecord | null }
	| { type: "journal"; entry: JournalEntry }
	| { type: "meta"; meta: SyncMeta }
	| { type: "settings"; settings: DurableSettings };

/** Where changes go after they are applied in memory. */
export interface Persister {
	write(changes: Change[]): Promise<void>;
}

export const EMPTY_META: SyncMeta = {
	version: null,
	lastSync: null,
	error: null,
	principal: null,
	home: null,
};

export const DEFAULT_SETTINGS: DurableSettings = {
	readOnly: false,
	paused: null,
};

const JOURNAL_MAX = 500;

export interface StoreSnapshot {
	tasks: TaskRecord[];
	lists: ListRecord[];
	journal: JournalEntry[];
	meta: SyncMeta;
	settings: DurableSettings;
}

export class Store {
	private readonly taskMap = new Map<string, TaskRecord>();
	private readonly listMap = new Map<string, ListRecord>();
	private journalRows: JournalEntry[] = [];
	private nextJournalId = 1;
	private metaValue: SyncMeta = EMPTY_META;
	private settingsValue: DurableSettings = DEFAULT_SETTINGS;
	/** Session ids: stable while the app runs, carried along when a task moves. */
	private readonly ids = new Map<string, number>();
	private nextId = 1;
	private pending: Change[] = [];
	private writing: Promise<void> = Promise.resolve();
	private readonly listeners = new Set<() => void>();
	private notifyQueued = false;
	/** Bumped on every change; views memoise on it. */
	version = 0;

	constructor(
		private readonly persister: Persister | null = null,
		snapshot?: Partial<StoreSnapshot>,
	) {
		for (const t of snapshot?.tasks ?? []) this.taskMap.set(t.href, t);
		for (const l of snapshot?.lists ?? []) this.listMap.set(l.href, l);
		this.journalRows = [...(snapshot?.journal ?? [])].sort(
			(a, b) => a.id - b.id,
		);
		this.nextJournalId = (this.journalRows.at(-1)?.id ?? 0) + 1;
		if (snapshot?.meta) this.metaValue = { ...EMPTY_META, ...snapshot.meta };
		if (snapshot?.settings)
			this.settingsValue = { ...DEFAULT_SETTINGS, ...snapshot.settings };
	}

	// ---------- change plumbing ----------

	private changed(c: Change): void {
		this.version++;
		this.pending.push(c);
		if (this.persister) {
			const batch = this.pending;
			this.pending = [];
			const p = this.persister;
			this.writing = this.writing
				.then(() => p.write(batch))
				.catch((err: unknown) => {
					console.error("Writing the local copy failed:", err);
				});
		} else this.pending = [];
		if (!this.notifyQueued) {
			this.notifyQueued = true;
			queueMicrotask(() => {
				this.notifyQueued = false;
				for (const l of this.listeners) l();
			});
		}
	}

	/** Called (batched, after the current task) whenever anything changed. */
	subscribe(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	/** Resolves once every change so far has been handed to the persister. */
	flush(): Promise<void> {
		return this.writing;
	}

	// ---------- tasks ----------

	tasks(): TaskRecord[] {
		return [...this.taskMap.values()];
	}

	tasksOf(list: string): TaskRecord[] {
		return this.tasks().filter((t) => t.list === list);
	}

	task(href: string): TaskRecord | undefined {
		return this.taskMap.get(href);
	}

	/** The session id of a task (assigned on first sight). */
	idOf(href: string): number {
		let id = this.ids.get(href);
		if (id === undefined) {
			id = this.nextId++;
			this.ids.set(href, id);
		}
		return id;
	}

	hrefOf(id: number): string | undefined {
		for (const [href, x] of this.ids)
			if (x === id && this.taskMap.has(href)) return href;
		return undefined;
	}

	/**
	 * Stores (or replaces) a task exactly as fetched. From a sync (`syncStarted` set), a copy
	 * stored after the sync began (by a write meanwhile) is newer and stays.
	 */
	putTask(
		rec: Omit<TaskRecord, "syncedAt">,
		now: number,
		syncStarted?: number,
	): boolean {
		const cur = this.taskMap.get(rec.href);
		if (cur && syncStarted !== undefined && cur.syncedAt > syncStarted)
			return false;
		const record = { ...rec, syncedAt: now };
		this.taskMap.set(rec.href, record);
		this.idOf(rec.href);
		this.changed({ type: "task", href: rec.href, record });
		return true;
	}

	/** Forgets a task, unless a write stored it after the sync began. */
	dropTask(href: string, syncStarted?: number): boolean {
		const cur = this.taskMap.get(href);
		if (!cur) return false;
		if (syncStarted !== undefined && cur.syncedAt > syncStarted) return false;
		this.taskMap.delete(href);
		this.changed({ type: "task", href, record: null });
		return true;
	}

	/** A task moved to another href: same session id, new place. */
	moveTask(from: string, rec: Omit<TaskRecord, "syncedAt">, now: number): void {
		const id = this.ids.get(from);
		this.dropTask(from);
		if (id !== undefined) this.ids.set(rec.href, id);
		this.putTask(rec, now);
	}

	// ---------- lists ----------

	lists(): ListRecord[] {
		return [...this.listMap.values()].sort(
			(a, b) => a.order - b.order || a.name.localeCompare(b.name),
		);
	}

	list(href: string): ListRecord | undefined {
		return this.listMap.get(href);
	}

	putList(rec: ListRecord): void {
		this.listMap.set(rec.href, rec);
		this.changed({ type: "list", href: rec.href, record: rec });
	}

	patchList(href: string, patch: Partial<ListRecord>): void {
		const cur = this.listMap.get(href);
		if (cur) this.putList({ ...cur, ...patch });
	}

	/** Removes a list and its tasks from the mirror. */
	removeList(href: string): void {
		for (const t of this.tasksOf(href)) this.dropTask(t.href);
		if (this.listMap.delete(href))
			this.changed({ type: "list", href, record: null });
	}

	// ---------- journal ----------

	addJournal(
		e: Omit<JournalEntry, "id" | "undoneBy" | "undoOf" | "message"> & {
			message?: string;
			undoOf?: number;
		},
	): number {
		const entry: JournalEntry = {
			id: this.nextJournalId++,
			at: e.at,
			op: e.op,
			target: e.target,
			before: e.before,
			after: e.after,
			status: e.status,
			message: e.message ?? "",
			undoOf: e.undoOf ?? null,
			undoneBy: null,
		};
		this.journalRows.push(entry);
		if (this.journalRows.length > JOURNAL_MAX)
			this.journalRows = this.journalRows.slice(-JOURNAL_MAX);
		this.changed({ type: "journal", entry });
		return entry.id;
	}

	/** Newest first. */
	journal(): JournalEntry[] {
		return [...this.journalRows].reverse();
	}

	journalEntry(id: number): JournalEntry | undefined {
		return this.journalRows.find((e) => e.id === id);
	}

	/** Marks `id` as undone by the entry its undo journaled (whose undoOf points back). */
	markUndone(id: number): void {
		const entry = this.journalEntry(id);
		const by = this.journalRows.filter((e) => e.undoOf === id).at(-1);
		if (!entry || !by) return;
		const next = { ...entry, undoneBy: by.id };
		this.journalRows = this.journalRows.map((e) => (e.id === id ? next : e));
		this.changed({ type: "journal", entry: next });
	}

	lastJournalId(): number {
		return this.journalRows.at(-1)?.id ?? 0;
	}

	// ---------- meta and settings ----------

	get meta(): SyncMeta {
		return this.metaValue;
	}

	patchMeta(p: Partial<SyncMeta>): void {
		this.metaValue = { ...this.metaValue, ...p };
		this.changed({ type: "meta", meta: this.metaValue });
	}

	get settings(): DurableSettings {
		return this.settingsValue;
	}

	patchSettings(p: Partial<DurableSettings>): void {
		this.settingsValue = { ...this.settingsValue, ...p };
		this.changed({ type: "settings", settings: this.settingsValue });
	}

	/** Forgets the mirror (a new connection); the journal stays. */
	forget(): void {
		for (const l of [...this.listMap.keys()]) this.removeList(l);
		for (const t of [...this.taskMap.keys()]) this.dropTask(t);
		this.patchMeta(EMPTY_META);
	}
}
