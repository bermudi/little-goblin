// Read-only attention projection over the durable owners. Items point at
// the surface that can resolve them; this module records no second state.

import type { AppConversationSummary } from "../conversation.ts";
import { responsibilityStage } from "../responsibility-stage.ts";
import { listProposedSkills } from "../stateview.ts";
import { conversationName } from "./operator.ts";
import { changesSummary, programChanges } from "./app-program-diff.ts";
import { type AppChannelDeps, NO_STORE } from "./app-shared.ts";
import type { AppAttentionItem, AppAttentionPage, AppAttentionResponse } from "./app-wire.ts";

const STAGE_TITLE: Partial<Record<string, string>> = {
	question: "Question",
	review: "Ready for review",
	blocked: "Blocked",
	failed: "Failed",
};

// What to do about a failed memory save, from the error text the queue
// stored (a Hindsight status code or a transport failure). Unknown text
// gets the honest generic answer.
function memoryFix(error: string | null): string {
	const text = error ?? "";
	if (/\b40[13]\b|unauthori[sz]ed|forbidden|api key|auth/i.test(text)) {
		return "Memory's model provider rejects its key. Update the key, restart memory, then try again.";
	}
	if (/\b429\b|rate.?limit|quota/i.test(text)) {
		return "The model provider is limiting memory's requests. Wait a while or check the plan, then try again.";
	}
	if (/\b5\d\d\b|ECONN|timed? ?out|fetch failed|unreachable/i.test(text)) {
		return "Memory's server failed or can't be reached. Check that it is running, then try again.";
	}
	return "Check the memory service log for the reason, fix it, then try again.";
}

function pageItem(
	item: Omit<AppAttentionItem, "target"> & { page: AppAttentionPage },
): AppAttentionItem {
	const { page, ...rest } = item;
	return { ...rest, target: { kind: "page", page } };
}

function conversationTitle(conv: AppConversationSummary): string {
	return conv.title ?? conv.id;
}

function callsNeedingDecisions(calls: { state: string }[]): number {
	return calls.filter((c) => c.state === "dispatched").length;
}

