import { Type, type Static } from "@sinclair/typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { MemoryStore, StoreResult } from "./store.ts";
import type { MetricsStore } from "../metrics/mod.ts";
import { activeMemoryScopeFor, type ActiveScope, type MemoryScope } from "./scope.ts";
import { VALID_NAME_RE } from "../subagents/named-agents.ts";
import { checkMemorySafety } from "./safety.ts";
import { searchMemoryEntries, type MemorySearchOutput } from "./search.ts";
import { stripEntryMetadata } from "./entry.ts";
import { includeAgentsFor, personaPolicyForCaller, type MemoryCaller } from "./context.ts";

const targetSchema = Type.Union([
  Type.Literal("memory"),
  Type.Literal("user"),
  Type.Literal("agent"),
]);

const scopeSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("general"),
  Type.Literal("user"),
  Type.Object({ topic: Type.Object({ chatId: Type.Number(), topicId: Type.Number() }) }),
  Type.Object({ agent: Type.Object({ name: Type.String() }) }),
]);

const corpusSchema = Type.Union(
  [Type.Literal("memory"), Type.Literal("transcripts"), Type.Literal("all")],
  { default: "all" },
);

const memorySearchSchema = Type.Object({
  query: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Number()),
  scope: Type.Optional(scopeSchema),
  all_chats: Type.Optional(Type.Boolean()),
  corpus: Type.Optional(corpusSchema),
});

const memoryWriteSchema = Type.Object({
  action: Type.Union([
    Type.Literal("add"),
    Type.Literal("replace"),
    Type.Literal("remove"),
    Type.Literal("rewrite"),
    Type.Literal("set_description"),
  ]),
  target: targetSchema,
  content: Type.Optional(Type.String()),
  old_text: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
});

type MemorySearchInput = Static<typeof memorySearchSchema>;
type MemoryWriteInput = Static<typeof memoryWriteSchema>;

const SEARCH_DESCRIPTION = `Hybrid search over goblin memory entries and indexed transcript chunks.

- With ":{query}" returns ranked results.
- With ":{scope}" (and no query) returns all entries in that scope.
- With no query and no scope returns the scope index.

Corpus:
- ":{corpus:"all"}" — curated memory + transcripts (default).
- ":{corpus:"memory"}" — only curated memory.
- ":{corpus:"transcripts"}" — only transcript snippets.`;

const WRITE_DESCRIPTION = `Curate persistent goblin memory.

Targets:
- \`memory\` — the active chat/topic scope.
- \`user\` — global user identity.
- \`agent\` — named subagent persona memory.

Actions:
- \`add\`     — append a new entry. Requires \`content\`.
- \`replace\` — replace a unique substring. Requires \`old_text\` (must match exactly one location) and \`content\`.
- \`remove\` — delete the entry whose text uniquely contains \`old_text\`. Requires \`old_text\`.
- \`rewrite\` — replace the whole body. Requires \`content\`.
- \`set_description\` — set the one-line scope description. Requires \`description\`.

If a write would overflow the cap, the call fails and you must consolidate before retrying.`;

const SEARCH_PROMPT_SNIPPET = "memory_search: hybrid recall across memory and transcripts; subsumes the old memory_read and memory_read_index tools.";
const WRITE_PROMPT_SNIPPET = "memory_write: persist or revise curated facts in the active memory scope.";

const WRITE_PROMPT_GUIDELINES = [
  "Use memory_write to record durable facts about the user, the environment, and project conventions.",
  "On overflow errors, consolidate existing entries with replace/remove before retrying — do not ask the user.",
];

function textResult(message: string): {
  content: { type: "text"; text: string }[];
  details: undefined;
} {
  return { content: [{ type: "text", text: message }], details: undefined };
}

type MemoryTarget = "memory" | "user" | "agent";
type MemoryWriteAction = "add" | "replace" | "remove" | "rewrite" | "set_description";

function jsonResult(value: unknown): {
  content: { type: "text"; text: string }[];
  details: undefined;
} {
  return textResult(JSON.stringify(value));
}

function formatSearchOutput(output: MemorySearchOutput): unknown {
  return {
    query: output.query,
    searched_scopes: output.searchedScopes,
    degraded: output.degraded,
    warning: output.warning,
    results: output.results.map((r) => ({
      entry_id: r.entryId,
      scope: r.scope,
      entry_kind: r.entryKind,
      target: r.target,
      text: r.text,
      score: r.score,
      vectorScore: r.vectorScore,
      textScore: r.textScore,
      conceptBoost: r.conceptBoost,
      tags: r.tags,
      source: r.source,
      session_id: r.sessionId,
      timestamp: r.timestamp,
      metadata: r.metadata,
    })),
  };
}

function assertSafe(
  check: () => { ok: boolean; reason?: string; message?: string },
  onReject?: () => void,
): void {
  const r = check();
  if (!r.ok) {
    onReject?.();
    throw new Error(`memory_write rejected by safety filter: ${r.reason ?? "unknown"} (${r.message ?? "no detail"})`);
  }
}

function summarize(action: MemoryWriteAction, target: MemoryTarget): string {
  switch (action) {
    case "add":
      return `memory: added entry to ${target}`;
    case "replace":
      return `memory: replaced entry in ${target}`;
    case "remove":
      return `memory: removed entry from ${target}`;
    case "rewrite":
      return `memory: rewrote ${target}`;
    case "set_description":
      return `memory: set description for ${target}`;
  }
}

