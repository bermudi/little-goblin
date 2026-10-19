import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Submission } from "@earendil-works/pi-durable";
import { exportNamedBytes } from "../box-files.ts";
import { DesktopError, type Desktops } from "../desktops.ts";
import { log } from "../log.ts";
import { PodmanError } from "../podman.ts";
import { SandboxError } from "../sandboxes.ts";
import { subagentNotice } from "../subagent-prompts.ts";
import { crashDecisionNotice, type SubagentRun, type SubagentRuns } from "../subagent-runs.ts";
import type { ApprovalGate } from "./approval-gate.ts";
import { SubagentError } from "./errors.ts";
import { RunDoc, type RunOutcome } from "./run-doc.ts";
import type { RowAccess } from "./row-access.ts";
import type { HarnessBundle } from "./tools.ts";
import type { buildTransfer } from "./transfer.ts";

const ctx: Context = BACKGROUND_CONTEXT;

interface MonitorState {
	tasks: Set<Promise<void>>;
	perRun: Map<number, Set<Promise<void>>>;
}

export interface SettleDeps {
	runs: SubagentRuns;
	lane: <T>(id: number, fn: () => Promise<T>) => Promise<T>;
	harness: HarnessBundle["harness"];
	access: RowAccess;
	desktops: Desktops;
	exportOutcomeFiles: ReturnType<typeof buildTransfer>["exportOutcomeFiles"];
	wake: (conversationId: string, message: string) => boolean;
	gate: ApprovalGate;
	scheduleDrain: () => void;
	admitAttempts: Map<number, number>;
	retryAfter: Map<number, number>;
	recoveryPending: Set<number>;
	recoveryAttempts: Map<number, { count: number; lastError: string }>;
	isClosing: () => boolean;
	isHarnessClosed: () => boolean;
}

export interface Settle {
	notify(row: SubagentRun): void;
	releaseLeases(row: SubagentRun): void;
	completeStop(id: number): Promise<void>;
	finalize(
		rowId: number,
		rev: number,
		unanswered?: { reason: string; detail?: string | undefined },
	): Promise<void>;
	monitor(rowId: number, rev: number, submission: Submission): void;
	monitored(rowId: number): boolean;
	pendingMonitors(): Promise<void>[];
}

export function makeSettle(deps: SettleDeps): Settle {
	const state: MonitorState = { tasks: new Set(), perRun: new Map() };
	return {
		notify: (row) => notify(deps, row),
		releaseLeases: (row) => releaseLeases(deps, row),
		completeStop: (id) => completeStop(deps, id),
		finalize: (rowId, rev, unanswered) => finalize(deps, rowId, rev, unanswered),
		monitor: (rowId, rev, submission) => monitor(deps, state, rowId, rev, submission),
		monitored: (rowId) => (state.perRun.get(rowId)?.size ?? 0) > 0,
		pendingMonitors: () => [...state.tasks],
	};
}

function noticeBody(row: SubagentRun): string {
	let body = noticeResult(row);
	if (row.lifecycleNote !== null) body += `\nLifecycle warning: ${row.lifecycleNote}`;
	const crash = crashDecisionNotice(row.crashDecisions);
	if (crash !== null) body += `\n${crash}`;
	return body;
}

function noticeResult(row: SubagentRun): string {
	switch (row.status) {
		case "needs_input":
			return row.pendingApproval !== null
				? `Crash resolution needed — a restarted ${row.pendingApproval.tool} call may have partially run:\n${row.question ?? ""}`
				: `Question: ${row.question ?? ""}`;
		case "stopped":
			return "Stopped by the originating conversation.";
		case "failed":
			return row.error ?? "run failed";
		case "done": {
			let b = row.result ?? "";
			if (row.exportedFiles.length > 0) b += `\nExported: ${row.exportedFiles.join(", ")}`;
			if (row.exportErrors.length > 0) b += `\nExport refused: ${row.exportErrors.join("; ")}`;
			if (row.finalScreenshot !== null) b += `\nFinal screenshot: ${row.finalScreenshot}`;
			return b;
		}
		default:
			return `status: ${row.status}`;
	}
}

function notify(deps: SettleDeps, row: SubagentRun): void {
	if (deps.isClosing() || deps.isHarnessClosed()) return;
	const rev = row.noticeRev + 1;
	const fresh = deps.runs.update(row.id, { noticeRev: rev, noticePending: true });
	let ok = false;
	try {
		ok = deps.wake(
			fresh.conversationId,
			subagentNotice(fresh.id, fresh.kind, fresh.status, noticeBody(fresh)),
		);
	} catch (err) {
		log.warn("subagent wake threw — notice stays pending", err, { run: fresh.id });
	}
	if (ok) {
		deps.runs.ackNotice(fresh.id, rev);
	} else {
		log.warn("subagent notice not admitted — will retry on scan", { run: fresh.id });
	}
	log.info("subagent notice", { run: fresh.id, status: fresh.status, woke: ok });
}

