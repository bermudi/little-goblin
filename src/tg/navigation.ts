// Manual DM selection. All durable effects share the store transaction;
// Telegram delivery and slow intake deliberately live outside this module.
import { z } from "zod";
import {
	formatAddress,
	parseAddress,
	type Conversation,
	type ConversationStore,
} from "../conversation.ts";
import { log } from "../log.ts";
import type { Runtime } from "../runtime.ts";
import type { openTelegramInbox } from "./inbox.ts";

const positiveId = z.number().int().safe().positive();
const inputSchema = z.strictObject({
	chatId: positiveId,
	updateId: z.number().int().safe().nonnegative(),
	messageId: positiveId,
	command: z.enum(["new", "back"]),
});
const conversationIdSchema = z.string().refine((id) => {
	const parsed = parseAddress(id);
	return parsed !== null && parsed.kind === "rolling" && parsed.chatId > 0;
}, "rolling dm conversation id");
const receiptSchema = z.strictObject({
	fromId: conversationIdSchema.nullable(),
	toId: conversationIdSchema.nullable(),
	outcome: z.enum(["new", "back", "no_previous"]),
	archivedInputs: z.number().int().safe().nonnegative(),
});
type Receipt = z.infer<typeof receiptSchema>;
export interface DmNavigationResult extends Receipt {
	conv: Conversation | null;
	duplicate: boolean;
	stopped: boolean;
	reviewsCancelled: number;
}
interface CommittedNavigation {
	result: DmNavigationResult;
	fence: { outgoingId: string; epoch: number } | null;
}
const storedSchema = z.object({
	update_id: inputSchema.shape.updateId,
	chat_id: positiveId,
	message_id: positiveId,
	command: inputSchema.shape.command,
	result_json: z.string(),
});

function assertScope(id: string | null, chatId: number): void {
	if (id === null) return;
	conversationIdSchema.parse(id);
	const parsed = parseAddress(id);
	if (parsed === null || parsed.kind !== "rolling" || parsed.chatId !== chatId) {
		throw new Error("DM navigation receipt has a mismatched conversation");
	}
}

