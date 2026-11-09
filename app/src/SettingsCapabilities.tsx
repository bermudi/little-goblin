// Capabilities — the tools goblin can use. Off parks the block (its
// contents come back on re-enable); needs-setup rows without an in-app
// form are disabled with the server's hint.

import { Fragment, useId } from "react";
import type { CapabilityName, ThinkingLevel } from "../../src/config.ts";
import {
	emptySubagentsDraft,
	type SubagentModelDraft,
	SUBAGENT_DEFAULTS,
	type SubagentsDraft,
	THINKING_ORDER,
} from "./settingsDraft.ts";
import { Field, Row, type RowTag, SectionHead, type SettingsCtx, Switch } from "./settingsKit.tsx";

const CAPS: {
	key: CapabilityName;
	label: string;
	cap: string;
	tag?: RowTag;
	/** The row's setup form lives here too — needs-setup only styles
	 *  the hint; the switch stays usable (subagents). */
	setupInApp?: boolean;
}[] = [
	{
		key: "sandbox",
		label: "Sandboxed shell",
		cap: "Runs untrusted code in a container.",
		tag: "careful",
	},
	{
		key: "subagents",
		label: "Subagents & computer use",
		cap: "Hands long jobs to helper agents.",
		setupInApp: true,
	},
	{
		key: "scripting",
		label: "Script tool",
		cap: "Lets goblin chain several tool calls in one step.",
	},
	{
		key: "delegation",
		label: "Delegate to coding agents",
		cap: "Lets goblin start coding agents such as Codex and Claude.",
		tag: "careful",
	},
	{
		key: "reviewer",
		label: "Learn skills automatically",
		cap: "Reviews and installs new skills on its own.",
		tag: "restart",
	},
];

export function SettingsCapabilities({ ctx }: { ctx: SettingsCtx }) {
	const { draft, setDraft, capStates, last } = ctx;
	return (
		<>
			<SectionHead
				title="Capabilities"
				purpose="Extra tools goblin may use. Each one you turn on gives goblin more power."
			/>
			<div className="card">
				{CAPS.map((c) => {
					const st = capStates?.[c.key];
					return (
						<Fragment key={c.key}>
							<Row
								label={c.label}
								{...(c.tag !== undefined ? { tag: c.tag } : {})}
								cap={st?.state === "needs-setup" ? (st.hint ?? c.cap) : c.cap}
							>
								<Switch
									on={draft.capabilities[c.key] === true}
									ariaLabel={c.label}
									disabled={st?.state === "needs-setup" && c.setupInApp !== true}
									onChange={(on) =>
										setDraft((d) => {
											// Delegation and subagents are rows backed by an
											// editable block — flag and content must move
											// together, like their own sections' switches, or
											// the save emits an active block over the park.
											if (c.key !== "delegation" && c.key !== "subagents") {
												return { ...d, capabilities: { ...d.capabilities, [c.key]: on } };
											}
											if (on) {
												if (c.key === "delegation") {
													return {
														...d,
														capabilities: { ...d.capabilities, delegation: true },
														delegation: d.delegation ??
															last.current.delegation ?? {
																harnesses: [],
																roles: [],
																machineHarnesses: [],
															},
													};
												}
												return {
													...d,
													capabilities: { ...d.capabilities, subagents: true },
													subagents: d.subagents ?? last.current.subagents ?? emptySubagentsDraft(),
												};
											}
											if (c.key === "delegation") {
												last.current.delegation = d.delegation;
												return {
													...d,
													capabilities: { ...d.capabilities, delegation: false },
													delegation: null,
												};
											}
											last.current.subagents = d.subagents;
											return {
												...d,
												capabilities: { ...d.capabilities, subagents: false },
												subagents: null,
											};
										})
									}
								/>
							</Row>
							{c.key === "subagents" && draft.subagents !== null && <SubagentsForm ctx={ctx} />}
						</Fragment>
					);
				})}
				<div className="cap ops-cap">
					Turning one off keeps its settings. Turning it on again restores them.
				</div>
			</div>
		</>
	);
}

