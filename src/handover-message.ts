import { z } from "zod";
import type { Message } from "./message.ts";

export const HANDOVER_PART = "data-handover";
export const HANDOVER_STOP_PART = "data-handover-stop";
export const HANDOVER_OPERATOR_PART = "data-handover-operator";
export const HANDOVER_LIMIT = 5;

const chainId = z.string().min(1);
const card = {
	from: z.string(),
	to: z.string(),
	request: z.string(),
};
export const handoverCardSchema = z.discriminatedUnion("direction", [
	z.object({ ...card, direction: z.literal("sent") }),
	z.object({ ...card, direction: z.literal("received"), chains: z.array(chainId).min(1) }),
]);
export type HandoverCard = z.infer<typeof handoverCardSchema>;
export type IncomingHandover = Extract<HandoverCard, { direction: "received" }>;

export const handoverStopSchema = z.object({
	askId: z.number().int().positive(),
	question: z.string(),
});

export function handoverCard(parts: readonly { type: string; data?: unknown }[]): HandoverCard | null {
	const part = parts.find((part) => part.type === HANDOVER_PART);
	const result = handoverCardSchema.safeParse(part?.data);
	return result.success ? result.data : null;
}

export function handoverChains(message: Message): readonly string[] {
	const incoming = handoverCard(message.parts);
	if (incoming?.direction === "received") return incoming.chains;
	const operator = message.parts.find((part) => part.type === HANDOVER_OPERATOR_PART);
	const parsed = chainId.safeParse(operator !== undefined && "data" in operator ? operator.data : null);
	return parsed.success ? [parsed.data] : [];
}

export function isHandoverCard(parts: readonly { type: string }[]): boolean {
	return parts.some((part) => part.type === HANDOVER_PART);
}
