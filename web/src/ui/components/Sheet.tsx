// A sheet slides over the list inside the widget (no second window); Esc or the back button
// closes it and focus goes back where it was.
import type { ComponentChildren } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import { Close } from "./icons.tsx";

export function SheetFrame(props: {
	title: string;
	onClose: () => void;
	children: ComponentChildren;
	foot?: ComponentChildren;
	/** Esc asks first (unsaved changes) when this returns false. */
	/** The body only scrolls (nothing to focus in it): it takes focus so the keys scroll it. */
	scrollOnly?: boolean;
	/** Extra keys for the whole sheet (Ctrl+Enter saves). */
	onKeyDown?: (e: KeyboardEvent) => void;
}) {
	const ref = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const back = document.activeElement as HTMLElement | null;
		const first =
			ref.current?.querySelector<HTMLElement>("[data-autofocus]") ??
			ref.current?.querySelector<HTMLElement>(
				".sheet-body :is(input, textarea, select, button)",
			) ??
			ref.current?.querySelector<HTMLElement>("button");
		first?.focus();
		// Back where it was; if that is gone (a menu item), to the highlighted row.
		return () => {
			if (back?.isConnected) back.focus();
			else
				document.querySelector<HTMLElement>(".row.hl, .switcher-btn")?.focus();
		};
	}, []);
	return (
		<div
			class="sheet"
			role="dialog"
			aria-modal="true"
			aria-label={props.title}
			ref={ref}
			onKeyDown={(e) => {
				props.onKeyDown?.(e);
				if (e.key === "Escape" && !e.defaultPrevented) {
					e.preventDefault();
					e.stopPropagation();
					props.onClose();
				}
				if (e.key === "Tab") trapFocus(e, ref.current);
			}}
		>
			<div class="sheet-head">
				<h2>{props.title}</h2>
				<button
					type="button"
					class="icon-btn"
					aria-label="Close"
					title="Close (Esc)"
					onClick={props.onClose}
				>
					<Close />
				</button>
			</div>
			<div
				class="sheet-body"
				{...(props.scrollOnly
					? {
							tabIndex: 0,
							role: "region",
							"aria-label": props.title,
							"data-autofocus": "",
						}
					: {})}
			>
				{props.children}
			</div>
			{props.foot && <div class="sheet-foot">{props.foot}</div>}
		</div>
	);
}

/** Tab stays inside the sheet (it is modal). */
export function trapFocus(e: KeyboardEvent, root: HTMLElement | null): void {
	if (!root) return;
	const items = [
		...root.querySelectorAll<HTMLElement>(
			"a[href], button:not([disabled]), input:not([disabled]), textarea, select, [tabindex='0']",
		),
	].filter((el) => el.offsetParent !== null);
	const first = items[0];
	const last = items.at(-1);
	if (!first || !last) return;
	if (e.shiftKey && document.activeElement === first) {
		e.preventDefault();
		last.focus();
	} else if (!e.shiftKey && document.activeElement === last) {
		e.preventDefault();
		first.focus();
	}
}

/** The click-outside layer under a popover or dialog. The keyboard closes them with Esc. */
export function Scrim(props: {
	onClose: () => void;
	clear?: boolean;
	z?: number;
}) {
	const style = `${props.clear ? "background: transparent;" : ""}${props.z ? ` z-index: ${props.z};` : ""}`;
	return (
		<div
			class="scrim"
			aria-hidden="true"
			style={style}
			onClick={props.onClose}
		/>
	);
}

/** Puts focus back where it was when the layer closes (the highlighted row if that is gone). */
export function useRestoreFocus(): void {
	useLayoutEffect(() => {
		const back = document.activeElement as HTMLElement | null;
		return () => {
			if (back?.isConnected && back !== document.body) back.focus();
			else
				document.querySelector<HTMLElement>(".row.hl, .switcher-btn")?.focus();
		};
	}, []);
}
