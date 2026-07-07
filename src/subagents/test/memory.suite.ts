import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  MemoryStore,
  createMemoryReadIndexTool,
  createMemoryReadTool,
  createMemoryWriteTool,
  type ActiveScope,
} from "../../memory/mod.ts";
import { memoryDir } from "../../memory/paths.ts";
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
      readFileSync(join(memoryDir(tmp), "topics", "-100123", "42", "memory.md"), "utf-8"),
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
      readFileSync(join(memoryDir(tmp), "agents", "researcher", "memory.md"), "utf-8"),
    ).toBe("persona fact");
    expect(
      readFileSync(join(memoryDir(tmp), "topics", "-100123", "42", "memory.md"), "utf-8"),
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
          activeScope: TOPIC_SCOPE,
          caller: { kind: "anonymous-subagent" },
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

  it("named subagents cannot discover peer persona scopes via memory_read_index", async () => {
    // Set up: create another named agent's persona
    mkdirSync(join(memoryDir(tmp), "agents", "writer"), { recursive: true });
    writeFileSync(join(memoryDir(tmp), "agents", "writer", "memory.md"), "writer persona");
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
    const readIndex = tools.find((tool) => tool.name === "memory_read_index");

    expect(readIndex).toBeDefined();
    const index = await readIndex!.execute("ri-named", {});

    // Named subagent's index does NOT include other agents
    // This is intentional isolation - subagents don't see peer personas
    // When includeAgents is false, the agents field is omitted (undefined)
    expect((index as { agents?: unknown[] }).agents).toBeUndefined();

    sessionHolder.emit({ type: "agent_end", messages: [] });
    await handle.result;
  });

  it("sends named-subagent snapshots with the persona section only for named agents", async () => {
    mkdirSync(join(memoryDir(tmp), "topics", "-100123", "42"), { recursive: true });
    writeFileSync(join(memoryDir(tmp), "topics", "-100123", "42", "memory.md"), "topic memory");
    writeFileSync(join(memoryDir(tmp), "user.md"), "user memory");
    mkdirSync(join(memoryDir(tmp), "agents", "researcher"), { recursive: true });
    writeFileSync(join(memoryDir(tmp), "agents", "researcher", "memory.md"), "persona memory");
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

  /**
   * Recursively collect every path under `root` whose basename matches `name`.
   * Returns relative paths for readable assertion failures.
   */
  function findFilesNamed(root: string, name: string): string[] {
    if (!existsSync(root)) return [];
    const hits: string[] = [];
    for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && entry.name === name) {
        hits.push(relative(root, join(entry.parentPath, entry.name)));
      }
    }
    return hits;
  }

  it("subagent agent_end does not schedule memory reflection", async () => {
    // Pre-seed a topic memory file so a reflector (if one were wired) would
    // have a target to write to. The point is that no reflector runs.
    mkdirSync(join(memoryDir(tmp), "topics", "-100123", "42"), { recursive: true });
    writeFileSync(join(memoryDir(tmp), "topics", "-100123", "42", "memory.md"), "topic memory");
    writeFileSync(join(memoryDir(tmp), "user.md"), "user memory");

    const handle = await runner.spawn({
      prompt: "remember, I prefer concise summaries with test output",
      activeScope: TOPIC_SCOPE,
    });
    await flush();

    // Emit agent_end — a main-agent runner would schedule reflection here.
    // A subagent must not.
    sessionHolder.emit({ type: "agent_end", messages: [] });
    await handle.result;
    // Drain any microtasks a hypothetical fire-and-log pass would queue.
    await flush();
    await flush();

    // No reflection cursor should exist anywhere under $GOBLIN_HOME.
    expect(findFilesNamed(tmp, "memory-reflection.json")).toEqual([]);
    // No quarantine file should have been created by automatic reflection.
    expect(existsSync(join(memoryDir(tmp), "quarantine.jsonl"))).toBe(false);
    // Trusted memory files are untouched — no automatic writes happened.
    expect(
      readFileSync(join(memoryDir(tmp), "topics", "-100123", "42", "memory.md"), "utf-8"),
    ).toBe("topic memory");
    expect(readFileSync(join(memoryDir(tmp), "user.md"), "utf-8")).toBe("user memory");
  });

  it("named subagent persona memory changes only via explicit memory_write", async () => {
    mkdirSync(join(memoryDir(tmp), "agents", "researcher"), { recursive: true });
    writeFileSync(join(memoryDir(tmp), "agents", "researcher", "memory.md"), "persona memory");
    mkdirSync(namedAgentDir(tmp, "researcher"), { recursive: true });
    writeFileSync(namedAgentAgentsMdPath(tmp, "researcher"), "# Researcher\n");

    const handle = await runner.spawn({
      prompt: "remember, I prefer concise summaries with test output",
      name: "researcher",
      activeScope: TOPIC_SCOPE,
    });
    await flush();

    // Complete the named subagent WITHOUT calling memory_write({target:"agent"}).
    sessionHolder.emit({ type: "agent_end", messages: [] });
    await handle.result;
    await flush();
    await flush();

    // Persona memory must be unchanged — automatic reflection never ran.
    expect(
      readFileSync(join(memoryDir(tmp), "agents", "researcher", "memory.md"), "utf-8"),
    ).toBe("persona memory");
    // No reflection cursor anywhere under $GOBLIN_HOME.
    expect(findFilesNamed(tmp, "memory-reflection.json")).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // memory_search registration on the subagent path.
  // Spec: "Named subagent searches own persona only" — the named subagent's
  // search SHALL consider its own persona scope and SHALL NOT consider peer
  // persona scopes. Anonymous subagents SHALL NOT search any persona scope.
  // -------------------------------------------------------------------------

  /** Extract the customTools array from the captured createAgentSession args. */
  function captureTools(): Array<{
    name: string;
    execute: (toolCallId: string, params: unknown) => Promise<unknown>;
  }> {
    const opts = getCapturedCreateArgs()[0] as Record<string, unknown>;
    return opts.customTools as Array<{
      name: string;
      execute: (toolCallId: string, params: unknown) => Promise<unknown>;
    }>;
  }

  /** Parse the JSON payload of a tool's text result. */
  function jsonOf(result: unknown): { results: Array<{ scope: string; text: string }> } {
    const r = result as { content: Array<{ type: string; text: string }> };
    return JSON.parse(r.content[0]!.text);
  }

  it("registers memory_search on the subagent tool list", async () => {
    const handle = await runner.spawn({ prompt: "work", activeScope: TOPIC_SCOPE });
    await flush();

    expect(captureTools().some((t) => t.name === "memory_search")).toBe(true);

    sessionHolder.emit({ type: "agent_end", messages: [] });
    await handle.result;
  });

  it("named subagent searches its own persona scope and excludes peer personas", async () => {
    // Own persona — searchable.
    mkdirSync(namedAgentDir(tmp, "researcher"), { recursive: true });
    writeFileSync(namedAgentAgentsMdPath(tmp, "researcher"), "# Researcher\n");
    mkdirSync(join(memoryDir(tmp), "agents", "researcher"), { recursive: true });
    writeFileSync(join(memoryDir(tmp), "agents", "researcher", "memory.md"), "researcher deployment notes");
    // Peer persona — MUST NOT be searched by the named subagent.
    mkdirSync(join(memoryDir(tmp), "agents", "writer"), { recursive: true });
    writeFileSync(join(memoryDir(tmp), "agents", "writer", "memory.md"), "writer deployment notes");
    // Same-chat topic scope — searchable.
    mkdirSync(join(memoryDir(tmp), "topics", "-100123", "7"), { recursive: true });
    writeFileSync(join(memoryDir(tmp), "topics", "-100123", "7", "memory.md"), "topic deployment notes");
    // Different-chat topic scope — MUST NOT be searched without all_chats.
    mkdirSync(join(memoryDir(tmp), "topics", "-999", "1"), { recursive: true });
    writeFileSync(join(memoryDir(tmp), "topics", "-999", "1", "memory.md"), "other chat deployment notes");

    const handle = await runner.spawn({
      prompt: "work",
      name: "researcher",
      activeScope: TOPIC_SCOPE,
    });
    await flush();

    const search = captureTools().find((t) => t.name === "memory_search")!;
    expect(search).toBeDefined();
    const out = jsonOf(await search.execute("ms-named", { query: "deployment" }));
    const scopes = new Set(out.results.map((r) => r.scope));

    // Own persona is searched.
    expect(scopes.has("agents/researcher")).toBe(true);
    // Peer persona is excluded.
    expect(scopes.has("agents/writer")).toBe(false);
    // Same-chat topic is searched.
    expect(scopes.has("topics/-100123/7")).toBe(true);
    // Different-chat topic excluded without all_chats.
    expect(scopes.has("topics/-999/1")).toBe(false);

    sessionHolder.emit({ type: "agent_end", messages: [] });
    await handle.result;
  });

  it("anonymous subagent searches no named-agent persona scopes", async () => {
    // Persona scopes exist but MUST NOT be searched by an anonymous subagent.
    mkdirSync(join(memoryDir(tmp), "agents", "researcher"), { recursive: true });
    writeFileSync(join(memoryDir(tmp), "agents", "researcher", "memory.md"), "researcher deployment notes");
    mkdirSync(join(memoryDir(tmp), "agents", "writer"), { recursive: true });
    writeFileSync(join(memoryDir(tmp), "agents", "writer", "memory.md"), "writer deployment notes");
    // Same-chat topic is still in scope.
    mkdirSync(join(memoryDir(tmp), "topics", "-100123", "7"), { recursive: true });
    writeFileSync(join(memoryDir(tmp), "topics", "-100123", "7", "memory.md"), "topic deployment notes");

    const handle = await runner.spawn({ prompt: "work", activeScope: TOPIC_SCOPE });
    await flush();

    const search = captureTools().find((t) => t.name === "memory_search")!;
    expect(search).toBeDefined();
    const out = jsonOf(await search.execute("ms-anon", { query: "deployment" }));
    const scopes = new Set(out.results.map((r) => r.scope));

    expect(scopes.has("agents/researcher")).toBe(false);
    expect(scopes.has("agents/writer")).toBe(false);
    // Same-chat topic scope remains searchable by anonymous subagents.
    expect(scopes.has("topics/-100123/7")).toBe(true);

    sessionHolder.emit({ type: "agent_end", messages: [] });
    await handle.result;
  });
});
