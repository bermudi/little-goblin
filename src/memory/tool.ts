import { Type, type Static } from "@sinclair/typebox";
import { defineTool, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { MemoryStore, StoreResult } from "./store.ts";
import type { ActiveScope, MemoryScope } from "./scope.ts";

/** Valid characters for agent names: alphanumeric, hyphens, underscores. Mirrors subagents/named-agents.ts. */
const VALID_NAME_RE = /^[a-zA-Z0-9_-]+$/;

const targetSchema = Type.Union([
  Type.Literal("memory"),
  Type.Literal("user"),
  Type.Literal("agent"),
]);

const memoryReadSchema = Type.Object({
  target: targetSchema,
  scope: Type.Optional(
    Type.Union([
      Type.Literal("active"),
      Type.Literal("general"),
      Type.Object({ topic: Type.Object({ chatId: Type.Number(), topicId: Type.Number() }) }),
      Type.Object({ agent: Type.Object({ name: Type.String() }) }),
    ]),
  ),
});

const memoryReadIndexSchema = Type.Object({
  all_chats: Type.Optional(Type.Boolean()),
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

type MemoryReadInput = Static<typeof memoryReadSchema>;
type MemoryReadIndexInput = Static<typeof memoryReadIndexSchema>;
type MemoryWriteInput = Static<typeof memoryWriteSchema>;

const READ_DESCRIPTION = "Read scoped goblin memory without modifying files.";
const READ_INDEX_DESCRIPTION = "List available scoped goblin memories and their descriptions.";
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

const READ_PROMPT_SNIPPET = "memory_read: read scoped memory.md, user.md, or named agent memory.";
const READ_INDEX_PROMPT_SNIPPET = "memory_read_index: discover other memory scopes by description.";
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

export function createMemoryReadTool(args: {
  store: MemoryStore;
  activeScope: ActiveScope;
}): ToolDefinition {
  return defineTool({
    name: "memory_read",
    label: "Memory Read",
    description: READ_DESCRIPTION,
    promptSnippet: READ_PROMPT_SNIPPET,
    promptGuidelines: [],
    parameters: memoryReadSchema,
    async execute(_toolCallId, params: MemoryReadInput) {
      return jsonResult(args.store.read(resolveReadScope(args.activeScope, params)));
    },
  });
}

export function createMemoryReadIndexTool(args: {
  store: MemoryStore;
  activeChatId?: number;
  includeAgents: boolean;
  getTopicName?: (chatId: number, topicId: number) => Promise<string | null>;
}): ToolDefinition {
  return defineTool({
    name: "memory_read_index",
    label: "Memory Read Index",
    description: READ_INDEX_DESCRIPTION,
    promptSnippet: READ_INDEX_PROMPT_SNIPPET,
    promptGuidelines: [],
    parameters: memoryReadIndexSchema,
    async execute(_toolCallId, _params: MemoryReadIndexInput) {
      // Note: all_chats is ignored to prevent leaking unreadable topology.
      // Cross-chat reads are gated; listing all chats would reveal scopes
      // that cannot be read via memory_read. Filter to active chat only.
      return jsonResult(
        await args.store.listIndex({
          chatId: args.activeChatId,
          includeAgents: args.includeAgents,
          getTopicName: args.getTopicName,
        }),
      );
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
      let result: StoreResult;
      switch (action) {
        case "add": {
          if (params.content === undefined) {
            throw new Error("memory_write.add requires `content`");
          }
          if (params.content.length === 0) {
            throw new Error("memory_write.add requires non-empty `content`");
          }
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

function resolveReadScope(activeScope: ActiveScope, input: MemoryReadInput): MemoryScope | "user" {
  if (input.target === "user") return "user";
  if (input.target === "agent") {
    // Honor scope discriminator: if input.scope specifies an agent, use that.
    // Otherwise fall back to the active subagent's own persona.
    if (input.scope !== undefined && typeof input.scope === "object" && "agent" in input.scope) {
      if (!VALID_NAME_RE.test(input.scope.agent.name)) {
        throw new Error(`Invalid agent name: must match ${VALID_NAME_RE.source}`);
      }
      return { agent: { name: input.scope.agent.name } };
    }
    if (activeScope.namedAgent === null) {
      throw new Error('target = "agent" is only valid for named subagents');
    }
    if (!VALID_NAME_RE.test(activeScope.namedAgent.name)) {
      throw new Error(`Invalid agent name: must match ${VALID_NAME_RE.source}`);
    }
    return { agent: { name: activeScope.namedAgent.name } };
  }
  const scope = input.scope ?? "active";
  if (scope === "active") return activeMemoryScope(activeScope);
  if (scope === "general") return "general";
  if ("agent" in scope) {
    if (!VALID_NAME_RE.test(scope.agent.name)) {
      throw new Error(`Invalid agent name: must match ${VALID_NAME_RE.source}`);
    }
    return { agent: { name: scope.agent.name } };
  }
  if (scope.topic.chatId !== activeScope.chatId) {
    throw new Error("memory_read topic scope must be in the active chat");
  }
  return { topic: { chatId: scope.topic.chatId, topicId: scope.topic.topicId } };
}

function resolveWriteScope(activeScope: ActiveScope, target: MemoryTarget): MemoryScope | "user" {
  if (target === "user") return "user";
  if (target === "agent") {
    if (activeScope.namedAgent === null) {
      throw new Error('target = "agent" is only valid for named subagents');
    }
    return { agent: { name: activeScope.namedAgent.name } };
  }
  return activeMemoryScope(activeScope);
}

function activeMemoryScope(activeScope: ActiveScope): MemoryScope {
  if (activeScope.topicScope === "general") return "general";
  return {
    topic: {
      chatId: activeScope.chatId,
      topicId: activeScope.topicScope.topicId,
    },
  };
}
