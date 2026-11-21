// Capabilities — the tools goblin can use. Off parks the block (its
// contents come back on re-enable); needs-setup rows without an in-app
// form are disabled with the server's hint.

import type { CapabilityName } from "../../src/config-schema.ts";
import { Row, type RowTag, SectionHead, type SettingsCtx, Switch } from "./settingsKit.tsx";

const CAPS: {
	key: CapabilityName;
	label: string;
	cap: string;
	tag?: RowTag;
}[] = [
	{
		key: "sandbox",
		label: "Sandboxed shell",
		cap: "Runs untrusted code in a container.",
		tag: "careful",
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
						<Row
							key={c.key}
							label={c.label}
							{...(c.tag !== undefined ? { tag: c.tag } : {})}
							cap={st?.state === "needs-setup" ? (st.hint ?? c.cap) : c.cap}
						>
							<Switch
								on={draft.capabilities[c.key] === true}
								ariaLabel={c.label}
								disabled={st?.state === "needs-setup"}
								onChange={(on) =>
									setDraft((d) => {
										// Delegation is a row backed by an editable
										// block — flag and content must move together,
										// like its own section's switch, or the save
										// emits an active block over the park.
										if (c.key !== "delegation") {
											return { ...d, capabilities: { ...d.capabilities, [c.key]: on } };
										}
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
					);
				})}
				<div className="cap ops-cap">
					Turning one off keeps its settings. Turning it on again restores them.
				</div>
			</div>
		</>
	);
}
