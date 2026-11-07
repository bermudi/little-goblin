// System — version, uptime, log level, and the read-only doors. The
// restart banner lives in the shell so it shows on every section.

import { Row, SectionHead, Seg, type SettingsCtx } from "./settingsKit.tsx";

export function SettingsSystem({ ctx }: { ctx: SettingsCtx }) {
	const { draft, patchDraft, status } = ctx;
	const started = status === null ? null : new Date(status.startedAt);
	return (
		<>
			<SectionHead title="System" purpose="What is running, and how much it writes to the log. Read-only facts are set in goblin.json5." />
			<div className="card">
				{status !== null && (
					<Row
						label="Version"
						cap={started === null ? undefined : `Started ${started.toLocaleString()}`}
					>
						<span className="cap">v{status.version}</span>
					</Row>
				)}
				<Row label="Log level" cap="How much goblin writes to its log. Debug is noisy." col>
					<Seg
						options={["debug", "info", "warn", "error"]}
						value={draft.logLevel}
						ariaLabel="Log level"
						onChange={(v) => patchDraft({ logLevel: v as typeof draft.logLevel })}
					/>
				</Row>
				{draft.publicUrl.trim() !== "" && (
					<Row label="Public url">
						<span className="cap mono">{draft.publicUrl}</span>
					</Row>
				)}
				<Row label="Http port">
					<span className="cap mono">{draft.port}</span>
				</Row>
				{draft.apiRoot.trim() !== "" && (
					<Row label="Bot api root">
						<span className="cap mono">{draft.apiRoot}</span>
					</Row>
				)}
				<Row label="App access">
					<span className="cap">
						{ctx.hasAppToken ? "Bearer token required" : "Trust mode — tailnet only"}
					</span>
				</Row>
				<div className="cap ops-cap">Advanced: edit goblin.json5 in goblin's home.</div>
			</div>
		</>
	);
}
