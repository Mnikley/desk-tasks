// Drag and drop with pointer events, not HTML5 DnD (spec "Drag and drop"): reorder within
// siblings with an insertion line, the horizontal offset decides the nesting level, a drop on
// an Upcoming day header sets the due date, a drop on a list in the switcher (it opens when
// the pointer rests on the header's switcher button) moves the task with its subtree.
// Read-only rows don't drag; selected tasks drag together.
import type { RefObject } from "preact";
import { useEffect } from "preact/hooks";
import type { TaskView } from "../../core/tasks.ts";
import type { Controller } from "../controller.ts";
import { dropPlace, type Row, visibleRows } from "../model.ts";

const START_PX = 5;
const INDENT = 20;
const OPEN_SWITCHER_MS = 400;
const EDGE_PX = 28;

type Target =
	| {
			kind: "row";
			group: string;
			at: number;
			depth: number;
			line: { top: number; left: number };
	  }
	| { kind: "day"; date: string; el: HTMLElement }
	| { kind: "list"; href: string; el: HTMLElement }
	| null;

export function useDrag(
	app: Controller,
	scroller: RefObject<HTMLDivElement | null>,
): void {
	useEffect(() => {
		const el = scroller.current;
		if (!el) return;
		let start: { x: number; y: number; id: number; pointer: number } | null =
			null;
		let suppressUntil = 0;
		const swallow = (e: MouseEvent) => {
			if (Date.now() < suppressUntil) {
				e.stopPropagation();
				e.preventDefault();
			}
		};
		let drag: {
			tasks: TaskView[];
			ids: Set<number>;
			depth: number;
			ghost: HTMLElement;
			line: HTMLElement;
			target: Target;
			switcherTimer: ReturnType<typeof setTimeout> | null;
		} | null = null;

		const clearMark = () => {
			for (const m of document.querySelectorAll(".drop-target"))
				m.classList.remove("drop-target");
		};
		const end = () => {
			if (drag) {
				drag.ghost.remove();
				drag.line.remove();
				if (drag.switcherTimer) clearTimeout(drag.switcherTimer);
				clearMark();
				document.body.classList.remove("dragging");
				// The click that ends a drag isn't a click on the row.
				suppressUntil = Date.now() + 300;
			}
			start = null;
			drag = null;
		};

		const onDown = (e: PointerEvent) => {
			if (e.button !== 0 || e.pointerType === "touch") return;
			const t = e.target as Element;
			const row = t.closest<HTMLElement>(".row[data-id]");
			if (!row || t.closest("button, input, textarea, a, select")) return;
			start = {
				x: e.clientX,
				y: e.clientY,
				id: Number(row.dataset.id),
				pointer: e.pointerId,
			};
		};

		const begin = (e: PointerEvent): boolean => {
			if (!start) return false;
			const t = app.task(start.id);
			if (!t) return false;
			if (t.readOnly) {
				start = null;
				return false;
			}
			const sel = app.selection.get();
			const order = visibleRows(app.model()).map((r) => r.task);
			const tasks = sel.has(t.id)
				? order.filter((x) => sel.has(x.id) && !x.readOnly)
				: [t];
			const ghost = document.createElement("div");
			ghost.className = "drag-ghost";
			ghost.textContent =
				tasks.length > 1 ? `${t.summary} +${tasks.length - 1}` : t.summary;
			document.body.append(ghost);
			const line = document.createElement("div");
			line.className = "drop-line";
			line.hidden = true;
			el.append(line);
			const depth =
				Number(
					el
						.querySelector<HTMLElement>(`.row[data-id="${t.id}"]`)
						?.getAttribute("aria-level") ?? 1,
				) - 1;
			drag = {
				tasks,
				ids: new Set(tasks.map((x) => x.id)),
				depth,
				ghost,
				line,
				target: null,
				switcherTimer: null,
			};
			document.body.classList.add("dragging");
			try {
				el.setPointerCapture(e.pointerId);
			} catch {
				// The pointer may be gone already.
			}
			return true;
		};

		const locate = (e: PointerEvent): Target => {
			if (!drag || !start) return null;
			const hit = document.elementFromPoint(e.clientX, e.clientY);
			if (!hit) return null;
			const list = hit.closest<HTMLElement>("[data-drop-list]");
			if (list)
				return {
					kind: "list",
					href: list.dataset.dropList as string,
					el: list,
				};
			const day = hit.closest<HTMLElement>(".group-head[data-date]");
			if (day)
				return { kind: "day", date: day.dataset.date as string, el: day };
			const row = hit.closest<HTMLElement>(".row[data-id]");
			if (!row || !el.contains(row)) return null;
			const group = row.closest<HTMLElement>("[data-group]")?.dataset.group;
			const g = app.model().groups.find((x) => x.key === group);
			if (!group || !g || g.folded) return null;
			const idx = g.rows.findIndex((r) => r.task.id === Number(row.dataset.id));
			const rect = row.getBoundingClientRect();
			const after = e.clientY > rect.top + rect.height / 2;
			const at = idx + (after ? 1 : 0);
			const want = drag.depth + Math.round((e.clientX - start.x) / INDENT);
			const place = dropPlace(g.rows, drag.ids, at, want);
			const pad =
				Number.parseFloat(getComputedStyle(row).paddingLeft) -
				(Number(row.style.getPropertyValue("--depth")) || 0) * INDENT;
			return {
				kind: "row",
				group,
				at,
				depth: place.depth,
				line: {
					top: row.offsetTop + (after ? row.offsetHeight : 0) - 1,
					left: pad + place.depth * INDENT + 4,
				},
			};
		};

		const onMove = (e: PointerEvent) => {
			if (!start || e.pointerId !== start.pointer) return;
			if (!drag) {
				if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < START_PX)
					return;
				if (!begin(e)) return;
			}
			if (!drag) return;
			e.preventDefault();
			drag.ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 8}px)`;
			// Near the top or bottom edge the list scrolls.
			const box = el.getBoundingClientRect();
			if (e.clientY < box.top + EDGE_PX) el.scrollTop -= 8;
			else if (e.clientY > box.bottom - EDGE_PX) el.scrollTop += 8;
			// Resting on the switcher button opens it, so a list can take the drop.
			const onSwitcher = document
				.elementFromPoint(e.clientX, e.clientY)
				?.closest(".switcher-btn");
			if (onSwitcher && !drag.switcherTimer && !app.switcherOpen.get())
				drag.switcherTimer = setTimeout(
					() => app.switcherOpen.set("switcher"),
					OPEN_SWITCHER_MS,
				);
			else if (!onSwitcher && drag.switcherTimer) {
				clearTimeout(drag.switcherTimer);
				drag.switcherTimer = null;
			}
			const target = locate(e);
			drag.target = target;
			clearMark();
			drag.line.hidden = target?.kind !== "row";
			if (target?.kind === "row") {
				drag.line.style.top = `${target.line.top}px`;
				drag.line.style.left = `${target.line.left}px`;
			} else if (target) target.el.classList.add("drop-target");
		};

		const onUp = (e: PointerEvent) => {
			if (!start || e.pointerId !== start.pointer) return;
			const d = drag;
			end();
			if (!d?.target) return;
			const tasks = d.tasks;
			const tg = d.target;
			if (tg.kind === "list") {
				app.switcherOpen.set(false);
				void app.moveToList(tasks, tg.href);
				return;
			}
			if (tg.kind === "day") {
				void app.moveToDay(tasks, tg.date);
				return;
			}
			const v = app.view.get();
			if (v.kind !== "list" && v.kind !== "all") {
				app.toast(
					`${app.viewTitle()} is sorted by time and priority. Reorder in a list.`,
				);
				return;
			}
			const g = app.model().groups.find((x) => x.key === tg.group);
			if (!g) return;
			const list = v.kind === "list" ? v.href : (g.list as string);
			const place = dropPlace(g.rows as Row[], d.ids, tg.at, tg.depth);
			void app.dropAt(tasks, {
				list,
				parent: place.parent,
				index: place.index,
			});
		};

		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape" && drag) {
				e.preventDefault();
				e.stopPropagation();
				end();
			}
		};

		el.addEventListener("pointerdown", onDown);
		window.addEventListener("click", swallow, true);
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		window.addEventListener("pointercancel", end);
		window.addEventListener("keydown", onKey, true);
		return () => {
			end();
			el.removeEventListener("pointerdown", onDown);
			window.removeEventListener("click", swallow, true);
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", end);
			window.removeEventListener("keydown", onKey, true);
		};
	}, [app, scroller.current]);
}
