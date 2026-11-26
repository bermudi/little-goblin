import type {
	AppWindowCall,
	AppWindowRun,
	AppWindowToolRun,
} from "../../src/http/app-wire.ts";

export interface TrajectoryTool {
	tool: AppWindowToolRun;
	lane: number;
}

export interface TrajectoryCall {
	call: AppWindowCall;
	tools: TrajectoryTool[];
}

export interface TrajectoryRow {
	turn: number;
	resumed: boolean;
	run: AppWindowRun | null;
	startedMs: number;
	finishedMs: number;
	lanes: number;
	calls: TrajectoryCall[];
}

export function seconds(ms: number | null): string {
	return ms === null ? "…" : `${(ms / 1000).toFixed(1)}s`;
}

export function buildTrajectory(
	calls: AppWindowCall[],
	toolRuns: AppWindowToolRun[],
	runs: AppWindowRun[],
	nowMs: number,
): TrajectoryRow[] {
	const orderedRuns = [...runs].sort((a, b) => a.startedMs - b.startedMs);
	const rows: TrajectoryRow[] = orderedRuns.map((run) => ({
		turn: 0,
		resumed: false,
		run,
		startedMs: run.startedMs,
		finishedMs: run.finishedMs ?? run.startedMs,
		lanes: 0,
		calls: [],
	}));
	const unplaced: TrajectoryRow = {
		turn: 0,
		resumed: false,
		run: null,
		startedMs: 0,
		finishedMs: 0,
		lanes: 0,
		calls: [],
	};
	const placed = [...calls]
		.filter((call) => call.purpose === null)
		.sort((a, b) => a.startedMs - b.startedMs)
		.map((call) => {
			const stamped = toolRuns.find((tool) => tool.modelCallId === call.callId);
			const row =
				(stamped === undefined
					? undefined
					: rows.find((item) => item.run?.runId === stamped.runId)) ??
				[...rows]
					.reverse()
					.find(
						(item) =>
							item.startedMs <= call.startedMs &&
							call.startedMs <= (item.run?.finishedMs ?? Number.POSITIVE_INFINITY),
					) ??
				unplaced;
			const group = { call, tools: [] as TrajectoryTool[] };
			row.calls.push(group);
			return { ...group, row };
		});
	const toolGroups = new Map<TrajectoryCall, AppWindowToolRun[]>();
	for (const tool of toolRuns) {
		let match = placed.find((item) => item.call.callId === tool.modelCallId);
		if (match === undefined) {
			match = [...placed]
				.reverse()
				.find(
					(item) =>
						item.row.run?.runId === tool.runId &&
						item.call.finishedMs !== null &&
						item.call.finishedMs <= tool.beganMs,
				);
		}
		if (match === undefined) continue;
		const group = toolGroups.get(match) ?? [];
		group.push(tool);
		toolGroups.set(match, group);
	}
	for (const item of placed) {
		const tools = (toolGroups.get(item) ?? []).sort(
			(a, b) => a.beganMs - b.beganMs || a.toolCallId.localeCompare(b.toolCallId),
		);
		item.tools.push(...tools.map((tool) => ({ tool, lane: 0 })));
	}
	const turnOf = new Map<string, number>();
	let lastTurn = 0;
	const orphaned = unplaced.calls.length > 0;
	for (const row of orphaned ? [...rows, unplaced] : rows) {
		if (row.run !== null) {
			const priorTurn = row.run.resumedFrom === null ? undefined : turnOf.get(row.run.resumedFrom);
			row.turn = priorTurn ?? ++lastTurn;
			row.resumed = priorTurn !== undefined;
			turnOf.set(row.run.runId, row.turn);
		}
		const starts = [
			row.run?.startedMs,
			...row.calls.map((item) => item.call.startedMs),
			...row.calls.flatMap((item) => item.tools.map(({ tool }) => tool.beganMs)),
		].filter((n): n is number => n !== undefined);
		const ends = [
			row.run === null ? undefined : (row.run.finishedMs ?? nowMs),
			...row.calls.map((item) => item.call.finishedMs ?? item.call.startedMs),
			...row.calls.flatMap((item) => item.tools.map(({ tool }) => tool.settledMs ?? tool.beganMs)),
		].filter((n): n is number => n !== undefined);
		row.startedMs = Math.min(...starts);
		row.finishedMs = Math.max(...ends);
		if (row.finishedMs <= row.startedMs) row.finishedMs = row.startedMs + 1;
	}
	for (const item of placed) {
		const laneEnds: number[] = [];
		for (const placedTool of item.tools) {
			const { tool } = placedTool;
			let lane = laneEnds.findIndex((end) => end <= tool.beganMs);
			if (lane < 0) lane = laneEnds.length;
			const end =
				tool.settledMs !== null
					? Math.max(tool.settledMs, tool.beganMs)
					: item.row.run !== null && item.row.run.finishedMs === null
						? item.row.finishedMs
						: tool.beganMs;
			laneEnds[lane] = end;
			placedTool.lane = lane;
		}
		item.row.lanes = Math.max(item.row.lanes, laneEnds.length);
	}
	if (orphaned) {
		const next = rows.findIndex((row) => row.startedMs > unplaced.startedMs);
		rows.splice(next < 0 ? rows.length : next, 0, unplaced);
	}
	return rows;
}
