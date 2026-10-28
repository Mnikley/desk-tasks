// Every token pair the UI draws text or controls with passes WCAG 2.2 AA in both themes.
import { describe, expect, test } from "bun:test";
import {
	CONTRAST_PAIRS,
	contrast,
	oklchToSrgb,
	TOKENS,
} from "../src/ui/tokens.ts";

describe("colour tokens", () => {
	test("OKLCH conversion matches known values", () => {
		const w = oklchToSrgb("oklch(1 0 0)");
		expect(w.r).toBeCloseTo(1, 3);
		const blk = oklchToSrgb("oklch(0 0 0)");
		expect(blk.g).toBeCloseTo(0, 3);
		expect(contrast("oklch(0 0 0)", "oklch(1 0 0)")).toBeCloseTo(21, 0);
	});

	for (const theme of ["light", "dark"] as const)
		test(`${theme}: every pair passes`, () => {
			const t = TOKENS[theme];
			const fails = CONTRAST_PAIRS.map(([fg, bg, min]) => ({
				fg,
				bg,
				min,
				got: contrast(t[fg] as string, t[bg] as string),
			})).filter((x) => x.got < x.min);
			expect(
				fails.map((f) => `${f.fg} on ${f.bg}: ${f.got.toFixed(2)} < ${f.min}`),
			).toEqual([]);
		});
});