function releaseLeases(deps: SettleDeps, row: SubagentRun): void {
	if (row.kind === "computer" && row.desktop !== null) {
		deps.desktops.release(row.desktop, deps.access.holderFor(row.id)).catch((err) =>
			log.warn("desktop release on settle failed", err, {
				run: row.id,
				desktop: row.desktop,
			}),
		);
	}
}

// Stop persists the intent before the abort joins through the lane,
// so a mid-flight admission sees it at its next boundary; an abort
// failure leaves the intent for scan retry, with the slot held.
async function completeStop(deps: SettleDeps, id: number): Promise<void> {
	const { runs, lane, harness, gate, admitAttempts, retryAfter, recoveryAttempts } = deps;
	const { asConv } = deps.access;
	await lane(id, async () => {
		const row = runs.get(id);
		if (row === null || row.status === "stopped") return;
		if (row.piConversationId !== null) {
			// A closed harness can't confirm the abort: never claim
			// stopped while Pi work may still be live.
			if (deps.isHarnessClosed()) {
				throw new SubagentError("harness closed — stop cannot be confirmed");
			}
			const conv = await harness.conversation(asConv(row.piConversationId), ctx);
			await conv?.abort(ctx, { background: true });
			await conv?.waitForIdle(ctx);
		}
		const stopped = runs.update(id, {
			status: "stopped",
			finishedAt: Date.now(),
			noticePending: true,
			pendingApproval: null,
		});
		if (row.piConversationId !== null) gate.dropForConversation(row.piConversationId);
		admitAttempts.delete(id);
		retryAfter.delete(id);
		recoveryAttempts.delete(id);
		log.info("subagent stopped", { run: id, kind: stopped.kind });
		releaseLeases(deps, stopped);
		notify(deps, stopped);
	});
}

// A failure with no terminal call still explains itself: on a clean
// provider stop the last assistant's recorded stopReason (length =
// truncation) is the only witness left.
async function lastAssistantStopReason(
	deps: SettleDeps,
	piConversationId: string,
): Promise<string | null> {
	const conv = await deps.harness.conversation(deps.access.asConv(piConversationId), ctx);
	if (conv === undefined) return null;
	const page = await conv.entries({}, 8, undefined, ctx);
	for (const entry of page.items) {
		const last = entry.model?.findLast((m) => m.role === "assistant");
		if (last !== undefined) return last.stopReason ?? null;
	}
	return null;
}