export async function handleAttentionRoute(
	req: Request,
	url: URL,
	deps: AppChannelDeps,
): Promise<Response | null> {
	if (url.pathname !== "/api/app/attention") return null;
	if (req.method !== "GET") {
		return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
	}

	const items: AppAttentionItem[] = [];
	const unavailable: string[] = [];

	if (deps.approvals === undefined) {
		unavailable.push("approvals");
	} else {
		for (const proposal of deps.approvals.program.pending()) {
			const candidate = deps.approvals.program.candidate(proposal);
			const base = deps.approvals.program.base(proposal);
			items.push(
				pageItem({
					id: `program-approval:${proposal.id}`,
					kind: "program-approval",
					title:
						proposal.kind === "create"
							? `New program — ${candidate?.name ?? proposal.draft?.name ?? `#${proposal.id}`}`
							: `Program update — ${candidate?.name ?? `program ${proposal.targetId ?? proposal.id}`}`,
					detail:
						proposal.kind === "create"
							? "standing authority needs approval"
							: candidate !== null && base !== null
								? `needs approval — ${changesSummary(programChanges(base, candidate))}`
								: "standing-authority update needs approval",
					createdAt: proposal.createdAt,
					page: "programs",
				}),
			);
		}
		for (const draft of deps.approvals.mail.pending()) {
			items.push(
				pageItem({
					id: `mail-approval:${draft.id}`,
					kind: "mail-approval",
					title: draft.subject === "" ? `Mail draft #${draft.id}` : draft.subject,
					detail:
						draft.status === "sending"
							? `send outcome unresolved — check Gmail Sent — to ${draft.to.join(", ")}`
							: `send approval — to ${draft.to.join(", ")}`,
					createdAt: draft.createdAt,
					page: "programs",
				}),
			);
		}
	}

	const memory = deps.operator?.memory;
	if (memory === undefined) {
		unavailable.push("memory");
	} else {
		const { queue, client } = memory;
		if (queue !== undefined && client !== undefined) {
			// One card per cause, not per exchange: the operator decides
			// about a failure, and its count comes from the whole queue.
			for (const cause of queue.blockedSummary(client.target).byCause) {
				items.push(
					pageItem({
						id: `memory-blocked:${cause.error ?? ""}`,
						kind: "memory-blocked",
						title:
							cause.count === 1
								? "Memory can't save 1 exchange"
								: `Memory can't save ${cause.count} exchanges`,
						detail: cause.error ?? "Saving failed; no error was recorded.",
						createdAt: cause.since,
						page: "memory",
						memory: {
							error: cause.error,
							count: cause.count,
							conversations: cause.conversations.map((c) => ({
								...c,
								name: conversationName(memory, c.conversationId),
							})),
							fix: memoryFix(cause.error),
						},
					}),
				);
			}
		}
	}

	const skills = deps.operator?.skillSources;
	if (skills === undefined) {
		unavailable.push("skills");
	} else {
		for (const skill of listProposedSkills(skills.skillsDir, skills.proposedDir)) {
			const { diff } = skill;
			const counts = (["changed", "added", "removed"] as const)
				.map((status) => [status, diff.files.filter((f) => f.status === status).length] as const)
				.filter(([, n]) => n > 0)
				.map(([status, n]) => `${n} ${status}`);
			items.push(
				pageItem({
					id: `skill-proposal:${skill.name}`,
					kind: "skill-proposal",
					title:
						diff.kind === "update" ? `Skill update — ${skill.name}` : `New skill — ${skill.name}`,
					detail:
						diff.kind === "update"
							? `${counts.length === 0 ? "no file differs from the installed copy" : counts.join(", ")} — review the diff, then install or discard`
							: `${skill.files.length} ${skill.files.length === 1 ? "file" : "files"} — review, then install or discard`,
					createdAt: skill.updatedAt,
					page: "skills",
				}),
			);
		}
	}

	const delegations = deps.operator?.delegations;
	if (delegations == null) {
		unavailable.push("delegations");
	} else {
		for (const delegation of delegations.list()) {
			if (delegation.status !== "needs_input") continue;
			items.push({
				id: `delegation-input:${delegation.id}`,
				kind: "delegation-input",
				title: `Delegation needs input — ${delegation.name}`,
				detail: delegation.task,
				createdAt: delegation.promptedAt,
				target:
					delegation.appConversation === null
						? { kind: "page", page: "delegations" }
						: { kind: "conversation", conversationId: delegation.appConversation },
			});
		}
	}

	// Open work whose derived stage waits on the operator. A pause is
	// the operator's own choice, not a request for attention.
	const resps = deps.responsibilities?.resps;
	if (resps === undefined) {
		unavailable.push("responsibilities");
	} else {
		for (const resp of resps.open()) {
			const latest = resps.latestReport(resp.responsibilityId);
			const stage = responsibilityStage(resp, latest, resps.operationsFor(resp.responsibilityId));
			if (stage.waitsFor !== "operator" || stage.stage === "paused") continue;
			items.push({
				id: `responsibility:${resp.responsibilityId}:${latest?.reportId ?? 0}`,
				kind: "responsibility",
				title: `${STAGE_TITLE[stage.stage] ?? "Needs you"} — ${resp.outcome}`,
				detail: stage.reason,
				createdAt: latest?.createdAt ?? resp.updatedAt,
				target: { kind: "conversation", conversationId: resp.coordinationConversationId },
			});
		}
	}

	const resumeOps = deps.resumeOps?.();
	if (resumeOps === undefined) {
		unavailable.push("recovery");
	} else {
		for (const conv of deps.store.listAppConversations()) {
			for (const view of resumeOps.interrupted(conv.id)) {
				const undecided = callsNeedingDecisions(view.calls);
				items.push({
					id: `interrupted-run:${view.run.runId}`,
					kind: "interrupted-run",
					title: `Interrupted turn — ${conversationTitle(conv)}`,
					detail:
						undecided === 0
							? `${view.calls.length} recorded calls — resume or abandon`
							: `${undecided} of ${view.calls.length} calls need decisions`,
					createdAt: view.run.createdAt,
					target: { kind: "conversation", conversationId: conv.id },
				});
			}
		}
	}

	items.sort((a, b) => {
		const at = a.createdAt === null ? "" : a.createdAt;
		const bt = b.createdAt === null ? "" : b.createdAt;
		return at.localeCompare(bt) || a.id.localeCompare(b.id);
	});
	const body: AppAttentionResponse = { items, unavailable };
	return Response.json(body, { headers: NO_STORE });
}
