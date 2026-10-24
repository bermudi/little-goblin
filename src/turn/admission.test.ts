import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import type { Conversation } from "../conversation.ts";
import { admitTurn, type AdmittedMember, type AdmissionDeps, type LiveWire } from "./admission.ts";
import { buildModelView } from "./view.ts";

const conv = (epoch: number, id = "dm:1"): Conversation => ({
	id,
	chatId: 1,
	threadId: null,
	title: null,
	titleImplicit: false,
	model: null,
	thinking: null,
	voice: false,
	memoryExcluded: false,
	projectId: null,
	persona: "personal",
	archivedAt: null,
	pinnedAt: null,
	epoch,
	createdAt: "2026-01-01T00:00:00Z",
});

const msg = (id: string, role: "user" | "assistant" | "system" = "user"): UIMessage => ({
	id,
	role,
	parts: [{ type: "text", text: `t-${id}` }],
});

function baseDeps(
		over: {
			conversation?: Conversation | null;
			pendingSeqs?: Set<number>;
			ownedSeqs?: Set<number>;
			entries?: { seq: number; message: UIMessage }[];
		} = {},
): {
	deps: AdmissionDeps;
	order: string[];
	live: LiveWire;
	claimed: AdmittedMember[];
	captured: Conversation[];
} {
	const order: string[] = [];
	const live: LiveWire = { chunks: [] };
	const claimed: AdmittedMember[] = [];
	const captured: Conversation[] = [];
	return {
		order,
		live,
		claimed,
		captured,
		deps: {
			convId: "dm:1",
			live,
			getConversation: () => (over.conversation === undefined ? conv(3) : over.conversation),
			claimQueued: (wire) => {
				order.push("claim");
				expect(wire).toBe(live);
				return claimed;
			},
			pendingSeqs: () => {
				order.push("pendingSeqs");
				return over.pendingSeqs ?? new Set<number>();
			},
			ownedInputSeqs: () => {
				order.push("ownedInputSeqs");
				return over.ownedSeqs ?? new Set<number>();
			},
			modelEntries: () => over.entries ?? [],
			now: () => 1234,
		},
	};
}

