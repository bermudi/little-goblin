// Durable, immutable program proposals — staged standing authority
// waiting on an operator decision. A proposal is never an active
// program row: approval is one immediate SQLite transaction that
// activates through the trusted core operations and stamps the
// decision together, so a crash can leave neither a grant without its
// record nor a record without its grant, and a repeated tap or a
// restart can never activate twice. Update proposals bind to an
// immutable base fingerprint of the exact active configuration they
// were shown against — run/cursor accounting excluded, so a landed
// fire or a mail checkpoint never stales one — and store the
// renderable snapshot of that base, so an approval card re-posted at
// any time shows the candidate the fingerprint binds to, never a merge
// onto the live row. A new proposal for the same target supersedes the
// older pending ones. History is append-only: no mutation of stored
// payloads, no deletion.
//
// This helper composes into ProgramsStore on the SAME connection:
// programs.ts injects the core get/create/update and the definition
// validators, so this module never imports back at runtime.

import type { Database } from "bun:sqlite";
import { z } from "zod";
import { log } from "./log.ts";
import type { CreateProgram, Program, ProgramAddress, ProgramPatch } from "./programs.ts";
import {
	telegramActor,
	telegramAddressOf,
	telegramTarget,
	validTarget,
	type ConversationTarget,
} from "./targets.ts";

// The approval post shows the complete candidate, chunked but never
// truncated — the charter bound lives here so "approve what you saw"
// stays true at any length Telegram accepts.
export const PROPOSAL_CHARTER_MAX = 20_000;

/** A create proposal's validated candidate — everything programs.create
 *  needs except the address (pinned on the row) and the hook hash
 *  (a capability flag: the credential exists only at approval). */
export interface ProgramDraft {
	name: string;
	charter: string;
	cron: string | null;
	maxLatenessMinutes: number | null;
	hook: boolean;
	mailFilter: string | null;
}

/** An update proposal's requested patch — only the fields the requester
 *  asked to change; activation applies exactly these, never a
 *  full-field rewrite that reschedules an untouched cron. `hook: true`
 *  is the same capability flag as the draft's. Optional fields carry
 *  `| undefined` because zod's parse output does — the schema's own
 *  shape, verbatim, is what the store re-reads. */
export interface ProgramPatchRequest {
	name?: string | undefined;
	charter?: string | undefined;
	cron?: string | null | undefined;
	maxLatenessMinutes?: number | null | undefined;
	hook?: true | undefined;
	mailFilter?: string | null | undefined;
}

export type ProposalState = "pending" | "approved" | "rejected" | "superseded";

/** The immutable base configuration an update proposal was shown against —
 *  the fingerprint's fields minus the fingerprint's own bookkeeping (id,
 *  address, hookHash, enabled), kept so any later re-post renders the
 *  exact candidate the operator first saw, never a merge onto whatever
 *  the live row happens to say today. */
export interface ProgramBaseSnapshot {
	name: string;
	charter: string;
	cron: string | null;
	maxLatenessMinutes: number | null;
	hook: boolean;
	mailFilter: string | null;
}

export interface ProgramProposal {
	id: number;
	kind: "create" | "update";
	/** The update's program; null on a create. */
	targetId: number | null;
	/** kind === "create" — validated candidate definition. */
	draft: ProgramDraft | null;
	/** kind === "update" — validated requested patch. */
	patch: ProgramPatchRequest | null;
	/** kind === "update" — the fingerprinted base configuration. */
	base: string | null;
	/** kind === "update" — the renderable base snapshot; null on creates
	 *  and on legacy rows staged before the column existed. */
	baseSnapshot: ProgramBaseSnapshot | null;
	/** The requester's pinned conversation address — where the approval
	 *  posts, and where a created program answers. */
	target: ConversationTarget;
	/** Legacy transport projection derived from `target`; app rows use 0/null. */
	chatId: number;
	threadId: number | null;
	state: ProposalState;
	createdAt: string;
	decidedAt: string | null;
	/** The authenticated decision lane ("app" or "telegram:<user>"). */
	decidedBy: string | null;
	/** The program the approval activated; null until then. */
	activatedId: number | null;
}

