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

export interface FenceState {
	// The full fence run ("```" or "~~~~"), so a reopen uses the same
	// marker and a closer needs at least the opener's length.
	marker: string;
	info: string;
}

const FENCE_LINE = /^[ \t]*(`{3,}|~{3,})(.*)$/;

// The one fence-opener rule (delivery.ts renders share it through this
// export): a line whose backtick-fence info string contains a backtick
// is an inline code span, not an opener — "```npm install```" must
// never turn the lines after it into code.
export function fenceOpen(line: string): FenceState | null {
	const m = FENCE_LINE.exec(line);
	if (m === null) return null;
	const marker = m[1]!;
	const info = m[2]!.trim();
	if (marker.startsWith("`") && info.includes("`")) return null;
	return { marker, info };
}

// The fence state after `text`: a fence line opens when none is open and
// closes when it is a bare closer — same marker char, a run at least as
// long as the opener's, and no info string (a closer with trailing text
// is code content, not a close).
export function fenceStateAfter(text: string, initial: FenceState | null = null): FenceState | null {
	let fence = initial;
	for (const line of text.split("\n")) {
		const open = fenceOpen(line);
		if (open === null) continue;
		if (fence === null) fence = open;
		else if (open.info === "" && open.marker.startsWith(fence.marker)) fence = null;
	}
	return fence;
}

// The injected opener for a fence split across a window boundary: the
// opener's marker plus its info string, but bounded — past 64 chars the
// info is decoration that costs bubble budget against the 4096 cap.
const REOPEN_LIMIT = 64;
export function fenceReopen(fence: FenceState): string {
	const head = `${fence.marker}${fence.info}`;
	return `${head.length > REOPEN_LIMIT ? fence.marker : head}\n`;
}

// Where one window ends: CHUNK_LIMIT unless a break gives a cleaner
// seam, and never mid-surrogate-pair. A break only counts in the
// window's back half — anything earlier trades a nearly-full bubble for
// a stub (an early newline like a fence's own opener would otherwise
// win every window inside one long code block).
export function windowEnd(body: string, start: number): number {
	let end = Math.min(start + CHUNK_LIMIT, body.length);
	if (end >= body.length) return end;
	const floor = start + CHUNK_LIMIT / 2;
	const para = body.lastIndexOf("\n\n", end);
	if (para > floor) {
		end = para + 2;
	} else {
		const nl = body.lastIndexOf("\n", end);
		if (nl > floor) end = nl + 1;
	}
	if (
		end < body.length &&
		isHighSurrogate(body.charCodeAt(end - 1)) &&
		isLowSurrogate(body.charCodeAt(end))
	) {
		end -= 1;
	}
	return end;
}

// The plain path's chunks: boundaries snap to the last paragraph break
// (then the last newline) inside CHUNK_LIMIT, and a boundary landing
// mid-fence closes the fence at the chunk's end and reopens it — same
// info string — at the next chunk's start, so a split code block stays
// fenced on both sides.
export function chunkWindows(body: string): string[] {
	const windows: string[] = [];
	let start = 0;
	let fence: FenceState | null = null;
	while (start < body.length) {
		const end = windowEnd(body, start);
		const raw = body.slice(start, end);
		const text = (fence !== null ? fenceReopen(fence) : "") + raw;
		fence = fenceStateAfter(raw, fence);
		windows.push(fence !== null ? `${text}\n${fence.marker}` : text);
		start = end;
	}
	return windows;
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
