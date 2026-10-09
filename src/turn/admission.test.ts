// Admission unit tests: the snapshot's boundary rules
// (design/runtime-turn.md → phase 1) — epoch capture, the resume claim
// seam, the #82 ownership filter, anchor and mark derivation, the
// clock. Full turn behavior (steering, cache stability, overflow
// resume end to end) stays pinned e2e in runtime.test.ts.

import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import type { Conversation } from "../conversation.ts";
import { admitTurn, type AdmittedMember, type AdmissionDeps, type LiveWire } from "./admission.ts";

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
	persona: "personal",
	archivedAt: null,
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
		pendingIds?: ReadonlySet<string>;
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
				expect(wire).toBe(live); // the ruling: live is passed in
				return claimed;
			},
			pendingIds: () => {
				order.push("pendingIds");
				return over.pendingIds ?? new Set<string>();
			},
			modelEntries: () => over.entries ?? [],
			now: () => 1234,
		},
	};
}

describe("admitTurn", () => {
	test("fresh admission freezes epoch, snapshot, anchor, mark, and clock", () => {
		const h = baseDeps({
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
		// Settings are captured once, from the store row, and the epoch
		// is the captured conversation's — the authority token.
		expect(h.captured.map((c) => c.epoch)).toEqual([3]);
		expect(out.snapshot.conv.epoch).toBe(9);
		expect(out.snapshot.epoch).toBe(9);
		expect(out.snapshot.entries.map((e) => e.seq)).toEqual([1, 2, 3]);
		expect(out.snapshot.anchorSeq).toBe(3); // newest user message, not the first
		expect(out.snapshot.steerMarkSeed).toBe(3);
		expect(out.snapshot.turnStartMs).toBe(1234);
		expect(out.snapshot.claimed).toEqual([]);
		expect(h.order).toEqual(["pendingIds"]); // a fresh turn claims nothing
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
			entries: [{ seq: 4, message: msg("u1") }],
		});
		h.deps.captureConversation = (c) => {
			h.captured.push(c);
			return conv(99);
		};
		const member: AdmittedMember = { message: msg("q1"), sink: {} };
		h.claimed.push(member);
		const recovered = conv(42);
		const out = admitTurn(h.deps, { conversation: recovered, startedAt: 777 });
		expect(out.kind).toBe("admitted");
		if (out.kind !== "admitted") return;
		// One settings copy per logical turn: the recovery's conversation
		// stands in for capture, and its epoch is the token.
		expect(h.captured).toEqual([]);
		expect(out.snapshot.conv).toBe(recovered);
		expect(out.snapshot.epoch).toBe(42);
		expect(out.snapshot.turnStartMs).toBe(777);
		expect(out.snapshot.claimed).toEqual([member]);
		// The claim runs before the ownership read, so claimed submits are
		// owned input, not queued leftovers.
		expect(h.order).toEqual(["claim", "pendingIds"]);
	});

	test("queued-but-unclaimed ids are durable, not owned — they stay out of the snapshot (#82)", () => {
		const h = baseDeps({
			pendingIds: new Set(["q1"]),
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
		// The mark still spans the newest OWNED event.
		expect(out.snapshot.steerMarkSeed).toBe(3);
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
