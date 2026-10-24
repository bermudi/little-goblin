// Memory — the hindsight block. The connection itself is
// installer-managed; the draft keeps every field opaque and the form
// edits only the switch and the recall budget.

import { relTime } from "./memoryShared.tsx";
import { Row, Seg, type SettingsCtx, Switch } from "./settingsKit.tsx";

export function SettingsMemory({ ctx }: { ctx: SettingsCtx }) {
	const { draft, setDraft, capStates, status, last } = ctx;
	const memState = capStates?.memory;
	const memStatus = status?.memory ?? null;
	return (
		<>
			<p className="lead">What goblin retains and recalls — browse it in the Memories view.</p>
			<h2 className="ops-h2">Long-term memory</h2>
			<div className="card">
				<Row
					label="Memory"
					cap={
						memState?.state === "needs-setup"
							? (memState.hint ?? "Needs setup first.")
							: "Self-hosted hindsight. Completed exchanges are retained; relevant facts are recalled into new turns."
					}
				>
					<Switch
						on={draft.memory !== null}
						ariaLabel="long-term memory"
						disabled={memState?.state === "needs-setup"}
						onChange={(on) =>
							setDraft((d) => {
								if (on) {
									return {
										...d,
										capabilities: { ...d.capabilities, memory: true },
										memory: last.current.memory ?? d.memory,
									};
								}
								last.current.memory = d.memory;
								return {
									...d,
									capabilities: { ...d.capabilities, memory: false },
									memory: null,
								};
							})
						}
					/>
				</Row>
				{draft.memory !== null && (
					<>
						<div className="cap ops-cap">
							Hindsight · {draft.memory.baseUrl || "(url unset)"} · bank{" "}
							{draft.memory.bankId || "(unset)"} — set by the memory installer.
						</div>
						<Row label="Recall budget" col>
							<Seg
								options={["low", "mid", "high"]}
								value={draft.memory.budget || "mid"}
								ariaLabel="Recall budget"
								onChange={(v) =>
									setDraft((d) => ({
										...d,
										memory: d.memory === null ? d.memory : { ...d.memory, budget: v },
									}))
								}
							/>
						</Row>
					</>
				)}
			</div>
			{draft.memory !== null && memStatus !== null && (
				<div className="card">
					<div className="stat-grid">
						<div className="stat">
							<span className="stat-label">state</span>
							<span className={`stat-val mono mem-${memStatus.state}`}>{memStatus.state}</span>
						</div>
						<div className="stat">
							<span className="stat-label">last recall</span>
							<span className="stat-val mono">
								{memStatus.lastRecallAt === null
									? "—"
									: `${relTime(memStatus.lastRecallAt)}${
											memStatus.lastRecallOk === false ? " (failed)" : ""
										}`}
							</span>
						</div>
						<div className="stat">
							<span className="stat-label">queued</span>
							<span className="stat-val mono">{memStatus.queued}</span>
						</div>
						<div className="stat">
							<span className="stat-label">blocked</span>
							<span className="stat-val mono">{memStatus.blocked}</span>
						</div>
					</div>
					{memStatus.detail !== "" && <div className="cap ops-cap">{memStatus.detail}</div>}
				</div>
			)}
		</>
	);
}
