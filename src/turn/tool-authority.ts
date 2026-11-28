
import { randomUUID } from "node:crypto";
import type { Tools } from "../tool.ts";
import type { OutgoingFile } from "../agent/tools/send.ts";
import type { Conversation } from "../conversation-read.ts";
import { log } from "../log.ts";
import type { TurnCheckpointPatch, TurnJournal } from "../turn-journal.ts";
import type { SinkDelivery } from "./delivery.ts";
import { buildRetryGuard } from "./retry-guard.ts";
import type { RunOwnershipHooks } from "./run-ownership.ts";
import { fenceTools } from "./tool-fence.ts";

export type TurnToolMaker = (
	conv: Conversation,
	deliverVoice?: (audio: Uint8Array, toolCallId: string) => Promise<void>,
	recording?: () => () => void,
	deliverFile?: (file: OutgoingFile, toolCallId: string) => Promise<void>,
	context?: {
		runId: string;
		sourceMessageId(): string;
		sourceInputSeq(): number | null;
	},
) => Tools;

export interface ToolAuthorityRecord {
	anchorSeq: number | null;
	steerMarkSeed: number;
	startedAtMs: number;
	ownedInputSeqs: Set<number>;
	admissionExchangeExcluded: boolean;
	memberSeqs: number[];
	sourceInputSeq(): number | null;
	predecessorRun?: string | undefined;
	fallbackConfigured: string | null;
}

export interface ToolAuthorityDeps {
	conv: Conversation;
	convId: string;
	epoch: number;
	makeTools: TurnToolMaker;
	delivery: SinkDelivery;
	sourceMessageId(): string;
	record: ToolAuthorityRecord;
	journal: TurnJournal | undefined;
	journaled<T>(op: () => T): T;
	journalFault: { current: unknown };
	onJournalFault(): void;
	runOwnership?: RunOwnershipHooks | undefined;
	checkAuthority(): void;
	steerWaiting?: (() => boolean) | undefined;
}

export interface ToolAuthority {
	tools: Tools;
	runId: string;
	ownershipBegun: boolean;
	saveStep(patch: TurnCheckpointPatch): void;
}

export function openToolAuthority(deps: ToolAuthorityDeps): ToolAuthority {
	const { conv, convId, epoch, journal, record } = deps;
	const newRunId = randomUUID();
	const rawTools = deps.makeTools(
		conv,
		deps.delivery.deliverVoice,
		deps.delivery.recording,
		deps.delivery.deliverFile,
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
				...(record.fallbackConfigured !== conv.model
					? { configuredModel: record.fallbackConfigured }
					: {}),
			},
			toolNames: Object.keys(rawTools),
			startedAt: new Date(record.startedAtMs).toISOString(),
			ownedInputSeqs: [...record.ownedInputSeqs],
			admissionExchangeExcluded: record.admissionExchangeExcluded,
			sourceInputSeq: record.sourceInputSeq(),
			inheritFrom: record.predecessorRun === undefined ? undefined : [record.predecessorRun],
		}),
	);
	try {
		if (journal !== undefined) {
			deps.runOwnership?.begin({
				runId: newRunId,
				conversationId: convId,
				memberSeqs: record.memberSeqs,
				...(record.predecessorRun !== undefined
					? { inheritFrom: [record.predecessorRun] }
					: {}),
			});
		}
		const begunOwnership = journal !== undefined;
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
			try {
				deps.journaled(() => journal?.checkpoint(newRunId, patch));
			} catch (err) {
				log.error("journal checkpoint failed", err, { conversation: convId, run: newRunId });
				deps.onJournalFault();
				throw err;
			}
		};
		return { tools, runId: newRunId, ownershipBegun: begunOwnership, saveStep };
	} catch (err) {
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
