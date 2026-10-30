// Inline icons (16 px, currentColor, 1.5 px strokes), decorative unless given a label.
import type { JSX } from "preact";

type P = { size?: number; label?: string; class?: string };

function Svg({
	size = 16,
	label,
	class: cls,
	children,
}: P & { children: JSX.Element | JSX.Element[] }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			stroke-width="1.5"
			stroke-linecap="round"
			stroke-linejoin="round"
			class={cls}
			aria-hidden={label ? undefined : "true"}
			aria-label={label}
			role={label ? "img" : undefined}
		>
			{children}
		</svg>
	);
}

export const Plus = (p: P) => (
	<Svg {...p}>
		<path d="M8 3v10M3 8h10" />
	</Svg>
);
export const More = (p: P) => (
	<Svg {...p}>
		<circle cx="3.5" cy="8" r="0.6" fill="currentColor" />
		<circle cx="8" cy="8" r="0.6" fill="currentColor" />
		<circle cx="12.5" cy="8" r="0.6" fill="currentColor" />
	</Svg>
);
export const Chevron = (p: P & { open?: boolean }) => (
	<Svg {...p}>
		<path d={p.open ? "M4 6l4 4 4-4" : "M6 4l4 4-4 4"} />
	</Svg>
);
export const Caret = (p: P) => (
	<Svg {...p}>
		<path d="M5 6.5l3 3 3-3" />
	</Svg>
);
export const Lock = (p: P) => (
	<Svg {...p}>
		<rect x="3.5" y="7" width="9" height="6" rx="1.2" />
		<path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" />
	</Svg>
);
export const Shared = (p: P) => (
	<Svg {...p}>
		<circle cx="6" cy="6" r="2.2" />
		<path d="M2.5 13c.4-2 1.8-3 3.5-3s3.1 1 3.5 3" />
		<path d="M10.5 4.2a2 2 0 0 1 0 3.6M12 10.3c.9.5 1.4 1.4 1.5 2.7" />
	</Svg>
);
export const Repeat = (p: P) => (
	<Svg {...p}>
		<path d="M3 7a4 4 0 0 1 6.9-2.8L12 6M12 3v3H9M13 9a4 4 0 0 1-6.9 2.8L4 10M4 13v-3h3" />
	</Svg>
);
export const Notes = (p: P) => (
	<Svg {...p}>
		<path d="M3.5 4.5h9M3.5 8h9M3.5 11.5h6" />
	</Svg>
);
export const Bell = (p: P) => (
	<Svg {...p}>
		<path d="M4.5 11V7.5a3.5 3.5 0 0 1 7 0V11l1 1.2h-9zM6.8 13.6a1.3 1.3 0 0 0 2.4 0" />
	</Svg>
);
export const Pin = (p: P) => (
	<Svg {...p}>
		<path d="M9.5 2.5l4 4-2 1-2.5 2.5.5 3-1 1-3-3-3 3M5.5 9.5l-1-1 1-1 3-.5 2.5-2.5 1-2" />
	</Svg>
);
export const Search = (p: P) => (
	<Svg {...p}>
		<circle cx="7" cy="7" r="4" />
		<path d="M10 10l3.5 3.5" />
	</Svg>
);
export const Close = (p: P) => (
	<Svg {...p}>
		<path d="M4 4l8 8M12 4l-8 8" />
	</Svg>
);
export const Warning = (p: P) => (
	<Svg {...p}>
		<path d="M8 2.5l6 10.5H2z" />
		<path d="M8 6.5v3M8 11.6v.1" />
	</Svg>
);
/** A new version: an arrow up in a circle. */
export const Upgrade = (p: P) => (
	<Svg {...p}>
		<circle cx="8" cy="8" r="6" />
		<path d="M8 10.8V5.4M5.6 7.6 8 5.2l2.4 2.4" />
	</Svg>
);
export const Check = (p: P) => (
	<Svg {...p}>
		<path d="M3.5 8.5l3 3 6-7" />
	</Svg>
);
export const Trash = (p: P) => (
	<Svg {...p}>
		<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />
	</Svg>
);
export const Gear = (p: P) => (
	<Svg {...p}>
		<circle cx="8" cy="8" r="2" />
		<path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1" />
	</Svg>
);
export const Calendar = (p: P) => (
	<Svg {...p}>
		<rect x="2.5" y="3.5" width="11" height="10" rx="1.5" />
		<path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" />
	</Svg>
);
export const Sync = (p: P) => (
	<Svg {...p}>
		<path d="M13 8a5 5 0 0 1-8.6 3.5M3 8a5 5 0 0 1 8.6-3.5M11.5 2v2.6H9M4.5 14v-2.6H7" />
	</Svg>
);
