import type { HarnessDraft } from "./settingsDraft.ts";
import { Field, Row, SectionHead, type SettingsCtx, Switch } from "./settingsKit.tsx";

export function SettingsDelegation({ ctx }: { ctx: SettingsCtx }) {
	const { draft, setDraft, last } = ctx;
	const del = draft.delegation;

	const edit = (fn: (d: NonNullable<typeof del>) => NonNullable<typeof del>) =>
		setDraft((d) => (d.delegation === null ? d : { ...d, delegation: fn(d.delegation) }));

	const setHarness = (i: number, patch: Partial<HarnessDraft>) =>
		edit((d) => ({
			...d,
			harnesses: d.harnesses.map((h, j) => (j === i ? { ...h, ...patch } : h)),
		}));

	return (
		<>
			<SectionHead
				title="Delegation"
				purpose="Coding agents Goblin can use when the operator names one."
			/>
			<div className="card">
				<Row
					label="Delegate to coding agents"
					cap="Off turns the delegate tool off."
				>
					<Switch
						on={del !== null}
						ariaLabel="delegation"
						onChange={(on) =>
							setDraft((d) => {
								if (on) {
									return {
										...d,
										capabilities: { ...d.capabilities, delegation: true },
										delegation: d.delegation ??
											last.current.delegation ?? {
												harnesses: [],
												},
									};
								}
								last.current.delegation = d.delegation;
								return {
									...d,
									capabilities: { ...d.capabilities, delegation: false },
									delegation: null,
								};
							})
						}
					/>
				</Row>
				{del !== null && (
					<div className="cap ops-cap">
						Changes apply after a restart.
					</div>
				)}
			</div>

			{del !== null && (
				<>
					<SectionHead
						title="Coding agents"
						purpose="Each name is what a delegate call passes as its harness. Kind selects the installed harness."
					/>
					<div className="card">
						{del.harnesses.length === 0 && (
							<div className="cap ops-cap">No agents yet — add one below.</div>
						)}
						{del.harnesses.map((h, i) => (
							<div className="del-harness" key={i}>
								<div className="del-harness-head">
									<span className="rlabel">{h.name || "new agent"}</span>
									<button
										type="button"
										className="ghost-inline"
										aria-label={`remove ${h.name || "this agent"}`}
										onClick={() =>
											edit((d) => ({ ...d, harnesses: d.harnesses.filter((_, j) => j !== i) }))
										}
									>
										Remove
									</button>
								</div>
								<div className="del-grid">
									<Field
										label="Name"
										value={h.name}
										mono
										placeholder="pi"
										cap="Lowercase letters, digits, _ or - — 16 max."
										onChange={(v) => setHarness(i, { name: v })}
									/>
									<Field
										label="Kind"
										value={h.kind}
										mono
										placeholder="pi"
										cap="The harness kind to launch."
										onChange={(v) => setHarness(i, { kind: v })}
									/>
								</div>
								<div className="frow">
									<label className="flabel" htmlFor={`del-args-${i}`}>
										Args — native CLI flags, one per line
									</label>
									<textarea
										id={`del-args-${i}`}
										className="mono"
										rows={2}
										value={h.args}
										spellCheck={false}
										autoCapitalize="off"
										placeholder={"--model\nzai/glm-5.3"}
										onChange={(e) => setHarness(i, { args: e.target.value })}
									/>
									<div className="cap">
										The model goes here when the agent needs one. Do not repeat full-auto flags the
										operator's shell alias already adds.
									</div>
								</div>
								<Row
									label="Ask me first"
									cap="Goblin asks before each use (e.g. it spends a subscription)."
								>
									<Switch
										on={h.askFirst}
										ariaLabel={`ask first for ${h.name || "new agent"}`}
										onChange={(on) => setHarness(i, { askFirst: on })}
									/>
								</Row>
							</div>
						))}
						<div className="addrow">
							<button
								type="button"
								className="addbtn"
								onClick={() =>
									edit((d) => ({
										...d,
										harnesses: [...d.harnesses, { name: "", kind: "", args: "", askFirst: false }],
									}))
								}
							>
								+ Add a coding agent
							</button>
						</div>
					</div>

				</>
			)}
		</>
	);
}
