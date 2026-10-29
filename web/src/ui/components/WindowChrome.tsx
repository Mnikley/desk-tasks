// Moving and resizing the frameless window: the header's empty space drags it, the grip at
// the bottom right resizes it (spec "Desktop integration"). Python moves the window with
// SetWindowPos in physical pixels, so CSS pixels are scaled by devicePixelRatio here; one call
// is in flight at a time and the movement in between is added up (as in the spike).
import { useMemo, useRef } from "preact/hooks";
import type { Controller } from "../controller.ts";

type Send = (x: number, y: number) => Promise<unknown>;

/** Pointer tracking with one bridge call in flight; `send` gets the summed physical delta
 * in whole pixels. */
function tracker(send: Send) {
	let last: [number, number] | null = null;
	let pending: [number, number] = [0, 0];
	let inflight = false;
	const flush = async () => {
		if (inflight) return;
		const x = Math.round(pending[0]);
		const y = Math.round(pending[1]);
		if (x === 0 && y === 0) return;
		// The fraction stays for the next call, so a long drag doesn't drift.
		pending = [pending[0] - x, pending[1] - y];
		inflight = true;
		try {
			await send(x, y);
		} catch {
			// The window stays where it is; the next move tries again.
		} finally {
			inflight = false;
			void flush();
		}
	};
	return {
		down(e: PointerEvent) {
			(e.currentTarget as Element).setPointerCapture(e.pointerId);
			last = [e.screenX, e.screenY];
		},
		move(e: PointerEvent) {
			if (!last) return;
			const dpr = window.devicePixelRatio || 1;
			pending = [
				pending[0] + (e.screenX - last[0]) * dpr,
				pending[1] + (e.screenY - last[1]) * dpr,
			];
			last = [e.screenX, e.screenY];
			void flush();
		},
		up() {
			last = null;
		},
	};
}

/** Header handlers: a press on the header's own background (not a control) drags. */
export function headerDrag(app: Controller) {
	const t = tracker((dx, dy) => app.bridge.window({ cmd: "move", dx, dy }));
	return {
		onPointerDown: (e: PointerEvent) => {
			if (e.button !== 0) return;
			// The header itself, or its spacer and stale note; not a control, and not the
			// menus and popovers rendered inside it (their rows have `.grow` spans too).
			const el = e.target as Element;
			const part = el.closest(".grow, .stale");
			if (el !== e.currentTarget && part?.parentElement !== e.currentTarget)
				return;
			t.down(e);
		},
		onPointerMove: (e: PointerEvent) => t.move(e),
		onPointerUp: () => t.up(),
		onPointerCancel: () => t.up(),
	};
}

/** The resize grip, bottom right. Pointer only; Python keeps the minimum size. */
export function ResizeGrip(props: { app: Controller }) {
	// Kept across renders: a re-render mid-drag must not reset the size or the tracker.
	const size = useRef<[number, number]>([0, 0]);
	const t = useMemo(
		() =>
			tracker((dw, dh) => {
				const [w, h] = size.current;
				size.current = [w + dw, h + dh];
				return props.app.bridge.window({
					cmd: "resize",
					w: Math.max(1, Math.round(w + dw)),
					h: Math.max(1, Math.round(h + dh)),
				});
			}),
		[props.app],
	);
	return (
		<div
			class="grip"
			aria-hidden="true"
			onPointerDown={(e) => {
				if (e.button !== 0) return;
				const dpr = window.devicePixelRatio || 1;
				size.current = [window.innerWidth * dpr, window.innerHeight * dpr];
				t.down(e);
			}}
			onPointerMove={(e) => t.move(e)}
			onPointerUp={() => t.up()}
			onPointerCancel={() => t.up()}
		/>
	);
}
