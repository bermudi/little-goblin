// Turn-snapshot evidence for the skill reviewer — the runtime's side.
// The turn modules build these digests during the turn (the stream is
// gone once it ends) and the reviewer's gate and review read them.
// Leaf module, no imports: both sides depend on it, so it may not
// depend on reviewer internals (import-cycles rules count type edges).

// ---------- turn snapshot (the runtime's side) ----------

// What the gate and the review see of one tool call: name, bounded
// arguments, bounded result, and whether it succeeded. Built by the
// runtime during the turn (the stream is gone once it ends), ring-capped
// to the last `evidence.calls` calls — lossy by design, cheap by design.
export interface ToolCallDigest {
	tool: string;
	args: string;
	result: string;
	ok: boolean;
}

// One built-in tool as the review knows it — name plus the turn-time
// description. The reviewer's "already covered" check (ruling
// 2026-10-17): a procedure a built-in tool performs is not a skill.
export interface ToolInventoryItem {
	name: string;
	description: string;
}

export interface CompletedTurn {
	conversationId: string;
	// Monotonic completion counter — the queue's serialization order.
	turnSeq: number;
	operatorTexts: string[];
	replyText: string;
	toolNames: string[];
	toolDigest: ToolCallDigest[];
	toolInventory: ToolInventoryItem[];
}

// Attached when the gate fires on a correction: what the operator is
// correcting is usually the turn before, and the reviewer needs to see
// the wrong answer to distill the right one.
export interface PriorTurnContext {
	operatorTexts: string[];
	replyText: string;
	toolDigest: ToolCallDigest[];
}

export interface EvidenceLimits {
	calls: number;
	argChars: number;
	outChars: number;
}

// ---------- digest capture helpers (runtime side) ----------

// Stringify + truncate a tool call's input/result for the digest. Never
// throws: an unserializable value degrades to its String() form.
export function summarize(value: unknown, limit: number): string {
	let text: string;
	try {
		text = typeof value === "string" ? value : JSON.stringify(value);
	} catch {
		text = String(value);
	}
	if (text === undefined) text = "undefined";
	return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

// ok/fail for a tool result across the tool set's shapes: an error
// field means refused/failed, an exit-code field means the process's
// verdict, anything else ran to completion.
export function toolOk(output: unknown): boolean {
	if (typeof output !== "object" || output === null) return true;
	const o = output as Record<string, unknown>;
	if ("error" in o && o.error) return false;
	if (typeof o.exit_code === "number") return o.exit_code === 0;
	if (typeof o.exitCode === "number") return o.exitCode === 0;
	return true;
}
