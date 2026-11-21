// The delegation lifecycle's six verbs — launch, send, answer, stop,
// stopByOperator, read.

import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { durableCopyFile, fsyncDirectory } from "./durable.ts";
import { log } from "./log.ts";
import { agentNameFor } from "./delegations.ts";
import { attachHintFor, HcError } from "./hc-delegation.ts";
import { seedHarnessTrust } from "./harness-trust.ts";
import { delegationNoticeTag } from "./tags.ts";
import type {
	AnswerOutcome,
	DelegationLifecycleDeps,
	LaunchInput,
	LaunchOutcome,
	ReadOutcome,
	SendOutcome,
	StopOutcome,
} from "./delegation-lifecycle.ts";
import { notify, readScreenTail } from "./delegation-notices.ts";
import {
	killQuietly,
	reportDirFor,
	reportNote,
	reportPathFor,
} from "./delegation-paths.ts";
import type { WorkerSendRefusal } from "./responsibility-authority.ts";

// Either way the stop is the operator's call, not a fault to repair.
const OPERATOR_STOP_NOTE =
	"(the operator stopped it from the app — accept the stop; don't relaunch, retry or resend unless the operator asks)";
export const OUTSIDE_STOP_NOTE =
	"(the agent ended outside goblin — most likely the operator stopped it by hand; treat it as the operator's stop, not a failure: don't relaunch, retry or resend unless the operator asks)";

class NoPreviousReport extends Error {
	constructor() {
		super("no previous report");
	}
}

