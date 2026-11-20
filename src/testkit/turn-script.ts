import type { JSONObject } from "../message.ts";
import type { TurnEngine } from "../turn/engine.ts";
import type { TurnStep } from "../runtime.ts";

export type ScriptPart =
	| { type: "text"; text: string }
	| { type: "reasoning"; text: string }
	| { type: "tool-call"; toolName: string; input: JSONObject; toolCallId?: string };
export interface ScriptUsage { input: number; output: number; cacheRead?: number; cacheWrite?: number }
/** A provider failure in engine-neutral terms; each adapter renders its engine's native form. */
export interface ScriptError { message: string; status?: number }
/** How a successful call ends when not the implied default. */
export type ScriptFinish = "length" | "content-filter";
/** One model call. Unless `finish` says otherwise, it ends "tool-calls" when it has a tool-call part, else "stop". */
export type ScriptCall =
	| { kind: "reply"; parts: ScriptPart[]; usage?: ScriptUsage; finish?: ScriptFinish }
	/** Streams `parts`, calls `entered`, blocks until `gate` resolves, then finishes like "reply".
	 *  The hold is mid-step: a trailing text part is still open while it blocks. */
	| { kind: "hold"; parts: ScriptPart[]; gate: Promise<void>; entered?: () => void; usage?: ScriptUsage }
	/** Streams `parts`, then fails. Empty `parts` = failure before any content reaches the wire. */
	| { kind: "fail"; parts: ScriptPart[]; error: ScriptError };
export interface ScriptedModel {
	/** The engine id this adapter drives ("ai-sdk" | "claude-code"). */
	readonly engineId: string;
	/** A fresh step for `buildStep`, tagged for this adapter's engine. */
	step(): TurnStep;
	/** The engines to hand the Runtime. */
	readonly engines: readonly TurnEngine[];
	/** Queue model calls; consumed in order, across turns. Tools between calls run for real. */
	script(...calls: ScriptCall[]): void;
	/** Model calls made so far (ai-sdk); CLI queries started (claude-code, whose CLI owns the tool loop). */
	calls(): number;
	/** Serialized in order: ai-sdk full call options; claude-code each CLI query's prompt blocks. */
	requests(): string[];
}
