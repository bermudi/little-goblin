// Memory — the hindsight block. The connection itself is
// installer-managed; the draft keeps every field opaque and the form
// edits only the switch and the recall budget.

import { relTime } from "./memoryShared.tsx";
import { Row, SectionHead, Seg, type SettingsCtx, Switch } from "./settingsKit.tsx";

export function SettingsMemory({ ctx }: { ctx: SettingsCtx }) {
	const { draft, setDraft, capStates, status, last } = ctx;
	const memState = capStates?.memory;
	const memStatus = status?.memory ?? null;
	return (
		<>
			<SectionHead
				title="Long-term memory"
				purpose="What goblin remembers between chats. Browse it in the Memories view."
			/>
			<div className="card">
				<Row
					label="Memory"
					cap={
						memState?.state === "needs-setup"
							? (memState.hint ?? "Needs setup first.")
							: "Goblin saves finished chats and recalls useful facts in new ones."
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
						<Row label="Recall budget" cap="How much memory goblin may pull into each turn." col>
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
