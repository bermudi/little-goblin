// The run-row vocabulary shared by the owner's units (design/
// subagents.md → Owner decomposition): mapping a Pi conversation back
// to its goblin row, the live/halted checks every effect re-runs, the
// idempotent terminal write, the claim-note side write, the branded-id
// casts, and the lease-holder tag. Pure helpers over the runs store —
// no state of their own beyond the store itself.

import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, SubmissionId, ToolExecutionApi } from "@earendil-works/pi-durable";
import type { LeaseHolder } from "../desktops.ts";
import type { SubagentRun, SubagentRuns } from "../subagent-runs.ts";
import { SubagentError } from "./errors.ts";
import { RunDoc, type RunOutcome, type RunOutcomeBody } from "./run-doc.ts";

const ctx: Context = BACKGROUND_CONTEXT;

export interface RowAccessDeps {
	runs: SubagentRuns;
	/** closing only — a halted owner refuses, a dead harness does not. */
	isClosing: () => boolean;
	/** harnessClosed joins closing for the live-row guard. */
	isHarnessClosed: () => boolean;
}

export function makeRowAccess(deps: RowAccessDeps) {
	const { runs, isClosing, isHarnessClosed } = deps;

	function rowForConversation(piConversationId: string): SubagentRun | null {
		// close() joins every lane/monitor before the run store goes
		// away, so a storage failure here is real corruption — let it
		// propagate rather than read as "unknown row".
		return runs.byPiConversation(piConversationId);
	}
	function requireRow(api: ToolExecutionApi): SubagentRun {
		const row = rowForConversation(String(api.conversationId));
		if (row === null) throw new SubagentError("tool call on an unknown subagent conversation");
		return row;
	}
	function requireLive(row: SubagentRun): void {
		if (isClosing() || isHarnessClosed()) {
			throw new SubagentError("the subagent harness is closed — this action cannot run");
		}
		if (row.stopRequested) {
			throw new SubagentError(`run #${row.id} is stopping — this action cannot run`);
		}
		if (row.status !== "running") {
			throw new SubagentError(`run #${row.id} is ${row.status} — not executing`);
		}
	}
	// The terminal write is idempotent: a replayed safe tool re-commits
	// the same outcome under its input revision; a second terminal call
	// never replaces the first.
	async function recordOutcome(api: ToolExecutionApi, outcome: RunOutcomeBody): Promise<void> {
		await api.commit(async (tx) => {
			const d = await tx.doc(RunDoc, api.conversationId);
			if (d.outcome === null) d.outcome = { rev: d.inputRev, ...outcome } as RunOutcome;
		}, ctx);
	}
	// Pi ids are branded numbers; goblin rows persist them as text.
	const asConv = (id: string) => Number(id) as ConversationId;
	const asSub = (id: string) => Number(id) as SubmissionId;

	function holderFor(runId: number): LeaseHolder {
		return { kind: "run", id: String(runId) };
	}

	// A claim that adopted/restarted/recreated the desktop returns a
	// lifecycle note — persist it on the run so the next tool result
	// carries it as a diagnostic. Worker notes arrive through the
	// sandbox's onLifecycle hook; computer rows aren't worker lease
	// holders, so this writes the row directly.
	function persistClaimNote(rowId: number, note: string | undefined): void {
		if (note === undefined || note === "") return;
		const cur = runs.get(rowId);
		if (cur === null || cur.stopRequested || cur.status === "stopped") return;
		runs.update(rowId, { lifecycleNote: note });
	}

	function throwIfHalted(rowId: number): void {
		if (isClosing()) throw new SubagentError("owner closing");
		const row = runs.get(rowId);
		if (row === null) throw new SubagentError("run row vanished");
		if (row.stopRequested || row.status === "stopped") throw new SubagentError("stopped");
	}

	return {
		rowForConversation,
		requireRow,
		requireLive,
		recordOutcome,
		asConv,
		asSub,
		holderFor,
		persistClaimNote,
		throwIfHalted,
	};
}

export type RowAccess = ReturnType<typeof makeRowAccess>;