export async function launch(deps: DelegationLifecycleDeps, input: LaunchInput): Promise<LaunchOutcome> {
	const d = deps.delegations.create({
		name: input.name,
		harness: input.harness.name,
		cwd: input.cwd,
		task: input.task,
		role: input.role ?? "default",
		...(input.pr === undefined ? {} : { pr: input.pr }),
		address: input.address,
		...(input.appConversation === undefined ? {} : { appConversation: input.appConversation }),
		...(input.responsibilityId === undefined
			? {}
			: {
					responsibilityId: input.responsibilityId,
					responsibilityRevision: deps.responsibilityRevision?.(input.responsibilityId) ?? null,
				}),
	});
	// A failed launch must close any bound workspace — no watcher owns
	// cleanup after the failure.
	const fail = async (why: string, screen?: string): Promise<LaunchOutcome> => {
		// A raced stop owns cleanup; re-read so failure handling neither
		// overwrites its verdict nor closes the workspace twice.
		const raced = deps.delegations.get(d.id);
		if (raced?.status === "stopped") {
			log.info("delegation stopped during start failure", {
				delegation: d.id,
				name: d.name,
			});
			return { kind: "stopped", delegation: raced };
		}
		deps.delegations.setStatus(d.id, "failed");
		const bound = deps.delegations.get(d.id);
		if (bound?.workspaceId) {
			await killQuietly(deps, d.id, bound.workspaceId);
		}
		log.info("delegation failed at start", { delegation: d.id, name: d.name, why });
		return screen === undefined
			? { kind: "failed", delegation: bound ?? d, why }
			: { kind: "failed", delegation: bound ?? d, why, screen };
	};
	const hc = deps.hc;
	try {
		mkdirSync(reportDirFor(deps, d.id), { recursive: true });
	} catch (err) {
		return fail(
			`report directory unavailable: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	const agentName = agentNameFor(d.id, input.name);
	const terminalName = agentName;
	// No row can own the workspace until bindLaunch; a process death in that
	// gap leaves an orphan boot recovery cannot identify.
	try {
		deps.delegations.bindLaunch(d.id, {
			agentName,
			workspaceId: terminalName,
			paneId: terminalName,
		});
	} catch (err) {
		// Nothing to clean up: the terminal starts only after the bind.
		log.error("delegation workspace bind failed", err, {
			delegation: d.id,
			terminal: terminalName,
		});
		throw err;
	}
	// A stop may win before binding — re-read so the bound workspace is closed
	// and the stopped row never starts an agent.
	let row = deps.delegations.get(d.id);
	if (row?.status === "stopped") {
		await killQuietly(deps, d.id, terminalName);
		log.info("delegation stopped during workspace creation", {
			delegation: d.id,
			name: d.name,
		});
		return { kind: "stopped", delegation: row };
	}

	// Seed first-run trust gates before starting the harness, while the terminal is
	// still quiet. Local files fail loudly; existing trust decisions are
	// preserved.
	try {
		const seeded = seedHarnessTrust(input.harness.kind, input.cwd, deps.homeDir);
		log.info("delegation trust seed", {
			delegation: d.id,
			kind: input.harness.kind,
			cwd: input.cwd,
			seeded: seeded.length > 0 ? seeded : "no recipe",
		});
	} catch (err) {
		return fail(`trust seed failed: ${err instanceof Error ? err.message : String(err)}`);
	}

	try {
		await hc.start(agentName, input.harness.kind, input.cwd, input.harness.args);
	} catch (err) {
		// Keep a startup-blocked terminal alive and return its screen as untrusted data.
		let screen: string | undefined;
		try {
			screen = await hc.read(agentName, 40);
		} catch (err2) {
			log.warn("delegation start-failure screen unreadable", err2, {
				delegation: d.id,
			});
		}
		// A blocked startup parks the workspace with its task owed; the watcher
		// delivers it after the dialog advances the seq.
		if (err instanceof HcError && err.code === "agent_not_ready") {
			// Baseline the park after the observed seq so the owed prompt waits
			// for a real advance — a fresh row's startup seq would otherwise
			// trigger a guaranteed-rejected prompt.
			let parkedSeq: number | null = null;
			try {
				parkedSeq = (await hc.get(agentName))?.state_change_seq ?? null;
			} catch (err2) {
				// A failed get leaves the park pending; the next poll captures.
				log.warn("delegation park baseline read failed — watcher will capture", err2, {
					delegation: d.id,
				});
			}
			deps.delegations.markParked(d.id, parkedSeq);
			const parked = deps.delegations.get(d.id) ?? d;
			if (parked.status === "stopped") {
				await killQuietly(deps, d.id, terminalName);
				return { kind: "stopped", delegation: parked };
			}
			log.info("delegation parked at startup dialog", {
				delegation: d.id,
				name: d.name,
			});
			await notify(deps, parked, "needs input", {
				extra: `(blocked at startup — the task hasn't been sent yet; relay a keypress with action 'answer' or attach with \`${attachHintFor(agentName)}\`)`,
			});
			return { kind: "parked", delegation: parked };
		}
		return fail(err instanceof Error ? err.message : String(err), screen);
	}
	row = deps.delegations.get(d.id);
	if (row?.status === "stopped") {
		// Never prompt after a stop wins during startup.
		log.info("delegation stopped during agent start", { delegation: d.id, name: d.name });
		return { kind: "stopped", delegation: row };
	}

	// Start the prompt clock before sending so work completed mid-launch is fresh
	// rather than mistaken for stale work by the report check.
	const promptedAt = new Date();
	try {
		await hc.prompt(agentName, input.task + reportNote(deps, d));
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err));
	}
	// Never default a failed baseline read to 0 — startup already advances
	// seq, so 0 would make the first idle glance look like completed work.
	let baseline: number | null = null;
	try {
		baseline = (await hc.get(agentName))?.state_change_seq ?? null;
	} catch (err) {
		// Leave reconciliation to the next scan's capture.
		log.warn("delegation baseline read failed — watcher will capture", err, {
			delegation: d.id,
		});
	}
	const applied = deps.delegations.markRunning(d.id, baseline, promptedAt);
	if (applied === null) {
		// A raced stop owns the verdict, but this launch still closes the
		// workspace it left behind — no watcher remains.
		await killQuietly(deps, d.id, terminalName);
		log.info("delegation stopped while launching", {
			delegation: d.id,
			name: d.name,
		});
		return { kind: "stopped", delegation: deps.delegations.get(d.id) ?? d };
	}
	log.info("delegation started", {
		delegation: d.id,
		name: d.name,
		harness: input.harness.name,
		kind: input.harness.kind,
		cwd: input.cwd,
		conversation: `${input.address.chatId}/${input.address.threadId ?? "-"}`,
	});
	return { kind: "started", delegation: deps.delegations.get(d.id) ?? applied };
}

