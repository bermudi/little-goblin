import type { AppPageKey } from "../../src/http/app-routes.ts";
import type { OperatorStatusResponse } from "../../src/http/operator-wire.ts";
import { getServiceStatus } from "./api.ts";
import { KV, ts, uptime, useLoad } from "./opsShared.tsx";

export type PartTone = "ok" | "warn" | "bad" | "none";

export interface StatusPart {
	name: string;
	tone: PartTone;
	pill: string;
	// One plain line: what is wrong and what to do, or what is true.
	line: string;
	page: AppPageKey | null;
}

export type Verdict = { tone: "ok" | "warn" | "bad"; title: string };

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

// Only parts the status API reports get a health word. Counts alone are not
// health, so programs and delegations say "no signal" instead of guessing.
export function statusParts(s: OperatorStatusResponse): StatusPart[] {
	const m = s.memory;
	let memory: StatusPart;
	if (m.state === "disabled")
		memory = { name: "Memory", tone: "none", pill: "off", line: m.detail, page: "memory" };
	else if (m.state === "degraded")
		memory = {
			name: "Memory",
			tone: m.lastRecallOk === false ? "bad" : "warn",
			pill: m.lastRecallOk === false ? "failing" : "needs review",
			line: `${m.detail}. Open Memory to retry or dismiss.`,
			page: "memory",
		};
	else if (m.state === "pending")
		memory = { name: "Memory", tone: "ok", pill: "ok", line: m.detail, page: "memory" };
	else
		memory = {
			name: "Memory",
			tone: "ok",
			pill: "ok",
			line: `${m.completed} saved, last recall ${ts(m.lastRecallAt)}.`,
			page: "memory",
		};
	const restart: StatusPart =
		s.restartHints.length > 0
			? {
					name: "Service",
					tone: "warn",
					pill: "restart needed",
					line: `Changes wait for a restart: ${s.restartHints.join(", ")}.`,
					page: "settings",
				}
			: {
					name: "Service",
					tone: "ok",
					pill: "running",
					line: `Up ${uptime(s.uptimeSec)}, version ${s.version}.`,
					page: null,
				};
	const programs: StatusPart = {
		name: "Programs",
		tone: "none",
		pill: "no signal",
		line:
			s.programs === null
				? "Not reported."
				: `${s.programs.enabled} of ${s.programs.total} enabled. Late runs show on the Programs page.`,
		page: "programs",
	};
	const delegations: StatusPart = {
		name: "Delegations",
		tone: "none",
		pill: "no signal",
		line:
			s.delegations === null
				? "Not reported."
				: `${s.delegations.active} active of ${s.delegations.total}. Failures show on the Delegations page.`,
		page: "delegations",
	};
	return [restart, memory, programs, delegations];
}

export function statusVerdict(parts: StatusPart[]): Verdict {
	if (parts.some((p) => p.tone === "bad")) return { tone: "bad", title: "Something is broken" };
	const warn = parts.filter((p) => p.tone === "warn").length;
	if (warn > 0)
		return {
			tone: "warn",
			title: `${warn} ${plural(warn, "thing needs", "things need")} attention`,
		};
	return { tone: "ok", title: "Goblin is OK" };
}

export function StatusView({
	token,
	onPage,
}: {
	token: string | null;
	onPage(page: AppPageKey): void;
}) {
	const { data, err } = useLoad(() => getServiceStatus(token));
	if (err !== null)
		return (
			<div className="ops">
				<div className="status-verdict bad">
					<b>Something is broken</b>
					<span>Goblin did not answer the status request.</span>
				</div>
				<p className="error">{err}</p>
			</div>
		);
	if (data === null)
		return (
			<div className="ops">
				<p className="empty">Loading…</p>
			</div>
		);
	const s = data;
	const parts = statusParts(s);
	const verdict = statusVerdict(parts);
	const m = s.memory;
	return (
		<div className="ops status-page">
			<div className={`status-verdict ${verdict.tone}`} role="status">
				<b>{verdict.title}</b>
				<span>
					{verdict.tone === "ok"
						? "Every part that reports its health is fine."
						: "Details are in the parts below."}
				</span>
			</div>
			<div className="sumstrip status-strip">
				{parts.map((p) => (
					<div className={`sumtile status-part ${p.tone}`} key={p.name}>
						<div className="status-part-head">
							<span className="status-part-name">{p.name}</span>
							<span className={`pill status-pill ${p.tone}`}>{p.pill}</span>
						</div>
						<span className="status-part-line">{p.line}</span>
						{p.page !== null && (
							<button type="button" className="status-part-go" onClick={() => onPage(p.page!)}>
								Open {p.name === "Service" ? "Settings" : p.name}
							</button>
						)}
					</div>
				))}
			</div>
			<p className="cap status-note">
				Model providers, Telegram, keys and the herdr host are not reported here. Run{" "}
				<code>bun run doctor</code> for those.
			</p>
			<details className="status-raw">
				<summary>Raw details</summary>
				<div className="card">
					<KV k="version" v={s.version} mono />
					<KV k="started" v={ts(s.startedAt)} />
					<KV k="uptime" v={uptime(s.uptimeSec)} />
					<KV k="memory state" v={`${m.state} — ${m.detail}`} />
					<KV
						k="memory queue"
						v={`${m.completed} completed · ${m.queued} queued · ${m.blocked} blocked · ${m.dismissed} dismissed`}
					/>
					<KV k="last recall" v={ts(m.lastRecallAt)} />
					<KV
						k="programs"
						v={
							s.programs === null
								? "—"
								: `${s.programs.total} total · ${s.programs.enabled} enabled`
						}
					/>
					<KV
						k="delegations"
						v={
							s.delegations === null
								? "—"
								: `${s.delegations.total} total · ${s.delegations.active} active`
						}
					/>
				</div>
			</details>
		</div>
	);
}
