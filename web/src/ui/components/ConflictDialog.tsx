// "Changed on another device": the change wasn't saved; both versions side by side
// (an answer 412 from Nextcloud).
import type { TaskSide } from "../../core/tasks.ts";
import { PRIORITY_LABEL, STATUS_LABEL } from "../../logic/tasklogic.ts";
import { useStore } from "../store.ts";
import { useApp } from "./context.ts";
import { SheetFrame } from "./Sheet.tsx";

function Side(props: { title: string; side: TaskSide | null }) {
	const s = props.side;
	return (
		<div class="banner" style="margin: 0 0 8px; display: block">
			<strong style="display: block; margin-bottom: 4px">{props.title}</strong>
			{s ? (
				<dl style="margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 2px 8px">
					<dt class="help">Title</dt>
					<dd style="margin: 0">{s.summary}</dd>
					<dt class="help">Status</dt>
					<dd style="margin: 0">{STATUS_LABEL[s.status]}</dd>
					<dt class="help">Priority</dt>
					<dd style="margin: 0">{PRIORITY_LABEL[s.priority]}</dd>
					<dt class="help">Due</dt>
					<dd style="margin: 0">{s.due || "None"}</dd>
					{s.tags.length > 0 && (
						<>
							<dt class="help">Tags</dt>
							<dd style="margin: 0">{s.tags.map((t) => `#${t}`).join(" ")}</dd>
						</>
					)}
					{s.description && (
						<>
							<dt class="help">Notes</dt>
							<dd style="margin: 0; white-space: pre-wrap">{s.description}</dd>
						</>
					)}
				</dl>
			) : (
				<span class="help">Deleted.</span>
			)}
		</div>
	);
}

export function ConflictDialog() {
	const app = useApp();
	const c = useStore(app.conflict);
	if (!c) return null;
	const close = () => app.conflict.set(null);
	return (
		<SheetFrame
			title="Changed on another device"
			onClose={close}
			foot={
				<>
					<span class="grow" />
					<button
						type="button"
						class="btn primary"
						data-autofocus
						onClick={close}
					>
						OK
					</button>
				</>
			}
		>
			<p style="margin-top: 0">
				{c.summary
					? `“${c.summary}” changed in Nextcloud while you were editing it.`
					: "The task changed in Nextcloud while you were editing it."}{" "}
				The view now shows Nextcloud's version. Edit it again if your change
				still applies.
			</p>
			<Side
				title="Your change (not saved)"
				side={c.failure.conflict?.mine ?? null}
			/>
			<Side
				title="Now in Nextcloud"
				side={c.failure.conflict?.theirs ?? null}
			/>
		</SheetFrame>
	);
}