async function finalize(
	deps: SettleDeps,
	rowId: number,
	rev: number,
	unanswered?: { reason: string; detail?: string | undefined },
): Promise<void> {
	const { runs, lane, harness, exportOutcomeFiles } = deps;
	const { asConv } = deps.access;
	await lane(rowId, async () => {
		// A close landing mid-finalize leaves the row recoverable
		// `running`: the doc outcome and landed exports are durable,
		// and the next boot's finalize resumes from them.
		const closingNow = () => deps.isClosing() || deps.isHarnessClosed();
		const preempted = (): boolean => {
			if (closingNow()) return true;
			const cur = runs.get(rowId);
			return cur === null || cur.stopRequested || cur.status === "stopped";
		};
		const row = runs.get(rowId);
		if (row === null) return;
		if (row.status === "stopped" || row.status === "done" || row.status === "failed") return;
		if (row.stopRequested) return;
		if (row.inputRev > rev || row.inputIntent !== null) return;
		if (closingNow()) return;
		if (row.piConversationId === null) {
			if (preempted()) return;
			runs.update(rowId, {
				status: "failed",
				error: "no Pi conversation recorded",
				noticePending: true,
				finishedAt: Date.now(),
			});
			return;
		}
		// Pi commits are durable — after waitForIdle a single read is
		// authoritative; a storage error propagates to the caller.
		const doc = await harness.snapshot(RunDoc, asConv(row.piConversationId), ctx);
		if (preempted()) return;
		const recorded = doc?.outcome ?? null;
		const outcome = recorded !== null && recorded.rev === rev ? recorded : null;
		log.info("subagent settle", { run: rowId, outcome: outcome?.kind ?? null, unanswered });
		if (outcome?.kind === "done") {
			const { exported, errors } = await exportOutcomeFiles(row, outcome.files);
			if (preempted()) return;
			let finalScreenshot = row.finalScreenshot;
			if (row.kind === "computer" && row.desktop !== null && finalScreenshot === null) {
				try {
					const shot = await deps.desktops.screenshot(row.desktop);
					const out = exportNamedBytes(
						row.workspace,
						join("subagents", String(row.id)),
						"final.png",
						shot.bytes,
					);
					if ("error" in out) errors.push(`final screenshot: ${out.error}`);
					else {
						finalScreenshot = out.rel;
						runs.update(rowId, { finalScreenshot });
					}
				} catch (err) {
					if (
						err instanceof DesktopError ||
						err instanceof SandboxError ||
						err instanceof PodmanError
					) {
						errors.push(`final screenshot: ${err.message}`);
					} else {
						throw err;
					}
				}
			}
			if (preempted()) return;
			const done = runs.update(rowId, {
				status: "done",
				result: outcome.result,
				exportedFiles: exported,
				exportErrors: errors,
				noticePending: true,
				finishedAt: Date.now(),
			});
			releaseLeases(deps, done);
			notify(deps, done);
		} else if (outcome?.kind === "ask") {
			if (preempted()) return;
			const waiting = runs.update(rowId, {
				status: "needs_input",
				question: outcome.question,
				noticePending: true,
			});
			releaseLeases(deps, waiting);
			notify(deps, waiting);
		} else if (outcome?.kind === "aborted") {
			if (preempted()) return;
			const failed = runs.update(rowId, {
				status: "failed",
				error: outcome.reason,
				noticePending: true,
				finishedAt: Date.now(),
			});
			releaseLeases(deps, failed);
			notify(deps, failed);
		} else {
			let error: string;
			if (unanswered !== undefined) {
				error = `input went unanswered: ${unanswered.reason}`;
				if (unanswered.detail !== undefined && unanswered.detail.length > 0)
					error += ` — ${unanswered.detail}`;
			} else {
				const lastStop = await lastAssistantStopReason(deps, row.piConversationId);
				if (preempted()) return;
				error =
					lastStop === "length"
						? "the model's reply hit the output limit (stop reason length) before any terminal tool call"
						: lastStop !== null && lastStop !== "stop"
							? `the run ended on stop reason ${lastStop} without a terminal tool call`
							: "the run settled without a terminal tool call — plain prose is never a completion";
			}
			const failed = runs.update(rowId, {
				status: "failed",
				error,
				noticePending: true,
				finishedAt: Date.now(),
			});
			releaseLeases(deps, failed);
			notify(deps, failed);
		}
	});
}

function monitor(
	deps: SettleDeps,
	state: MonitorState,
	rowId: number,
	rev: number,
	submission: Submission,
): void {
	const { runs, harness, recoveryPending, recoveryAttempts, scheduleDrain } = deps;
	const { asConv } = deps.access;
	const task = (async () => {
		try {
			const settled = await submission.wait(ctx);
			if (deps.isClosing() || deps.isHarnessClosed()) return;
			// submission.wait resolves on the answer entry; the
			// terminal tool's doc commit lands with the round — idle
			// first so a recorded finish is never read as "no outcome".
			const row = runs.get(rowId);
			if (row?.piConversationId != null) {
				const conv = await harness.conversation(asConv(row.piConversationId), ctx);
				await conv?.waitForIdle(ctx);
			}
			await finalize(
				deps,
				rowId,
				rev,
				settled.status === "unanswered"
					? {
							reason: settled.reason ?? "unknown",
							detail:
								settled.detail === undefined
									? undefined
									: typeof settled.detail === "string"
										? settled.detail
										: JSON.stringify(settled.detail),
						}
					: undefined,
			);
			recoveryAttempts.delete(rowId);
		} catch (err) {
			if (deps.isClosing() || deps.isHarnessClosed()) return;
			log.error("subagent monitor failed — the run stays owned for recovery", err, {
				run: rowId,
			});
			recoveryAttempts.set(rowId, {
				count: recoveryAttempts.get(rowId)?.count ?? 0,
				lastError: err instanceof Error ? err.message : String(err),
			});
			recoveryPending.add(rowId);
		} finally {
			scheduleDrain();
		}
	})();
	state.tasks.add(task);
	const watching = state.perRun.get(rowId) ?? new Set<Promise<void>>();
	watching.add(task);
	state.perRun.set(rowId, watching);
	void task.finally(() => {
		state.tasks.delete(task);
		watching.delete(task);
		if (watching.size === 0) state.perRun.delete(rowId);
	});
}
