import { z } from "zod";
import { policyOf } from "../agent/tool-policy.ts";
import { log } from "../log.ts";
import { summarize, toolOk, type EvidenceLimits, type ToolCallDigest } from "../reviewer-evidence.ts";
import { attributedSkills, type SkillWatch } from "./skill-attribution.ts";

const scriptOutputSchema = z.object({
	calls: z.array(
		z.object({
			tool: z.string(),
			args: z.string(),
			ok: z.boolean(),
			result: z.string(),
		}),
	),
});

export interface ToolEventState {
	callById: Map<string, { tool: string; input: unknown }>;
	toolCalls: string[];
	digestRing: { id: string; entry: ToolCallDigest }[];
}

export function openToolEvents(seed: {
	toolCalls: string[];
	digest: { id: string; entry: ToolCallDigest }[];
}): ToolEventState {
	return {
		callById: new Map(),
		toolCalls: [...seed.toolCalls],
		digestRing: [...seed.digest],
	};
}

export function noteToolInput(
	state: ToolEventState,
	deps: {
		convId: string;
		evidence: EvidenceLimits | undefined;
		noteJournal?(toolCallId: string, toolName: string, input: unknown): void;
	},
	toolCallId: string,
	toolName: string,
	input: unknown,
): void {
	state.callById.set(toolCallId, { tool: toolName, input });
	deps.noteJournal?.(toolCallId, toolName, input);
	state.toolCalls.push(toolName);
	if (deps.evidence !== undefined) {
		state.digestRing.push({
			id: toolCallId,
			entry: {
				tool: toolName,
				args: summarize(input, deps.evidence.argChars),
				result: "(no result)",
				ok: true,
			},
		});
		if (state.digestRing.length > deps.evidence.calls) state.digestRing.shift();
	}
	log.info("tool call", {
		conversation: deps.convId,
		tool: toolName,
		arg: JSON.stringify(input).slice(0, 200),
	});
}

export function noteToolInputRejected(
	deps: Pick<ToolOutputDeps, "convId" | "onCompleted">,
	toolName: string,
	input: unknown,
	errorText: string,
): void {
	log.warn("tool call rejected", {
		conversation: deps.convId,
		tool: toolName,
		arg: JSON.stringify(input ?? null).slice(0, 200),
		error: errorText.slice(0, 300),
	});
	deps.onCompleted(toolName, input, errorText, true);
}

export interface ToolOutputDeps {
	convId: string;
	evidence: EvidenceLimits | undefined;
	skillWatch: SkillWatch | undefined;
	onCompleted(tool: string, input: unknown, result: unknown, failed: boolean): void;
}

export function noteToolOutput(
	state: ToolEventState,
	deps: ToolOutputDeps,
	toolCallId: string,
	output: unknown,
): void {
	const call = state.callById.get(toolCallId);
	if (deps.evidence !== undefined) {
		settleDigest(state.digestRing, deps.evidence, toolCallId, (ring) => {
			ring.result = summarize(output, deps.evidence!.outChars);
			ring.ok = toolOk(output);
		});
	}
	if (policyOf(call?.tool ?? "").composes) {
		const parsed = scriptOutputSchema.safeParse(output);
		if (parsed.success) {
			for (const [i, nested] of parsed.data.calls.entries()) {
				state.toolCalls.push(`script.${nested.tool}`);
				if (deps.evidence !== undefined) {
					state.digestRing.push({
						id: `${toolCallId}/${i + 1}`,
						entry: {
							tool: `script.${nested.tool}`,
							args: summarize(nested.args, deps.evidence.argChars),
							result: summarize(nested.result, deps.evidence.outChars),
							ok: nested.ok,
						},
					});
					if (state.digestRing.length > deps.evidence.calls) state.digestRing.shift();
				}
			}
		} else {
			log.warn("script call record unreadable — nested calls not expanded", {
				conversation: deps.convId,
				toolCallId,
			});
		}
	}
	if (deps.skillWatch !== undefined) {
		const tool = call?.tool ?? "";
		if (policyOf(tool).writesFiles) {
			for (const skill of attributedSkills(deps.skillWatch, tool, output)) {
				try {
					deps.skillWatch.record(deps.convId, skill);
					log.info("skill write attributed", { conversation: deps.convId, tool, skill });
				} catch (err) {
					log.error("skill provenance record failed — turn continues", err, {
						conversation: deps.convId,
						tool,
						skill,
					});
				}
			}
		}
	}
	deps.onCompleted(call?.tool ?? toolCallId, call?.input, output, false);
}

export function noteToolError(
	state: ToolEventState,
	deps: ToolOutputDeps,
	toolCallId: string,
	errorText: string,
): void {
	const call = state.callById.get(toolCallId);
	log.warn("tool execute failed", {
		conversation: deps.convId,
		tool: call?.tool ?? toolCallId,
		error: errorText.slice(0, 300),
	});
	if (deps.evidence !== undefined) {
		settleDigest(state.digestRing, deps.evidence, toolCallId, (ring) => {
			ring.result = summarize(errorText, deps.evidence!.outChars);
			ring.ok = false;
		});
	}
	deps.onCompleted(call?.tool ?? toolCallId, call?.input, errorText, true);
}

function settleDigest(
	ring: { id: string; entry: ToolCallDigest }[],
	evidence: EvidenceLimits,
	toolCallId: string,
	apply: (entry: ToolCallDigest) => void,
): void {
	for (let i = ring.length - 1; i >= 0; i--) {
		if (ring[i]!.id !== toolCallId) continue;
		apply(ring[i]!.entry);
		break;
	}
}
