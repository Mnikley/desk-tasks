// Vocabulary shared by the core and the UI.

/** Status values as written to STATUS; also the order the editor lists them in. */
export const TASK_STATUSES = [
	"NEEDS-ACTION",
	"IN-PROCESS",
	"COMPLETED",
	"CANCELLED",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ["none", "low", "medium", "high"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/** Colours given to lists that come without one, and offered for new lists. */
export const LIST_COLORS = [
	"#0e9484",
	"#8b5cd6",
	"#d07a10",
	"#d0476a",
	"#3a5bd9",
	"#7f9a1a",
] as const;