export type ProposalRefusal =
	/** No such proposal row. */
	| "gone"
	/** Already approved or rejected. */
	| "decided"
	/** A newer pending proposal for the same target took its place. */
	| "superseded"
	/** The update's program row is gone. */
	| "target-gone"
	/** The program changed since the proposal — the fingerprinted base
	 *  no longer matches, so the shown diff is no longer what approval
	 *  would grant. */
	| "stale"
	/** The proposal requests a hook but no hash arrived to activate
	 *  it — the adapter refuses before this can ever be reached. */
	| "hook-unsatisfied";

export type ApproveOutcome =
	| { kind: "activated"; proposal: ProgramProposal; program: Program }
	| { kind: "refused"; proposal: ProgramProposal | null; refusal: ProposalRefusal };

export type RejectOutcome =
	| { kind: "rejected"; proposal: ProgramProposal }
	| { kind: "refused"; proposal: ProgramProposal | null; refusal: ProposalRefusal };

export interface ProgramProposals {
	/** Validate and persist a create proposal. Never touches the
	 *  programs table. */
	proposeCreate(draft: ProgramDraft, address: ProgramAddress, now?: Date): ProgramProposal;
	/** Validate the patch against the live target, supersede older
	 *  pending proposals for it, and persist. Never mutates the
	 *  program row. Throws when the target is gone or the merged
	 *  candidate violates a program rule. */
	proposeUpdate(
		targetId: number,
		patch: ProgramPatchRequest,
		address: ProgramAddress,
		now?: Date,
	): ProgramProposal;
	get(id: number): ProgramProposal | null;
	list(): ProgramProposal[];
	pending(): ProgramProposal[];
	/** One immediate transaction: must still be pending, an update's
	 *  base fingerprint must still match exactly, then activate through
	 *  the injected core operations and stamp the decision. Any write
	 *  failure rolls activation and decision back together. `hookHash`
	 *  is the freshly minted credential a hook-requesting proposal
	 *  needs — absent when requested, the approval refuses. */
	approve(
		id: number,
		decidedBy: string | number,
		opts?: { hookHash?: string; now?: Date },
	): ApproveOutcome;
	reject(id: number, decidedBy: string | number, now?: Date): RejectOutcome;
}

/** The trusted low-level operations a decision activates through —
 *  the store's own validated writes, never a second path. */
export interface ProposalCore {
	get(id: number): Program | null;
	create(input: CreateProgram, now?: Date): Program;
	update(id: number, patch: ProgramPatch, now?: Date): Program | null;
}

export interface ProgramProposalsDeps {
	core: ProposalCore;
	/** Full-candidate validation for a create draft — trigger
	 *  invariant, lateness bound, cron parse. Throws on violation. */
	validateCreate(draft: ProgramDraft): void;
	/** The same validation over the candidate the patch would produce
	 *  when merged onto the live row. Throws on violation. */
	validateUpdate(current: Program, patch: ProgramPatchRequest): void;
}

// The exact active configuration a pending update's authority binds
// to — id, pinned address, charter, triggers and enabled, with
// last_run/next_run/mail cursor and revision accounting deliberately
// excluded: a landed fire or a checkpoint move never stales a
// proposal. Fixed key order makes this canonical.
export function programFingerprint(p: Program): string {
	const telegram = telegramAddressOf(p.target);
	return JSON.stringify({
		id: p.id,
		...(telegram === null
			? { target: p.target }
			: { chatId: telegram.chatId, threadId: telegram.threadId }),
		name: p.name,
		charter: p.charter,
		cron: p.cron,
		maxLatenessMinutes: p.maxLatenessMinutes,
		hookHash: p.hookHash,
		mailFilter: p.mailFilter,
		enabled: p.enabled,
	});
}

// The renderable half of the fingerprint: what an approval card needs to
// show the base configuration. Stored at staging, read at every render.
export function snapshotProgram(p: Program): ProgramBaseSnapshot {
	return {
		name: p.name,
		charter: p.charter,
		cron: p.cron,
		maxLatenessMinutes: p.maxLatenessMinutes,
		hook: p.hookHash !== null,
		mailFilter: p.mailFilter,
	};
}

const draftSchema = z
	.object({
		name: z.string().min(1).max(100),
		charter: z.string().min(1).max(PROPOSAL_CHARTER_MAX),
		cron: z.string().min(5).nullable(),
		maxLatenessMinutes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
		hook: z.boolean(),
		mailFilter: z.string().min(1).max(500).nullable(),
	})
	.strict();

