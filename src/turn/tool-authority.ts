// Tool authority: the run row lands before any tool side effect can
// execute, ownership links at begin, and every dispatch is fenced and
// journaled (tool-fence.ts). One seam, so runAttempt assembles tools
// without owning the journal's ordering invariants — and #195's
// step-end persistence (saveStep) lives here too, the one home both
// engines' step checkpoints pass through.

import { randomUUID } from "node:crypto";
import type { ToolSet } from "ai";
import type { AcceptsMedia } from "../agent/attachments.ts";
import type { OutgoingFile } from "../agent/tools/send.ts";
import type { Conversation } from "../conversation-read.ts";
import { log } from "../log.ts";
import type { TurnCheckpointPatch, TurnJournal } from "../turn-journal.ts";
import type { SinkDelivery } from "./delivery.ts";
import { buildRetryGuard } from "./retry-guard.ts";
import type { RunOwnershipHooks } from "./run-ownership.ts";
import { fenceTools } from "./tool-fence.ts";

// Build tools for the deployment workspace and conversation; delivery
// hooks connect speak and file tools to the running sink.
export type TurnToolMaker = (
	conv: Conversation,
	deliverVoice?: (audio: Uint8Array) => Promise<void>,
	recording?: () => () => void,
	deliverFile?: (file: OutgoingFile) => Promise<void>,
	// Filled after buildStep so fetch can render stored PDF references with
	// this turn's media capabilities.
	accepts?: { current: AcceptsMedia },
	context?: {
		runId: string;
		sourceMessageId(): string;
		sourceInputSeq(): number | null;
	},
) => ToolSet;

// Everything the run row's creation records about the attempt.
export interface ToolAuthorityRecord {
	anchorSeq: number | null;
	steerMarkSeed: number;
	startedAtMs: number;
	ownedInputSeqs: Set<number>;
	admissionExchangeExcluded: boolean;
	memberSeqs: number[];
	/** The newest owned input's event seq, read at begin time. */
	sourceInputSeq(): number | null;
	/** An operator-resume source, when this attempt continues one. */
	resumedFrom?: string | undefined;
	/** An overflow/fallback predecessor whose calls this row inherits. */
	predecessorRun?: string | undefined;
	/** The operator's configured selection when a fallback serves. */
	fallbackConfigured: string | null;
}

export interface ToolAuthorityDeps {
	conv: Conversation;
	convId: string;
	epoch: number;
	makeTools: TurnToolMaker;
	delivery: SinkDelivery;
	// Until buildStep resolves, media capability must conservatively reject
	// inlining.
	accepts: { current: AcceptsMedia };
	sourceMessageId(): string;
	record: ToolAuthorityRecord;
	journal: TurnJournal | undefined;
	// The run record's fault-classifying wrapper and fault box — beginRun
	// and the recovery-guard read classify a throw as a journal fault,
	// never a model failure.
	journaled<T>(op: () => T): T;
	journalFault: { current: unknown };
	onJournalFault(): void;
	runOwnership?: RunOwnershipHooks | undefined;
	checkAuthority(): void;
	// #477: the tool-launch steer gate — the runtime wires the lane's
	// claimable-pending read here, armed only by an engine whose
	// model-call boundary claims steers.
	steerWaiting?: (() => boolean) | undefined;
}

export interface ToolAuthority {
	tools: ToolSet;
	runId: string;
	/** True once the ownership begin hook has linked the members — the
	 *  pre-run failure announcement stops announcing past this point. The
	 *  begin runs inside open with no await after it, so the fact is
	 *  final at return; false means no journal, so no row to link. */
	ownershipBegun: boolean;
	/** #195 — step-end persistence's one home. Both engines route their
	 *  step-end checkpoints and steer-fold ownership writes through here,
	 *  never the journal directly, so a checkpoint throw classifies as a
	 *  journal fault exactly like a fenced tool's write: the turn dies as
	 *  an error and never advances the fallback walk. */
	saveStep(patch: TurnCheckpointPatch): void;
}

