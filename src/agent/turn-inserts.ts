import { z } from "zod";
import type { Message } from "../message.ts";

export const INSERTS_PART = "data-inserts";

export const turnInsertItemSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("text"), text: z.string() }).strict(),
	z.object({ kind: z.literal("steer"), seq: z.number().int().nonnegative() }).strict(),
]);

export const turnInsertSchema = z.object({
	step: z.number().int().nonnegative(),
	items: z.array(turnInsertItemSchema).min(1),
}).strict();

export const turnInsertsDataSchema = z.object({
	inserts: z.array(turnInsertSchema),
}).strict();

export type TurnInsertItem = z.infer<typeof turnInsertItemSchema>;
export type TurnInsert = z.infer<typeof turnInsertSchema>;

export function storedTurnInserts(
	entries: { message: Message }[],
	convId: string,
): { messageId: string; inserts: TurnInsert[] }[] {
	return entries.flatMap(({ message }) =>
		message.role !== "assistant" ? [] : message.parts.flatMap((part) => {
			if (part.type !== INSERTS_PART) return [];
			const parsed = turnInsertsDataSchema.safeParse((part as { data?: unknown }).data);
			if (!parsed.success) {
				throw new Error(
					`malformed ${INSERTS_PART} part in conversation ${convId}, message ${message.id}`,
				);
			}
			return [{ messageId: message.id, inserts: parsed.data.inserts }];
		}),
	);
}