export async function send(
	deps: DelegationLifecycleDeps,
	id: number,
	text: string,
	authorize?: (responsibilityId: string) => WorkerSendRefusal | null,
): Promise<SendOutcome> {
	const d = deps.delegations.get(id);
	if (d === null) return { kind: "no row", id };
	// Keep the workspace for follow-up; startup, never-launched, and owed-prompt
	// rows are refused below.
	if (d.status === "stopped") return { kind: "refused", id, why: "stopped" };
	if (d.status === "starting") return { kind: "refused", id, why: "starting" };
	if (!d.agentName) return { kind: "refused", id, why: "never launched" };
	// A parked startup row cannot accept text until its dialog is cleared.
	if (d.promptPending) return { kind: "refused", id, why: "task never sent" };
	if (d.responsibilityId !== null) {
		const refusal = authorize === undefined ? "outside-project" : authorize(d.responsibilityId);
		if (refusal !== null) {
			log.info("delegation send refused — responsibility authority", {
				delegation: d.id,
				responsibility: d.responsibilityId,
				refusal,
			});
			return { kind: "refused", id, why: refusal };
		}
	}
	// Archive the previous report before prompting; only a post-prompt report
	// may complete the new run, while the old result remains inspectable. Its mtime
	// may fall inside the freshness allowance.
	let archivedPath: string | null = null;
	{
		const reportPath = reportPathFor(deps, d);
		try {
			const destination = join(reportDirFor(deps, d.id), `report-${randomUUID()}.md`);
			// ENOENT is the expected "no previous report" — only here: once the
			// rename landed, a vanished archive is a real failure, never a quiet
			// "nothing to archive" with archivedPath pointing at nothing.
			try {
				renameSync(reportPath, destination);
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new NoPreviousReport();
				throw err;
			}
			archivedPath = destination;
			// Re-copy the archive into a fresh inode so a writer still holding
			// the old one cannot overwrite it, and keep the old mtime — the
			// freshness check reads it.
			const oldTimes = statSync(destination);
			durableCopyFile(destination, destination, {
				times: { atime: oldTimes.atime, mtime: oldTimes.mtime },
			});
			log.info("delegation previous report archived", {
				delegation: d.id,
				reportPath: reportPathFor(deps, d),
				archivedPath,
			});
		} catch (err) {
			if (!(err instanceof NoPreviousReport)) {
				log.error("delegation report archive failed", err, { delegation: d.id, reportPath });
				return { kind: "prompt failed", error: `report archive failed: ${String(err)}` };
			}
		}
	}
	const promptedAt = new Date();
	try {
		// No await separates authority check from hc.prompt, so it holds at the wire.
		// Include the report instruction on every prompt so notices have a result channel.
		await deps.hc.prompt(d.agentName, text + reportNote(deps, d));
	} catch (err) {
		let error = err instanceof Error ? err.message : String(err);
		// A blocked prompt must direct callers to the answer action.
		if (err instanceof HcError && err.code === "agent_blocked") {
			error +=
				" — the agent is blocked on a dialog; relay the operator's keypress with action 'answer'";
		}
		log.error("delegation prompt failed", err, { delegation: d.id, name: d.name });
		if (archivedPath !== null) {
			const restoreTemp = join(reportDirFor(deps, d.id), `.report-restore-${randomUUID()}`);
			try {
				// A new report may arrive during prompt. Copy before linking: agents
				// write report.md in place, so sharing the archive inode would
				// overwrite old work; the copy keeps the archive's mtime so the
				// restore can't read as a fresh report.
				const oldTimes = statSync(archivedPath);
				durableCopyFile(archivedPath, restoreTemp, {
					times: { atime: oldTimes.atime, mtime: oldTimes.mtime },
				});
				// link, not rename: EEXIST is the "a newer report landed" signal.
				linkSync(restoreTemp, reportPathFor(deps, d));
				fsyncDirectory(reportDirFor(deps, d.id));
				log.info("delegation previous report restored", {
					delegation: d.id,
					reportPath: reportPathFor(deps, d),
					archivedPath,
				});
			} catch (restoreErr) {
				if ((restoreErr as NodeJS.ErrnoException).code === "EEXIST") {
					log.warn("delegation previous report not restored — newer report exists", {
						delegation: d.id,
						reportPath: reportPathFor(deps, d),
						archivedPath,
					});
				} else {
					log.error("delegation previous report restoration failed", restoreErr, {
						delegation: d.id,
						reportPath: reportPathFor(deps, d),
						archivedPath,
					});
					return {
						kind: "prompt failed",
						error: `${error}; report restoration failed: ${String(restoreErr)}`,
					};
				}
			} finally {
				try {
					unlinkSync(restoreTemp);
				} catch (cleanupErr) {
					if ((cleanupErr as NodeJS.ErrnoException).code !== "ENOENT") {
						log.warn("delegation restore temp cleanup failed", cleanupErr, {
							delegation: d.id,
							restoreTemp,
						});
					}
				}
			}
		}
		return { kind: "prompt failed", error };
	}
	// The fresh prompt needs a fresh baseline; a failed read stays pending so
	// the watcher captures after the prompt instead of reporting done at idle.
	let seq: number | null = null;
	try {
		seq = (await deps.hc.get(d.agentName))?.state_change_seq ?? null;
	} catch (err) {
		log.warn("delegation post-send baseline read failed — watcher will capture", err, {
			delegation: d.id,
		});
	}
	if (deps.delegations.markRunning(d.id, seq, promptedAt) === null) {
		return { kind: "stopped mid send", id };
	}
	log.info("delegation prompted", { delegation: d.id, name: d.name });
	return { kind: "sent", delegation: deps.delegations.get(d.id) ?? d };
}

