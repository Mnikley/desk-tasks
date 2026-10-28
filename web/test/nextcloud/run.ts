// Starts a throwaway Nextcloud in Docker, creates the test users and an app password, runs the
// real-server suites against it (TypeScript, then the Python login tests), and removes it again.
// Flags: --keep (leave it running), --image <tag> (e.g. nextcloud:34.0.5-apache).
import { prepare, USER } from "./harness.ts";

const compose = ["docker", "compose", "-f", `${import.meta.dir}/compose.yaml`];
const keep = process.argv.includes("--keep");
const imageArg = process.argv.indexOf("--image");
const image = imageArg > 0 ? process.argv[imageArg + 1] : undefined;
const env = image ? { NEXTCLOUD_IMAGE: image } : {};

function run(cmd: string[], extra?: Record<string, string>): number {
	return (
		Bun.spawnSync(cmd, {
			stdout: "inherit",
			stderr: "inherit",
			env: { ...process.env, ...env, ...extra },
		}).exitCode ?? 1
	);
}

if (run([...compose, "up", "-d"]) !== 0) {
	console.error(
		"Couldn't start Nextcloud with Docker Compose. Is Docker running?",
	);
	process.exit(1);
}
let code = 1;
try {
	const nc = await prepare();
	console.log(`Nextcloud ${nc.version} is ready.`);
	code = run(["bun", "test", `${import.meta.dir}/`, "--timeout", "60000"], {
		NEXTCLOUD_TEST_URL: nc.url,
		NEXTCLOUD_APP_PASSWORD: nc.appPassword,
		NEXTCLOUD_VERSION: nc.version,
	});
	// Login Flow v2 and logging out go through the Python bridge.
	const py = run(["uv", "run", "pytest", "tests/nextcloud", "-q"], {
		NEXTCLOUD_TEST_URL: nc.url,
		NEXTCLOUD_USER: USER.name,
		NEXTCLOUD_PASSWORD: USER.password,
	});
	if (code === 0) code = py;
} finally {
	if (!keep) run([...compose, "down", "-v"]);
}
process.exit(code);
