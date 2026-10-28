// First run: "Connect your Nextcloud" → URL → "Log in in your browser" (Login Flow v2) →
// "Waiting for you to log in in the browser…"; "Use an app password instead" as the fallback.
// After that the welcome sheet (Sheets.tsx) asks which lists Today shows and about autostart.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { Bridge, LoginState } from "../../bridge.ts";

export function FirstRun(props: { bridge: Bridge; onConnected: () => void }) {
	const [url, setUrl] = useState("");
	const [state, setState] = useState<LoginState>({ state: "idle" });
	const [manual, setManual] = useState(false);
	const [user, setUser] = useState("");
	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState(false);
	const field = useRef<HTMLInputElement>(null);
	useLayoutEffect(() => field.current?.focus(), [manual]);

	// Python polls Nextcloud; this only asks how it is going.
	useEffect(() => {
		if (state.state !== "pending") return;
		const t = setInterval(async () => {
			const s = await props.bridge.connectPoll().catch(() => null);
			if (s && s.state !== "pending") {
				setState(s);
				if (s.state === "done") props.onConnected();
			}
		}, 1000);
		return () => clearInterval(t);
	}, [state.state]);

	const start = async () => {
		setBusy(true);
		const s = await props.bridge.connectStart(url).catch(
			(): LoginState => ({
				state: "failed",
				reason: "internal",
				message: "Something went wrong. The details are in the log.",
			}),
		);
		setBusy(false);
		setState(s);
		if (s.state === "done") props.onConnected();
	};
	const connectManual = async () => {
		setBusy(true);
		const s = await props.bridge.connectManual(url, user, password).catch(
			(): LoginState => ({
				state: "failed",
				reason: "internal",
				message: "Something went wrong. The details are in the log.",
			}),
		);
		setBusy(false);
		setState(s);
		if (s.state === "done") props.onConnected();
	};
	const failed = state.state === "failed" ? state : null;
	return (
		<div class="app">
			<div
				class="sheet"
				style="animation: none"
				role="main"
				aria-labelledby="fr-title"
			>
				<div class="sheet-head">
					<h2 id="fr-title">Connect your Nextcloud</h2>
				</div>
				<div class="sheet-body">
					{state.state === "pending" ? (
						<div role="status">
							<p style="margin-top: 0">
								Waiting for you to log in in the browser…
							</p>
							<p class="help">
								Log in there and allow desk-tasks. This page notices by itself.
								The link works for 20 minutes.
							</p>
							<div style="display: flex; gap: 8px; flex-wrap: wrap">
								<button
									type="button"
									class="btn"
									onClick={() => void props.bridge.openUrl(state.login)}
								>
									Open the login page again
								</button>
								<button
									type="button"
									class="btn"
									onClick={() => setState({ state: "idle" })}
								>
									Cancel
								</button>
							</div>
						</div>
					) : (
						<form
							onSubmit={(e) => {
								e.preventDefault();
								void (manual ? connectManual() : start());
							}}
						>
							<p style="margin-top: 0" class="help">
								desk-tasks shows and edits the task lists of your Nextcloud. It
								keeps its app password in Windows Credential Manager.
							</p>
							<div class="field">
								<label for="fr-url">Nextcloud address</label>
								<input
									id="fr-url"
									ref={field}
									class="input"
									type="url"
									inputMode="url"
									placeholder="https://cloud.example.com"
									autocomplete="url"
									spellcheck={false}
									value={url}
									onInput={(e) => setUrl(e.currentTarget.value)}
								/>
							</div>
							{manual && (
								<>
									<div class="field">
										<label for="fr-user">User name</label>
										<input
											id="fr-user"
											class="input"
											autocomplete="username"
											value={user}
											onInput={(e) => setUser(e.currentTarget.value)}
										/>
									</div>
									<div class="field">
										<label for="fr-pw">App password</label>
										<input
											id="fr-pw"
											class="input"
											type="password"
											autocomplete="off"
											value={password}
											onInput={(e) => setPassword(e.currentTarget.value)}
										/>
										<span class="help">
											In Nextcloud: Settings → Security → Devices &amp; sessions
											→ Create new app password.
										</span>
									</div>
								</>
							)}
							{failed && (
								<p class="error-text" role="alert">
									{failed.message}
								</p>
							)}
							<div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap">
								<button
									type="submit"
									class="btn primary"
									disabled={
										busy ||
										!url.trim() ||
										(manual && (!user.trim() || !password.trim()))
									}
								>
									{manual
										? "Connect"
										: failed?.reason === "expired"
											? "Start again"
											: "Log in in your browser"}
								</button>
								<button
									type="button"
									class="text-btn"
									onClick={() => setManual(!manual)}
								>
									{manual
										? "Log in in the browser instead"
										: "Use an app password instead"}
								</button>
							</div>
						</form>
					)}
				</div>
			</div>
		</div>
	);
}
