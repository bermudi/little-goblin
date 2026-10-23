// Channel-neutral program commands shared by the model tool and the
// authenticated operator surfaces. The store owns validation and the
// proposal owner owns presentation; this layer owns only the grant
// boundary — which requested changes are direct edits and which must
// stage as proposals.

import { log } from "./log.ts";
import { hookUrl, newHookToken } from "./program-hook.ts";
import type { ProgramDraft, ProgramPatchRequest, ProgramProposal } from "./program-proposals.ts";
import {
	nextFire,
	ProgramRuleError,
	type Program,
	type ProgramAddress,
	type ProgramPatch,
	type ProgramsStore,
} from "./programs.ts";

export interface ProgramOpsDeps {
	programs: Pick<ProgramsStore, "get" | "proposals" | "remove" | "setHook" | "update">;
	publicUrl(): string | undefined;
	requestApproval(proposal: ProgramProposal, signal?: AbortSignal): Promise<void>;
}

export type ProgramStaged = {
	kind: "proposal";
	proposal: ProgramProposal;
	posted: boolean;
	error?: string;
};

export type ProgramOpResult =
	| { kind: "program"; program: Program }
	| { kind: "deleted"; id: number }
	| { kind: "rotated"; url: string }
	| ProgramStaged
	| { kind: "error"; message: string };

export interface ProgramOps {
	get(id: number): Program | null;
	create(
		draft: ProgramDraft,
		address: ProgramAddress,
		signal?: AbortSignal,
	): Promise<ProgramOpResult>;
	update(
		id: number,
		patch: EditableProgramPatch,
		/** Staging a grant-shaped patch pins the proposal to its approval
		 *  lane, so staging without one refuses; direct edits (rename,
		 *  lateness, reschedule) never touch it — hook's rule. */
		address?: ProgramAddress,
		signal?: AbortSignal,
	): Promise<ProgramOpResult>;
	remove(id: number): ProgramOpResult;
	toggle(id: number): ProgramOpResult;
	hook(
		id: number,
		op: "enable" | "rotate" | "disable",
		address?: ProgramAddress,
		signal?: AbortSignal,
	): Promise<ProgramOpResult>;
	review(id: number, signal?: AbortSignal): Promise<ProgramOpResult>;
}

export type EditableProgramPatch = Pick<
	ProgramPatchRequest,
	"name" | "charter" | "cron" | "maxLatenessMinutes" | "mailFilter"
>;

