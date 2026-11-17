// The agent tool's model-facing surface: input validation, the child
// tool-exclusion policy, spawn paths (queued note, foreground wait,
// abort), and withAgent's mount. The engine itself is exercised in
// agent-children.test.ts against a real Runtime — here it is stubbed
// at its own boundary.

import { describe, expect, test } from "bun:test";
import type { AgentChild, AgentChildren, SpawnInput, Settlement } from "../../agent-children.ts";
import { GENERAL_AGENT_TYPE } from "../../agent-types.ts";
import type { Conversation } from "../../conversation-read.ts";
import { agentInputSchema, agentTool, childToolAllowlist, withAgent } from "./agent.ts";
import { isHosted } from "../../tool.ts";

// A child-shaped engine stub: the one method under test behaves, the
// rest throw if the tool reaches for them unexpectedly.
function stubEngine(over: Partial<AgentChildren> = {}): AgentChildren {
	const notExpected = (name: string) => () => {
		throw new Error(`unexpected engine call: ${name}`);
	};
	return {
		spawn: over.spawn ?? notExpected("spawn"),
		list: over.list ?? notExpected("list"),
		get: over.get ?? notExpected("get"),
		read: over.read ?? notExpected("read"),
		send: over.send ?? notExpected("send"),
		stop: over.stop ?? notExpected("stop"),
		awaitSettlement: over.awaitSettlement ?? notExpected("awaitSettlement"),
		allowlistFor: over.allowlistFor ?? notExpected("allowlistFor"),
		pump: over.pump ?? notExpected("pump"),
		recoverAtBoot: over.recoverAtBoot ?? notExpected("recoverAtBoot"),
	};
}

const parent = {
	id: "dm:1",
	model: "a/b",
	thinking: null,
	agentType: null,
} as unknown as Conversation;

const child = (status: AgentChild["status"]): AgentChild => ({
	conversationId: "app/agent-x",
	parentConversationId: "dm:1",
	type: "general",
	status,
	task: "the task",
	tools: ["read_file"],
	settlements: 0,
	createdAt: new Date().toISOString(),
	startedAt: null,
	settledAt: null,
});

// A stand-in tool for the mount test's base set.
const stubBaseTool = {
	description: "stub",
	input: agentInputSchema,
	execute: async () => ({}),
} as const;

describe("child tool allowlist", () => {
	test("exclusions go, the type allowlist intersects", () => {
		const parentTools = [
			"read_file",
			"bash",
			"speak",
			"send_file",
			"ui",
			"mail",
			"artifact",
			"memory_search",
			"memory_reflect",
			"note",
			"program",
			"desktop",
			"delegate",
			"subagent",
		];
		expect(childToolAllowlist(parentTools)).toEqual(["read_file", "bash"]);
		expect(childToolAllowlist(parentTools, ["bash"])).toEqual(["bash"]);
	});
});

describe("agent tool", () => {
	const types = new Map([[GENERAL_AGENT_TYPE.name, GENERAL_AGENT_TYPE]]);
	const deps = (engine: AgentChildren, parentTools = ["read_file", "bash", "speak"]) => ({
		engine,
		types,
		conversation: parent,
		parentTools,
	});

	test("spawn defaults to general, captures the filtered tools, and notes the queue", async () => {
		const captured: SpawnInput[] = [];
		const engine = stubEngine({
			spawn: (input) => {
				captured.push(input);
				return { child: child("queued"), queued: true };
			},
		});
		const result = await agentTool(deps(engine)).execute(
			{ action: "spawn", task: "read the logs" },
			{ toolCallId: "t1" },
		);
		expect(captured[0]?.type.name).toBe("general");
		expect(captured[0]?.task).toBe("read the logs");
		expect(captured[0]?.tools).toEqual(["read_file", "bash"]);
		expect(result).toMatchObject({ id: "app/agent-x", status: "queued", queued: true });
	});

	test("spawn with an unknown type names the known ones", async () => {
		const result = await agentTool(deps(stubEngine())).execute(
			{ action: "spawn", type: "nope", task: "x" },
			{ toolCallId: "t1" },
		);
		expect(result).toMatchObject({ error: expect.stringContaining("known: general") });
	});

	test("spawn background:false waits for the settlement and returns it", async () => {
		const settlement: Settlement = { child: child("done"), result: "THE REPLY" };
		const engine = stubEngine({
			spawn: () => ({ child: child("running"), queued: false }),
			awaitSettlement: () => Promise.resolve(settlement),
		});
		const result = await agentTool(deps(engine)).execute(
			{ action: "spawn", task: "x", background: false },
			{ toolCallId: "t1" },
		);
		expect(result).toMatchObject({ id: "app/agent-x", status: "done", result: "THE REPLY" });
	});

	test("spawn background:false on an aborted turn stops the child it made", async () => {
		const stopped: string[] = [];
		const engine = stubEngine({
			spawn: () => ({ child: child("running"), queued: false }),
			stop: (id) => {
				stopped.push(id);
				return { child: child("stopped") };
			},
		});
		const controller = new AbortController();
		controller.abort();
		const result = await agentTool(deps(engine)).execute(
			{ action: "spawn", task: "x", background: false },
			{ toolCallId: "t1", abortSignal: controller.signal },
		);
		expect(stopped).toEqual(["app/agent-x"]);
		expect(result).toMatchObject({ error: expect.stringContaining("stopped") });
	});

	test("read, send, and stop pass through the engine answers", async () => {
		const engine = stubEngine({
			read: (id) => {
				expect(id).toBe("app/agent-x");
				return {
					child: child("running"),
					messages: [{ role: "user", text: "the task" }],
				};
			},
			send: () => ({ child: child("running") }),
			stop: () => ({ error: "no agent child y" }),
		});
		const read = await agentTool(deps(engine)).execute(
			{ action: "read", id: "app/agent-x" },
			{ toolCallId: "t1" },
		);
		expect(read).toMatchObject({ status: "running", messages: [{ role: "user" }] });
		const send = await agentTool(deps(engine)).execute(
			{ action: "send", id: "app/agent-x", text: "go" },
			{ toolCallId: "t2" },
		);
		expect(send).toMatchObject({ id: "app/agent-x", status: "running" });
		const stop = await agentTool(deps(engine)).execute(
			{ action: "stop", id: "app/agent-x" },
			{ toolCallId: "t3" },
		);
		expect(stop).toMatchObject({ error: "no agent child y" });
	});

	test("the input schema rejects verb/field mismatches", () => {
		expect(agentInputSchema.safeParse({ action: "read" }).success).toBe(false);
		expect(agentInputSchema.safeParse({ action: "send", id: "x" }).success).toBe(false);
		expect(agentInputSchema.safeParse({ action: "spawn" }).success).toBe(false);
		expect(agentInputSchema.safeParse({ action: "spawn", task: "t" }).success).toBe(true);
		expect(agentInputSchema.safeParse({ action: "list" }).success).toBe(true);
	});

	test("withAgent mounts the tool and its description lists the types", async () => {
		const tools = withAgent(
			{ read_file: stubBaseTool, bash: stubBaseTool },
			{ engine: stubEngine(), types, conversation: parent },
		);
		const tool = tools.agent;
		if (tool === undefined || isHosted(tool)) throw new Error("agent tool not mounted");
		expect(tool.description).toContain("- general:");
	});
});