export function openToolAuthority(deps: ToolAuthorityDeps): ToolAuthority {
	const { conv, convId, epoch, journal, record } = deps;
	// The run row lands before the SDK's loop can reach a tool: after this
	// line every dispatch is journaled under runId. Creation, evidence
	// inheritance (an operator-resume source and any overflow-failed
	// predecessor), and the source's consumption are one journal
	// transaction — a crash between them must never leave a successor that
	// re-executes recorded side effects.
	const newRunId = randomUUID();
	const rawTools = deps.makeTools(
		conv,
		deps.delivery.deliverVoice,
		deps.delivery.recording,
		deps.delivery.deliverFile,
		deps.accepts,
		{
			runId: newRunId,
			sourceMessageId: deps.sourceMessageId,
			sourceInputSeq: record.sourceInputSeq,
		},
	);
	deps.journaled(() =>
		journal?.beginRun({
			runId: newRunId,
			conversationId: convId,
			epoch,
			anchorSeq: record.anchorSeq,
			steerMark: record.steerMarkSeed,
			convSnapshot: {
				model: conv.model,
				thinking: conv.thinking,
				// The operator's selection when a fallback serves — the resume
				// drift check compares this; resume runs on `model`.
				...(record.fallbackConfigured !== conv.model
					? { configuredModel: record.fallbackConfigured }
					: {}),
			},
			toolNames: Object.keys(rawTools),
			startedAt: new Date(record.startedAtMs).toISOString(),
			ownedInputSeqs: [...record.ownedInputSeqs],
			admissionExchangeExcluded: record.admissionExchangeExcluded,
			sourceInputSeq: record.sourceInputSeq(),
			resumedFrom: record.resumedFrom,
			inheritFrom: record.predecessorRun === undefined ? undefined : [record.predecessorRun],
		}),
	);
	// Set only once the row exists — a failed beginRun leaves no row to
	// stamp and no run for ownership to end. The runtime reads the id off
	// the returned authority; the run record reads it through the
	// runtime-injected getter, never a write-back callback.
	try {
		// Every member claimed into this attempt becomes this run's owned
		// input here, before the stream can reach a tool. A wake linked to
		// a predecessor the row continues or inherits moves with it.
		if (journal !== undefined) {
			deps.runOwnership?.begin({
				runId: newRunId,
				conversationId: convId,
				memberSeqs: record.memberSeqs,
				...(record.resumedFrom !== undefined ? { resumedFrom: record.resumedFrom } : {}),
				...(record.predecessorRun !== undefined
					? { inheritFrom: [record.predecessorRun] }
					: {}),
			});
		}
		const begunOwnership = journal !== undefined;
		// The recovery guard reads the fresh row once, after inheritance: it
		// already carries the source's decisions and every predecessor
		// attempt's recorded executions. Calls this attempt then makes never
		// join the set — same-run intentional repetition is a live-turn
		// matter, not recovery's.
		const recoveryGuard =
			journal === undefined
				? undefined
				: buildRetryGuard(deps.journaled(() => journal.callsFor(newRunId)));
		const tools = fenceTools({
			tools: rawTools,
			convId,
			epoch,
			journal,
			checkAuthority: deps.checkAuthority,
			runId: newRunId,
			guard: recoveryGuard,
			journalFault: deps.journalFault,
			onJournalFault: deps.onJournalFault,
			steerWaiting: deps.steerWaiting,
		});
		const saveStep = (patch: TurnCheckpointPatch): void => {
			deps.journaled(() => journal?.checkpoint(newRunId, patch));
		};
		return { tools, runId: newRunId, ownershipBegun: begunOwnership, saveStep };
	} catch (err) {
		// A begun row must not escape init still 'running': every stamp
		// path in the runtime keys off the returned authority, which this
		// throw never reaches. Terminate the row here so wakes linked by
		// begin settle off the stamp like any other run end — then let
		// the turn's catch report the original error.
		if (journal !== undefined) {
			try {
				deps.journaled(() => journal.finishRun(newRunId, "error", "failed"));
				deps.runOwnership?.end(newRunId, "error", "failed");
			} catch (stampErr) {
				log.error("run row terminal stamp failed while unwinding a failed init", stampErr, {
					run: newRunId,
					conversation: convId,
				});
			}
		}
		throw err;
	}
}
