// Delegation — the coding agents goblin may hand work to and the
// role → agent defaults the delegate tool uses when a call names no
// harness. Machine targets stay file-only: their herdr profiles are
// host-bound, and the server merge preserves them.

import { useState } from "react";
import type { DelegationRoleDraft, HarnessDraft } from "./settingsDraft.ts";
import { Field, Row, SectionHead, type SettingsCtx, Switch } from "./settingsKit.tsx";

const NAME_RE = /^[a-z][a-z0-9_-]{0,15}$/;
const ROLE_SUGGESTIONS = ["default", "build", "review", "overflow"];

// The fallback role is always visible — it is what an unroled call uses.
function withDefault(roles: DelegationRoleDraft[]): DelegationRoleDraft[] {
	if (roles.some((r) => r.role === "default")) return roles;
	return [{ role: "default", harness: "" }, ...roles];
}

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

	const roles = del === null ? [] : withDefault(del.roles);
	const names = del === null ? [] : del.harnesses.map((h) => h.name.trim()).filter((n) => n !== "");

	const setRole = (i: number, patch: Partial<DelegationRoleDraft>) =>
		edit((d) => {
			const list = withDefault(d.roles);
			return { ...d, roles: list.map((r, j) => (j === i ? { ...r, ...patch } : r)) };
		});

	return (
		<>
			<SectionHead
				title="Delegation"
				purpose="Coding agents goblin can hand work to, and which one it picks when a request names no agent."
			/>
			<div className="card">
				<Row
					label="Delegate to coding agents"
					cap="Off turns the delegate tool off. Machine targets stay in goblin.json5."
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
											last.current.delegation ?? { harnesses: [], roles: [] },
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
						Changes apply after a restart. An explicit harness in a delegate call always wins over
						these defaults.
					</div>
				)}
			</div>

			{del !== null && (
				<>
					<SectionHead
						title="Coding agents"
						purpose="Each name is what a delegate call passes as its harness. Kind is the herdr agent kind."
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
										cap="The herdr agent kind to launch."
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
										The model lives here when the agent needs one. Full-auto flags already in the
										operator's shell alias must not be repeated.
									</div>
								</div>
							</div>
						))}
						<div className="addrow">
							<button
								type="button"
								className="addbtn"
								onClick={() =>
									edit((d) => ({
										...d,
										harnesses: [...d.harnesses, { name: "", kind: "", args: "" }],
									}))
								}
							>
								+ Add a coding agent
							</button>
						</div>
					</div>

					<SectionHead
						title="Defaults"
						purpose="Which agent a role uses. `default` is the fallback when a call names no role."
					/>
					<div className="card">
						{roles.map((r, i) => (
							<div className="del-role" key={`${i}:${r.role}`}>
								<div className="del-role-name mono">{r.role}</div>
								<select
									aria-label={`agent for role ${r.role}`}
									value={r.harness}
									onChange={(e) => setRole(i, { harness: e.target.value })}
								>
									<option value="">— none —</option>
									{names.map((n) => (
										<option key={n} value={n}>
											{n}
										</option>
									))}
									{r.harness !== "" && !names.includes(r.harness) && (
										<option value={r.harness}>{r.harness} (unlisted)</option>
									)}
								</select>
								{r.role !== "default" && (
									<button
										type="button"
										className="ghost-inline"
										aria-label={`remove role ${r.role}`}
										onClick={() =>
											edit((d) => ({
												...d,
												roles: withDefault(d.roles).filter((_, j) => j !== i),
											}))
										}
									>
										Remove
									</button>
								)}
							</div>
						))}
						<RoleAdder
							taken={roles.map((r) => r.role)}
							onAdd={(role) =>
								edit((d) => ({ ...d, roles: [...withDefault(d.roles), { role, harness: "" }] }))
							}
						/>
						<div className="cap ops-cap">A named role with no entry uses the default agent.</div>
					</div>
				</>
			)}
		</>
	);
}

function RoleAdder({ taken, onAdd }: { taken: string[]; onAdd: (role: string) => void }) {
	const [value, setValue] = useState("");
	const role = value.trim();
	const ok = NAME_RE.test(role) && !taken.includes(role);
	const add = () => {
		if (!ok) return;
		onAdd(role);
		setValue("");
	};
	return (
		<div className="addrow">
			<input
				className="mono"
				value={value}
				onChange={(e) => setValue(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						add();
					}
				}}
				placeholder="new role"
				aria-label="new delegation role"
				autoComplete="off"
				spellCheck={false}
				list="del-role-suggestions"
			/>
			<datalist id="del-role-suggestions">
				{ROLE_SUGGESTIONS.filter((r) => !taken.includes(r)).map((r) => (
					<option key={r} value={r} />
				))}
			</datalist>
			<button className="addbtn" type="button" onClick={add} disabled={!ok}>
				Add role
			</button>
		</div>
	);
}
