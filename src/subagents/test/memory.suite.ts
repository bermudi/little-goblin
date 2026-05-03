import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  MemoryStore,
  createMemoryReadIndexTool,
  createMemoryReadTool,
  createMemoryWriteTool,
  type ActiveScope,
} from "../../memory/mod.ts";
import { SubagentRunner } from "../mod.ts";
import { namedAgentAgentsMdPath, namedAgentDir } from "../paths.ts";
import {
  createTestHome,
  flush,
  getCapturedCreateArgs,
  installStandardPiMock,
  makeConfig,
  resetPiMockState,
  sessionHolder,
} from "./support.ts";

// Install mock before any tests run
installStandardPiMock();

const TOPIC_SCOPE: ActiveScope = {
  chatId: -100123,
  topicScope: { topicId: 42 },
  namedAgent: null,
};

describe("SubagentRunner — scoped memory", () => {
  let tmp: string;
  let runner: SubagentRunner;

  beforeEach(() => {
    tmp = createTestHome("goblin-subagents-memory-");
    runner = new SubagentRunner(makeConfig(tmp));
    resetPiMockState();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("anonymous subagent in a topic writes to the parent's topic scope", async () => {
    const handle = await runner.spawn({
      prompt: "work",
      activeScope: TOPIC_SCOPE,
    });
    await flush();

    const opts = getCapturedCreateArgs()[0] as Record<string, unknown>;
    const tools = opts.customTools as Array<{
      name: string;
      execute: (toolCallId: string, params: unknown) => Promise<unknown>;
    }>;
    const memoryWrite = tools.find((tool) => tool.name === "memory_write");

    expect(memoryWrite).toBeDefined();
    await memoryWrite!.execute("mw-anon", {
      action: "add",
      target: "memory",
      content: "topic fact",
    });

    expect(
      readFileSync(join(tmp, "memory", "topics", "-100123", "42", "memory.md"), "utf-8"),
    ).toBe("topic fact");

    sessionHolder.emit({ type: "agent_end", messages: [] });
    await handle.result;
  });

  it("named subagent keeps persona writes separate from active-scope writes", async () => {
    mkdirSync(namedAgentDir(tmp, "researcher"), { recursive: true });
    writeFileSync(namedAgentAgentsMdPath(tmp, "researcher"), "# Researcher\n");

    const handle = await runner.spawn({
      prompt: "work",
      name: "researcher",
      activeScope: TOPIC_SCOPE,
    });
    await flush();

    const opts = getCapturedCreateArgs()[0] as Record<string, unknown>;
    const tools = opts.customTools as Array<{
      name: string;
      execute: (toolCallId: string, params: unknown) => Promise<unknown>;
    }>;
    const memoryWrite = tools.find((tool) => tool.name === "memory_write");

    expect(memoryWrite).toBeDefined();
    await memoryWrite!.execute("mw-agent", {
      action: "add",
      target: "agent",
      content: "persona fact",
    });
    await memoryWrite!.execute("mw-topic", {
      action: "add",
      target: "memory",
      content: "topic fact",
    });

    expect(
      readFileSync(join(tmp, "memory", "agents", "researcher", "memory.md"), "utf-8"),
    ).toBe("persona fact");
    expect(
      readFileSync(join(tmp, "memory", "topics", "-100123", "42", "memory.md"), "utf-8"),
    ).toBe("topic fact");

    sessionHolder.emit({ type: "agent_end", messages: [] });
    await handle.result;
  });

  it("rejects target=agent for anonymous subagents", async () => {
    const handle = await runner.spawn({
      prompt: "work",
      activeScope: TOPIC_SCOPE,
    });
    await flush();

    const opts = getCapturedCreateArgs()[0] as Record<string, unknown>;
    const tools = opts.customTools as Array<{
      name: string;
      execute: (toolCallId: string, params: unknown) => Promise<unknown>;
    }>;
    const memoryWrite = tools.find((tool) => tool.name === "memory_write");

    expect(memoryWrite).toBeDefined();
    await expect(
      memoryWrite!.execute("mw-agent-invalid", {
        action: "add",
        target: "agent",
        content: "persona fact",
      }),
    ).rejects.toThrow('target = "agent" is only valid for named subagents');

    sessionHolder.emit({ type: "agent_end", messages: [] });
    await handle.result;
  });

  it("registers byte-identical memory tool schemas to the main agent factories", async () => {
    const handle = await runner.spawn({
      prompt: "work",
      activeScope: TOPIC_SCOPE,
    });
    await flush();

    const opts = getCapturedCreateArgs()[0] as Record<string, unknown>;
    const tools = opts.customTools as Array<{ name: string; parameters: unknown }>;
    const readTool = tools.find((tool) => tool.name === "memory_read");
    const readIndexTool = tools.find((tool) => tool.name === "memory_read_index");
    const writeTool = tools.find((tool) => tool.name === "memory_write");

    expect(JSON.stringify(readTool?.parameters)).toBe(
      JSON.stringify(
        createMemoryReadTool({
          store: new MemoryStore(tmp),
          activeScope: TOPIC_SCOPE,
        }).parameters,
      ),
    );
    expect(JSON.stringify(readIndexTool?.parameters)).toBe(
      JSON.stringify(
        createMemoryReadIndexTool({
          store: new MemoryStore(tmp),
          activeChatId: TOPIC_SCOPE.chatId,
          includeAgents: false,
        }).parameters,
      ),
    );
    expect(JSON.stringify(writeTool?.parameters)).toBe(
      JSON.stringify(
        createMemoryWriteTool({
          store: new MemoryStore(tmp),
          activeScope: TOPIC_SCOPE,
        }).parameters,
      ),
    );

    sessionHolder.emit({ type: "agent_end", messages: [] });
    await handle.result;
  });

  it("sends named-subagent snapshots with the persona section only for named agents", async () => {
    mkdirSync(join(tmp, "memory", "topics", "-100123", "42"), { recursive: true });
    writeFileSync(join(tmp, "memory", "topics", "-100123", "42", "memory.md"), "topic memory");
    writeFileSync(join(tmp, "memory", "user.md"), "user memory");
    mkdirSync(join(tmp, "memory", "agents", "researcher"), { recursive: true });
    writeFileSync(join(tmp, "memory", "agents", "researcher", "memory.md"), "persona memory");
    mkdirSync(namedAgentDir(tmp, "researcher"), { recursive: true });
    writeFileSync(namedAgentAgentsMdPath(tmp, "researcher"), "# Researcher\n");

    const namedHandle = await runner.spawn({
      prompt: "work",
      name: "researcher",
      activeScope: TOPIC_SCOPE,
    });
    await flush();

    expect(sessionHolder.sendCustomMessage).toHaveBeenCalledTimes(1);
    const [namedPayload] = sessionHolder.sendCustomMessage.mock.calls[0]!;
    const namedContent = (namedPayload as { content: string }).content;
    expect(namedContent).toContain("## user.md\nuser memory");
    expect(namedContent).toContain("## memory.md\ntopic memory");
    expect(namedContent).toContain("## agent persona\npersona memory");

    sessionHolder.emit({ type: "agent_end", messages: [] });
    await namedHandle.result;

    resetPiMockState();
    const anonHandle = await runner.spawn({
      prompt: "work",
      activeScope: TOPIC_SCOPE,
    });
    await flush();

    expect(sessionHolder.sendCustomMessage).toHaveBeenCalledTimes(1);
    const [anonPayload] = sessionHolder.sendCustomMessage.mock.calls[0]!;
    expect((anonPayload as { content: string }).content).not.toContain("## agent persona");

    sessionHolder.emit({ type: "agent_end", messages: [] });
    await anonHandle.result;
  });
});
