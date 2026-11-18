// The computer agent type's desktop tools (design/agents.md → Computer
// use): inspect/act/launch/screenshot, goblin tools in zod ported from
// the Pi Durable computer extension (subagents/tools.ts). The child is
// bound to one desktop: spawn claimed it and stored it on the child
// row; every call re-claims with the child conversation as lease holder
// (the old withLeaseRenew), and agent-children.ts releases the lease at
// settlement. ask_operator lives in ask-operator.ts — it is not
// desktop-bound.

import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Desktops } from "../../desktops.ts";
import type { LeaseHolder } from "../../desktops-store.ts";
import { CUA_TOOLS, type CuaTool } from "../../desktops-cua.ts";
import { BoundaryError } from "../../boundary-error.ts";
import { DesktopLeaseError } from "../../desktops.ts";
import { log } from "../../log.ts";
import { defineTool, type Tool, type ToolOutput, type Tools } from "../../tool.ts";

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

// screenshot takes no arguments — the frame is always the whole desktop.
const screenshotSchema = z.object({});

// The stored output is this JSON descriptor string — small enough to
// ride history forever, and it carries the durable PNG path plus the
// observation id act/launch cite. toModelOutput rehydrates the frame
// from the path at view time, so image bytes exist only in the
// transient model-facing output, never in stored events. The pruning
// sweep (cache-pruning.ts) swaps old descriptors for text stubs.
const frameDescriptorSchema = z.object({
	v: z.literal(1),
	observation_id: z.string().min(1),
	path: z.string().min(1),
	bytes: z.number().int().nonnegative(),
	note: z.string().optional(),
});
type FrameDescriptor = z.infer<typeof frameDescriptorSchema>;

export interface ComputerToolDeps {
	/** The child conversation id — the desktop lease holder. */
	conversation: string;
	/** The desktop the child is bound to (agent_children.desktop). */
	desktop: string;
	desktops: Desktops;
	/** Mount screenshot — set only when the child's model accepts image
	 *  input AND its provider pipe carries image tool results
	 *  (turn-tools.ts gates on both; absent means the tool does not
	 *  exist for this child, it does not error). */
	screenshots?: boolean;
}

const holderOf = (conversation: string): LeaseHolder => ({
	kind: "conversation",
	id: conversation,
});

const TOOL_DESCRIPTIONS = {
	inspect:
		"Inspect your desktop's accessibility state and mint a new observation_id. Optional pid and window_id select a surface. Use the returned element tokens with the newest observation_id; earlier tokens and observations may be stale. Text only — no screenshot.",
	inspectWithFrames:
		"Inspect your desktop's accessibility state and mint a new observation_id. Optional pid and window_id select a surface. Use the returned element tokens with the newest observation_id; earlier tokens and observations may be stale. Text only — use screenshot when you need to see the frame.",
	act: 'Send one allowed cua-driver input operation to your desktop, citing the newest unused observation_id. args is the driver\'s JSON argument object. For a full-desktop click, args {scope:"desktop",x,y,button:"left"}; x/y without scope default to window-local coordinates and require a window target. For accessibility clicks, use args {pid,element_token} from the newest inspect. press_key uses {scope:"desktop",key} for the focused application (key names include enter, tab, escape, left, right); hotkey uses {scope:"desktop",keys:["ctrl","p"]}; type_text uses {scope:"desktop",text}. A dispatch failure may have partially acted and consumes the observation anyway; never blindly retry. effect is the driver\'s claim, not independent verification.',
	launch:
		"Launch Chromium on your desktop, consuming the newest unused observation_id. Optional url must be http://, https://, file://, or exactly about:blank. No command-line flags or other apps are accepted.",
	screenshot:
		"Capture the whole desktop as a PNG you can see, minting a new observation_id for act/launch. The image is the current frame — prefer it over inspect when layout or visuals matter. Each screenshot supersedes earlier frames; call it again for a fresh view.",
} as const;

// Claim-then-act (the old withLeaseRenew): the child holds its desktop
// for the call — covering a needs-input release or an expired lease —
// so the observation binding stays exclusive to it. Boundary errors
// become typed {error} results; programming failures still propagate.
async function withDesktop<T>(
	deps: ComputerToolDeps,
	fn: () => Promise<T>,
): Promise<T | { error: string }> {
	try {
		await deps.desktops.claim(deps.desktop, holderOf(deps.conversation));
		return await fn();
	} catch (err) {
		if (err instanceof DesktopLeaseError) return { error: err.message };
		if (err instanceof BoundaryError) {
			return { error: `${err.kind} ${err.boundary} error${err.kind === "transient" ? " (retry may succeed)" : ""}: ${err.message}` };
		}
		throw err;
	}
}

