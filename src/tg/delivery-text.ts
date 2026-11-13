// Text-shaping helpers and module state the delivery sink shares across
// instances: chunk/rich size math, forced/fallback tail lines, the DM
// discriminant for rich rendering, and the process-wide draft-id minter and
// message-effect gate. Nothing here touches the sink's closure scope —
// makeDeliverySink (delivery.ts) imports what it needs.

import { fallbackNotice } from "../agent/model-fallback.ts";
import { parseAddress } from "../conversation-address.ts";
import type { TurnDone } from "../turn/sink.ts";

export const CHUNK_LIMIT = 3800;
export const RICH_LIMIT = 32_000;
export const REASONING_BLOCK_OVERHEAD =
	"<details><summary>Thinking</summary>\n<pre></pre>\n</details>\n\n".length + 1;

// Draft ids must be non-zero; updates under one id animate.
let draftId = 1;

export function nextDraftId(): number {
	return draftId++;
}

export const SALUTE_EFFECT_ID = "4913930782671635058";
let effectsUsable = true;

export function resetMessageEffectsGateForTests(): void {
	effectsUsable = true;
}

export function messageEffectsUsable(): boolean {
	return effectsUsable;
}

// A premium-gated effect rejection drops effects for the rest of the process.
export function disableMessageEffects(): void {
	effectsUsable = false;
}

function forcedLine(done: TurnDone): string | null {
	if (done.kind !== "completed" || done.forced === undefined) return null;
	switch (done.forced) {
		case "repeat":
			return "⚠ loop detector — answer forced";
		case "watchdog":
			return "⚠ loop watchdog — answer forced";
		case "context":
			return "⚠ context nearly full — answer forced";
	}
}

// The status tail a completed reply carries: a forced landing, and a
// fallback that served (design/model.md → Model fallback list).
export function forcedNotice(done: TurnDone): string | null {
	const lines = [
		forcedLine(done),
		done.kind === "completed" && done.fallback !== undefined ? fallbackNotice(done.fallback) : null,
	].filter((l): l is string => l !== null);
	return lines.length > 0 ? lines.join("\n") : null;
}

// A split surrogate pair is a lone surrogate Telegram may reject or mangle.
const isHighSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff;

export function windowEnd(body: string, start: number): number {
	const end = start + CHUNK_LIMIT;
	if (
		end < body.length &&
		isHighSurrogate(body.charCodeAt(end - 1)) &&
		isLowSurrogate(body.charCodeAt(end))
	) {
		return end - 1;
	}
	return end;
}

// Rich rendering and the salute effect are DM-only in v1 (design/telegram.md
// → Formatted replies & draft streaming: "DMs only"). The `dm:` id prefix is
// not the DM discriminant — a topic-less group's standing lane is addressed
// `dm:<chatId>` too, with a negative chat id (mod.ts conversationAddress).
// Parse the address and require a private chat: kind dm/rolling, chatId > 0.
export function isPrivateDmAddress(id: string): boolean {
	const parsed = parseAddress(id);
	if (parsed === null) return false;
	if (parsed.kind !== "dm" && parsed.kind !== "rolling") return false;
	return parsed.chatId > 0;
}
