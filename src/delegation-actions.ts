// The delegation lifecycle's verbs — launch, send, stop, stopByOperator,
// read — over the T3 Code transport: a thread start carries the message,
// a busy thread queues follow-ups, and there are no startup dialogs to
// answer.

import { log } from "./log.ts";
import { T3Error } from "./t3.ts";
import { delegationNoticeTag } from "./tags.ts";
import type {
	DelegationLifecycleDeps,
	LaunchInput,
	LaunchOutcome,
	ReadOutcome,
	SendOutcome,
	StopOutcome,
} from "./delegation-lifecycle.ts";
import { leadNote } from "./delegation-paths.ts";
import { notify } from "./delegation-notices.ts";

// Either way the stop is the operator's call, not a fault to repair.
const OPERATOR_STOP_NOTE =
	"(the operator stopped it from the app — accept the stop; don't relaunch, retry or resend unless the operator asks)";
export const OUTSIDE_STOP_NOTE =
	"(the run ended outside goblin — most likely the operator stopped it in T3 Code; treat it as the operator's stop, not a failure: don't relaunch, retry or resend unless the operator asks)";

export async function launch(deps: DelegationLifecycleDeps, input: LaunchInput): Promise<LaunchOutcome> {
	const d = deps.delegations.create({
		name: input.name,
		harness: input.harness.name,
		cwd: input.cwd,
		task: input.task,
		role: input.role ?? "default",
		...(input.issue === undefined ? {} : { issue: input.issue }),
		address: input.address,
		...(input.appConversation === undefined ? {} : { appConversation: input.appConversation }),
		...(input.responsibilityId === undefined
			? {}
			: {
					responsibilityId: input.responsibilityId,
					responsibilityRevision: deps.responsibilityRevision?.(input.responsibilityId) ?? null,
				}),
	});
	// A failed launch has no thread to clean up — the row is the only
	// side effect, and it says failed.
	const fail = async (why: string): Promise<LaunchOutcome> => {
		// A raced stop owns the verdict; re-read so failure handling
		// never overwrites it.
		const raced = deps.delegations.get(d.id);
		if (raced?.status === "stopped") {
			log.info("delegation stopped during start failure", {
				delegation: d.id,
				name: d.name,
			});
			return { kind: "stopped", delegation: raced };
		}
		deps.delegations.setStatus(d.id, "failed");
		log.info("delegation failed at start", { delegation: d.id, name: d.name, why });
		return { kind: "failed", delegation: deps.delegations.get(d.id) ?? d, why };
	};

	let started;
	try {
		started = await deps.t3.startThread({
			project: input.cwd,
			message: input.task + leadNote(d),
			provider: input.harness.provider,
			model: input.harness.model,
			...(input.harness.options === undefined ? {} : { options: input.harness.options }),
			title: input.name,
		});
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err));
	}
	deps.delegations.bindThread(d.id, {
		t3Thread: started.threadId,
		t3Link: null,
		t3Run: started.runId,
	});
	// The link arrives with show; fetch it once so the tool result and
	// every later notice can carry it without a call.
	let link: string | null = null;
	let runtimeMode: string | undefined;
	try {
		const shown = await deps.t3.showThread(started.threadId, 1);
		link = shown?.thread.link ?? null;
		runtimeMode = shown?.thread.runtimeMode;
	} catch (err) {
		// The thread exists — the link fetch is cosmetic and retries
		// implicitly through the watcher's own reads.
		log.warn("delegation link fetch failed", err, { delegation: d.id, thread: started.threadId });
	}
	const applied = deps.delegations.markRunning(d.id, started.runId, link, new Date());
	if (applied === null) {
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
		provider: input.harness.provider,
		model: input.harness.model,
		...(input.harness.options === undefined ? {} : { options: input.harness.options }),
		...(runtimeMode === undefined ? {} : { runtimeMode }),
		thread: started.threadId,
		cwd: input.cwd,
		conversation: `${input.address.chatId}/${input.address.threadId ?? "-"}`,
	});
	return { kind: "started", delegation: deps.delegations.get(d.id) ?? applied };
}