// The subagents row's inline editor — first-time setup and later edits
// without touching goblin.json5. A type left off is null on the wire;
// api and the file-only tuning never appear here.
function SubagentsForm({ ctx }: { ctx: SettingsCtx }) {
	const { draft, setDraft, authNames } = ctx;
	const sub = draft.subagents;
	if (sub === null) return null;
	const edit = (fn: (s: SubagentsDraft) => SubagentsDraft) =>
		setDraft((d) => (d.subagents === null ? d : { ...d, subagents: fn(d.subagents) }));
	const newModel = (t: "worker" | "computer"): SubagentModelDraft => ({
		auth: "",
		id: t === "worker" ? SUBAGENT_DEFAULTS.worker.id : SUBAGENT_DEFAULTS.computer.id,
		baseUrl: SUBAGENT_DEFAULTS.baseUrl,
		thinking:
			t === "worker" ? SUBAGENT_DEFAULTS.worker.thinking : SUBAGENT_DEFAULTS.computer.thinking,
	});
	const patchWorker = (p: Partial<SubagentModelDraft>) =>
		edit((s) => (s.worker === null ? s : { ...s, worker: { ...s.worker, ...p } }));
	const patchComputer = (p: Partial<SubagentModelDraft>) =>
		edit((s) => (s.computer === null ? s : { ...s, computer: { ...s.computer, ...p } }));
	// One container (`.sub-form`) so the form sits inset to its row's
	// padding and carries no card-edge divider — it belongs to the row
	// above, not the card.
	return (
		<div className="sub-form">
			<div className="del-harness">
				<div className="del-harness-head">
					<span className="rlabel">Code worker</span>
					<Switch
						on={sub.worker !== null}
						ariaLabel="Code worker"
						onChange={(on) => edit((s) => ({ ...s, worker: on ? newModel("worker") : null }))}
					/>
				</div>
				{sub.worker !== null && (
					<SubagentModelFields
						named="code worker"
						m={sub.worker}
						authNames={authNames}
						onPatch={patchWorker}
					/>
				)}
			</div>
			<div className="del-harness">
				<div className="del-harness-head">
					<span className="rlabel">Computer use</span>
					<Switch
						on={sub.computer !== null}
						ariaLabel="Computer use"
						onChange={(on) => edit((s) => ({ ...s, computer: on ? newModel("computer") : null }))}
					/>
				</div>
				{sub.computer !== null && (
					<>
						<SubagentModelFields
							named="computer use"
							m={sub.computer}
							authNames={authNames}
							onPatch={patchComputer}
						/>
						<Field
							label="Desktop image"
							value={sub.desktopImage}
							mono
							onChange={(v) => edit((s) => ({ ...s, desktopImage: v }))}
							cap="Must already be built on this machine; goblin never pulls it."
						/>
					</>
				)}
			</div>
			{sub.worker !== null && !draft.capabilities.sandbox && (
				<div className="cap ops-cap">The code worker also needs Sandboxed shell.</div>
			)}
			{sub.worker === null && sub.computer === null && (
				<div className="cap ops-cap">Pick at least one.</div>
			)}
		</div>
	);
}

function SubagentModelFields({
	named,
	m,
	authNames,
	onPatch,
}: {
	/** aria wording, e.g. "code worker". */
	named: string;
	m: SubagentModelDraft;
	authNames: readonly string[];
	onPatch(p: Partial<SubagentModelDraft>): void;
}) {
	const keyId = useId();
	const thinkId = useId();
	return (
		<div className="del-grid">
			<div className="frow">
				<label className="flabel" htmlFor={keyId}>
					Key
				</label>
				<select
					id={keyId}
					value={m.auth}
					aria-label={`key for the ${named}`}
					onChange={(e) => onPatch({ auth: e.target.value })}
				>
					{m.auth === "" && <option value="">— pick a key —</option>}
					{m.auth !== "" && !authNames.includes(m.auth) && (
						<option value={m.auth}>{m.auth} (unlisted)</option>
					)}
					{authNames.map((n) => (
						<option key={n} value={n}>
							{n}
						</option>
					))}
				</select>
			</div>
			<Field label="Model" value={m.id} mono onChange={(v) => onPatch({ id: v })} />
			<Field label="Base url" value={m.baseUrl} mono onChange={(v) => onPatch({ baseUrl: v })} />
			<div className="frow">
				<label className="flabel" htmlFor={thinkId}>
					Thinking
				</label>
				<select
					id={thinkId}
					value={m.thinking}
					aria-label={`thinking for the ${named}`}
					onChange={(e) => onPatch({ thinking: e.target.value as ThinkingLevel })}
				>
					{THINKING_ORDER.map((l) => (
						<option key={l} value={l}>
							{l}
						</option>
					))}
				</select>
			</div>
		</div>
	);
}
