import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  MemoryStore,
  createMemoryWriteTool,
  type ActiveScope,
  type MemoryScope,
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

type SeedScope = "user" | "memory" | MemoryScope;

async function seedMemory(
  home: string,
  records: Array<{ scope: SeedScope; content: string }>,
): Promise<void> {
  const store = new MemoryStore(home);
  try {
    for (const r of records) await store.add(r.scope, r.content);
  } finally {
    store.close();
  }
}

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

    const check = new MemoryStore(tmp);
    expect(check.readBody({ topic: { chatId: -100123, topicId: 42 } })).toBe("topic fact");
    check.close();

    sessionHolder.emit({ type: "agent_end", messages: [] });
    await handle.result;
  });

  it("named subagent keeps persona writes separate from active-scope writes", async () => {
    mkdirSync(namedAgentDir(tmp, "researcher"), { recursive: true });
    writeFileSync(namedAgentAgentsMdPath(tmp, "researcher"), "# Researcher\n");

    await seedMemory(tmp, [
      { scope: { topic: { chatId: -100123, topicId: 42 } }, content: "topic base" },
      { scope: { agent: { name: "researcher" } }, content: "persona base" },
    ]);

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

    const check = new MemoryStore(tmp);
    expect(check.readBody({ topic: { chatId: -100123, topicId: 42 } })).toBe(
      "topic base\n§\ntopic fact",
    );
    expect(check.readBody({ agent: { name: "researcher" } })).toBe(
      "persona base\n§\npersona fact",
    );
    check.close();

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
    const searchTool = tools.find((tool) => tool.name === "memory_search");
    const writeTool = tools.find((tool) => tool.name === "memory_write");

    expect(searchTool).toBeDefined();
    expect(writeTool).toBeDefined();
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

  it("named subagents cannot discover peer persona scopes via memory_search index", async () => {
    // Set up: create another named agent's persona
    mkdirSync(namedAgentDir(tmp, "researcher"), { recursive: true });
    writeFileSync(namedAgentAgentsMdPath(tmp, "researcher"), "# Researcher\n");

    await seedMemory(tmp, [
      { scope: { agent: { name: "writer" } }, content: "writer persona" },
      { scope: { agent: { name: "researcher" } }, content: "researcher persona" },
    ]);

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
    const searchTool = tools.find((tool) => tool.name === "memory_search");

    expect(searchTool).toBeDefined();
    const index = await searchTool!.execute("ms-named", {});
    const parsed = jsonOf<{ general: unknown[]; topics: unknown[]; agents: unknown[] }>(index);

    // Named subagent's index does NOT include other agents
    // This is intentional isolation - subagents don't see peer personas.
    expect(parsed.agents).toEqual([]);

    sessionHolder.emit({ type: "agent_end", messages: [] });
    await handle.result;
  });

  it("injects a frozen memory summary into the subagent system prompt and sends a bounded relevant-memory aside", async () => {
    mkdirSync(namedAgentDir(tmp, "researcher"), { recursive: true });
    writeFileSync(namedAgentAgentsMdPath(tmp, "researcher"), "# Researcher\n");

    await seedMemory(tmp, [
      { scope: "general", content: "general memory" },
      { scope: "user", content: "user memory" },
      { scope: { topic: { chatId: -100123, topicId: 42 } }, content: "topic memory" },
      { scope: { agent: { name: "researcher" } }, content: "persona memory" },
    ]);

    const namedHandle = await runner.spawn({
      prompt: "persona",
      name: "researcher",
      activeScope: TOPIC_SCOPE,
    });
    await flush();

    // Named subagent: system prompt is the agent's AGENTS.md plus the frozen
    // memory summary; the per-turn aside is a bounded relevant-memory snapshot.
    const namedOpts = getCapturedCreateArgs()[0] as { resourceLoader?: { options?: { systemPrompt?: string } } };
    const namedSystem = namedOpts.resourceLoader?.options?.systemPrompt ?? "";
    expect(namedSystem).toContain("# Researcher");
    expect(namedSystem).toContain("[goblin memory summary (frozen at session start)]");
    expect(namedSystem).toContain("## user.md\nuser memory");
    expect(namedSystem).toContain("## memory.md\ntopic memory");

    expect(sessionHolder.sendCustomMessage).toHaveBeenCalledTimes(1);
    const [namedPayload] = sessionHolder.sendCustomMessage.mock.calls[0]!;
    const namedAside = (namedPayload as { content: string }).content;
    expect(namedAside).toContain("## relevant memory");
    expect(namedAside).toContain("persona memory");

    sessionHolder.emit({ type: "agent_end", messages: [] });
    await namedHandle.result;

    resetPiMockState();
    const anonHandle = await runner.spawn({
      prompt: "persona",
      activeScope: TOPIC_SCOPE,
    });
    await flush();

    // Anonymous subagent: no agent AGENTS.md section and no persona memory in
    // the relevant-memory aside (it is not allowed to search agent scopes).
    const anonOpts = getCapturedCreateArgs()[0] as { resourceLoader?: { options?: { systemPrompt?: string } } };
    const anonSystem = anonOpts.resourceLoader?.options?.systemPrompt ?? "";
    expect(anonSystem).not.toContain("# Researcher");
    expect(anonSystem).toContain("[goblin memory summary (frozen at session start)]");

    expect(sessionHolder.sendCustomMessage).toHaveBeenCalledTimes(0);

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
    // Pre-seed topic and user memory so a reflector (if one were wired) would
    // have a target to write to. The point is that no reflector runs.
    await seedMemory(tmp, [
      { scope: { topic: { chatId: -100123, topicId: 42 } }, content: "topic memory" },
      { scope: "user", content: "user memory" },
    ]);

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
    const check = new MemoryStore(tmp);
    expect(check.readBody({ topic: { chatId: -100123, topicId: 42 } })).toBe("topic memory");
    expect(check.readBody("user")).toBe("user memory");
    check.close();
  });

  it("named subagent persona memory changes only via explicit memory_write", async () => {
    mkdirSync(namedAgentDir(tmp, "researcher"), { recursive: true });
    writeFileSync(namedAgentAgentsMdPath(tmp, "researcher"), "# Researcher\n");

    await seedMemory(tmp, [
      { scope: { agent: { name: "researcher" } }, content: "persona memory" },
    ]);

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
    const check = new MemoryStore(tmp);
    expect(check.readBody({ agent: { name: "researcher" } })).toBe("persona memory");
    check.close();
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
  function jsonOf<T>(result: unknown): T {
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

    await seedMemory(tmp, [
      { scope: { agent: { name: "researcher" } }, content: "researcher deployment notes" },
      // Peer persona — MUST NOT be searched by the named subagent.
      { scope: { agent: { name: "writer" } }, content: "writer deployment notes" },
      // Same-chat topic scope — searchable.
      { scope: { topic: { chatId: -100123, topicId: 7 } }, content: "topic deployment notes" },
      // Different-chat topic scope — MUST NOT be searched without all_chats.
      { scope: { topic: { chatId: -999, topicId: 1 } }, content: "other chat deployment notes" },
    ]);

    const handle = await runner.spawn({
      prompt: "work",
      name: "researcher",
      activeScope: TOPIC_SCOPE,
    });
    await flush();

    const search = captureTools().find((t) => t.name === "memory_search")!;
    expect(search).toBeDefined();
    const out = jsonOf<{ results: Array<{ scope: string; text: string }> }>(
      await search.execute("ms-named", { query: "deployment" }),
    );
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
    await seedMemory(tmp, [
      { scope: { agent: { name: "researcher" } }, content: "researcher deployment notes" },
      { scope: { agent: { name: "writer" } }, content: "writer deployment notes" },
      // Same-chat topic is still in scope.
      { scope: { topic: { chatId: -100123, topicId: 7 } }, content: "topic deployment notes" },
    ]);

    const handle = await runner.spawn({ prompt: "work", activeScope: TOPIC_SCOPE });
    await flush();

    const search = captureTools().find((t) => t.name === "memory_search")!;
    expect(search).toBeDefined();
    const out = jsonOf<{ results: Array<{ scope: string; text: string }> }>(
      await search.execute("ms-anon", { query: "deployment" }),
    );
    const scopes = new Set(out.results.map((r) => r.scope));

    expect(scopes.has("agents/researcher")).toBe(false);
    expect(scopes.has("agents/writer")).toBe(false);
    // Same-chat topic scope remains searchable by anonymous subagents.
    expect(scopes.has("topics/-100123/7")).toBe(true);

    sessionHolder.emit({ type: "agent_end", messages: [] });
    await handle.result;
  });
});
