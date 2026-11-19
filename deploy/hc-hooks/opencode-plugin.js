export const GoblinStatus = async () => ({
	event: async ({ event }) => {
		if (process.env.GOBLIN_HC_RUN !== "1") return;
		const report = process.env.GOBLIN_HC_REPORT;
		if (typeof report !== "string" || report.length === 0) return;
		let state;
		let kind;
		if (event.type === "session.status") {
			const status = event.properties?.status?.type;
			if (status === "idle") state = "idle";
			else if (["active", "busy", "pending", "retry", "running", "streaming", "working"].includes(status)) {
				state = "working";
			}
		} else if (event.type === "session.idle") state = "idle";
		else if (event.type === "session.error") state = "blocked";
		else if (event.type === "permission.asked") { state = "blocked"; kind = "permission"; }
		else if (event.type === "question.asked") { state = "blocked"; kind = "question"; }
		else if (["permission.replied", "question.replied", "question.rejected"].includes(event.type)) state = "working";
		if (!state) return;
		const { spawnSync } = await import("node:child_process");
		spawnSync(report, kind ? [state, kind] : [state], { stdio: "ignore" });
	},
});
