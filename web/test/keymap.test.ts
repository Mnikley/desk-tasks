// The keyboard matching rules (spec "Keyboard map"), each with a test.
import { describe, expect, test } from "bun:test";
import { KEYMAP, keyLabel, matches, rowShortcuts } from "../src/ui/keymap.ts";

function ev(
	key: string,
	o: { shift?: boolean; ctrl?: boolean; alt?: boolean; altGr?: boolean } = {},
): KeyboardEvent {
	return {
		key,
		shiftKey: !!o.shift,
		ctrlKey: !!(o.ctrl || o.altGr),
		altKey: !!(o.alt || o.altGr),
		metaKey: false,
		getModifierState: (m: string) => m === "AltGraph" && !!o.altGr,
	} as unknown as KeyboardEvent;
}

describe("keymap matching", () => {
	test("printable keys match on e.key and ignore Shift (QWERTZ and US)", () => {
		// "#" is Shift+3 on US, its own key on QWERTZ; "+" is Shift+= on US.
		for (const k of ["#", "/", "?", "+", "*", "_"]) {
			expect(matches(k, ev(k, { shift: true }))).toBe(true);
			expect(matches(k, ev(k))).toBe(true);
		}
	});

	test("letters keep their case: N is Shift+N, n is n", () => {
		expect(matches("N", ev("N", { shift: true }))).toBe(true);
		expect(matches("n", ev("N", { shift: true }))).toBe(false);
		expect(matches("n", ev("n"))).toBe(true);
	});

	test("AltGr counts as unmodified (Windows reports it as Ctrl+Alt)", () => {
		// "/" is Shift+7 on German keyboards, "{" is AltGr+7.
		expect(matches("/", ev("/", { altGr: true }))).toBe(true);
		expect(matches("Ctrl+k", ev("k", { altGr: true }))).toBe(false);
	});

	test("modifiers must match exactly for non-printable keys", () => {
		expect(matches("Alt+ArrowRight", ev("ArrowRight", { alt: true }))).toBe(
			true,
		);
		expect(matches("ArrowRight", ev("ArrowRight", { alt: true }))).toBe(false);
		expect(matches("Shift+ArrowDown", ev("ArrowDown", { shift: true }))).toBe(
			true,
		);
		expect(matches("ArrowDown", ev("ArrowDown", { shift: true }))).toBe(false);
		expect(matches("Ctrl+z", ev("z", { ctrl: true }))).toBe(true);
		expect(matches("z", ev("z", { ctrl: true }))).toBe(false);
	});

	test("no binding uses Ctrl+Alt, and the table is ASCII only", () => {
		for (const b of KEYMAP)
			for (const k of b.keys) {
				expect(k.includes("Ctrl+") && k.includes("Alt+")).toBe(false);
				expect(/^[\x20-\x7e]+$/.test(k)).toBe(true);
			}
	});

	test("the sheet's labels", () => {
		expect(keyLabel("Ctrl+k")).toBe("Ctrl+K");
		expect(keyLabel("Shift+ArrowDown")).toBe("Shift+↓");
		expect(keyLabel("N")).toBe("Shift+N");
		expect(keyLabel(" ")).toBe("Space");
		expect(keyLabel("+")).toBe("+");
	});

	test("rows announce their shortcuts; with single keys off only the modified ones", () => {
		const on = rowShortcuts(true).split(" ");
		expect(on).toEqual(
			expect.arrayContaining([
				"Space",
				"E",
				"Enter",
				"F2",
				"Shift+D",
				"1",
				"Delete",
				"Alt+ArrowRight",
			]),
		);
		const off = rowShortcuts(false).split(" ");
		expect(off).toEqual(
			expect.arrayContaining(["Enter", "F2", "Delete", "Alt+ArrowUp"]),
		);
		expect(off).not.toContain("E");
		expect(off).not.toContain("Shift+D");
		expect(off).not.toContain("Space");
	});
});
