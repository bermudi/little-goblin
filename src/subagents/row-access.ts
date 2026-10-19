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
	isClosing: () => boolean;
	isHarnessClosed: () => boolean;
}

export function makeRowAccess(deps: RowAccessDeps) {
	const { runs, isClosing, isHarnessClosed } = deps;

	function rowForConversation(piConversationId: string): SubagentRun | null {
		// close() joins every lane/monitor before the store goes away: a
		// read failure here is real corruption — propagate, never read as
		// "unknown row".
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
	async function recordOutcome(api: ToolExecutionApi, outcome: RunOutcomeBody): Promise<void> {
		await api.commit(async (tx) => {
			const d = await tx.doc(RunDoc, api.conversationId);
			if (d.outcome === null) d.outcome = { rev: d.inputRev, ...outcome } as RunOutcome;
		}, ctx);
	}
	const asConv = (id: string) => Number(id) as ConversationId;
	const asSub = (id: string) => Number(id) as SubmissionId;

	function holderFor(runId: number): LeaseHolder {
		return { kind: "run", id: String(runId) };
	}

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