function inspectTool(deps: ComputerToolDeps): Tool {
	return defineTool({
		description: deps.screenshots === true ? TOOL_DESCRIPTIONS.inspectWithFrames : TOOL_DESCRIPTIONS.inspect,
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

function screenshotTool(deps: ComputerToolDeps): Tool {
	return defineTool({
		description: TOOL_DESCRIPTIONS.screenshot,
		input: screenshotSchema,
		execute: async () => {
			const out = await withDesktop(deps, () => deps.desktops.screenshot(deps.desktop));
			if ("error" in out) return out;
			// The durable record is this descriptor string — the PNG
			// itself already lives at `path` (desktops.screenshot wrote
			// it); only metadata rides history.
			return JSON.stringify({
				v: 1,
				observation_id: out.id,
				path: out.path,
				bytes: out.bytes.byteLength,
				...(out.note !== undefined ? { note: out.note } : {}),
			} satisfies FrameDescriptor);
		},
		toModelOutput: async ({ output }): Promise<ToolOutput> => {
			// output is the stored execute() result: the descriptor
			// string, an {error} object, or — after the pruning sweep —
			// the text stub marker. Anything that is not a descriptor
			// passes through as text so the model still sees what
			// happened (and never a stale frame).
			const parsed =
				typeof output === "string" ? frameDescriptorSchema.safeParse(safeJson(output)) : null;
			if (parsed === null || !parsed.success) {
				return {
					type: "text",
					value: typeof output === "string" ? output : JSON.stringify(output),
				};
			}
			const frame: FrameDescriptor = parsed.data;
			// A frame that is gone or not a whole PNG becomes text, never an
			// image part: the provider rejects a bad image before any tool
			// runs, so the child could never take the frame that replaces it.
			const unavailable = (why: string): ToolOutput => ({
				type: "text",
				value:
					`screenshot frame unavailable — the PNG at ${frame.path} ${why}. ` +
					`Call screenshot for a fresh frame. observation_id ${frame.observation_id} may be stale.`,
			});
			let data: Uint8Array;
			try {
				data = new Uint8Array(await readFile(frame.path));
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
					log.warn("screenshot frame unreadable", err, { path: frame.path });
				}
				return unavailable("could not be read");
			}
			if (data.byteLength !== frame.bytes || !isWholePng(data)) {
				log.warn("screenshot frame corrupt", undefined, {
					path: frame.path,
					bytes: data.byteLength,
					expected: frame.bytes,
				});
				return unavailable("is not a complete PNG");
			}
			return {
				type: "content",
				value: [
					{
						type: "text",
						text:
							`screenshot observation_id: ${frame.observation_id}\n` +
							`png: ${frame.path} (${frame.bytes} bytes)\n` +
							`Cite observation_id with act or launch.`,
					},
					{ type: "image", mediaType: "image/png", data },
				],
			};
		},
	});
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
// The IEND chunk: zero length, type "IEND", fixed CRC.
const PNG_IEND = [0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130];

function isWholePng(data: Uint8Array): boolean {
	if (data.byteLength < PNG_SIGNATURE.length + PNG_IEND.length) return false;
	const tail = data.byteLength - PNG_IEND.length;
	return (
		PNG_SIGNATURE.every((b, i) => data[i] === b) && PNG_IEND.every((b, i) => data[tail + i] === b)
	);
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/** The names a child conversation can carry that no parent turn ever
 * mounts — the agent tool's spawn allowlist admits them by name
 * (agent.ts childToolAllowlist). ask_operator is always mountable;
 * the desktop tools only while the pool exists. screenshot joins the
 * allowlist unconditionally: the capability gate decides whether the
 * tool itself mounts for a given child model+provider. */
export function agentChildToolNames(desktopsAvailable: boolean): string[] {
	return desktopsAvailable
		? ["inspect", "act", "launch", "screenshot", "ask_operator"]
		: ["ask_operator"];
}

export function computerTools(deps: ComputerToolDeps): Tools {
	return {
		inspect: inspectTool(deps),
		act: actTool(deps),
		launch: launchTool(deps),
		...(deps.screenshots === true ? { screenshot: screenshotTool(deps) } : {}),
	};
}
