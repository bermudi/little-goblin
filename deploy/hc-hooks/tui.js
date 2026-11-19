// OpenCode v2 status bridge. OpenCode loads this directory as a plugin and
// runs `setup` in the TUI, which lives in the hc terminal: report.sh writes
// to that terminal. Event names and shapes follow herdr's v2 integration.
import { spawnSync } from "node:child_process";

function report(state, kind) {
	const script = process.env.GOBLIN_HC_REPORT;
	if (typeof script !== "string" || script.length === 0) return;
	spawnSync(script, kind ? [state, kind] : [state], { stdio: "ignore" });
}

export function setup(api) {
	if (process.env.GOBLIN_HC_RUN !== "1") return;
	// Goblin starts OpenCode with --standalone, so every event is this run's.
	// Child sessions (subagents) can block the run but never end it.
	const children = new Set();
	const blockers = new Map();
	let state = "idle";
	let last = "";
	const publish = () => {
		const kind = [...blockers.values()].at(-1);
		const next = kind ? `blocked ${kind}` : state;
		if (next === last) return;
		last = next;
		if (kind) report("blocked", kind);
		else report(state);
	};
	const unsubscribe = api.data.listen(({ details: event }) => {
		const data = event?.data;
		if (data == null) return;
		const root = !children.has(data.sessionID);
		switch (event.type) {
			case "session.created":
				if (data.parentID) children.add(data.sessionID);
				return;
			case "permission.asked":
				blockers.set(`permission:${data.id}`, "permission");
				break;
			case "permission.replied":
				blockers.delete(`permission:${data.requestID}`);
				break;
			case "form.created":
				blockers.set(`form:${data.form?.id}`, "question");
				break;
			case "form.replied":
			case "form.cancelled":
				blockers.delete(`form:${data.id}`);
				break;
			case "session.execution.started":
				if (!root) return;
				state = "working";
				break;
			case "session.execution.succeeded":
			case "session.execution.interrupted":
				if (!root) return;
				state = "idle";
				break;
			// A failed turn waits on the operator, as herdr reports it.
			case "session.execution.failed":
				if (!root) return;
				state = "blocked";
				break;
			default:
				return;
		}
		publish();
	});
	publish();
	return unsubscribe;
}

export default { id: "goblin.hc-status", setup };
