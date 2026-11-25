import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Message } from "./message.ts";

const rowSchema = z.object({
	id: z.string().uuid(),
	conversation: z.string(),
	mode: z.enum(["steer", "followUp"]),
	message: z.string(),
	created_at: z.string(),
});

const messageSchema = z.looseObject({
	id: z.string().min(1),
	role: z.literal("user"),
	parts: z.array(z.looseObject({ type: z.string() })).min(1),
});

export type PendingInputMode = "steer" | "followUp";
export interface PendingInput {
	id: string;
	conversation: string;
	mode: PendingInputMode;
	message: Message;
	createdAt: string;
}

export class PendingInputs {
	constructor(private readonly db: Database) {}

	add(
		conversation: string,
		message: Message,
		mode: PendingInputMode,
		now = Date.now(),
	): PendingInput {
		const row: PendingInput = {
			id: randomUUID(),
			conversation,
			mode,
			message,
			createdAt: new Date(now).toISOString(),
		};
		this.db
			.query(
				"INSERT INTO app_pending_input (id, conversation, mode, message, created_at) VALUES (?, ?, ?, ?, ?)",
			)
			.run(row.id, conversation, mode, JSON.stringify(message), row.createdAt);
		return row;
	}

	list(conversation: string): PendingInput[] {
		return this.db
			.query(
				"SELECT id, conversation, mode, message, created_at FROM app_pending_input WHERE conversation = ? ORDER BY created_at, rowid",
			)
			.all(conversation)
			.map((value) => this.decode(value));
	}

	take(conversation: string, id: string): PendingInput | null {
		const row = this.db
			.query(
				"SELECT id, conversation, mode, message, created_at FROM app_pending_input WHERE id = ? AND conversation = ?",
			)
			.get(id, conversation);
		if (row === null) return null;
		const decoded = this.decode(row);
		this.db
			.query("DELETE FROM app_pending_input WHERE id = ? AND conversation = ?")
			.run(id, conversation);
		return decoded;
	}

	private decode(value: unknown): PendingInput {
		const row = rowSchema.parse(value);
		let raw: unknown;
		try {
			raw = JSON.parse(row.message);
		} catch (err) {
			throw new Error(`corrupt pending input JSON ${row.id}`, { cause: err });
		}
		return {
			id: row.id,
			conversation: row.conversation,
			mode: row.mode,
			message: messageSchema.parse(raw) as Message,
			createdAt: row.created_at,
		};
	}
}
