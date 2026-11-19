// The agent tool's model-facing surface: input validation, the child
// tool-exclusion policy, spawn paths (queued note, foreground wait,
// abort), and withAgent's mount. The engine itself is exercised in
// agent-children.test.ts against a real Runtime — here it is stubbed
// at its own boundary.

import { z } from "zod";
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
		askOperator: over.askOperator ?? notExpected("askOperator"),
		desktopFor: over.desktopFor ?? (() => null),
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

const child = (status: AgentChild["status"], over: Partial<AgentChild> = {}): AgentChild => ({
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
	desktop: null,
	responsibilityId: null,
	responsibilityRevision: null,
	...over,
});

const executeUnknown = (tool: ReturnType<typeof agentTool>, input: unknown) =>
	(tool as unknown as {
		execute: (raw: unknown, options: { toolCallId: string }) => Promise<unknown>;
	}).execute(input, { toolCallId: "test" });

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
		];
		expect(childToolAllowlist(parentTools)).toEqual(["read_file", "bash"]);
		expect(childToolAllowlist(parentTools, ["bash"])).toEqual(["bash"]);
	});

	test("intrinsic tools admit only the names the type lists", () => {
		// A parent turn never mounts the computer tools — the type's
		// allowlist names them and intrinsicTools is what admits them.
		const parentTools = ["read_file", "bash"];
		const typeTools = ["inspect", "act", "launch", "ask_operator"];
		expect(childToolAllowlist(parentTools, typeTools, typeTools)).toEqual(typeTools);
		// A name the child mount does not provide stays out.
		expect(childToolAllowlist(parentTools, typeTools, ["inspect"])).toEqual(["inspect"]);
		// Without intrinsicTools the same type allowlist loses them all.
		expect(childToolAllowlist(parentTools, typeTools)).toEqual([]);
	});
});

describe("agent tool", () => {
	const types = new Map([[GENERAL_AGENT_TYPE.name, GENERAL_AGENT_TYPE]]);
	const deps = (
		engine: AgentChildren,
		parentTools = ["read_file", "bash", "speak"],
		extra: {
			checkResponsibility?: ((id: string) => string | null) | undefined;
			sendAuthority?: ((id: string) => "responsibility-missing" | "responsibility-inactive" | "outside-project" | null) | undefined;
		} = {},
	) => ({
		engine,
		types,
		conversation: parent,
		parentTools,
		intrinsicTools: [] as string[],
		...extra,
	});

	test("spawn defaults to general, captures the filtered tools, and notes the queue", async () => {
		const captured: SpawnInput[] = [];
		const engine = stubEngine({
			spawn: async (input) => {
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

	test("responsibility links are admitted only by the project check", async () => {
		const captured: SpawnInput[] = [];
		const engine = stubEngine({
			spawn: async (input) => {
				captured.push(input);
				return { child: child("running", { responsibilityId: "resp-1" }), queued: false };
			},
		});
		const result = await executeUnknown(
			agentTool(deps(engine, ["read_file"], { checkResponsibility: () => null })),
			{ action: "spawn", task: "assigned", responsibility: "resp-1" },
		);
		expect(result).toMatchObject({ responsibility: "resp-1" });
		expect(captured[0]?.responsibilityId).toBe("resp-1");

		const refused = await executeUnknown(
			agentTool(deps(stubEngine(), ["read_file"], {
				checkResponsibility: () => "responsibility is closed",
			})),
			{ action: "spawn", task: "assigned", responsibility: "resp-1" },
		);
		expect(refused).toMatchObject({ error: "responsibility is closed" });
	});

	test("spawn refuses a desktop for a type that cannot drive one, before any claim", async () => {
		// stubEngine's spawn throws if reached: the refusal claims nothing.
		const result = await agentTool(deps(stubEngine())).execute(
			{ action: "spawn", task: "x", desktop: "desk1" },
			{ toolCallId: "t1" },
		);
		expect(result).toMatchObject({ error: expect.stringContaining("cannot take a desktop") });
	});

	test("spawn background:false waits for the settlement and returns it", async () => {
		const settlement: Settlement = { child: child("done"), result: "THE REPLY" };
		const engine = stubEngine({
			spawn: async () => ({ child: child("running"), queued: false }),
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
			spawn: async () => ({ child: child("running"), queued: false }),
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

	test("responsibility description and schema are exposed only when linkable", () => {
		const linkable = agentTool(deps(stubEngine(), ["read_file"], { checkResponsibility: () => null }));
		const plain = agentTool(deps(stubEngine()));
		expect(linkable.description).toContain("each settlement is then filed as a worker report");
		expect(plain.description).not.toContain("each settlement is then filed as a worker report");
		expect(linkable.input.safeParse({ action: "spawn", task: "t", responsibility: "r1" }).success).toBe(true);
		const props = (t: { input: unknown }) =>
			Object.keys((z.toJSONSchema(t.input as z.ZodType) as { properties: object }).properties);
		expect(props(linkable)).toContain("responsibility");
		expect(props(plain)).not.toContain("responsibility");
	});

	test("a responsibility link outside a project conversation is refused before spawn", async () => {
		// stubEngine's spawn throws if reached.
		const refused = await executeUnknown(agentTool(deps(stubEngine())), {
			action: "spawn",
			task: "assigned",
			responsibility: "resp-1",
		});
		expect(refused).toEqual({ error: "responsibility links need a project conversation" });
	});

	test("send forwards the authority callback to the child engine", async () => {
		let authorizeReceived: unknown;
		const authorize = () => "responsibility-inactive" as const;
		const engine = stubEngine({
			send: (_id, _text, check) => {
				authorizeReceived = check;
				return { child: child("running") };
			},
		});
		await agentTool(deps(engine, ["read_file"], { sendAuthority: authorize })).execute(
			{ action: "send", id: "app/agent-x", text: "continue" },
			{ toolCallId: "t3" },
		);
		expect(authorizeReceived).toBe(authorize);
	});

	test("withAgent mounts the tool and its description lists the types", async () => {
		const tools = withAgent(
			{ read_file: stubBaseTool, bash: stubBaseTool },
			{ engine: stubEngine(), types, conversation: parent, intrinsicTools: [] },
		);
		const tool = tools.agent;
		if (tool === undefined || isHosted(tool)) throw new Error("agent tool not mounted");
		expect(tool.description).toContain("- general:");
	});
});
