// The agent-children engine's observable behaviour through a real
// Runtime with a scripted fake model at the edge: spawn/settle, the
// maxRunning cap with queueing, stop, send follow-ups, and boot
// recovery. The model provider is faked; nothing else is.

import { describe, expect, test } from "bun:test";
import { COMPUTER_AGENT_TYPE, GENERAL_AGENT_TYPE } from "./agent-types.ts";
import { startAgentChildren, type AgentChildren, type AgentChild } from "./agent-children.ts";
import { DesktopError, type Desktops } from "./desktops.ts";
import { BoundaryError } from "./boundary-error.ts";
import { holderId, type DesktopRow, type LeaseHolder } from "./desktops-store.ts";
import { openStore } from "./conversation.ts";
import { Runtime } from "./runtime.ts";
import { tmpDb, useHome, waitUntil } from "./testkit.ts";
import { sdkScript } from "./testkit/turn-script-sdk.ts";
import { claudeScript } from "./testkit/turn-script-claude.ts";
import type { ScriptCall, ScriptedModel } from "./testkit/turn-script.ts";
import type { TurnSink } from "./turn/sink.ts";
import type { DevelopmentInput } from "./wake-store.ts";

const adapters = [sdkScript, claudeScript] as const;
const engineName = (make: (typeof adapters)[number]) =>
	make === sdkScript ? "ai-sdk" : "claude-code";

// Unwrap an engine result union — the test wanted the child, not the error.
const childOf = (res: { child: AgentChild } | { error: string }): AgentChild => {
	if ("error" in res) throw new Error(res.error);
	return res.child;
};

function createReply(text: string): ScriptCall[] {
	return [{ kind: "reply", parts: [{ type: "text", text }] }];
}

// A model whose single call hangs until the test releases it — a child
// mid-task.
function createGate(text: string): { calls: ScriptCall[]; release: () => void } {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { calls: [{ kind: "hold", parts: [{ type: "text", text }], gate }], release };
}

// A stateful Desktops stub: claim/release/list over an in-memory row
// map with real lease semantics — the pool's podman half is
// desktops.test.ts's job. Far-future expiry keeps leaseLive true
// against the rig's frozen clock.
function fakeDesktops() {
	const rows = new Map<string, DesktopRow>();
	const events: string[] = [];
	const blank = (name: string): DesktopRow => ({
		name,
		container: `c-${name}`,
		image: "img",
		network: false,
		reserved: false,
		leaseKind: null,
		leaseId: null,
		leaseExpiresAt: null,
		lastObsId: null,
		lastObsUsed: false,
		lastObsHash: null,
		lastActSig: null,
		lastActFrameHash: null,
		shotSeq: 0,
		createdAt: 0,
		lastUsedAt: 0,
	});
	const desktops = {
		allocate: async () => {
			throw new Error("unused");
		},
		list: () => [...rows.values()],
		get: (name: string) => rows.get(name) ?? null,
		claim: async (name: string, holder: LeaseHolder) => {
			const row = rows.get(name) ?? blank(name);
			const live = row.leaseKind !== null && (row.leaseExpiresAt ?? 0) > Date.now();
			const mine =
				live &&
				row.leaseKind === holder.kind &&
				row.leaseId === holderId(holder);
			if (live && !mine) {
				throw new DesktopError(`desktop ${name} is controlled by ${row.leaseKind} ${row.leaseId}`);
			}
			row.leaseKind = holder.kind;
			row.leaseId = holderId(holder);
			row.leaseExpiresAt = 8_640_000_000_000;
			rows.set(name, row);
			events.push(`claim ${name} ${holder.kind}:${holderId(holder) ?? ""}`);
			return row;
		},
		release: async (name: string) => {
			const row = rows.get(name);
			events.push(`release ${name}`);
			if (row !== undefined) {
				row.leaseKind = null;
				row.leaseId = null;
				row.leaseExpiresAt = null;
			}
		},
		handoff: async () => undefined,
		reserve: async () => undefined,
		setNetwork: async () => undefined,
		destroy: async () => undefined,
		screenshot: async () => {
			throw new Error("unused");
		},
		inspect: async () => {
			throw new Error("unused");
		},
		act: async () => {
			throw new Error("unused");
		},
		cpIn: async () => {
			throw new Error("unused");
		},
		catFile: async () => {
			throw new Error("unused");
		},
	} as unknown as Desktops;
	return { desktops, events, rows };
}