export function createMemorySearchTool(args: {
  store: MemoryStore;
  activeScope: ActiveScope;
  /**
   * Who is calling. The persona-eligibility policy is derived from the caller
   * kind: main searches all personas, a named subagent searches only its own,
   * an anonymous subagent searches none. Replaces the former `memory_read_index`
   * `agents` gating.
   */
  caller: MemoryCaller;
  /** Optional topic-name resolver for the scope index. */
  getTopicName?: (chatId: number, topicId: number) => Promise<string | null>;
  /** Optional metrics store to record memory_search events. */
  metrics?: MetricsStore;
}): ToolDefinition {
  return defineTool({
    name: "memory_search",
    label: "Memory Search",
    description: SEARCH_DESCRIPTION,
    promptSnippet: SEARCH_PROMPT_SNIPPET,
    promptGuidelines: [],
    parameters: memorySearchSchema,
    async execute(_toolCallId, params: MemorySearchInput) {
      if (params.query !== undefined && params.query.trim().length === 0) {
        throw new Error("memory_search requires a non-empty `query`");
      }
      const query = params.query?.trim();
      const scope = params.scope !== undefined ? resolveSearchScope(args.activeScope, params.scope) : undefined;

      // No query: list entries for a scope, or the full scope index.
      if (query === undefined) {
        if (scope !== undefined) {
          const entries = args.store.readEntries(scope).map((e) => ({ ...e, text: stripEntryMetadata(e.text) }));
          return jsonResult({ entries });
        }
        const index = await args.store.listScopeIndex({
          chatId: params.all_chats ? undefined : args.activeScope.chatId,
          includeAgents: includeAgentsFor(args.caller),
          getTopicName: args.getTopicName,
        });
        return jsonResult({
          general: index.general,
          topics: index.topics,
          agents: index.agents,
        });
      }

      // Search mode.
      const persona = personaPolicyForCaller(args.caller);
      const output = await searchMemoryEntries({
        store: args.store,
        activeScope: args.activeScope,
        persona,
        query,
        limit: params.limit,
        allChats: params.all_chats,
        corpus: params.corpus ?? "all",
        scope,
        metrics: args.metrics,
      });
      return jsonResult(formatSearchOutput(output));
    },
  });
}

export function createMemoryWriteTool(args: {
  store: MemoryStore;
  activeScope: ActiveScope;
}): ToolDefinition {
  return defineTool({
    name: "memory_write",
    label: "Memory Write",
    description: WRITE_DESCRIPTION,
    promptSnippet: WRITE_PROMPT_SNIPPET,
    promptGuidelines: WRITE_PROMPT_GUIDELINES,
    parameters: memoryWriteSchema,
    async execute(_toolCallId, params: MemoryWriteInput) {
      const { action, target } = params;
      const scope = resolveWriteScope(args.activeScope, target);
      const onReject = () => args.store.recordSafetyReject(scope);
      let result: StoreResult;
      switch (action) {
        case "add": {
          if (params.content === undefined) {
            throw new Error("memory_write.add requires `content`");
          }
          if (params.content.length === 0) {
            throw new Error("memory_write.add requires non-empty `content`");
          }
          assertSafe(() => checkMemorySafety(params.content!), onReject);
          result = await args.store.add(scope, params.content);
          break;
        }
        case "replace": {
          if (params.old_text === undefined) {
            throw new Error("memory_write.replace requires `old_text`");
          }
          if (params.content === undefined) {
            throw new Error("memory_write.replace requires `content`");
          }
          assertSafe(() => checkMemorySafety(params.content!), onReject);
          result = await args.store.replace(scope, params.old_text, params.content);
          break;
        }
        case "remove": {
          if (params.old_text === undefined) {
            throw new Error("memory_write.remove requires `old_text`");
          }
          result = await args.store.remove(scope, params.old_text);
          break;
        }
        case "rewrite": {
          if (params.content === undefined) {
            throw new Error("memory_write.rewrite requires `content`");
          }
          assertSafe(() => checkMemorySafety(params.content!), onReject);
          result = await args.store.rewrite(scope, params.content);
          break;
        }
        case "set_description": {
          if (params.description === undefined) {
            throw new Error("memory_write.set_description requires `description`");
          }
          result = await args.store.setDescription(scope, params.description);
          break;
        }
      }
      if (!result.ok) {
        throw new Error(result.error);
      }
      return textResult(summarize(action, target));
    },
  });
}

function resolveSearchScope(activeScope: ActiveScope, input: Static<typeof scopeSchema>): MemoryScope | "user" {
  if (input === "active") return activeMemoryScopeFor(activeScope);
  if (input === "user" || input === "general") return input;
  if ("agent" in input) {
    if (!VALID_NAME_RE.test(input.agent.name)) {
      throw new Error(`Invalid agent name: must match ${VALID_NAME_RE.source}`);
    }
    return { agent: { name: input.agent.name } };
  }
  return { topic: { chatId: input.topic.chatId, topicId: input.topic.topicId } };
}

function resolveWriteScope(activeScope: ActiveScope, target: MemoryTarget): MemoryScope | "user" {
  if (target === "user") return "user";
  if (target === "agent") {
    if (activeScope.namedAgent === null) {
      throw new Error('target = "agent" is only valid for named subagents');
    }
    return { agent: { name: activeScope.namedAgent.name } };
  }
  return activeMemoryScopeFor(activeScope);
}
