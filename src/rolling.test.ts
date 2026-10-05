import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UIMessage } from "ai";
import { z } from "zod";
import { openStore } from "./conversation.ts";
import { JevClient, JevError, JEV_FALLBACK_MODEL, type JevQuestion } from "./jev.ts";
import {
	FRESH_BELOW,
	isRollingChat,
	rollingChatId,
	routeDm,
	routeDmMessage,
	type RollDeps,
} from "./rolling.ts";

let dirs: string[] = [];
function tmpdb(): string {
	const dir = mkdtempSync(join(tmpdir(), "goblin-roll-test-"));
	dirs.push(dir);
	return join(dir, "goblin.sqlite");
}
afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
});

interface GateCall { state: string; questions: Record<string, JevQuestion> }

// Fake the gate at the edge like injection.test.ts: scripted answers or
// a thrown error; calls are captured so tests can read the state.
function fakeGate(answersOrError: Record<string, number> | Error, calls?: GateCall[]): Pick<JevClient, "decide"> {
	return {
		decide: async (state: string, questions: Record<string, JevQuestion>) => {
			calls?.push({ state, questions });
			if (answersOrError instanceof Error) throw answersOrError;
			return { answers: { ...answersOrError }, inputTokens: 12, cost: 0.001 };
		},
	};
}

function harness(opts?: {
	gapMinutes?: number;
	gate?: Pick<JevClient, "decide">;
	now?: () => Date;
	busy?: (id: string) => boolean;
	checkDeadlineMs?: number;
}) {
	const store = openStore(tmpdb());
	const deps: RollDeps = {
		store,
		runtime: { busy: opts?.busy ?? (() => false) },
		gapMinutes: () => opts?.gapMinutes ?? 45,
		...(opts?.gate === undefined ? {} : { gate: () => opts.gate }),
		...(opts?.now === undefined ? {} : { now: opts.now }),
		...(opts?.checkDeadlineMs === undefined ? {} : { checkDeadlineMs: opts.checkDeadlineMs }),
	};
	return { store, deps };
}

// The clock that makes the current conversation look an hour stale.
const anHourHence = () => new Date(Date.now() + 3_600_000);

const msg = (role: "user" | "assistant", text: string): UIMessage => ({
	id: `${role}-${text}`,
	role,
	parts: [{ type: "text", text }],
});

describe("isRollingChat / rollingChatId", () => {
	test("positive ids roll, groups and topics don't", () => {
		expect(isRollingChat(42)).toBe(true);
		expect(isRollingChat(-100)).toBe(false);
		expect(rollingChatId("dm:42")).toBe(42);
		expect(rollingChatId("dm:-100")).toBeNull();
		expect(rollingChatId("topic:-100:7")).toBeNull();
		expect(rollingChatId("dm:42:3")).toBeNull(); // a concrete rolling conv is not a lane
	});
});

