import { Buffer } from "node:buffer";
import type { Context } from "@earendil-works/chord";
import { type MutableModels, Type } from "@earendil-works/pi-ai";
import {
	createRegistry,
	defineExtension,
	defineTool,
	type Extension,
	GenerationTask,
	Harness,
	type HookApi,
	hook,
	type ToolExecutionApi,
	type ToolExecutionResult,
	type ToolRegistration,
	ToolTask,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-durable/tools";
import { z } from "zod";
import {
	CUA_TOOLS,
	type CuaTool,
	DesktopLeaseError,
	type Desktops,
	type LeaseHolder,
} from "../desktops.ts";
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
	type SubagentKind,
	type SubagentRun,
	type SubagentRuns,
} from "../subagent-runs.ts";
import type { SandboxEnv } from "./env.ts";
import { SubagentError } from "./errors.ts";
import type { KindSpec } from "./models.ts";
import { RunDoc, type RunOutcome, type RunOutcomeBody } from "./run-doc.ts";

const INSPECT_STATE_CAP = 200_000;

export interface HarnessDeps {
	deps: {
		desktops: Desktops;
		storagePath: string;
		harnessSettings?: Record<string, unknown>;
	};
	runs: SubagentRuns;
	specs: Map<SubagentKind, KindSpec>;
	models: MutableModels;
	ctx: Context;
	holderFor(runId: number): LeaseHolder;
	rowForConversation(piConversationId: string): SubagentRun | null;
	requireRow(api: ToolExecutionApi): SubagentRun;
	requireLive(row: SubagentRun): void;
	recordOutcome(api: ToolExecutionApi, outcome: RunOutcomeBody): Promise<void>;
	envFor(origin: string): SandboxEnv;
	persistClaimNote(rowId: number, note: string | undefined): void;
	recoveryNudge(rowId: number, inputRev: number, context: Context): Promise<void>;
	withApprovalGate<T extends ToolRegistration>(tool: T): T;
}

export interface HarnessBundle {
	harness: Harness;
	workerExtension: Extension;
	computerExtension: Extension;
}

