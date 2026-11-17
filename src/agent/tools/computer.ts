// The computer agent type's desktop tools (design/agents.md → Computer
// use): inspect/act/launch, goblin tools in zod ported from the Pi
// Durable computer extension (subagents/tools.ts) — text only, no
// screenshots (#606). The child is bound to one desktop: spawn claimed
// it and stored it on the child row; every call re-claims with the
// child conversation as lease holder (the old withLeaseRenew), and
// agent-children.ts releases the lease at settlement. ask_operator
// lives in ask-operator.ts — it is not desktop-bound.

import { z } from "zod";
import { DesktopError, type Desktops } from "../../desktops.ts";
import type { LeaseHolder } from "../../desktops-store.ts";
import { CUA_TOOLS, type CuaTool } from "../../desktops-cua.ts";
import { PodmanError } from "../../podman.ts";
import { defineTool, type Tool, type Tools } from "../../tool.ts";

// Same cap the Pi Durable inspect applied to the state JSON.
const INSPECT_STATE_CAP = 200_000;

const inspectSchema = z.object({
	pid: z.number().int().optional(),
	window_id: z.number().int().optional(),
});

const actSchema = z.object({
	observation_id: z.string().min(1),
	tool: z.string().min(1),
	args: z.record(z.string(), z.unknown()),
});

const launchSchema = z.object({
	observation_id: z.string().min(1),
	url: z.string().min(1).optional(),
});

export interface ComputerToolDeps {
	/** The child conversation id — the desktop lease holder. */
	conversation: string;
	/** The desktop the child is bound to (agent_children.desktop). */
	desktop: string;
	desktops: Desktops;
}

const holderOf = (conversation: string): LeaseHolder => ({
	kind: "conversation",
	id: conversation,
});

const TOOL_DESCRIPTIONS = {
	inspect:
		"Inspect your desktop's accessibility state and mint a new observation_id. Optional pid and window_id select a surface. Use the returned element tokens with the newest observation_id; earlier tokens and observations may be stale. Text only — no screenshot.",
	act: 'Send one allowed cua-driver input operation to your desktop, citing the newest unused observation_id. args is the driver\'s JSON argument object. For a full-desktop click, args {scope:"desktop",x,y,button:"left"}; x/y without scope default to window-local coordinates and require a window target. For accessibility clicks, use args {pid,element_token} from the newest inspect. press_key uses {scope:"desktop",key} for the focused application (key names include enter, tab, escape, left, right); hotkey uses {scope:"desktop",keys:["ctrl","p"]}; type_text uses {scope:"desktop",text}. A dispatch failure may have partially acted and consumes the observation anyway; never blindly retry. effect is the driver\'s claim, not independent verification.',
	launch:
		"Launch Chromium on your desktop, consuming the newest unused observation_id. Optional url must be http://, https://, file://, or exactly about:blank. No command-line flags or other apps are accepted.",
} as const;

// Claim-then-act (the old withLeaseRenew): the child holds its desktop
// for the call — covering a needs-input release or an expired lease —
// so the observation binding stays exclusive to it. DesktopError and
// PodmanError are model/operator-actionable — they become {error}
// results like every other goblin tool; anything else propagates.
async function withDesktop<T>(
	deps: ComputerToolDeps,
	fn: () => Promise<T>,
): Promise<T | { error: string }> {
	try {
		await deps.desktops.claim(deps.desktop, holderOf(deps.conversation));
		return await fn();
	} catch (err) {
		if (err instanceof DesktopError || err instanceof PodmanError) {
			return { error: err.message };
		}
		throw err;
	}
}

function inspectTool(deps: ComputerToolDeps): Tool {
	return defineTool({
		description: TOOL_DESCRIPTIONS.inspect,
		input: inspectSchema,
		execute: async (input) => {
			const out = await withDesktop(deps, () =>
				deps.desktops.inspect(deps.desktop, {
					...(input.pid !== undefined ? { pid: input.pid } : {}),
					...(input.window_id !== undefined ? { windowId: input.window_id } : {}),
				}),
			);
			if ("error" in out) return out;
			const raw: unknown = out.state;
			const stateObj: Record<string, unknown> =
				typeof raw === "object" && raw !== null
					? { ...(raw as Record<string, unknown>) }
					: { state: raw };
			// Text only (#606): the frame never leaves the box — drop the
			// screenshot fields entirely rather than sending them.
			delete stateObj["screenshot_png_b64"];
			delete stateObj["screenshot"];
			const text = JSON.stringify(stateObj);
			return {
				observation_id: out.id,
				state:
					text.length > INSPECT_STATE_CAP
						? `${text.slice(0, INSPECT_STATE_CAP)}\n[state truncated at ${INSPECT_STATE_CAP} chars]`
						: text,
				...(out.note !== undefined ? { note: out.note } : {}),
			};
		},
	});
}

function actTool(deps: ComputerToolDeps): Tool {
	return defineTool({
		description: TOOL_DESCRIPTIONS.act,
		input: actSchema,
		execute: async (input) => {
			if (!CUA_TOOLS.has(input.tool)) {
				return {
					error: `act tool ${JSON.stringify(input.tool)} is not an allowed input operation`,
				};
			}
			const out = await withDesktop(deps, () =>
				deps.desktops.act(deps.desktop, holderOf(deps.conversation), input.observation_id, {
					kind: "cua",
					tool: input.tool as CuaTool,
					args: input.args,
				}),
			);
			if ("error" in out) return out;
			return {
				result: out.result,
				...(out.note !== undefined ? { note: out.note } : {}),
			};
		},
	});
}

function launchTool(deps: ComputerToolDeps): Tool {
	return defineTool({
		description: TOOL_DESCRIPTIONS.launch,
		input: launchSchema,
		execute: async (input) => {
			const out = await withDesktop(deps, () =>
				deps.desktops.act(deps.desktop, holderOf(deps.conversation), input.observation_id, {
					kind: "launch",
					app: "chromium",
					...(input.url !== undefined ? { url: input.url } : {}),
				}),
			);
			if ("error" in out) return out;
			return {
				result: out.result,
				...(out.note !== undefined ? { note: out.note } : {}),
			};
		},
	});
}

/** The names a child conversation can carry that no parent turn ever
 * mounts — the agent tool's spawn allowlist admits them by name
 * (agent.ts childToolAllowlist). ask_operator is always mountable;
 * the desktop tools only while the pool exists. */
export function agentChildToolNames(desktopsAvailable: boolean): string[] {
	return desktopsAvailable
		? ["inspect", "act", "launch", "ask_operator"]
		: ["ask_operator"];
}

export function computerTools(deps: ComputerToolDeps): Tools {
	return {
		inspect: inspectTool(deps),
		act: actTool(deps),
		launch: launchTool(deps),
	};
}
