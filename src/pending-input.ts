import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Message } from "./message.ts";
import type { ConversationStore } from "./conversation.ts";
import { log } from "./log.ts";

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

	all(): PendingInput[] {
		return this.db
			.query("SELECT id, conversation, mode, message, created_at FROM app_pending_input ORDER BY created_at, rowid")
			.all()
			.map((value) => this.decode(value));
	}

	take(id: string): PendingInput | null {
		const row = this.db
			.query(
				"SELECT id, conversation, mode, message, created_at FROM app_pending_input WHERE id = ?",
			)
			.get(id);
		if (row === null) return null;
		const decoded = this.decode(row);
		this.db.query("DELETE FROM app_pending_input WHERE id = ?").run(id);
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

export function recoverPendingInputs(store: ConversationStore): void {
	const pending = new PendingInputs(store.db);
	const stranded = pending.all();
	if (stranded.length === 0) return;
	const converted = store.db.transaction(() =>
		stranded.map((input) => {
			const taken = pending.take(input.id);
			if (taken === null) throw new Error(`pending input ${input.id} disappeared during boot`);
			const seq = store.append(input.conversation, [input.message])[0]!;
			return { input, seq };
		}),
	)();
	for (const { input, seq } of converted) {
		log.info("app pending input boot-convert", {
			conversation: input.conversation,
			pendingId: input.id,
			seq,
		});
	}
}
