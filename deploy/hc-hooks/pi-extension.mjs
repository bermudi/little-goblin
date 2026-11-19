import { spawnSync } from "node:child_process";

export default function (pi) {
	let rootTui = false;
	const report = (state, kind) => {
		if (process.env.GOBLIN_HC_RUN !== "1") return;
		const script = process.env.GOBLIN_HC_REPORT;
		if (typeof script !== "string" || script.length === 0) return;
		const result = spawnSync(script, kind ? [state, kind] : [state], { stdio: "ignore" });
		if (result.error && process.env.GOBLIN_HC_DEBUG === "1") {
			process.stderr.write(`goblin hc pi hook failed: ${result.error.message}\n`);
		}
	};
	pi.on("session_start", (_event, ctx) => {
		rootTui = ctx.mode === "tui";
		if (rootTui) report("idle");
	});
	pi.on("agent_start", () => {
		if (rootTui) report("working");
	});
	pi.on("agent_settled", (_event, ctx) => {
		if (rootTui && ctx.isIdle?.() === true) report("idle");
	});
	let blockedCount = 0;
	pi.events?.on("herdr:blocked", (data) => {
		if (!rootTui) return;
		if (data?.active) {
			blockedCount += 1;
			report("blocked", data?.kind === "question" ? "question" : "permission");
		} else {
			blockedCount = Math.max(0, blockedCount - 1);
			if (blockedCount === 0) report("working");
		}
	});
}