const patchSchema = z
	.object({
		name: z.string().min(1).max(100).optional(),
		charter: z.string().min(1).max(PROPOSAL_CHARTER_MAX).optional(),
		cron: z.string().min(5).nullable().optional(),
		maxLatenessMinutes: z
			.number()
			.int()
			.positive()
			.max(Number.MAX_SAFE_INTEGER)
			.nullable()
			.optional(),
		hook: z.literal(true).optional(),
		mailFilter: z.string().min(1).max(500).nullable().optional(),
	})
	.strict()
	.refine((patch) => Object.keys(patch).length > 0, {
		message: "a proposal needs at least one requested field",
	});

function actorOf(actor: string | number): string {
	return typeof actor === "number" ? telegramActor(actor) : actor;
}

function proposalTarget(address: ProgramAddress): ConversationTarget {
	return "target" in address ? address.target : telegramTarget(address.chatId, address.threadId);
}

const rowSchema = z.object({
	id: z.number(),
	kind: z.enum(["create", "update"]),
	target_id: z.number().nullable(),
	payload: z.string(),
	base: z.string().nullable(),
	base_snapshot: z.string().nullable(),
	target: z.string().refine(validTarget),
	state: z.enum(["pending", "approved", "rejected", "superseded"]),
	created_at: z.string(),
	decided_at: z.string().nullable(),
	decided_by: z.union([z.string(), z.number()]).nullable(),
	activated_id: z.number().nullable(),
});

// The snapshot copies an existing program row, so its bounds are the
// trusted store's — never proposal-input limits: a grandfathered or
// pre-limit charter, name, or filter longer than a new proposal allows
// must still stage, read, and decide.
const baseSnapshotSchema = z
	.object({
		name: z.string(),
		charter: z.string(),
		cron: z.string().nullable(),
		maxLatenessMinutes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
		hook: z.boolean(),
		mailFilter: z.string().nullable(),
	})
	.strict();

