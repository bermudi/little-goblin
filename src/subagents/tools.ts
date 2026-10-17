import { Buffer } from "node:buffer";
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
	defineTool,
	type ToolExecutionApi,
	type ToolExecutionResult,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import {
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-durable/tools";
import { CUA_TOOLS, type CuaTool, type Desktops, type LeaseHolder } from "../desktops.ts";
import { log } from "../log.ts";
import {
	ASK_OPERATOR_TOOL_DESCRIPTION,
	COMPUTER_TOOL_DESCRIPTIONS,
	FINISH_TOOL_DESCRIPTION,
	SUBAGENT_PARAMETER_DESCRIPTIONS,
	WORKER_BASH_DESCRIPTION,
} from "../subagent-prompts.ts";
import {
	MAX_INPUT_FILES,
	MAX_MESSAGE_CHARS,
	MAX_RESULT_CHARS,
	type SubagentRun,
} from "../subagent-runs.ts";
import { SubagentError } from "./errors.ts";
import { RunDoc, type RunOutcomeBody } from "./run-doc.ts";

const INSPECT_STATE_CAP = 200_000;

interface ToolArgs {
	deps: { desktops: Desktops };
	rowForConversation(id: string): SubagentRun | null;
	requireRow(api: ToolExecutionApi): SubagentRun;
	requireLive(row: SubagentRun): void;
	recordOutcome(api: ToolExecutionApi, outcome: RunOutcomeBody): Promise<void>;
	holderFor(id: number): LeaseHolder;
	persistClaimNote(id: number, note: string | undefined): void;
}

export function buildTools(args: ToolArgs) {
	const {
		deps,
		rowForConversation,
		requireRow,
		requireLive,
		recordOutcome,
		holderFor,
		persistClaimNote,
	} = args;
	// ---------- tool wrappers ----------

	// Terminal-outcome wrap: once a terminal tool committed the doc,
	// every other tool in the bundled round returns terminate WITHOUT
	// running — `terminate` only ends the round when every call
	// terminates, so a blocked call would keep the round alive; this
	// satisfies it while keeping the side effect out.
	function withTerminalWrap<T extends ToolRegistration>(tool: T): T {
		const inner = tool.execute;
		return {
			...tool,
			execute: async (args: never, api: ToolExecutionApi, context: Context) => {
				const doc = await api.snapshot(RunDoc, api.conversationId, context);
				if (doc?.outcome !== undefined && doc?.outcome !== null) {
					return {
						control: { terminate: true },
						output: [
							{
								type: "text" as const,
								text: "this run already recorded a terminal outcome — the action was not performed",
							},
						],
					};
				}
				return inner(args, api, context);
			},
		} as T;
	}

	// Every worker tool result carries the latest destructive sandbox
	// lifecycle note as a diagnostic — recorded through api.diagnostic
	// in a finally so a timeout or nonzero/error path carries it too,
	// alongside whatever output the tool already streamed. Repeat
	// until replaced, never a clear-before-result gap.
	function withLifecycleNote<T extends ToolRegistration>(tool: T): T {
		const inner = tool.execute;
		return {
			...tool,
			execute: async (args: never, api: ToolExecutionApi, context: Context) => {
				try {
					return await inner(args, api, context);
				} finally {
					const note = rowForConversation(String(api.conversationId))?.lifecycleNote;
					if (note !== undefined && note !== null && note !== "") {
						try {
							api.diagnostic({ severity: "warn", message: note, code: "lifecycle" });
						} catch (err) {
							log.warn("lifecycle diagnostic could not be recorded", err);
						}
					}
				}
			},
		} as T;
	}

	// Every run-scoped tool passes the liveness gate first: the row
	// exists, the run is executing, no stop intent is persisted, and
	// the owner is open.
	function withRunGuards<T extends ToolRegistration>(tool: T): T {
		const inner = tool.execute;
		return {
			...tool,
			execute: async (args: never, api: ToolExecutionApi, context: Context) => {
				const row = requireRow(api);
				requireLive(row);
				return inner(args, api, context);
			},
		} as T;
	}

	// Computer tools also renew the desktop controller lease before
	// touching the box — observation and input alike; acting under
	// someone else's lease is impossible.
	function withLeaseRenew<T extends ToolRegistration>(tool: T): T {
		const inner = tool.execute;
		return {
			...tool,
			execute: async (args: never, api: ToolExecutionApi, context: Context) => {
				const row = requireRow(api);
				const claimed = await deps.desktops.claim(row.desktop!, holderFor(row.id));
				persistClaimNote(row.id, claimed.note);
				// The claim await is a cancellation window — stop intent can
				// persist while it pends, and the entry row is stale. Re-gate
				// on a fresh read immediately before dispatch.
				requireLive(requireRow(api));
				if (context.abortSignal?.aborted) {
					throw new SubagentError(
						`run #${row.id} was cancelled during lease acquisition — the action was not performed`,
					);
				}
				return inner(args, api, context);
			},
		} as T;
	}

	// ---------- tools ----------

	const finishParams = Type.Object({
		result: Type.String({
			description: SUBAGENT_PARAMETER_DESCRIPTIONS.result,
			minLength: 1,
			maxLength: MAX_RESULT_CHARS,
		}),
		files: Type.Optional(
			Type.Array(Type.String({ pattern: "^/" }), {
				description: SUBAGENT_PARAMETER_DESCRIPTIONS.files,
				maxItems: MAX_INPUT_FILES,
			}),
		),
	});
	const askParams = Type.Object({
		question: Type.String({
			description: SUBAGENT_PARAMETER_DESCRIPTIONS.question,
			minLength: 1,
			maxLength: MAX_MESSAGE_CHARS,
		}),
	});

	const finishTool = defineTool({
		name: "finish",
		description: FINISH_TOOL_DESCRIPTION,
		parameters: finishParams,
		replay: "safe",
		execute: async (args, api, context) => {
			requireLive(requireRow(api));
			const files = args.files ?? [];
			if (files.length > MAX_INPUT_FILES || files.some((f) => !f.startsWith("/"))) {
				throw new SubagentError(
					`finish files must be at most ${MAX_INPUT_FILES} absolute box paths`,
				);
			}
			await recordOutcome(api, { kind: "done", result: args.result, files });
			return {
				control: { terminate: true },
				output: [{ type: "text", text: "run finished" }],
			};
		},
	});
	const askTool = defineTool({
		name: "ask_operator",
		description: ASK_OPERATOR_TOOL_DESCRIPTION,
		parameters: askParams,
		replay: "safe",
		execute: async (args, api, context) => {
			requireLive(requireRow(api));
			await recordOutcome(api, { kind: "ask", question: args.question });
			return {
				control: { terminate: true },
				output: [{ type: "text", text: "question recorded — the run pauses until answered" }],
			};
		},
	});

	const workerTools: ToolRegistration[] = [
		withLifecycleNote(
			withTerminalWrap(withRunGuards({ ...createReadTool(), replay: "safe" as const })),
		),
		withLifecycleNote(withTerminalWrap(withRunGuards(createWriteTool()))),
		withLifecycleNote(withTerminalWrap(withRunGuards(createEditTool()))),
		withLifecycleNote(
			withTerminalWrap(
				withRunGuards({ ...createBashTool(), description: WORKER_BASH_DESCRIPTION }),
			),
		),
		finishTool,
		askTool,
	];

	const computerTools: ToolRegistration[] = [
		defineTool({
			name: "screenshot",
			description: COMPUTER_TOOL_DESCRIPTIONS.screenshot,
			parameters: Type.Object({}),
			replay: "safe",
			execute: async (_args, api) => {
				const row = requireRow(api);
				const shot = await deps.desktops.screenshot(row.desktop!);
				return {
					output: [
						{
							type: "text",
							text: `observation_id: ${shot.id}\naudited path: ${shot.path}${shot.note ? `\n${shot.note}` : ""}`,
						},
						{
							type: "image",
							data: Buffer.from(shot.bytes).toString("base64"),
							mimeType: "image/png",
						},
					],
				};
			},
		}),
		defineTool({
			name: "inspect",
			description: COMPUTER_TOOL_DESCRIPTIONS.inspect,
			parameters: Type.Object({
				pid: Type.Optional(Type.Number()),
				window_id: Type.Optional(Type.Number()),
			}),
			replay: "safe",
			execute: async (args, api) => {
				const row = requireRow(api);
				const ins = await deps.desktops.inspect(row.desktop!, {
					...(args.pid !== undefined ? { pid: args.pid } : {}),
					...(args.window_id !== undefined ? { windowId: args.window_id } : {}),
				});
				// The state may carry a base64 frame — it is image data,
				// not text: strip it from the JSON and emit it as an inline
				// image block so a dump can't crowd out the tree.
				const raw: unknown = ins.state;
				const stateObj: Record<string, unknown> =
					typeof raw === "object" && raw !== null
						? { ...(raw as Record<string, unknown>) }
						: { state: raw };
				let image: { type: "image"; data: string; mimeType: string } | null = null;
				const shot = stateObj["screenshot_png_b64"] ?? stateObj["screenshot"];
				if (typeof shot === "string" && shot.length > 0) {
					image = { type: "image", data: shot, mimeType: "image/png" };
				}
				delete stateObj["screenshot_png_b64"];
				delete stateObj["screenshot"];
				const state = stateObj;
				const text = JSON.stringify(state);
				const output: NonNullable<ToolExecutionResult["output"]> = [
					{
						type: "text",
						text:
							`observation_id: ${ins.id}${ins.note ? `\n${ins.note}` : ""}\n` +
							(text.length > INSPECT_STATE_CAP
								? `${text.slice(0, INSPECT_STATE_CAP)}\n[state truncated at ${INSPECT_STATE_CAP} chars]`
								: text),
					},
				];
				if (image !== null) output.push(image);
				return { output };
			},
		}),
		defineTool({
			name: "act",
			description: COMPUTER_TOOL_DESCRIPTIONS.act,
			parameters: Type.Object({
				observation_id: Type.String(),
				tool: Type.String({ description: SUBAGENT_PARAMETER_DESCRIPTIONS.cuaTool }),
				args: Type.Record(Type.String(), Type.Unknown()),
			}),
			execute: async (args, api) => {
				const row = requireRow(api);
				if (!CUA_TOOLS.has(args.tool)) {
					throw new SubagentError(
						`act tool ${JSON.stringify(args.tool)} is not an allowed input operation`,
					);
				}
				const holder = holderFor(row.id);
				const out = await deps.desktops.act(row.desktop!, holder, args.observation_id, {
					kind: "cua",
					tool: args.tool as CuaTool,
					args: args.args,
				});
				return {
					output: [
						{
							type: "text",
							text: JSON.stringify(out.result) + (out.note ? `\n${out.note}` : ""),
						},
					],
				};
			},
		}),
		defineTool({
			name: "launch",
			description: COMPUTER_TOOL_DESCRIPTIONS.launch,
			parameters: Type.Object({
				observation_id: Type.String(),
				url: Type.Optional(Type.String()),
			}),
			execute: async (args, api) => {
				const row = requireRow(api);
				const holder = holderFor(row.id);
				const out = await deps.desktops.act(row.desktop!, holder, args.observation_id, {
					kind: "launch",
					app: "chromium",
					...(args.url !== undefined ? { url: args.url } : {}),
				});
				return {
					output: [
						{ type: "text", text: JSON.stringify(out.result) + (out.note ? `\n${out.note}` : "") },
					],
				};
			},
		}),
		finishTool,
		askTool,
	];

	return {
		workerTools,
		computerTools,
		withLifecycleNote,
		withRunGuards,
		withLeaseRenew,
		withTerminalWrap,
	};
}
