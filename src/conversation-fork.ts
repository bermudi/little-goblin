// The spin-off/branch copy: forkToApp copies model state into a fresh
// app conversation in one transaction — events verbatim, the latest
// compaction pointer, every memory_contexts row, committed projections
// with their pruning markers retargeted. Pure move from conversation.ts.

import type { Database } from "bun:sqlite";
import { appAddress, formatAddress } from "./conversation-address.ts";
import type { ConversationQueries } from "./conversation-queries.ts";
import { toConversation } from "./conversation-read.ts";
import type { ConversationMetaPatch, ModelSettings } from "./conversation-settings.ts";
import { modelSettingsSchema } from "./conversation-settings.ts";
import { retargetPruningMarker } from "./pruning-marker.ts";

export function makeConversationFork(
	db: Database,
	queries: Pick<
		ConversationQueries,
		| "qGet"
		| "qInsertConv"
		| "qAllEvents"
		| "qEventsThrough"
		| "qInsertEvent"
		| "qCompaction"
		| "qInsertCompaction"
		| "qContextsFor"
		| "qContextsThrough"
		| "qInsertContext"
		| "qAllProjections"
		| "qProjectionsThrough"
		| "qInsertProjection"
	>,
	applyPatch: (id: string, patch: ConversationMetaPatch) => void,
) {
	const {
		qGet,
		qInsertConv,
		qAllEvents,
		qEventsThrough,
		qInsertEvent,
		qCompaction,
		qInsertCompaction,
		qContextsFor,
		qContextsThrough,
		qInsertContext,
		qAllProjections,
		qProjectionsThrough,
		qInsertProjection,
	} = queries;

	function forkToApp(
		fromId: string,
		appId: string,
		defaultCwd: string,
		title: string | null,
		defaults?: ModelSettings,
		opts?: {
			throughSeq?: number;
			projectId?: string | null;
			// A branch copies a real title; a spin-off's provisional name
			// stays implicit so the retitle path can improve it.
			titleImplicit?: boolean;
		},
	) {
		return db.transaction(() => {
			const id = formatAddress(appAddress(appId));
			const through = opts?.throughSeq;
			qInsertConv.run(id, 0, null, defaultCwd, new Date().toISOString());
			// The memory opt-out is copied state — an excluded DM's text
			// stays unsearchable and unretained in the fork too.
			applyPatch(id, {
				...(title === null ? {} : { title }),
				titleImplicit: title === null ? true : (opts?.titleImplicit ?? true),
				memoryExcluded: qGet.get(fromId)?.memory_excluded === 1,
				...(defaults === undefined ? {} : modelSettingsSchema.parse(defaults)),
			});
			if (opts?.projectId !== undefined && opts.projectId !== null) {
				const bound = db.run("UPDATE conversations SET project_id = ? WHERE id = ?", [
					opts.projectId,
					id,
				]);
				if (bound.changes !== 1) throw new Error(`conversation ${id} project bind failed`);
			}
			// The FTS triggers fire on these inserts — correct: the app
			// pool's search should see the copied exchange.
			const events =
				through === undefined ? qAllEvents.all(fromId) : qEventsThrough.all(fromId, through);
			for (const e of events) {
				qInsertEvent.run(
					id,
					e.seq,
					e.role,
					e.data,
					e.anchor_seq,
					e.created_at,
					e.memory_eligible,
				);
			}
			// Only the latest pointer copies — it alone steers the model
			// view — and its eligibility with it: the fork's memory-bound
			// view must match the source's. A branch drops a pointer whose
			// boundary lies past its cut: the summary would describe events
			// the branch does not hold. Equality keeps it — the pointer
			// folds the inclusive prefix (causal position ≤ boundary),
			// which is exactly what the branch holds at that cut.
			const compaction = qCompaction.get(fromId);
			if (compaction !== null && (through === undefined || compaction.boundary_seq <= through)) {
				qInsertCompaction.run(
					id,
					compaction.boundary_seq,
					compaction.summary,
					compaction.summary_eligible,
					compaction.tokens_before,
					compaction.model,
					compaction.created_at,
					compaction.tail_events,
				);
			}
			for (const c of through === undefined
				? qContextsFor.all(fromId)
				: qContextsThrough.all(fromId, through)) {
				qInsertContext.run(id, c.anchor_seq, c.content, c.source_ids, c.created_at);
			}
			// Committed projections ride along — the fork's model view
			// replays the same markers, and the events they overlay came
			// through the copy above untouched. One rewrite: the marker's
			// recovery address names the source id, so point it at the
			// fork or recovery would read another conversation's events
			// (refused for an excluded fork) and die with the source.
			const projections =
				through === undefined
					? qAllProjections.all(fromId)
					: qProjectionsThrough.all(fromId, through);
			for (const p of projections) {
				qInsertProjection.run(
					id,
					p.seq,
					p.tool_call_id,
					retargetPruningMarker(p.replacement, p.seq, p.tool_call_id, fromId, id),
					p.route_key,
					p.settings_hash,
					p.created_at,
				);
			}
			const created = qGet.get(id);
			if (!created) throw new Error(`conversation ${id} insert failed`);
			return toConversation(created);
		})();
	}

	return { forkToApp };
}
