// Memory — the hindsight block. The connection itself is
// installer-managed; the draft keeps it opaque and the form edits only
// the switch and recall budget.

import { Field, KeyStatus, Row, Seg, type SettingsCtx, Switch } from "./settingsKit.tsx";

export function SettingsMemory({ ctx }: { ctx: SettingsCtx }) {
	const { draft, setDraft, kinds, capStates, authNames, authCommandNames, token, last } = ctx;
	const memState = capStates?.memory;
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
						<Row label="Key">
							<KeyStatus
								token={token}
								name={draft.memory.auth}
								keyless={draft.memory.auth.trim() === ""}
								commandNames={authCommandNames}
								authNames={authNames}
								onStored={ctx.keyStored((n) =>
									setDraft((d) => ({
										...d,
										memory: d.memory === null ? d.memory : { ...d.memory, auth: n },
									})),
								)}
							/>
						</Row>
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
						<details className="tuning">
							<summary>Recall tuning</summary>
							<div className="inner">
								<Field
									label="Timeout (ms)"
									value={draft.memory.timeout}
									onChange={(v) =>
										setDraft((d) => ({
											...d,
											memory: d.memory === null ? d.memory : { ...d.memory, timeout: v },
										}))
									}
									placeholder="2000"
									numeric
									mono
								/>
								<Field
									label="Max tokens"
									value={draft.memory.tokens}
									onChange={(v) =>
										setDraft((d) => ({
											...d,
											memory: d.memory === null ? d.memory : { ...d.memory, tokens: v },
										}))
									}
									placeholder="1024"
									numeric
									mono
									cap="Tight by default — turns must not wait on memory."
								/>
							</div>
						</details>
					</>
				)}
			</div>
		</>
	);
}