export function startProgramOps(deps: ProgramOpsDeps): ProgramOps {
	return {
		get(id) {
			return deps.programs.get(id);
		},

		async create(draft, address, signal) {
			if (draft.cron !== null) {
				const invalid = invalidCron(draft.cron);
				if (invalid !== null) return { kind: "error", message: invalid };
			}
			try {
				return await stage(deps, deps.programs.proposals.proposeCreate(draft, address), signal);
			} catch (err) {
				if (err instanceof ProgramRuleError) return { kind: "error", message: err.message };
				throw err;
			}
		},

		async update(id, patch, address, signal) {
			if (typeof patch.cron === "string") {
				const invalid = invalidCron(patch.cron);
				if (invalid !== null) return { kind: "error", message: invalid };
			}
			const current = deps.programs.get(id);
			if (current === null) return { kind: "error", message: `no program ${id}` };
			try {
			if (requiresApproval(current, patch)) {
				// Any grant-shaped component stages the whole requested
				// patch — no partial application while it is pending. The
				// staged row pins its approval lane, so an addressless
				// surface can apply directly but can never stage.
				if (address === undefined) {
					return {
						kind: "error",
						message: "no destination — this surface has no conversation address",
					};
				}
				return await stage(
					deps,
					deps.programs.proposals.proposeUpdate(id, patch, address),
					signal,
				);
			}
				const program = deps.programs.update(id, storePatch(patch));
				if (program === null) return { kind: "error", message: `no program ${id}` };
				log.info("program updated", {
					program: program.id,
					name: program.name,
					maxLatenessMinutes: program.maxLatenessMinutes,
				});
				return { kind: "program", program };
			} catch (err) {
				if (err instanceof ProgramRuleError) return { kind: "error", message: err.message };
				throw err;
			}
		},

		remove(id) {
			const ok = deps.programs.remove(id);
			log.info("program deleted", { program: id, existed: ok });
			return ok ? { kind: "deleted", id } : { kind: "error", message: `no program ${id}` };
		},

		toggle(id) {
			const current = deps.programs.get(id);
			if (current === null) return { kind: "error", message: `no program ${id}` };
			const program = deps.programs.update(id, { enabled: !current.enabled });
			if (program === null) return { kind: "error", message: `no program ${id}` };
			log.info("program toggled", { program: program.id, enabled: program.enabled });
			return { kind: "program", program };
		},

		async hook(id, op, address, signal) {
			const current = deps.programs.get(id);
			if (current === null) return { kind: "error", message: `no program ${id}` };
			if (op !== "disable" && address === undefined) {
				return {
					kind: "error",
					message: "no destination — this surface has no conversation address",
				};
			}
			if (op === "disable") {
				try {
					deps.programs.setHook(id, null);
				} catch (err) {
					if (err instanceof ProgramRuleError) return { kind: "error", message: err.message };
					throw err;
				}
				const program = deps.programs.get(id);
				if (program === null) return { kind: "error", message: `no program ${id}` };
				log.info("program hook disabled", { program: id, name: current.name });
				return { kind: "program", program };
			}
			if (current.hookHash === null) {
				// A new trigger kind stages like any widened authority — the
				// credential exists only once approved.
				try {
					return await stage(
						deps,
						deps.programs.proposals.proposeUpdate(id, { hook: true }, address!),
						signal,
					);
				} catch (err) {
					if (err instanceof ProgramRuleError) return { kind: "error", message: err.message };
					throw err;
				}
			}
			const base = deps.publicUrl();
			if (base === undefined) {
				return { kind: "error", message: "publicUrl is not set — set it in the mini app first" };
			}
			const token = newHookToken();
			deps.programs.setHook(id, hookHash(token));
			return { kind: "rotated", url: hookUrl(base, token) };
		},

		async review(id, signal) {
			const proposal = deps.programs.proposals.get(id);
			if (proposal === null) return { kind: "error", message: `no proposal ${id}` };
			if (proposal.state !== "pending") return { kind: "proposal", proposal, posted: true };
			return stage(deps, proposal, signal);
		},
	};
}

// The grant boundary: a different charter text always stages (the
// model never classifies its own authority widening), and so do a new
// trigger kind — a cron where none existed — and a new or changed
// non-null mail filter. Everything else stays inside granted
// authority: rescheduling an existing cron, name or lateness edits,
// clearing a filter or a cron, toggling.
export function requiresApproval(current: Program, patch: EditableProgramPatch): boolean {
	if (patch.charter !== undefined && patch.charter !== current.charter) return true;
	if (
		patch.mailFilter !== undefined &&
		patch.mailFilter !== null &&
		patch.mailFilter !== current.mailFilter
	)
		return true;
	if (patch.cron !== undefined && patch.cron !== null && current.cron === null) return true;
	return false;
}

// Stage first, notify second: a failed post returns the pending
// proposal with review guidance — the row is durable, never lost.
async function stage(
	deps: ProgramOpsDeps,
	proposal: ProgramProposal,
	signal?: AbortSignal,
): Promise<ProgramStaged> {
	try {
		await deps.requestApproval(proposal, signal);
		return { kind: "proposal", proposal, posted: true };
	} catch (err) {
		log.error("program approval post failed — proposal stays pending", err, {
			proposal: proposal.id,
		});
		return {
			kind: "proposal",
			proposal,
			posted: false,
			error: `proposal #${proposal.id} is staged but its approval message could not be posted — nothing is active. Run program/review with id ${proposal.id} to re-send it.`,
		};
	}
}

function invalidCron(cron: string): string | null {
	try {
		nextFire(cron, new Date());
		return null;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

// exactOptionalPropertyTypes: a request field is either absent or a
// real value/null — never `key: undefined` reaching the store patch.
function storePatch(patch: EditableProgramPatch): ProgramPatch {
	const out: ProgramPatch = {};
	if (patch.name !== undefined) out.name = patch.name;
	if (patch.charter !== undefined) out.charter = patch.charter;
	if (patch.cron !== undefined) out.cron = patch.cron;
	if (patch.maxLatenessMinutes !== undefined) out.maxLatenessMinutes = patch.maxLatenessMinutes;
	if (patch.mailFilter !== undefined) out.mailFilter = patch.mailFilter;
	return out;
}

function hookHash(token: string): string {
	return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}
