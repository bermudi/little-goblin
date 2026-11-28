import { z } from "zod";
import { BoundaryError } from "./boundary-error.ts";
import { boundedRun } from "./proc.ts";

const AB_TIMEOUT_MS = 30_000;
const AB_MAX_OUTPUT = 1 << 20;
const ERROR_CAP = 200;

const mcpCallSchema = z
	.object({
		structuredContent: z
			.object({
				response: z
					.object({
						success: z.boolean(),
						error: z.string().nullable().optional(),
						data: z.unknown().optional(),
					})
					.passthrough(),
			})
			.passthrough(),
	})
	.passthrough();

const evalDataSchema = z.object({ result: z.unknown() }).passthrough();

export interface AgentBrowser {
	pageUrl(session?: string): Promise<string>;
	fill(
		target: string,
		text: string,
		session?: string,
	): Promise<{ ok: true } | { ok: false; error: string }>;
}

function spawnAgentBrowser(args: string[], session: string | undefined, stdinJson?: string): Bun.ReadableSubprocess {
	const env = { ...process.env };
	if (session !== undefined) env.AGENT_BROWSER_SESSION = session;
	return Bun.spawn(["agent-browser", ...args], {
		env,
		stdin: stdinJson === undefined ? "ignore" : new TextEncoder().encode(stdinJson),
		stdout: "pipe",
		stderr: "pipe",
		detached: true,
	});
}

interface McpResponse {
	success: boolean;
	error: string | undefined;
	data: unknown;
	exitCode: number | null;
	stderr: string;
}

async function mcpCall(tool: string, argsJson: string, session?: string): Promise<McpResponse> {
	const proc = spawnAgentBrowser(["mcp", "call", tool, "-"], session, argsJson);
	const r = await boundedRun(proc, { timeoutMs: AB_TIMEOUT_MS, maxOutput: AB_MAX_OUTPUT });
	if (r.timedOut) {
		throw new BoundaryError("agent-browser", "transient", `agent-browser ${tool} timed out after ${AB_TIMEOUT_MS}ms`);
	}
	let parsed: z.infer<typeof mcpCallSchema>;
	try {
		parsed = mcpCallSchema.parse(JSON.parse(r.stdout));
	} catch (err) {
		throw new BoundaryError("agent-browser", "fatal", `agent-browser ${tool} returned an unexpected shape`, { cause: err });
	}
	const response = parsed.structuredContent.response;
	return {
		success: response.success,
		error: response.error ?? undefined,
		data: response.data,
		exitCode: r.exitCode,
		stderr: r.stderr,
	};
}

export function makeAgentBrowser(): AgentBrowser {
	return {
		async pageUrl(session?: string): Promise<string> {
			const r = await mcpCall("agent_browser_eval", JSON.stringify({ script: "location.href" }), session);
			if (!r.success) {
				throw new BoundaryError(
					"agent-browser",
					"fatal",
					`agent_browser_eval failed — ${(r.error ?? r.stderr.split("\n", 1)[0] ?? `exit ${r.exitCode ?? "unknown"}`).slice(0, ERROR_CAP)}`,
				);
			}
			const data = evalDataSchema.safeParse(r.data);
			if (!data.success || typeof data.data.result !== "string") {
				throw new BoundaryError("agent-browser", "fatal", "agent_browser_eval returned no page URL");
			}
			return data.data.result;
		},

		async fill(target: string, text: string, session?: string) {
			let r: McpResponse;
			try {
				r = await mcpCall("agent_browser_fill", JSON.stringify({ selector: target, text }), session);
			} catch (err) {
				return { ok: false as const, error: (err instanceof Error ? err.message : String(err)).slice(0, ERROR_CAP) };
			}
			if (r.success && r.exitCode === 0) return { ok: true as const };
			const detail = r.error ?? r.stderr.split("\n").find((line) => line.trim() !== "")?.trim() ?? `agent-browser exited ${r.exitCode ?? "unknown"}`;
			return { ok: false as const, error: detail.slice(0, ERROR_CAP) };
		},
	};
}