// Stored payloads are validated JSON, parsed at read — corruption
// names itself with the row instead of surfacing downstream as a
// mislabeled failure.
function rowToProposal(row: unknown): ProgramProposal {
	const r = rowSchema.parse(row);
	let draft: ProgramDraft | null = null;
	let patch: ProgramPatchRequest | null = null;
	try {
		const payload: unknown = JSON.parse(r.payload);
		if (r.kind === "create") draft = draftSchema.parse(payload);
		else patch = patchSchema.parse(payload);
	} catch (err) {
		throw new Error(
			`program proposal ${r.id}: corrupt payload — ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	const telegram = telegramAddressOf(r.target);
	let baseSnapshot: ProgramBaseSnapshot | null = null;
	if (r.base_snapshot !== null) {
		try {
			baseSnapshot = baseSnapshotSchema.parse(JSON.parse(r.base_snapshot));
		} catch (err) {
			throw new Error(
				`program proposal ${r.id}: corrupt base snapshot — ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
	return {
		id: r.id,
		kind: r.kind,
		targetId: r.target_id,
		draft,
		patch,
		base: r.base,
		baseSnapshot,
		target: r.target,
		chatId: telegram?.chatId ?? 0,
		threadId: telegram?.threadId ?? null,
		state: r.state,
		createdAt: r.created_at,
		decidedAt: r.decided_at,
		decidedBy: typeof r.decided_by === "number" ? `telegram:${r.decided_by}` : r.decided_by,
		activatedId: r.activated_id,
	};
}

export function openProgramProposals(db: Database, deps: ProgramProposalsDeps): ProgramProposals {
	db.exec(`CREATE TABLE IF NOT EXISTS program_proposals (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		kind TEXT NOT NULL,
		target_id INTEGER,
		payload TEXT NOT NULL,
		base TEXT,
		base_snapshot TEXT,
		target TEXT NOT NULL,
		chat_id INTEGER NOT NULL DEFAULT 0,
		thread_id INTEGER,
		state TEXT NOT NULL,
		created_at TEXT NOT NULL,
		decided_at TEXT,
		decided_by TEXT,
		activated_id INTEGER
	)`);
	const proposalCols = new Set(
		db
			.query<{ name: string }, []>("PRAGMA table_info(program_proposals)")
			.all()
			.map((c) => c.name),
	);
	if (!proposalCols.has("target")) {
		db.exec("ALTER TABLE program_proposals ADD COLUMN target TEXT");
		db.exec(`UPDATE program_proposals SET target =
			CASE WHEN thread_id IS NULL THEN 'dm:' || chat_id
			     ELSE 'topic:' || chat_id || ':' || thread_id END
			WHERE target IS NULL`);
	}
	// Rows staged before base_snapshot existed read NULL — renders fall
	// back to the fingerprint check (same conversation.ts ALTER pattern).
	if (!proposalCols.has("base_snapshot")) {
		db.exec("ALTER TABLE program_proposals ADD COLUMN base_snapshot TEXT");
	}

	const qGet = db.query("SELECT * FROM program_proposals WHERE id = ?");
	const qList = db.query("SELECT * FROM program_proposals ORDER BY id");
	const qPending = db.query("SELECT * FROM program_proposals WHERE state = 'pending' ORDER BY id");
	const qInsert = db.query(`INSERT INTO program_proposals
		(kind, target_id, payload, base, base_snapshot, target, chat_id, thread_id, state, created_at, decided_at, decided_by, activated_id)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, NULL)`);
	const qDecide = db.query(
		"UPDATE program_proposals SET state = ?, decided_at = ?, decided_by = ?, activated_id = ? WHERE id = ?",
	);
	const qSupersede = db.query(
		"UPDATE program_proposals SET state = 'superseded', decided_at = ? WHERE target_id IS ? AND state = 'pending'",
	);

	// Target read, validation, supersede and insert land together — a
	// stale proposal can never ride in beside a fresher one.
	const proposeUpdateTxn = db.transaction(
		(
			targetId: number,
			patch: ProgramPatchRequest,
			address: ProgramAddress,
			now: Date,
		): { id: number; superseded: number } => {
			const target = deps.core.get(targetId);
			if (target === null) throw new Error(`program proposal: no program ${targetId}`);
			const validated = patchSchema.parse(patch);
			deps.validateUpdate(target, validated);
			const destination = proposalTarget(address);
			if (!validTarget(destination)) {
				throw new Error(`invalid proposal destination "${destination}"`);
			}
			const telegram = telegramAddressOf(destination);
			// Validate before any write: the stored snapshot must decode on
			// every later read, so a rejection aborts the transaction here —
			// staging can never commit a row its own reader throws on.
			const baseSnapshot = JSON.stringify(baseSnapshotSchema.parse(snapshotProgram(target)));
			const superseded = qSupersede.run(now.toISOString(), targetId).changes;
			const res = qInsert.run(
				"update",
				targetId,
				JSON.stringify(validated),
				programFingerprint(target),
				baseSnapshot,
				destination,
				telegram?.chatId ?? 0,
				telegram?.threadId ?? null,
				now.toISOString(),
			);
			return { id: Number(res.lastInsertRowid), superseded };
		},
	);

	// Read, base compare, activation and the decision stamp are one
	// immediate transaction — a refusal returns early with nothing
	// written, and a write failure anywhere rolls the grant and its
	// record back together.
	const approveTxn = db.transaction(
		(id: number, decidedBy: string, hookHash: string | undefined, now: Date): ApproveOutcome => {
			const row = qGet.get(id);
			if (row === null) return { kind: "refused", proposal: null, refusal: "gone" };
			const proposal = rowToProposal(row);
			if (proposal.state !== "pending") {
				return {
					kind: "refused",
					proposal,
					refusal: proposal.state === "superseded" ? "superseded" : "decided",
				};
			}
			if (proposal.kind === "create") {
				const draft = proposal.draft!;
				if (draft.hook && hookHash === undefined) {
					return { kind: "refused", proposal, refusal: "hook-unsatisfied" };
				}
				const program = deps.core.create(
					{
						name: draft.name,
						charter: draft.charter,
						cron: draft.cron,
						maxLatenessMinutes: draft.maxLatenessMinutes,
						hookHash: draft.hook ? hookHash! : null,
						mailFilter: draft.mailFilter,
						address: { target: proposal.target },
					},
					now,
				);
				qDecide.run("approved", now.toISOString(), decidedBy, program.id, id);
				return { kind: "activated", proposal: rowToProposal(qGet.get(id)), program };
			}
			const target = deps.core.get(proposal.targetId!);
			if (target === null) return { kind: "refused", proposal, refusal: "target-gone" };
			if (programFingerprint(target) !== proposal.base) {
				return { kind: "refused", proposal, refusal: "stale" };
			}
			const patch = proposal.patch!;
			if (patch.hook === true && hookHash === undefined) {
				return { kind: "refused", proposal, refusal: "hook-unsatisfied" };
			}
			// Exactly the requested fields — the patch's own shape is the
			// grant, so an unchanged cron keeps its next_run.
			const applied: ProgramPatch = {};
			if (patch.name !== undefined) applied.name = patch.name;
			if (patch.charter !== undefined) applied.charter = patch.charter;
			if (patch.cron !== undefined) applied.cron = patch.cron;
			if (patch.maxLatenessMinutes !== undefined)
				applied.maxLatenessMinutes = patch.maxLatenessMinutes;
			if (patch.mailFilter !== undefined) applied.mailFilter = patch.mailFilter;
			if (patch.hook === true) applied.hookHash = hookHash!;
			const program = deps.core.update(target.id, applied, now);
			if (program === null) {
				throw new Error(`program proposal ${id}: target ${target.id} vanished mid-activation`);
			}
			qDecide.run("approved", now.toISOString(), decidedBy, program.id, id);
			return { kind: "activated", proposal: rowToProposal(qGet.get(id)), program };
		},
	);

	const rejectTxn = db.transaction((id: number, decidedBy: string, now: Date): RejectOutcome => {
		const row = qGet.get(id);
		if (row === null) return { kind: "refused", proposal: null, refusal: "gone" };
		const proposal = rowToProposal(row);
		if (proposal.state !== "pending") {
			return {
				kind: "refused",
				proposal,
				refusal: proposal.state === "superseded" ? "superseded" : "decided",
			};
		}
		qDecide.run("rejected", now.toISOString(), decidedBy, null, id);
		return { kind: "rejected", proposal: rowToProposal(qGet.get(id)) };
	});

	return {
		proposeCreate(draft, address, now = new Date()) {
			const validated = draftSchema.parse(draft);
			deps.validateCreate(validated);
			const destination = proposalTarget(address);
			if (!validTarget(destination)) {
				throw new Error(`invalid proposal destination "${destination}"`);
			}
			const telegram = telegramAddressOf(destination);
			const res = qInsert.run(
				"create",
				null,
				JSON.stringify(validated),
				null,
				null,
				destination,
				telegram?.chatId ?? 0,
				telegram?.threadId ?? null,
				now.toISOString(),
			);
			const proposal = rowToProposal(qGet.get(Number(res.lastInsertRowid)));
			log.info("program proposal staged", {
				proposal: proposal.id,
				kind: "create",
				name: proposal.draft!.name,
				cron: proposal.draft!.cron,
				hook: proposal.draft!.hook,
				mail: proposal.draft!.mailFilter !== null,
				target: proposal.target,
			});
			return proposal;
		},
		proposeUpdate(targetId, patch, address, now = new Date()) {
			const { id, superseded } = proposeUpdateTxn.immediate(targetId, patch, address, now);
			const proposal = rowToProposal(qGet.get(id));
			log.info("program proposal staged", {
				proposal: proposal.id,
				kind: "update",
				program: targetId,
				fields: Object.keys(proposal.patch!),
				...(superseded > 0 ? { superseded } : {}),
				target: proposal.target,
			});
			return proposal;
		},
		get(id) {
			const row = qGet.get(id);
			return row === null ? null : rowToProposal(row);
		},
		list() {
			return qList.all().map(rowToProposal);
		},
		pending() {
			return qPending.all().map(rowToProposal);
		},
		approve(id, decidedBy, opts = {}) {
			const actor = actorOf(decidedBy);
			const outcome = approveTxn.immediate(id, actor, opts.hookHash, opts.now ?? new Date());
			if (outcome.kind === "activated") {
				log.info("program proposal approved", {
					proposal: id,
					decidedBy: actor,
					program: outcome.program.id,
					name: outcome.program.name,
				});
			} else {
				log.info("program proposal approval refused", {
					proposal: id,
					refusal: outcome.refusal,
					decidedBy: actor,
				});
			}
			return outcome;
		},
		reject(id, decidedBy, now = new Date()) {
			const actor = actorOf(decidedBy);
			const outcome = rejectTxn.immediate(id, actor, now);
			if (outcome.kind === "rejected") {
				log.info("program proposal rejected", { proposal: id, decidedBy: actor });
			} else {
				log.info("program proposal rejection refused", {
					proposal: id,
					refusal: outcome.refusal,
					decidedBy: actor,
				});
			}
			return outcome;
		},
	};
}
