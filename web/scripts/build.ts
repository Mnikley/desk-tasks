// Builds the UI bundle into src/desk_tasks/web/ (gitignored; the wheel carries it):
// index.html, app.js (Preact UI + TS core, one module) and app.css.
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tokensCss } from "../src/ui/tokens.ts";

const root = join(import.meta.dir, "..", "..");
const version = (await Bun.file(join(root, "pyproject.toml")).text()).match(
	/^version = "([^"]+)"$/m,
)?.[1];
if (!version) throw new Error("no version in pyproject.toml");
const out = join(root, "src", "desk_tasks", "web");
const dev = process.argv.includes("--dev");

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const result = await Bun.build({
	entrypoints: [join(root, "web", "src", "ui", "main.tsx")],
	outdir: out,
	naming: "app.js",
	target: "browser",
	format: "esm",
	minify: !dev && !process.env.NO_MINIFY,
	sourcemap: dev ? "inline" : "none",
	define: {
		"process.env.NODE_ENV": JSON.stringify(dev ? "development" : "production"),
		"process.env.DESK_TASKS_VERSION": JSON.stringify(version),
	},
});
if (!result.success) {
	for (const m of result.logs) console.error(m);
	process.exit(1);
}

const css = new Bun.Glob("*.css");
const styles = [
	...css.scanSync(join(root, "web", "src", "ui", "styles")),
].sort();
const text = await Promise.all(
	styles.map((f) =>
		Bun.file(join(root, "web", "src", "ui", "styles", f)).text(),
	),
);
await Bun.write(join(out, "app.css"), [tokensCss(), ...text].join("\n"));
await Bun.write(
	join(out, "index.html"),
	Bun.file(join(root, "web", "index.html")),
);
console.log(`Built ${out} (${styles.length} stylesheets).`);