describe("routeDm", () => {
	test("no current rolls first", () => {
		const { store, deps } = harness();
		const r = routeDm(deps, 7, "current");
		expect(r.rolled).toBe(true);
		expect(r.decidedBy).toBe("first");
		expect(r.conv.id).toBe("dm:7:1");
		expect(store.currentDm(7)?.id).toBe("dm:7:1");
		store.close();
	});

	test("inside the gap joins current — no roll, no gate call", () => {
		const calls: GateCall[] = [];
		const { store, deps } = harness({ gate: fakeGate({ follow_up: 0.1 }, calls) });
		const current = store.rollDm(7, "/w");
		const r = routeDm(deps, 7, "command");
		expect(r.rolled).toBe(false);
		expect(r.decidedBy).toBe("gap");
		expect(r.conv.id).toBe(current.id);
		expect(calls).toHaveLength(0);
		store.close();
	});

	test("a busy lane joins current — a live turn absorbs the input", () => {
		const { store, deps } = harness({ busy: () => true, now: anHourHence });
		const current = store.rollDm(7, "/w");
		const r = routeDm(deps, 7, "command");
		expect(r.rolled).toBe(false);
		expect(r.decidedBy).toBe("busy");
		expect(r.conv.id).toBe(current.id);
		store.close();
	});

	test("past the gap: reply and current join, command and fire roll — none call the gate", () => {
		const calls: GateCall[] = [];
		const { store, deps } = harness({ gate: fakeGate({ follow_up: 0.1 }, calls), now: anHourHence });
		store.rollDm(7, "/w");
		expect(routeDm(deps, 7, "reply").decidedBy).toBe("reply");
		expect(routeDm(deps, 7, "current").decidedBy).toBe("gap");
		const cmd = routeDm(deps, 7, "command");
		expect(cmd.rolled).toBe(true);
		expect(cmd.decidedBy).toBe("command");
		expect(cmd.conv.id).toBe("dm:7:2");
		const fire = routeDm(deps, 7, "fire");
		expect(fire.rolled).toBe(true);
		expect(fire.decidedBy).toBe("fire");
		expect(fire.conv.id).toBe("dm:7:3");
		expect(calls).toHaveLength(0);
		store.close();
	});
});