describe("admitTurn", () => {
	test("historical skills stay context, while only current coalesced inputs are owned", async () => {
		const historical: UIMessage = {
			id: "reused",
			role: "user",
			parts: [{ type: "data-skill", data: { name: "demo" } }],
		};
		const h = baseDeps({
			ownedSeqs: new Set([3, 4]),
			pendingSeqs: new Set([5]),
			entries: [
				{ seq: 1, message: historical },
				{ seq: 2, message: msg("answer", "assistant") },
				{ seq: 3, message: msg("reused") },
				{ seq: 4, message: msg("coalesced") },
				{ seq: 5, message: msg("reused") },
			],
		});
		const out = admitTurn(h.deps);
		expect(out.kind).toBe("admitted");
		if (out.kind !== "admitted") return;
		expect(out.snapshot.ownedInputSeqs).toEqual([3, 4]);
		expect(out.snapshot.entries.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
		const reads: boolean[] = [];
		const view = await buildModelView(
			{
				convId: "dm:1",
				tools: {},
				modalities: undefined,
				carries: () => false,
				skillRef: (_ref, includeBody) => {
					reads.push(includeBody);
					return { name: "demo", body: includeBody ? "PRIVATE SKILL BODY" : null };
				},
			},
			{
				entries: out.snapshot.entries,
				ownedSeqs: out.snapshot.ownedInputSeqs,
				prior: [],
				current: null,
				partial: null,
				assertAuthority() {},
			},
		);
		expect(reads).toEqual([false]);
		expect(JSON.stringify(view)).toContain("[skill: demo]");
		expect(JSON.stringify(view)).not.toContain("PRIVATE SKILL BODY");
	});

	test("recovery owns newly claimed members, not the historical user context", () => {
		const members: AdmittedMember[] = [{ seq: 3, message: msg("head"), sink: {} }];
		const h = baseDeps({
			entries: [
				{ seq: 1, message: msg("old") },
				{ seq: 3, message: members[0]!.message },
				{ seq: 4, message: msg("claimed") },
			],
		});
		h.deps.claimQueued = () => {
			const claimed = { seq: 4, message: msg("claimed"), sink: {} };
			members.push(claimed);
			return [claimed];
		};
		h.deps.ownedInputSeqs = () => new Set(members.map((m) => m.seq));
		const out = admitTurn(h.deps, { conversation: conv(3), startedAt: 1 });
		expect(out.kind).toBe("admitted");
		if (out.kind !== "admitted") return;
		expect(out.snapshot.ownedInputSeqs).toEqual([3, 4]);
		expect(out.snapshot.entries.map((e) => e.seq)).toEqual([1, 3, 4]);
	});

	test("fresh admission freezes epoch, snapshot, anchor, mark, and clock", () => {
		const h = baseDeps({
			ownedSeqs: new Set([1, 3]),
			entries: [
				{ seq: 1, message: msg("u1") },
				{ seq: 2, message: msg("a1", "assistant") },
				{ seq: 3, message: msg("u2") },
			],
		});
		h.deps.captureConversation = (c) => {
			h.captured.push(c);
			return conv(9);
		};
		const out = admitTurn(h.deps);
		expect(out.kind).toBe("admitted");
		if (out.kind !== "admitted") return;
		expect(h.captured.map((c) => c.epoch)).toEqual([3]);
		expect(out.snapshot.conv.epoch).toBe(9);
		expect(out.snapshot.epoch).toBe(9);
		expect(out.snapshot.entries.map((e) => e.seq)).toEqual([1, 2, 3]);
		expect(out.snapshot.anchorSeq).toBe(3);
		expect(out.snapshot.steerMarkSeed).toBe(3);
		expect(out.snapshot.turnStartMs).toBe(1234);
		expect(out.snapshot.ownedInputSeqs).toEqual([1, 3]);
		expect(h.order).toEqual(["pendingSeqs", "ownedInputSeqs"]);
	});

	test("a missing conversation is admission's first failure", () => {
		const h = baseDeps({ conversation: null });
		expect(admitTurn(h.deps)).toEqual({ kind: "missing" });
	});

	test("a settings-capture failure surfaces the message", () => {
		const h = baseDeps();
		h.deps.captureConversation = () => {
			throw new Error("settings blew up");
		};
		expect(admitTurn(h.deps)).toEqual({ kind: "settings-failed", message: "settings blew up" });
		h.deps.captureConversation = () => {
			throw "not an error";
		};
		expect(admitTurn(h.deps)).toEqual({ kind: "settings-failed", message: "not an error" });
	});

	test("a resume keeps the recovered conversation and clock, claiming through the seam first", () => {
		const h = baseDeps({
			ownedSeqs: new Set([4]),
			entries: [{ seq: 4, message: msg("u1") }],
		});
		h.deps.captureConversation = (c) => {
			h.captured.push(c);
			return conv(99);
		};
		h.claimed.push({ seq: 9, message: msg("q1"), sink: {} });
		const recovered = conv(42);
		const out = admitTurn(h.deps, { conversation: recovered, startedAt: 777 });
		expect(out.kind).toBe("admitted");
		if (out.kind !== "admitted") return;
		expect(h.captured).toEqual([]);
		expect(out.snapshot.conv).toBe(recovered);
		expect(out.snapshot.epoch).toBe(42);
		expect(out.snapshot.turnStartMs).toBe(777);
		expect(out.snapshot.ownedInputSeqs).toEqual([4]);
		expect(h.order).toEqual(["claim", "pendingSeqs", "ownedInputSeqs"]);
	});

	test("queued-but-unclaimed events are durable, not owned — they stay out of the snapshot (#82)", () => {
		const h = baseDeps({
			pendingSeqs: new Set([2]),
			entries: [
				{ seq: 1, message: msg("u1") },
				{ seq: 2, message: msg("q1") },
				{ seq: 3, message: msg("a1", "assistant") },
			],
		});
		const out = admitTurn(h.deps);
		expect(out.kind).toBe("admitted");
		if (out.kind !== "admitted") return;
		expect(out.snapshot.entries.map((e) => e.message.id)).toEqual(["u1", "a1"]);
		expect(out.snapshot.anchorSeq).toBe(1);
		expect(out.snapshot.steerMarkSeed).toBe(3);
	});

	test("a pending submit reusing an older event's message id hides only its own event", () => {
		// Client message ids are neither unique nor trusted: the queued
		// steer at seq 2 shares id "dup" with the owned event at seq 1 —
		// seq-based exclusion keeps the older event in the snapshot.
		const h = baseDeps({
			pendingSeqs: new Set([2]),
			ownedSeqs: new Set([1, 3]),
			entries: [
				{ seq: 1, message: msg("dup") },
				{ seq: 2, message: msg("dup") },
				{ seq: 3, message: msg("u9") },
			],
		});
		const out = admitTurn(h.deps);
		expect(out.kind).toBe("admitted");
		if (out.kind !== "admitted") return;
		expect(out.snapshot.entries.map((e) => e.seq)).toEqual([1, 3]);
		expect(out.snapshot.ownedInputSeqs).toEqual([1, 3]);
		expect(out.snapshot.anchorSeq).toBe(3);
	});

	test("an owned view without user messages anchors null; an empty view seeds the mark at 0", () => {
		const noUser = baseDeps({ entries: [{ seq: 5, message: msg("a1", "assistant") }] });
		const out = admitTurn(noUser.deps);
		expect(out.kind).toBe("admitted");
		if (out.kind !== "admitted") return;
		expect(out.snapshot.anchorSeq).toBeNull();
		expect(out.snapshot.steerMarkSeed).toBe(5);
		const empty = baseDeps();
		const emptyOut = admitTurn(empty.deps);
		expect(emptyOut.kind).toBe("admitted");
		if (emptyOut.kind !== "admitted") return;
		expect(emptyOut.snapshot.anchorSeq).toBeNull();
		expect(emptyOut.snapshot.steerMarkSeed).toBe(0);
	});
});