export async function send(deps: DelegationLifecycleDeps, id: number, text: string): Promise<SendOutcome> {
	const d = deps.delegations.get(id);
	if (d === null) return { kind: "no row", id };
	// A starting row has no thread to address yet; a stopped one is
	// gone; a row without a thread is a pre-t3 leftover.
	if (d.status === "stopped") return { kind: "refused", id, why: "stopped" };
	if (d.status === "starting") return { kind: "refused", id, why: "starting" };
	if (d.t3Thread === null) return { kind: "refused", id, why: "never launched" };
	let out;
	try {
		// A busy thread queues the text as its next turn; a waiting one
		// takes it as the answer. Nothing is interrupted either way.
		out = await deps.t3.sendThread(d.t3Thread, text + leadNote(d));
	} catch (err) {
		log.error("delegation send failed", err, { delegation: d.id, name: d.name });
		return { kind: "send failed", id, error: err instanceof Error ? err.message : String(err) };
	}
	if (deps.delegations.markRunning(d.id, out.runId, out.link, new Date()) === null) {
		return { kind: "refused", id, why: "stopped" };
	}
	log.info("delegation sent", { delegation: d.id, name: d.name, run: out.runId });
	return { kind: "sent", delegation: deps.delegations.get(id) ?? d };
}

export async function stop(deps: DelegationLifecycleDeps, id: number): Promise<StopOutcome> {
	const d = deps.delegations.get(id);
	if (d === null) return { kind: "no row", id };
	// t3 v0.1.9 has no stop or interrupt verb: a live T3 thread cannot
	// be ended from goblin. Say so honestly — never fake a stop, never
	// strand the row as stopped while the run continues.
	if (d.status === "running" || d.status === "needs_input" || d.status === "starting") {
		log.info("delegation stop unavailable — t3 has no stop verb", {
			delegation: d.id,
			name: d.name,
		});
		return { kind: "unavailable", delegation: d };
	}
	// A finished row's stop is cleanup: nothing runs host-side, the row
	// just records the operator's intent.
	deps.delegations.setStatus(d.id, "stopped");
	log.info("delegation stopped (row cleanup)", { delegation: d.id, name: d.name });
	return { kind: "stopped", delegation: deps.delegations.get(d.id) ?? d, notes: [] };
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
	// Unreachable today (a live row's stop is unavailable), kept for the
	// day t3 grows a stop verb: the notice contract stands.
	const d = out.delegation;
	const body = "(stopped from the app)";
	deps.settled?.(d, "stopped", body);
	const text = `${delegationNoticeTag(d.id, d.name, "stopped", OPERATOR_STOP_NOTE)}\n\n${body}`;
	const landed =
		d.appConversation !== null
			? deps.wakeApp(d.appConversation, text)
			: deps.wake({ chatId: d.chatId, threadId: d.threadId }, text);
	if (!landed) {
		log.error("delegation stop notice lost", undefined, { delegation: d.id });
		return { ...out, notes: [...out.notes, "goblin's conversation was not told about this stop"] };
	}
	return out;
}

export async function read(
	deps: DelegationLifecycleDeps,
	id: number,
	messages: number,
): Promise<ReadOutcome> {
	const d = deps.delegations.get(id);
	if (d === null) return { kind: "no row", id };
	if (d.t3Thread === null) return { kind: "never launched", delegation: d };
	try {
		const shown = await deps.t3.showThread(d.t3Thread, messages);
		if (shown === null) return { kind: "unreadable", id, error: "thread no longer exists in T3 Code" };
		return {
			kind: "thread",
			delegation: d,
			messages: shown.messages.map((m) => ({ role: m.role, text: m.text })),
		};
	} catch (err) {
		if (err instanceof T3Error) {
			log[err.kind === "fatal" ? "error" : "warn"]("delegation read unavailable", err, {
				delegation: id,
				thread: d.t3Thread,
				boundary: err.boundary,
				kind: err.kind,
			});
			return { kind: "unreadable", id, error: err.message };
		}
		return { kind: "unreadable", id, error: err instanceof Error ? err.message : String(err) };
	}
}