describe("routeDmMessage", () => {
	test("no current rolls first without a check", async () => {
		const calls: GateCall[] = [];
		const { store, deps } = harness({ gate: fakeGate({ follow_up: 0.1 }, calls) });
		const r = await routeDmMessage(deps, 7, "hello");
		expect(r.rolled).toBe(true);
		expect(r.decidedBy).toBe("first");
		expect(calls).toHaveLength(0);
		store.close();
	});

	test("inside the gap joins current without a check", async () => {
		const calls: GateCall[] = [];
		const { store, deps } = harness({ gate: fakeGate({ follow_up: 0.1 }, calls) });
		store.rollDm(7, "/w");
		const r = await routeDmMessage(deps, 7, "hello");
		expect(r.rolled).toBe(false);
		expect(r.decidedBy).toBe("gap");
		expect(calls).toHaveLength(0);
		store.close();
	});

	test("p below the threshold rolls, above joins — both decided by the check", async () => {
		const fresh = harness({ gate: fakeGate({ follow_up: 0.1 }), now: anHourHence });
		fresh.store.rollDm(7, "/w");
		const rolled = await routeDmMessage(fresh.deps, 7, "new subject");
		expect(rolled.rolled).toBe(true);
		expect(rolled.decidedBy).toBe("check");
		expect(rolled.conv.id).toBe("dm:7:2");
		expect(rolled.probability).toBe(0.1);
		fresh.store.close();

		const cont = harness({ gate: fakeGate({ follow_up: 0.6 }), now: anHourHence });
		const current = cont.store.rollDm(8, "/w");
		const joined = await routeDmMessage(cont.deps, 8, "and also this");
		expect(joined.rolled).toBe(false);
		expect(joined.decidedBy).toBe("check");
		expect(joined.conv.id).toBe(current.id);
		expect(joined.probability).toBe(0.6);
		cont.store.close();
		expect(FRESH_BELOW).toBe(0.3);
	});

	test("a JevError falls back into current", async () => {
		const { store, deps } = harness({
			gate: fakeGate(new JevError("timeout")),
			now: anHourHence,
		});
		const current = store.rollDm(7, "/w");
		const r = await routeDmMessage(deps, 7, "hello");
		expect(r.rolled).toBe(false);
		expect(r.decidedBy).toBe("fallback");
		expect(r.conv.id).toBe(current.id);
		store.close();
	});

	test("a hanging gate hits the deadline and falls back into current", async () => {
		const hanging: Pick<JevClient, "decide"> = {
			decide: () => new Promise(() => {}), // never settles
		};
		const { store, deps } = harness({ gate: hanging, now: anHourHence, checkDeadlineMs: 30 });
		const current = store.rollDm(7, "/w");
		const r = await routeDmMessage(deps, 7, "hello");
		expect(r.rolled).toBe(false);
		expect(r.decidedBy).toBe("fallback");
		expect(r.conv.id).toBe(current.id);
		store.close();
	});

	test("passes the interactive deadline into the client as well as racing it", async () => {
		for (const deadline of [undefined, 200]) {
			let budget: number | undefined;
			const gate: Pick<JevClient, "decide"> = {
				async decide(_state, _questions, options) {
					budget = options?.timeoutMs;
					return { answers: { follow_up: 0.9 }, inputTokens: null, cost: null };
				},
			};
			const { store, deps } = harness({
				gate, now: anHourHence,
				...(deadline === undefined ? {} : { checkDeadlineMs: deadline }),
			});
			const current = store.rollDm(7, "/w");
			expect((await routeDmMessage(deps, 7, "or what do you think?")).conv.id).toBe(current.id);
			expect(budget).toBe(deadline ?? 3_000);
			store.close();
		}
	});

	test("a hung primary can recover via the backup without losing the current conversation", async () => {
		const models: string[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1", port: 0,
			async fetch(request) {
				const body = z.object({ model: z.string() }).parse(await request.json());
				models.push(body.model);
				return body.model === JEV_FALLBACK_MODEL
					? Response.json({ answers: { follow_up: { type: "noul", noul: 0.92 } } })
					: new Promise<Response>(() => {});
			},
		});
		const gate = new JevClient({
			baseUrl: `http://127.0.0.1:${server.port}`, model: "primary", auth: async () => "key",
		});
		const { store, deps } = harness({ gate, now: anHourHence, checkDeadlineMs: 400 });
		try {
			const current = store.rollDm(7, "/w");
			const result = await routeDmMessage(deps, 7, "or what do you think?");
			expect(result.conv.id).toBe(current.id);
			expect(result.rolled).toBe(false);
			expect(result.decidedBy).toBe("check");
			expect(result.probability).toBe(0.92);
			expect(models).toEqual(["primary", JEV_FALLBACK_MODEL]);
		} finally {
			server.stop(true);
			store.close();
		}
	});

	test("no gate falls back into current", async () => {
		const { store, deps } = harness({ now: anHourHence });
		const current = store.rollDm(7, "/w");
		const r = await routeDmMessage(deps, 7, "hello");
		expect(r.rolled).toBe(false);
		expect(r.decidedBy).toBe("fallback");
		expect(r.conv.id).toBe(current.id);
		store.close();
	});

	test("a non-JevError propagates — fail loud, never swallowed", async () => {
		const { store, deps } = harness({
			gate: fakeGate(new TypeError("bug in the gate")),
			now: anHourHence,
		});
		store.rollDm(7, "/w");
		await expect(routeDmMessage(deps, 7, "hello")).rejects.toThrow("bug in the gate");
		store.close();
	});

	test("a roll that happened during the check is joined, never doubled", async () => {
		const store = openStore(tmpdb());
		const racingGate: Pick<JevClient, "decide"> = {
			decide: async () => {
				// A fire rolled meanwhile — the pin now points elsewhere.
				store.rollDm(7, "/w");
				return { answers: { follow_up: 0.1 }, inputTokens: null, cost: null };
			},
		};
		const deps: RollDeps = {
			store,
			runtime: { busy: () => false },
			gapMinutes: () => 45,
			gate: () => racingGate,
			now: anHourHence,
		};
		store.rollDm(7, "/w"); // dm:7:1 — current when the burst arrived
		const r = await routeDmMessage(deps, 7, "hello");
		expect(r.rolled).toBe(false);
		expect(r.decidedBy).toBe("gap");
		expect(r.conv.id).toBe("dm:7:2"); // the fire's roll, joined
		expect(store.currentDm(7)?.id).toBe("dm:7:2"); // exactly one roll happened
		store.close();
	});

	test("a roll during a failing check joins the new current, not the stale one", async () => {
		const store = openStore(tmpdb());
		const racingGate: Pick<JevClient, "decide"> = {
			decide: async () => {
				// A fire rolled while the check was in flight — then the
				// check died. The pin re-read still wins.
				store.rollDm(7, "/w");
				throw new JevError("timeout");
			},
		};
		const deps: RollDeps = {
			store,
			runtime: { busy: () => false },
			gapMinutes: () => 45,
			gate: () => racingGate,
			now: anHourHence,
		};
		store.rollDm(7, "/w"); // dm:7:1
		const r = await routeDmMessage(deps, 7, "hello");
		expect(r.rolled).toBe(false);
		expect(r.decidedBy).toBe("gap");
		expect(r.conv.id).toBe("dm:7:2");
		store.close();
	});

	test("a lane that went busy during the check absorbs instead of rolling", async () => {
		const store = openStore(tmpdb());
		let wentBusy = false;
		const gate: Pick<JevClient, "decide"> = {
			decide: async () => {
				// A turn started on the current conversation mid-check —
				// rolling would strand this burst from the turn that must
				// see it.
				wentBusy = true;
				return { answers: { follow_up: 0.1 }, inputTokens: 1, cost: 0 };
			},
		};
		const deps: RollDeps = {
			store,
			runtime: { busy: () => wentBusy },
			gapMinutes: () => 45,
			gate: () => gate,
			now: anHourHence,
		};
		const current = store.rollDm(7, "/w");
		const r = await routeDmMessage(deps, 7, "new subject");
		expect(r.rolled).toBe(false);
		expect(r.decidedBy).toBe("busy");
		expect(r.conv.id).toBe(current.id);
		store.close();
	});

	test("fresh activity during the check joins the gap instead of rolling", async () => {
		const store = openStore(tmpdb());
		let now = anHourHence();
		const gate: Pick<JevClient, "decide"> = {
			decide: async () => {
				// Another burst landed meanwhile — it resets the quiet
				// clock, and a roll now would split two adjacent inputs.
				store.append("dm:7:1", [
					{ id: "u-mid", role: "user", parts: [{ type: "text", text: "meanwhile" }] },
				]);
				now = new Date();
				return { answers: { follow_up: 0.1 }, inputTokens: 1, cost: 0 };
			},
		};
		const deps: RollDeps = {
			store,
			runtime: { busy: () => false },
			gapMinutes: () => 45,
			gate: () => gate,
			now: () => now,
		};
		const current = store.rollDm(7, "/w");
		const r = await routeDmMessage(deps, 7, "new subject");
		expect(r.rolled).toBe(false);
		expect(r.decidedBy).toBe("gap");
		expect(r.conv.id).toBe(current.id);
		store.close();
	});

	test("the check state carries the last exchange and the burst, head-cut", async () => {
		const calls: GateCall[] = [];
		const { store, deps } = harness({ gate: fakeGate({ follow_up: 0.6 }, calls), now: anHourHence });
		const conv = store.rollDm(7, "/w");
		store.append(conv.id, [
			msg("user", "what's the weather"),
			msg("assistant", "sunny, 22°"),
			{
				id: "u2",
				role: "user",
				parts: [
					{ type: "data-attachment", data: { path: "/a.jpg", mediaType: "image/jpeg", filename: "a.jpg" } },
					{ type: "text", text: "and this pic" },
				],
			},
			msg("assistant", "nice photo"),
		]);
		const burst = "x".repeat(3_000);
		const r = await routeDmMessage(deps, 7, burst);
		expect(r.decidedBy).toBe("check");
		expect(calls).toHaveLength(1);
		const state = JSON.parse(calls[0]!.state) as {
			gapMinutes: number;
			previous: { user: string; assistant: string };
			next: string;
		};
		expect(state.previous.user).toBe("[photo]\nand this pic");
		expect(state.previous.assistant).toBe("nice photo");
		expect(state.next).toHaveLength(2_000);
		expect(state.gapMinutes).toBeGreaterThanOrEqual(59);
		store.close();
	});
});