interface Rig {
	store: ReturnType<typeof openStore>;
	parent: ReturnType<ReturnType<typeof openStore>["resolve"]>;
	runtime: Runtime;
	engine: AgentChildren;
	recorded: DevelopmentInput[];
	events: string[];
	queue: ScriptCall[][];
}

function createRig(opts: {
	maxRunning?: number;
	desktops?: Desktops | null;
}, make: (typeof adapters)[number]): Rig {
	useHome("goblin-agent-children-");
	const store = openStore(tmpDb("goblin-agent-children-"));
	// An app conversation — the one kind whose resolve persists settings,
	// so the parent carries the model the child inherits.
	const parent = store.resolve({ kind: "app", appId: "main", chatId: 0, threadId: 0 }, "/w", {
		model: "fake/parent",
		thinking: "low",
	});
	// One adapter instance drives the Runtime; each queued script is added
	// when that Runtime asks to build the next child turn's step.
	const queue: ScriptCall[][] = [];
	const model = make();
	const runtime = new Runtime({
		engines: model.engines,
		store,
		buildStep: () => {
			const next = queue.shift();
			if (next === undefined) throw new Error("test rig: no scripted model left");
			model.script(...next);
			return model.step();
		},
	});
	runtime.mount({ makeTools: () => ({}) });
	const recorded: DevelopmentInput[] = [];
	const events: string[] = [];
	const quiet: TurnSink = {
		delivery: "headless",
		onTextDelta() {},
		onReasoningDelta() {},
		onToolCall() {},
		onDone() {},
	};
	const engine = startAgentChildren({
		store,
		runtime,
		record: (input) => {
			events.push("record");
			recorded.push(input);
			return { eventId: recorded.length, wakeId: 0, created: true };
		},
		bell: () => quiet,
		maxRunning: () => opts.maxRunning ?? 3,
		now: () => new Date("2026-11-16T00:00:00.000Z"),
		...(opts.desktops !== undefined ? { desktops: () => opts.desktops ?? null } : {}),
	});
	return { store, parent, runtime, engine, recorded, events, queue };
}

const spawn = (r: Rig, task: string) =>
	r.engine.spawn({ parent: r.parent, type: GENERAL_AGENT_TYPE, task, tools: ["read_file"] });

