// Capabilities — the tools goblin can use. Off parks the block (its
// contents come back on re-enable); needs-setup rows are disabled with
// the server's hint.

import type { CapabilityName } from "../../src/config.ts";
import { Row, type SettingsCtx, Switch } from "./settingsKit.tsx";

const CAPS: { key: CapabilityName; label: string; cap: string }[] = [
	{ key: "sandbox", label: "Sandboxed shell", cap: "Run untrusted code in a container." },
	{ key: "subagents", label: "Subagents & computer use", cap: "Delegate long work to sub-agents." },
	{ key: "scripting", label: "Script tool", cap: "Chain tool calls in one step." },
	{ key: "delegation", label: "Delegate to coding agents", cap: "Codex, Claude, and friends." },
	{ key: "reviewer", label: "Learn skills automatically", cap: "Review and install new skills." },
];

export function SettingsCapabilities({ ctx }: { ctx: SettingsCtx }) {
	const { draft, setDraft, capStates } = ctx;
	return (
		<>
			<h2 className="ops-h2">Capabilities</h2>
			<div className="card">
				{CAPS.map((c) => {
					const st = capStates?.[c.key];
					return (
						<Row
							key={c.key}
							label={c.label}
							cap={st?.state === "needs-setup" ? (st.hint ?? c.cap) : c.cap}
						>
							<Switch
								on={draft.capabilities[c.key] === true}
								ariaLabel={c.label}
								disabled={st?.state === "needs-setup"}
								onChange={(on) =>
									setDraft((d) => ({
										...d,
										capabilities: { ...d.capabilities, [c.key]: on },
									}))
								}
							/>
						</Row>
					);
				})}
				<div className="cap ops-cap">
					Switching one off keeps its settings — turning it back on restores them.
				</div>
			</div>
		</>
	);
}