export function navigateDm(
	deps: {
		store: ConversationStore;
		runtime: Pick<Runtime, "cancelFenced">;
		inbox: ReturnType<typeof openTelegramInbox>;
	},
	input: { chatId: number; updateId: number; messageId: number; command: "new" | "back" },
): DmNavigationResult {
	let phase = "validate";
	let committed = false;
	try {
		const valid = inputSchema.parse(input);
		const { store, runtime, inbox } = deps;
		const db = store.db;
		const navigation = db.transaction((): CommittedNavigation => {
			phase = "receipt_lookup";
			db.run(`CREATE TABLE IF NOT EXISTS tg_dm_navigation (
				update_id INTEGER PRIMARY KEY,
				chat_id INTEGER NOT NULL,
				message_id INTEGER NOT NULL,
				command TEXT NOT NULL,
				result_json TEXT NOT NULL,
				UNIQUE(chat_id, message_id)
			)`);
			// Guard both identities if one chat/message arrives under another
			// update id. Remember aliases so that id cannot identify another command.
			db.run(`CREATE TABLE IF NOT EXISTS tg_dm_navigation_updates (
				update_id INTEGER PRIMARY KEY,
				receipt_id INTEGER NOT NULL REFERENCES tg_dm_navigation(update_id)
			)`);
			const byUpdate = db
				.query(`SELECT n.* FROM tg_dm_navigation_updates u
				JOIN tg_dm_navigation n ON n.update_id = u.receipt_id WHERE u.update_id = ?`)
				.get(valid.updateId);
			const byMessage = db
				.query("SELECT * FROM tg_dm_navigation WHERE chat_id = ? AND message_id = ?")
				.get(valid.chatId, valid.messageId);
			const alias = db.query(
				"INSERT INTO tg_dm_navigation_updates (update_id, receipt_id) VALUES (?, ?)",
			);
			if (byUpdate || byMessage) {
				const row = storedSchema.parse(byUpdate ?? byMessage);
				if (
					row.chat_id !== valid.chatId ||
					row.message_id !== valid.messageId ||
					row.command !== valid.command ||
					(byMessage && storedSchema.parse(byMessage).update_id !== row.update_id)
				) {
					throw new Error("DM navigation conflicting command identity");
				}
				const json: unknown = JSON.parse(row.result_json);
				const receipt = receiptSchema.parse(json);
				assertScope(receipt.fromId, valid.chatId);
				assertScope(receipt.toId, valid.chatId);
				if (
					(receipt.outcome === "no_previous") !== (receipt.toId === null) ||
					(receipt.outcome === "no_previous" && receipt.archivedInputs !== 0) ||
					(valid.command === "new" && receipt.outcome !== "new") ||
					(valid.command === "back" && receipt.outcome === "new")
				) {
					throw new Error("DM navigation invalid command receipt");
				}
				const conv = receipt.toId === null ? null : store.get(receipt.toId);
				if (receipt.toId !== null && !conv)
					throw new Error("DM navigation selected history is missing");
				if (!byUpdate) alias.run(valid.updateId, row.update_id);
				return {
					result: { ...receipt, conv, duplicate: true, stopped: false, reviewsCancelled: 0 },
					fence: null,
				};
			}

			phase = "current_lookup";
			const laneKey = formatAddress({ kind: "dm", chatId: valid.chatId });
			const current = store.currentDm(valid.chatId);
			let outgoing = current;
			let selected: Conversation | null = null;
			let fence: CommittedNavigation["fence"] = null;
			let archivedInputs = 0;
			let outcome: Receipt["outcome"] = "no_previous";
			// The cwd column is a retired NOT NULL compatibility field, not
			// tool state. This helper needs no deployment/workspace configuration.
			if (
				valid.command === "new" &&
				outgoing === null &&
				inbox.hasPendingBefore(laneKey, valid.updateId)
			) {
				phase = "historical_create";
				outgoing = store.rollDm(valid.chatId, "");
			}
			phase = "previous_lookup";
			const previous =
				valid.command === "back" && outgoing !== null ? store.previousDm(valid.chatId) : null;
			if (valid.command === "new" || previous !== null) {
				if (outgoing !== null) {
					assertScope(outgoing.id, valid.chatId);
					if (current !== null) {
						phase = "fence";
						fence = { outgoingId: current.id, epoch: store.bumpEpoch(current.id) };
					}
					phase = "archive_pending";
					archivedInputs = inbox.archivePendingBefore(laneKey, valid.updateId, outgoing.id);
				}
				phase = "selection";
				selected =
					valid.command === "new" ? store.rollDm(valid.chatId, "") : store.backDm(valid.chatId);
				if (!selected) throw new Error("DM navigation predecessor disappeared during selection");
				assertScope(selected.id, valid.chatId);
				outcome = valid.command;
			}
			const receipt = receiptSchema.parse({
				fromId: outgoing?.id ?? null,
				toId: selected?.id ?? null,
				outcome,
				archivedInputs,
			});
			phase = "receipt_write";
			db.query(`INSERT INTO tg_dm_navigation (update_id, chat_id, message_id, command, result_json)
				VALUES (?, ?, ?, ?, ?)`).run(
				valid.updateId,
				valid.chatId,
				valid.messageId,
				valid.command,
				JSON.stringify(receipt),
			);
			alias.run(valid.updateId, valid.updateId);
			return {
				result: {
					...receipt,
					conv: selected,
					duplicate: false,
					stopped: false,
					reviewsCancelled: 0,
				},
				fence,
			};
		})();
		committed = true;
		const { result, fence } = navigation;
		// Cancellation is irreversible. Fence durably with the pin/receipt,
		// then cancel synchronously before any other work can enter the lane.
		if (fence !== null) {
			phase = "cancel_fenced";
			const cancelled = runtime.cancelFenced(fence.outgoingId, fence.epoch);
			result.stopped = cancelled.stopped;
			result.reviewsCancelled = cancelled.reviewsCancelled;
		}
		phase = "log";
		log.info(result.duplicate ? "dm navigation duplicate" : "dm navigated", {
			chatId: valid.chatId,
			updateId: valid.updateId,
			messageId: valid.messageId,
			command: valid.command,
			fromId: result.fromId,
			toId: result.toId,
			outcome: result.outcome,
			duplicate: result.duplicate,
			stopped: result.stopped,
			reviewsCancelled: result.reviewsCancelled,
			archivedInputs: result.archivedInputs,
		});
		return result;
	} catch (err) {
		// Never log exception messages/stacks here: validation and SQLite
		// exceptions may contain persisted input. The caller gets the original error.
		const safe = inputSchema.safeParse(input);
		log.error(
			committed ? "dm navigation failed after commit" : "dm navigation failed — rolled back",
			undefined,
			{
				...(safe.success ? safe.data : {}),
				phase,
				errorKind: err instanceof Error ? err.name : "unknown",
			},
		);
		throw err;
	}
}
