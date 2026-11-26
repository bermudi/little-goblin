import type { ReactElement } from "react";
import { contextCount } from "./chat/ContextGauge.tsx";
import { ts } from "./opsShared.tsx";
import type { TrajectoryRow } from "./trajectory.ts";
import { seconds } from "./trajectory.ts";

export function TrajectoryChart({ rows }: { rows: TrajectoryRow[] }): null | ReactElement {
	if (rows.length === 0) return null;
	return (
		<div className="win-traj">
			{rows.map((row, index) => {
				const span = row.finishedMs - row.startedMs;
				const position = (start: number, end: number): { left: string; width: string } => {
					const left = Math.max(0, Math.min(100, ((start - row.startedMs) / span) * 100));
					const right = Math.max(left, Math.min(100, ((end - row.startedMs) / span) * 100));
					return { left: `${left}%`, width: `${Math.max(0, right - left)}%` };
				};
				const callCount = row.calls.length;
				const toolCount = row.calls.reduce((sum, item) => sum + item.tools.length, 0);
				return (
					<div
						className="win-traj-row"
						role="img"
						aria-label={
							row.run === null
								? `No run recorded, ${callCount} model calls, ${toolCount} tools, ${seconds(span)}`
								: `Turn ${row.turn}${row.resumed ? ", resumed" : ""}: ${callCount} model calls, ${toolCount} tools, ${seconds(span)}`
						}
						key={row.run?.runId ?? `fallback-${index}`}
					>
						<div className="win-traj-label">
							<strong>{row.run === null ? "No run" : `Turn ${row.turn}${row.resumed ? " · resumed" : ""}`}</strong>
							{row.run !== null && (
								<>
									<span className="win-traj-time">{ts(new Date(row.run.startedMs).toISOString())}</span>
									<span>{row.run.finishedMs === null ? "live" : seconds(row.run.finishedMs - row.run.startedMs)}</span>
								</>
							)}
						</div>
						<div
							className="win-traj-track"
							style={{ position: "relative", height: `${45 + row.lanes * 14 + 6}px` }}
						>
							{row.calls.map(({ call, tools }) => {
								const end = call.finishedMs ?? row.finishedMs;
								const geometry = position(call.startedMs, end);
								const pct =
									typeof call.inputTokens === "number" &&
									typeof call.cacheRead === "number" &&
									call.inputTokens > 0
										? `${Math.round((call.cacheRead / call.inputTokens) * 100)}%`
										: "—";
								const relation = ["same", "append", "rewrite", "first"].includes(call.prefixRelation)
									? call.prefixRelation
									: "first";
								const state =
									call.finishedMs === null
										? row.run !== null && row.run.finishedMs === null
											? "running"
											: "unfinished"
										: call.status !== "completed"
											? "failed"
											: "";
								return (
									<div key={call.callId}>
										<span
											className={`win-traj-call ${relation}${state === "" ? "" : ` ${state}`}`}
											style={{ ...geometry, position: "absolute", top: "6px", height: "30px" }}
											title={`${call.callId} · ${ts(new Date(call.startedMs).toISOString())} · in ${call.inputTokens ?? "?"} · out ${call.outputTokens ?? "?"} · cache read ${call.cacheRead ?? "—"} · ${call.prefixRelation} · ${call.status}`}
										>
											<span>{call.inputTokens === null ? "?" : contextCount(call.inputTokens)} in</span>
											<span>{seconds(end - call.startedMs)} · cache {pct}</span>
										</span>
										{tools.map(({ tool, lane }) => {
											const toolEnd = tool.settledMs ?? tool.beganMs;
											const toolState =
												tool.state === "failed"
													? "failed"
													: tool.settledMs !== null
														? "ok"
														: row.run !== null && row.run.finishedMs === null
															? "running"
															: "unfinished";
											return (
												<span
													key={tool.toolCallId}
													className={`win-traj-tool ${toolState}`}
													style={{
														...position(tool.beganMs, toolEnd),
														position: "absolute",
														top: `${39 + lane * 14}px`,
														height: "12px",
													}}
													title={`${tool.name} · ${tool.state} · ${ts(new Date(tool.beganMs).toISOString())}–${tool.settledMs === null ? "…" : ts(new Date(tool.settledMs).toISOString())} · ${seconds(tool.settledMs === null ? null : tool.settledMs - tool.beganMs)}`}
												>
													{tool.name}
												</span>
											);
										})}
									</div>
								);
							})}
						</div>
					</div>
				);
			})}
		</div>
	);
}