// Dialogs reject text prompts, so answer only sends the whitelisted key. The
// watcher observes its seq effect and owns every resulting transition.
export async function answer(
	deps: DelegationLifecycleDeps,
	id: number,
	key: string,
): Promise<AnswerOutcome> {
	const d = deps.delegations.get(id);
	if (d === null) return { kind: "no row", id };
	if (d.status === "stopped") return { kind: "refused", id, why: "stopped" };
	if (d.status === "starting") return { kind: "refused", id, why: "starting" };
	if (!d.agentName) return { kind: "refused", id, why: "never launched" };
	// A keypress only reaches a dialog that owns the terminal; typing one into
	// a working or idle agent corrupts its draft. Preflight the live
	// status — only a blocked agent takes keys (#493-L28).
	let agentStatus: string | null;
	try {
		agentStatus = (await deps.hc.get(d.agentName))?.agent_status ?? null;
	} catch (err) {
		log.error("delegation answer preflight failed", err, {
			delegation: d.id,
			name: d.name,
		});
		return { kind: "key failed", id, error: err instanceof Error ? err.message : String(err) };
	}
	if (agentStatus !== "blocked") {
		return { kind: "refused", id, why: agentStatus === null ? "agent gone" : "not blocked" };
	}
	try {
		await deps.hc.sendKey(d.agentName, key);
	} catch (err) {
		log.error("delegation answer key failed", err, { delegation: d.id, name: d.name, key });
		return { kind: "key failed", id, error: err instanceof Error ? err.message : String(err) };
	}
	log.info("delegation dialog key sent", { delegation: d.id, name: d.name, key });
	return { kind: "sent", delegation: deps.delegations.get(d.id) ?? d };
}

