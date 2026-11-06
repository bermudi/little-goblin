// Arrival facts on a user message: when it arrived and on which surface.
// A part, not text — the transcript, search and memory keep the words as
// sent; only the model view renders it. Written once at the store's
// append, so replay is byte-stable and rows older than this part simply
// have none. New facts go in the schema and contextText, nothing else.

import type { UIMessage } from "ai";
import { z } from "zod";
import { channelOf } from "./conversation-address.ts";

export const CONTEXT_PART = "data-context";

export const contextPartDataSchema = z.object({
	// Local wall clock with its own offset: `2026-11-06 14:32 -06:00`.
	at: z.string(),
	surface: z.enum(["telegram", "app", "guest"]),
});
export type ContextPartData = z.infer<typeof contextPartDataSchema>;

function pad(n: number): string {
	return String(n).padStart(2, "0");
}

// The offset is the box's at this instant and is frozen into the stamp,
// so a later timezone or DST change cannot rewrite history.
export function formatArrival(now: Date): string {
	const offset = -now.getTimezoneOffset();
	const sign = offset < 0 ? "-" : "+";
	const abs = Math.abs(offset);
	const zone = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
	const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
	return `${date} ${pad(now.getHours())}:${pad(now.getMinutes())} ${zone}`;
}

// Mutates in place on purpose: a steered turn converts the caller's
// object rather than re-reading the row, and both must render the same
// bytes or the next request rewrites its prefix. A part already present
// (a client echoing an edited message) is replaced: arrival is ours.
export function stampArrival(conversationId: string, message: UIMessage, now: Date): void {
	if (message.role !== "user") return;
	const data: ContextPartData = { at: formatArrival(now), surface: channelOf(conversationId) };
	const rest = message.parts.filter((p) => p.type !== CONTEXT_PART);
	message.parts = [{ type: CONTEXT_PART, data } as UIMessage["parts"][number], ...rest];
}

export function contextText(data: ContextPartData): string {
	return `[${data.at} · ${data.surface}]`;
}
