// Read-only attention projection over the durable owners. Items point at
// the surface that can resolve them; this module records no second state.

import { listProposedSkills, type ProposedSkillItem } from "../stateview.ts";
import { appConversationOf } from "../targets.ts";
import { conversationName } from "./operator-memory.ts";
import { changesSummary, programChanges } from "./app-program-diff.ts";
import { type AppChannelDeps, NO_STORE } from "./app-shared.ts";
import type { AppAttentionItem, AppAttentionPage, AppAttentionResponse } from "./app-wire.ts";
import { versionedJson } from "./live-version.ts";

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

export function proposedSkills(
	deps: Pick<AppChannelDeps, "operator">,
): ProposedSkillItem[] | null {
	const sources = deps.operator?.skillSources;
	return sources === undefined
		? null
		: listProposedSkills(sources.skillsDir, sources.proposedDir);
}

export function attentionBody(
	deps: Pick<AppChannelDeps, "approvals" | "operator">,
	proposed = proposedSkills(deps),
): AppAttentionResponse {
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
					conversationId: appConversationOf(proposal.target),
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
					conversationId: appConversationOf(draft.target),
					page: "programs",
				}),
			);
		}
	}

	const memory = deps.operator?.memory;
	if (memory === undefined) {
		unavailable.push("memory");
	} else {
		// The same durable states the Telegram notices ride: an open
		// outage row means the retain queue cannot drain; a failed last
		// recall means turns proceed without memory. Read-only — each
		// clears on its own when the service is healthy again.
		const outage = memory.outage?.() ?? null;
		if (outage !== null) {
			const counts = memory.counts();
			const queued = counts.pending + counts.submitted;
			items.push(
				pageItem({
					id: "memory-outage",
					kind: "memory-outage",
					title: "Memory can't reach its service",
					detail: `${queued} exchange${queued === 1 ? "" : "s"} queued locally, nothing lost — saves keep retrying on their own.`,
					createdAt: new Date(outage.startedAt).toISOString(),
					conversationId: null,
					page: "memory",
				}),
			);
		}
		if (memory.lastRecallOk() === false) {
			items.push(
				pageItem({
					id: "memory-recall",
					kind: "memory-recall",
					title: "Memory can't recall",
					detail:
						"The last recall failed — turns run without long-term memory until one succeeds.",
					createdAt: memory.lastRecallAt(),
					conversationId: null,
					page: "memory",
				}),
			);
		}
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
						conversationId: null,
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

	if (proposed === null) {
		unavailable.push("skills");
	} else {
		for (const skill of proposed) {
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
					conversationId: null,
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
				conversationId: delegation.appConversation,
				target:
					delegation.appConversation === null
						? { kind: "page", page: "delegations" }
						: { kind: "conversation", conversationId: delegation.appConversation },
			});
		}
	}

	items.sort((a, b) => {
		const at = a.createdAt === null ? "" : a.createdAt;
		const bt = b.createdAt === null ? "" : b.createdAt;
		return at.localeCompare(bt) || a.id.localeCompare(b.id);
	});
	return { items, unavailable };
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
	return versionedJson(attentionBody(deps));
}