export async function stop(deps: DelegationLifecycleDeps, id: number): Promise<StopOutcome> {
	const d = deps.delegations.get(id);
	if (d === null) return { kind: "no row", id };
	const notes: string[] = [];
	if (d.status === "running" || d.status === "needs_input") {
		try {
			await deps.hc.interrupt(d.agentName);
		} catch (err) {
			notes.push(`interrupt: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	// Mark stopped only when no unseen workspace/agent can remain running; a failed
	// close triggers an explicit liveness check.
	let closeFailed = false;
	if (d.workspaceId) {
		try {
			await deps.hc.kill(d.workspaceId);
		} catch (err) {
			closeFailed = true;
			notes.push(`close: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	if (closeFailed) {
		let alive = true;
		if (d.agentName) {
			try {
				alive = (await deps.hc.get(d.agentName)) !== null;
			} catch (err) {
				notes.push(`agent check: ${err instanceof Error ? err.message : String(err)}`);
			}
		} else {
			alive = false;
		}
		if (alive) {
			log.warn("delegation stop refused — agent may still be running", {
				delegation: d.id,
				name: d.name,
				notes,
			});
			return { kind: "still running", delegation: d, notes };
		}
	}
	deps.delegations.setStatus(d.id, "stopped");
	log.info("delegation stopped", { delegation: d.id, name: d.name, notes });
	return { kind: "stopped", delegation: deps.delegations.get(d.id) ?? d, notes };
}

export async function stopByOperator(deps: DelegationLifecycleDeps, id: number): Promise<StopOutcome> {
	const before = deps.delegations.get(id);
	const out = await stop(deps, id);
	log.info("delegation stop by operator", { delegation: id, outcome: out.kind });
	// A finished row's stop is cleanup — nothing was cut short, so no notice.
	if (out.kind !== "stopped" || before === null) return out;
	if (before.status === "done" || before.status === "failed" || before.status === "stopped") {
		return out;
	}
	// The row is already stopped and a retried stop sends nothing, so this is
	// the notice's only chance: an unreadable report must not cost it.
	const d = out.delegation;
	let landed: boolean;
	try {
		landed = await notify(deps, d, "stopped", { extra: OPERATOR_STOP_NOTE });
	} catch (err) {
		log.error("delegation stop notice body unreadable — sending header only", err, {
			delegation: d.id,
		});
		const body = `(report unreadable: ${err instanceof Error ? err.message : String(err)})`;
		deps.settled?.(d, "stopped", body);
		const text = `${delegationNoticeTag(d.id, d.name, "stopped", OPERATOR_STOP_NOTE)}\n\n${body}`;
		landed =
			d.appConversation !== null
				? deps.wakeApp(d.appConversation, text)
				: deps.wake({ chatId: d.chatId, threadId: d.threadId }, text);
	}
	if (!landed) {
		log.error("delegation stop notice lost", undefined, { delegation: d.id });
		return { ...out, notes: [...out.notes, "goblin's conversation was not told about this stop"] };
	}
	return out;
}

export async function read(
	deps: DelegationLifecycleDeps,
	id: number,
	lines: number,
): Promise<ReadOutcome> {
	const d = deps.delegations.get(id);
	if (d === null) return { kind: "no row", id };
	if (!d.agentName) return { kind: "never launched", delegation: d };
	try {
		return { kind: "screen", delegation: d, screen: await readScreenTail(deps, d, lines) };
	} catch (err) {
		return { kind: "unreadable", id, error: err instanceof Error ? err.message : String(err) };
	}
}
