// The colour tokens, both themes: the one source the build turns into CSS custom properties
// (tokens.css) and the contrast test checks pair by pair (WCAG 2.2 AA: text 4.5:1, rings,
// focus and other UI parts 3:1). OKLCH, as the spec writes the surfaces.

export type Theme = "light" | "dark";

export const TOKENS: Record<Theme, Record<string, string>> = {
	light: {
		surface: "oklch(0.985 0.004 265)",
		"surface-raised": "oklch(1 0 0)",
		"surface-sunken": "oklch(0.955 0.005 265)",
		hover: "oklch(0.945 0.006 265)",
		selected: "oklch(0.93 0.03 255)",
		hairline: "oklch(0.88 0.006 265)",
		ink: "oklch(0.24 0.012 265)",
		muted: "oklch(0.47 0.012 265)",
		ring: "oklch(0.58 0.012 265)",
		accent: "oklch(0.5 0.16 255)",
		"accent-ink": "oklch(1 0 0)",
		late: "oklch(0.52 0.19 27)",
		warn: "oklch(0.5 0.12 75)",
		focus: "oklch(0.5 0.16 255)",
		scrim: "oklch(0.2 0.01 265 / 0.28)",
		shadow: "oklch(0.2 0.02 265 / 0.16)",
	},
	dark: {
		surface: "oklch(0.21 0.006 265)",
		"surface-raised": "oklch(0.255 0.008 265)",
		"surface-sunken": "oklch(0.185 0.006 265)",
		hover: "oklch(0.26 0.008 265)",
		selected: "oklch(0.3 0.04 255)",
		hairline: "oklch(0.32 0.008 265)",
		ink: "oklch(0.94 0.006 265)",
		muted: "oklch(0.74 0.01 265)",
		ring: "oklch(0.62 0.01 265)",
		accent: "oklch(0.74 0.13 250)",
		"accent-ink": "oklch(0.18 0.02 255)",
		late: "oklch(0.74 0.15 25)",
		warn: "oklch(0.8 0.12 80)",
		focus: "oklch(0.74 0.13 250)",
		scrim: "oklch(0 0 0 / 0.45)",
		shadow: "oklch(0 0 0 / 0.4)",
	},
};

/** Pairs that must pass: [foreground, background, minimum ratio]. */
export const CONTRAST_PAIRS: [string, string, number][] = [
	...[
		"surface",
		"surface-raised",
		"hover",
		"selected",
		"surface-sunken",
	].flatMap((bg): [string, string, number][] => [
		["ink", bg, 4.5],
		["muted", bg, 4.5],
		["accent", bg, 4.5],
		["late", bg, 4.5],
		["ring", bg, 3],
		["focus", bg, 3],
	]),
	["warn", "surface", 4.5],
	["accent-ink", "accent", 4.5],
];

/** The CSS for both themes: light by default, dark by media query or data-theme. */
export function tokensCss(): string {
	const vars = (t: Theme) =>
		Object.entries(TOKENS[t])
			.map(([k, v]) => `\t--${k}: ${v};`)
			.join("\n");
	return [
		`:root {\n\tcolor-scheme: light;\n${vars("light")}\n}`,
		`@media (prefers-color-scheme: dark) {\n\t:root:not([data-theme="light"]) {\n\t\tcolor-scheme: dark;\n${vars("dark").replaceAll("\t--", "\t\t--")}\n\t}\n}`,
		`:root[data-theme="dark"] {\n\tcolor-scheme: dark;\n${vars("dark")}\n}`,
	].join("\n\n");
}

// --- OKLCH → sRGB → WCAG contrast -----------------------------------------------------------

/** sRGB channels 0–1 (clamped) and alpha of an `oklch(L C H [/ A])` value. */
export function oklchToSrgb(v: string): {
	r: number;
	g: number;
	b: number;
	a: number;
} {
	const m =
		/^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+))?\s*\)$/.exec(
			v,
		);
	if (!m) throw new Error(`not an oklch() value: ${v}`);
	const L = Number(m[1]);
	const C = Number(m[2]);
	const h = (Number(m[3]) * Math.PI) / 180;
	const a = Number(m[4] ?? 1);
	const A = C * Math.cos(h);
	const B = C * Math.sin(h);
	const l_ = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
	const m_ = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
	const s_ = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
	const lin = [
		4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
		-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
		-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
	];
	const enc = (x: number) => {
		const c = Math.min(1, Math.max(0, x));
		return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
	};
	const [r, g, b] = lin.map(enc) as [number, number, number];
	return { r, g, b, a };
}

const luminance = ({ r, g, b }: { r: number; g: number; b: number }) => {
	const lin = (c: number) =>
		c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};

export function contrast(fg: string, bg: string): number {
	const a = luminance(oklchToSrgb(fg));
	const b = luminance(oklchToSrgb(bg));
	return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
