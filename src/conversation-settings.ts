// Per-conversation metadata and app model settings: the meta patch
// writer, the stored-selection reader, first-write initialization
// with the thinking clamp, and the epoch bump turns fence on.

import type { Database } from "bun:sqlite";
import { z } from "zod";
import { clampThinkingFor } from "./agent/thinking.ts";
import type { Config, ThinkingLevel } from "./config-schema.ts";
import { thinkingLevels } from "./config-schema.ts";
import { channelOf } from "./conversation-address.ts";
import type { ConversationQueries } from "./conversation-queries.ts";
import { log } from "./log.ts";

export interface ModelSettings {
	model: string;
	thinking: ThinkingLevel;
}
export const modelSettingsSchema = z.object({
	model: z.string().min(1),
	thinking: z.enum(thinkingLevels),
});

export interface ConversationMetaPatch {
	title?: string;
	titleImplicit?: boolean;
	model?: string | null;
	thinking?: string | null;
	voice?: boolean;
	memoryExcluded?: boolean;
	persona?: "personal" | "guest";
	archived?: boolean;
	pinned?: boolean;
}

export function makeConversationSettings(
	db: Database,
	qGet: ConversationQueries["qGet"],
	qEpoch: ConversationQueries["qEpoch"],
) {
	function applyPatch(id: string, patch: ConversationMetaPatch): void {
		// An archived row never carries a pin: unarchive+pin in one patch
		// is coherent, but pinning a row that is or becomes archived (this
		// patch or earlier) is a caller bug and dies here rather than
		// writing a contradiction the unarchive would resurrect.
		if (patch.pinned === true) {
			const row = qGet.get(id);
			if (row === null) throw new Error(`conversation ${id} not found`);
			const stays =
				patch.archived === false || (patch.archived === undefined && row.archived_at === null);
			if (!stays) throw new Error(`cannot pin archived conversation ${id}`);
		}
		const sets: string[] = [];
		const vals: (string | number | null)[] = [];
		if (patch.title !== undefined) {
			sets.push("title = ?");
			vals.push(patch.title);
		}
		if (patch.titleImplicit !== undefined) {
			sets.push("title_implicit = ?");
			vals.push(patch.titleImplicit ? 1 : 0);
		}
		if (patch.model !== undefined) {
			sets.push("model = ?");
			vals.push(patch.model);
		}
		if (patch.thinking !== undefined) {
			sets.push("thinking = ?");
			vals.push(patch.thinking);
		}
		if (patch.voice !== undefined) {
			sets.push("voice = ?");
			vals.push(patch.voice ? 1 : 0);
		}
		if (patch.memoryExcluded !== undefined) {
			sets.push("memory_excluded = ?");
			vals.push(patch.memoryExcluded ? 1 : 0);
		}
		if (patch.persona !== undefined) {
			sets.push("persona = ?");
			vals.push(patch.persona);
		}
		if (patch.archived !== undefined) {
			sets.push("archived_at = ?");
			vals.push(patch.archived ? new Date().toISOString() : null);
			// Shelving supersedes pinning — unarchive must not resurrect a
			// stale pin.
			if (patch.archived) sets.push("pinned_at = NULL");
		}
		if (patch.pinned !== undefined) {
			sets.push("pinned_at = ?");
			vals.push(patch.pinned ? new Date().toISOString() : null);
		}
		if (sets.length === 0) return;
		vals.push(id);
		db.run(`UPDATE conversations SET ${sets.join(", ")} WHERE id = ?`, vals);
	}

	// The stored selection, defaults filling the gaps — no clamp, no
	// write. Writers that re-derive the level need the raw pair so a
	// normalization pass can't erase information first.
	function readSettings(id: string, defaults: ModelSettings): ModelSettings {
		const row = qGet.get(id);
		if (!row || channelOf(id) !== "app") throw new Error(`no app conversation ${id}`);
		return modelSettingsSchema.parse({
			model: row.model ?? defaults.model,
			thinking: row.thinking ?? defaults.thinking,
		});
	}

	function initializeSettings(
		id: string,
		defaults: ModelSettings & { providers?: Config["providers"] },
	): ModelSettings {
		const row = qGet.get(id);
		if (!row || channelOf(id) !== "app") throw new Error(`no app conversation ${id}`);
		const stored = readSettings(id, defaults);
		// A stored level the model can't express is a lie — persist the
		// rung the wire clamp would land on instead of showing it.
		const settings: ModelSettings = {
			model: stored.model,
			thinking: clampThinkingFor(defaults.providers ?? {}, stored.model, stored.thinking),
		};
		if (row.model === null || row.thinking === null) {
			applyPatch(id, settings);
			log.info("app conversation settings initialized", { conversation: id, ...settings });
		} else if (settings.thinking !== stored.thinking) {
			applyPatch(id, settings);
			log.info("app conversation thinking clamped to the model's ladder", {
				conversation: id,
				model: settings.model,
				from: stored.thinking,
				to: settings.thinking,
			});
		}
		return settings;
	}

	function bump(id: string, previousEpoch = 0): number {
		db.run("UPDATE conversations SET epoch = max(epoch, ?) + 1 WHERE id = ?", [previousEpoch, id]);
		const row = qEpoch.get(id);
		if (!row) throw new Error(`conversation ${id} not found`);
		return row.epoch;
	}

	return { applyPatch, readSettings, initializeSettings, bump };
}