for (const make of adapters) {
describe(`agent children engine — ${engineName(make)}`, () => {
	const rig = (opts: Parameters<typeof createRig>[0] = {}) => createRig(opts, make);
	const reply = (text: string) => createReply(text);
	const gated = (text: string) => createGate(text);
	test("spawn runs the child, settles done, wakes the parent with the fenced result", async () => {
		const r = rig();
		r.queue.push(reply("CHILD RESULT"));
		const { child, queued } = await spawn(r, "do it");
		expect(queued).toBe(false);
		expect(child.status).toBe("running");
		// The child conversation carries the family marks.
		const conv = r.store.get(child.conversationId)!;
		expect(conv.parentId).toBe(r.parent.id);
		expect(conv.agentType).toBe("general");
		expect(conv.memoryExcluded).toBe(true);
		const settlement = await r.engine.awaitSettlement(child.conversationId);
		expect(settlement.child.status).toBe("done");
		expect(settlement.result).toBe("CHILD RESULT");
		// The wake: one durable development on the parent, fenced.
		expect(r.recorded).toHaveLength(1);
		const wake = r.recorded[0]!;
		expect(wake.conversationId).toBe(r.parent.id);
		expect(wake.kind).toBe("agent");
		expect(wake.sourceKey).toBe(`agent:${child.conversationId}:1`);
		expect(wake.text).toContain("[agent: general · done]");
		expect(wake.text).toContain('<event source="agent">');
		expect(wake.text).toContain("CHILD RESULT");
		// list and read see the settled child.
		expect(r.engine.list(r.parent.id).map((c) => c.conversationId)).toEqual([
			child.conversationId,
		]);
		const read = r.engine.read(child.conversationId)!;
		expect(read.child.status).toBe("done");
		expect(read.messages.at(-1)).toMatchObject({ role: "assistant", text: "CHILD RESULT" });
		// allowlistFor serves the persisted spawn-time tools.
		expect(r.engine.allowlistFor(child.conversationId)).toEqual(["read_file"]);
		expect(r.engine.allowlistFor(r.parent.id)).toBeNull();
	});

	test("an agent_children table that still has responsibility columns spawns and sends", async () => {
		const r = rig();
		r.store.db.run("DROP TABLE agent_children");
		r.store.db.run(`
			CREATE TABLE agent_children (
				conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
				parent_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
				type TEXT NOT NULL, status TEXT NOT NULL, task TEXT NOT NULL,
				tools_json TEXT NOT NULL, settlements INTEGER NOT NULL DEFAULT 0,
				created_at TEXT NOT NULL, started_at TEXT, settled_at TEXT,
				desktop TEXT, pending_ask TEXT,
				responsibility_id TEXT, responsibility_revision INTEGER
			)
		`);
		const { ensureAgentChildrenSchema } = await import("./agent-children.ts");
		ensureAgentChildrenSchema(r.store.db);
		r.queue.push(reply("first"), reply("follow-up"));
		const child = (await r.engine.spawn({
			parent: r.parent, type: GENERAL_AGENT_TYPE, task: "old table", tools: ["read_file"],
		})).child;
		await r.engine.awaitSettlement(child.conversationId);
		expect("error" in r.engine.send(child.conversationId, "continue")).toBe(false);
		expect((await r.engine.awaitSettlement(child.conversationId)).result).toBe("follow-up");
		const cols = r.store.db.query<{ name: string }, []>("PRAGMA table_info(agent_children)").all();
		expect(cols.map((col) => col.name)).toContain("responsibility_id");
	});

	test("over maxRunning the spawn queues; a freed slot pumps it", async () => {
		const r = rig({ maxRunning: 1 });
		const first = gated("A DONE");
		const second = gated("B DONE");
		r.queue.push(first.calls, second.calls);
		const a = await spawn(r, "a");
		expect(a.child.status).toBe("running");
		const b = await spawn(r, "b");
		expect(b.queued).toBe(true);
		expect(b.child.status).toBe("queued");
		// Settling A frees the slot; pump starts B without a nudge. B's
		// gate opens with A's — the queue, not the gate, is what holds it.
		first.release();
		second.release();
		const sa = await r.engine.awaitSettlement(a.child.conversationId);
		expect(sa.child.status).toBe("done");
		expect(sa.result).toBe("A DONE");
		const sb = await r.engine.awaitSettlement(b.child.conversationId);
		expect(sb.child.status).toBe("done");
		expect(sb.result).toBe("B DONE");
		expect(r.recorded).toHaveLength(2);
	});

	test("stop closes a running child and a queued one, with no parent wake", async () => {
		const r = rig({ maxRunning: 1 });
		const gate = gated("NEVER SEEN");
		const queuedModel = reply("QUEUED RUNS");
		r.queue.push(gate.calls, queuedModel);
		const a = await spawn(r, "a");
		const b = await spawn(r, "b");
		expect(childOf(r.engine.stop(b.child.conversationId)).status).toBe("stopped");
		expect(childOf(r.engine.stop(a.child.conversationId)).status).toBe("stopped");
		// The foreground waiter resolves from the stop itself.
		const settlement = await r.engine.awaitSettlement(a.child.conversationId);
		expect(settlement.child.status).toBe("stopped");
		await waitUntil(() => !r.runtime.busy(a.child.conversationId), "child lane drains");
		// The freed slot pumps the queue — but B is stopped, so nothing
		// runs and the parent is never woken.
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(r.recorded).toHaveLength(0);
		gate.release();
		await r.runtime.shutdown();
	});

	test("send to a done child runs a follow-up that settles and wakes again", async () => {
		const r = rig();
		r.queue.push(reply("FIRST"));
		const { child } = await spawn(r, "one");
		await r.engine.awaitSettlement(child.conversationId);
		r.queue.push(reply("SECOND"));
		expect(childOf(r.engine.send(child.conversationId, "go again")).status).toBe("running");
		const second = await r.engine.awaitSettlement(child.conversationId);
		expect(second.child.status).toBe("done");
		expect(second.result).toBe("SECOND");
		expect(r.recorded).toHaveLength(2);
		expect(r.recorded[1]!.sourceKey).toBe(`agent:${child.conversationId}:2`);
	});

	test("send while the child runs rides that turn; the row settles once at its end", async () => {
		const r = rig();
		const gate = gated("STEER TARGET");
		r.queue.push(gate.calls);
		// No tool boundary sends this late input into Claude's query; it needs a follow-up reply.
		if (make === claudeScript) r.queue.push(reply("STEER TARGET"));
		const { child } = await spawn(r, "slow");
		expect(childOf(r.engine.send(child.conversationId, "and also this")).status).toBe("running");
		gate.release();
		const settlement = await r.engine.awaitSettlement(child.conversationId);
		// Both submitted sinks owe a done; the LAST one settles the row —
		// one wake, the child's final reply.
		expect(settlement.child.status).toBe("done");
		expect(settlement.result).toBe("STEER TARGET");
		expect(r.recorded).toHaveLength(1);
	});

	test("a failed turn settles failed and names the error", async () => {
		const r = rig();
		r.queue.push([{ kind: "fail", parts: [], error: { message: "model exploded" } }]);
		const { child } = await spawn(r, "doomed");
		const settlement = await r.engine.awaitSettlement(child.conversationId);
		expect(settlement.child.status).toBe("failed");
		// A failed child's result slot carries the reason.
		expect(settlement.result).toBe("model exploded");
		const wake = r.recorded[0]!;
		expect(wake.text).toContain("[agent: general · failed]");
		expect(wake.text).toContain("model exploded");
	});

	test("boot recovery settles a cut child failed and pumps the queue", async () => {
		const r = rig({ maxRunning: 1 });
		const gate = gated("CUT SHORT");
		const queuedModel = reply("QUEUED AFTER BOOT");
		r.queue.push(gate.calls, queuedModel);
		const cut = await spawn(r, "was running");
		const waiting = await spawn(r, "was queued");
		expect(waiting.queued).toBe(true);
		// A fresh engine on the same store — the process restarted around
		// the same rows. The old runtime's lane is abandoned with its gate.
		const recorded: DevelopmentInput[] = [];
		const quiet: TurnSink = {
			delivery: "headless",
			onTextDelta() {},
			onReasoningDelta() {},
			onToolCall() {},
			onDone() {},
		};
		const after = startAgentChildren({
			store: r.store,
			runtime: r.runtime,
			record: (input) => {
				recorded.push(input);
				return { eventId: recorded.length, wakeId: 0, created: true };
			},
			bell: () => quiet,
			maxRunning: () => 1,
			now: () => new Date("2026-11-16T00:00:00.000Z"),
		});
		after.recoverAtBoot();
		expect(after.get(cut.child.conversationId)!.status).toBe("failed");
		expect(recorded).toHaveLength(1);
		expect(recorded[0]!.text).toContain("[agent: general · failed]");
		expect(recorded[0]!.text).toContain("restart");
		// The queued child started on the freed slot.
		const settlement = await after.awaitSettlement(waiting.child.conversationId);
		expect(settlement.child.status).toBe("done");
		expect(settlement.result).toBe("QUEUED AFTER BOOT");
		gate.release();
		await r.runtime.shutdown();
	});

	test("a computer spawn claims its desktop for the child conversation; settlement releases it", async () => {
		const fake = fakeDesktops();
		const r = rig({ desktops: fake.desktops });
		r.queue.push(reply("CLICKED IT"));
		const { child, spawnError } = await r.engine.spawn({
			parent: r.parent,
			type: COMPUTER_AGENT_TYPE,
			task: "click the button on desk",
			tools: ["inspect", "act", "launch", "ask_operator"],
			desktop: "desk",
		});
		expect(spawnError).toBeUndefined();
		// The claim names the child conversation as holder — not the
		// parent, not a run id.
		expect(fake.events).toEqual([`claim desk conversation:${child.conversationId}`]);
		expect(r.engine.desktopFor(child.conversationId)).toBe("desk");
		expect(r.engine.desktopFor(r.parent.id)).toBeNull();
		const settlement = await r.engine.awaitSettlement(child.conversationId);
		expect(settlement.child.status).toBe("done");
		// Settlement hands the desktop back.
		expect(fake.events).toEqual([
			`claim desk conversation:${child.conversationId}`,
			"release desk",
		]);
		expect(fake.rows.get("desk")!.leaseKind).toBeNull();
	});

	test("a refused desktop claim fails the spawn before the child runs", async () => {
		const fake = fakeDesktops();
		// The operator holds the desktop — the child's claim must refuse.
		await fake.desktops.claim("desk", { kind: "operator" });
		fake.events.length = 0;
		const r = rig({ desktops: fake.desktops });
		const { child, queued, spawnError } = await r.engine.spawn({
			parent: r.parent,
			type: COMPUTER_AGENT_TYPE,
			task: "click the button",
			tools: ["inspect", "act"],
			desktop: "desk",
		});
		expect(queued).toBe(false);
		expect(child.status).toBe("failed");
		expect(spawnError).toContain("controlled by operator");
		// No turn was submitted — the scripted-model queue stays empty
		// and nothing settles again.
		expect(r.recorded).toHaveLength(0);
		expect(r.engine.get(child.conversationId)!.status).toBe("failed");
	});

	test("a transient desktop claim keeps the computer run alive", async () => {
		const fake = fakeDesktops();
		fake.desktops.claim = async () => {
			throw new BoundaryError("podman", "transient", "daemon unavailable");
		};
		const r = rig({ desktops: fake.desktops });
		const gate = gated("waiting for user");
		r.queue.push(gate.calls);
		const { child, spawnError } = await r.engine.spawn({
			parent: r.parent,
			type: COMPUTER_AGENT_TYPE,
			task: "inspect the desktop",
			tools: ["inspect", "act"],
			desktop: "desk",
		});
		expect(spawnError).toBeUndefined();
		expect(child.status).toBe("running");
		expect(r.engine.get(child.conversationId)!.status).toBe("running");
		gate.release();
		await r.engine.awaitSettlement(child.conversationId);
		await r.runtime.shutdown();
	});

	test("ask_operator parks the child needs-input, releases the desktop, and send resumes it", async () => {
		const fake = fakeDesktops();
		const r = rig({ desktops: fake.desktops });
		const gate = gated("never reached");
		r.queue.push(gate.calls, reply("DONE AFTER ANSWER"));
		const { child } = await r.engine.spawn({
			parent: r.parent,
			type: COMPUTER_AGENT_TYPE,
			task: "pick a button",
			tools: ["inspect", "act", "ask_operator"],
			desktop: "desk",
		});
		expect(child.status).toBe("running");
		// The tool's engine call mid-turn records the question.
		expect(r.engine.askOperator(child.conversationId, "which button should I click?")).toEqual({
			ok: true,
		});
		gate.release();
		const settlement = await r.engine.awaitSettlement(child.conversationId);
		// needs-input: the question is the result the parent must answer.
		expect(settlement.child.status).toBe("needs-input");
		expect(settlement.result).toBe("which button should I click?");
		const wake = r.recorded[0]!;
		expect(wake.text).toContain("[agent: computer · needs-input]");
		expect(wake.text).toContain("which button should I click?");
		// Needs input released the desktop for the operator.
		expect(fake.rows.get("desk")!.leaseKind).toBeNull();
		// The operator's answer continues the same child.
		expect(childOf(r.engine.send(child.conversationId, "the red one")).status).toBe("running");
		const second = await r.engine.awaitSettlement(child.conversationId);
		expect(second.child.status).toBe("done");
		expect(second.result).toBe("DONE AFTER ANSWER");
	});

	test("stop releases the child's desktop lease", async () => {
		const fake = fakeDesktops();
		const r = rig({ desktops: fake.desktops });
		const gate = gated("NEVER");
		r.queue.push(gate.calls);
		const { child } = await r.engine.spawn({
			parent: r.parent,
			type: COMPUTER_AGENT_TYPE,
			task: "work",
			tools: ["inspect"],
			desktop: "desk",
		});
		expect(childOf(r.engine.stop(child.conversationId)).status).toBe("stopped");
		expect(fake.events).toContain("release desk");
		expect(fake.rows.get("desk")!.leaseKind).toBeNull();
		gate.release();
		await r.runtime.shutdown();
	});
});
}