export async function buildHarness(args: HarnessDeps): Promise<HarnessBundle> {
	const {
		deps,
		runs,
		specs,
		models,
		ctx,
		holderFor,
		rowForConversation,
		requireRow,
		requireLive,
		recordOutcome,
		envFor,
		persistClaimNote,
		recoveryNudge,
		withApprovalGate,
	} = args;

	// pi-durable's `terminate` ends the round only when every bundled call
	// terminates — this returns it without running once a terminal outcome is
	// committed, so a blocked sibling can't keep the round alive.
	function withTerminalWrap<T extends ToolRegistration>(tool: T): T {
		const inner = tool.execute;
		return {
			...tool,
			execute: async (args: never, api: ToolExecutionApi, context: Context) => {
				const doc = await api.snapshot(RunDoc, api.conversationId, context);
				if (doc?.outcome !== undefined && doc?.outcome !== null) {
					return {
						control: { terminate: true },
						isError: true,
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

	function withLeaseRenew<T extends ToolRegistration>(tool: T): T {
		const inner = tool.execute;
		return {
			...tool,
			execute: async (args: never, api: ToolExecutionApi, context: Context) => {
				const row = requireRow(api);
				const claimed = await deps.desktops.claim(row.desktop!, holderFor(row.id));
				persistClaimNote(row.id, claimed.note);
				// The claim await is a cancellation window: stop intent
				// can persist while it pends, so re-gate on a fresh read.
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
		withLifecycleNote(withApprovalGate(withTerminalWrap(withRunGuards(createWriteTool())))),
		withLifecycleNote(withApprovalGate(withTerminalWrap(withRunGuards(createEditTool())))),
		withLifecycleNote(
			withApprovalGate(
				withTerminalWrap(
					withRunGuards({ ...createBashTool(), description: WORKER_BASH_DESCRIPTION }),
				),
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

	// abortTask joins the live invocation — never await it from inside
	// that invocation; the abort mark is what refuses, the join is async.
	function abortPiTask(api: HookApi): void {
		void harness
			.abortTask(api.taskId, ctx)
			.catch((err) => log.warn("subagent task abort failed", err));
	}

	const requestCheckpointSchema = z.object({
		phase: z.literal("request"),
		cutoff: z.number().int().positive(),
	});

	// inputRev is the input this request consumed, not the newest admitted
	// intent: the request checkpoint's cutoff bounds the search, and a
	// stale committed outcome is cleared so it can't mis-settle this rev.
	async function bindConsumedInput(
		api: HookApi,
		row: SubagentRun,
	): Promise<{ inputRev: number; outcome: RunOutcome | null }> {
		const fresh = runs.get(row.id);
		if (fresh === null) throw new SubagentError("run row vanished");
		return await harness.commit(async (tx) => {
			const task = await tx.task(api.taskId);
			if (
				task === undefined ||
				(task.state.status !== "pending" &&
					task.state.status !== "running" &&
					task.state.status !== "waiting")
			) {
				throw new SubagentError("generation task is not live — cannot bind its input");
			}
			const checkpoint = requestCheckpointSchema.parse(task.state.checkpoint);
			let consumed: number | null = null;
			for (let rev = fresh.inputRev; rev >= 1; rev--) {
				const sub = await tx.submissionByRequest(
					api.conversationId,
					`subagent:${row.id}:input:${rev}`,
				);
				if (
					sub !== undefined &&
					sub.type === "input" &&
					sub.entry !== undefined &&
					sub.entry <= checkpoint.cutoff
				) {
					consumed = rev;
					break;
				}
			}
			if (consumed === null) {
				throw new SubagentError(
					`no admitted input reached the request transcript (row rev ${fresh.inputRev}, cutoff ${checkpoint.cutoff})`,
				);
			}
			const d = await tx.doc(RunDoc, api.conversationId);
			d.inputRev = consumed;
			if (d.outcome !== null && d.outcome.rev !== consumed) d.outcome = null;
			return {
				inputRev: consumed,
				outcome: d.outcome === null ? null : { ...d.outcome },
			};
		}, ctx);
	}

	const requestGuard = hook(GenerationTask, {
		beforeRequest: async (_input, api, context) => {
			let row: SubagentRun | null;
			try {
				const doc = await api.snapshot(RunDoc, api.conversationId, context);
				row =
					doc?.runId !== null && doc !== undefined && doc !== null
						? runs.get(doc.runId)
						: rowForConversation(String(api.conversationId));
			} catch (err) {
				log.error("subagent request guard read failed — aborting", err, {
					conversation: String(api.conversationId),
					task: String(api.taskId),
				});
				abortPiTask(api);
				return undefined;
			}
			// No throw here — pi-durable merely reports a hook failure and
			// the request would proceed; every guard refuses through the
			// real abort mark instead.
			if (row === null) {
				log.warn("subagent request on an unknown row — aborting", {
					conversation: String(api.conversationId),
				});
				abortPiTask(api);
				return undefined;
			}
			let bound: { inputRev: number; outcome: RunOutcome | null };
			try {
				bound = await bindConsumedInput(api, row);
			} catch (err) {
				log.error("subagent request input binding failed", err, {
					run: row.id,
					task: String(api.taskId),
				});
				abortPiTask(api);
				return undefined;
			}
			if (bound.outcome !== null) {
				// A committed outcome means the round should already have
				// terminated — a sibling (a malformed slot can't terminate)
				// kept it alive; abort, the monitor classifies from the doc.
				log.warn("subagent generation continued past a committed outcome — aborting", {
					conversation: String(api.conversationId),
				});
				abortPiTask(api);
				return undefined;
			}
			if (row.status !== "running" || row.stopRequested) {
				abortPiTask(api);
				return undefined;
			}
			if (row.kind === "computer" && row.desktop !== null) {
				try {
					const claimed = await deps.desktops.claim(row.desktop, holderFor(row.id));
					persistClaimNote(row.id, claimed.note);
				} catch (err) {
					if (err instanceof DesktopLeaseError) {
						log.warn("subagent lost its desktop lease — aborting the request", err, {
							run: row.id,
							desktop: row.desktop,
						});
						abortPiTask(api);
						return undefined;
					}
					// Any other claim failure is transient podman work: the request
					// aborts and a fresh-rev nudge rides the bounded recovery —
					// replaying the task brief would inject a stale duplicate.
					log.warn(
						"subagent desktop claim failed — the request aborts; the run stays owned for recovery",
						err,
						{ run: row.id, desktop: row.desktop },
					);
					try {
						await recoveryNudge(row.id, bound.inputRev, context);
					} finally {
						abortPiTask(api);
					}
					return undefined;
				}
			}
			log.info("subagent model request", {
				run: row.id,
				kind: row.kind,
				model: specs.get(row.kind)?.modelId,
				conversation: row.conversationId,
				inputRev: bound.inputRev,
			});
			return undefined;
		},
		afterResponse: (message, api) => {
			const row = rowForConversation(String(api.conversationId));
			log.info("subagent model response", {
				run: row?.id ?? null,
				stopReason: message.stopReason,
				usage: message.usage,
			});
		},
	});

	const toolLog = hook(ToolTask, {
		beforeTool: async (call, api, context) => {
			await api.memo(`t0-${call.id}`, Date.now(), context);
			return undefined;
		},
		afterTool: async (call, result, api, context) => {
			const row = rowForConversation(String(api.conversationId));
			const t0 = await api.memo<number>(`t0-${call.id}`, context);
			log.info("subagent tool", {
				run: row?.id ?? null,
				kind: row?.kind ?? null,
				tool: call.name,
				callId: call.id,
				ok: result.isError !== true,
				ms: t0 === undefined ? null : Date.now() - t0,
			});
			return undefined;
		},
	});

	const workerExtension = defineExtension({
		name: "goblin-worker",
		tools: workerTools,
		hooks: [toolLog, requestGuard],
	});
	const computerExtension = defineExtension({
		name: "goblin-computer",
		tools: computerTools.map((t) => {
			if (t.name === "finish" || t.name === "ask_operator") return t;
			// Lifecycle-outermost so a claim note persisted mid-execute
			// still reaches this call's result.
			if (t.name === "act" || t.name === "launch") {
				return withLifecycleNote(
					withApprovalGate(withRunGuards(withLeaseRenew(withTerminalWrap(t)))),
				);
			}
			return withLifecycleNote(withRunGuards(withLeaseRenew(withTerminalWrap(t))));
		}),
		hooks: [toolLog, requestGuard],
	});

	const registry = createRegistry();
	registry.install(workerExtension);
	registry.install(computerExtension);

	const storage = await openNodeSqliteStorage(deps.storagePath);
	const harness = await Harness.open(
		storage,
		{
			models,
			registry,
			settings: {
				toolExecution: "sequential",
				...(deps.harnessSettings ?? {}),
			},
			env: (target) => {
				const row = rowForConversation(String(target.conversationId));
				if (row === null || row.kind !== "worker") return undefined;
				return envFor(row.conversationId);
			},
			// onReport is non-fatal (extension failures that did not fail
			// the calling operation) — the real close edge is mod.ts's
			// subscribeClose, never this hook.
			onReport: (error) => {
				log.error("subagent harness report", error);
			},
		},
		ctx,
	);

	return { harness, workerExtension, computerExtension };
}
