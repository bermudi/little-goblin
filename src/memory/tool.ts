import { Type, type Static } from "@sinclair/typebox";
import { defineTool, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { MemoryStore, StoreResult } from "./store.ts";

/**
 * Schema for the `memory` tool. We accept a single union schema and validate
 * action-specific required args inside `execute` so the model gets a clear
 * error message instead of an opaque schema-validation failure.
 */
const memorySchema = Type.Object({
  action: Type.Union([
    Type.Literal("add"),
    Type.Literal("replace"),
    Type.Literal("remove"),
  ]),
  target: Type.Union([Type.Literal("memory"), Type.Literal("user")]),
  content: Type.Optional(Type.String()),
  old_text: Type.Optional(Type.String()),
});

type MemoryToolInput = Static<typeof memorySchema>;

const DESCRIPTION = `Curate persistent memory.

Two files: \`memory.md\` (notes about the environment, projects, conventions, decisions; cap 4000 chars) and \`user.md\` (user preferences, communication style, recurring people/places; cap 2000 chars).
Entries are separated by the delimiter \`\\n§\\n\` automatically; \`content\` is the entry body only.

Actions:
- \`add\`     — append a new entry. Requires \`content\`.
- \`replace\` — replace a unique substring. Requires \`old_text\` (must match exactly one location) and \`content\`.
- \`remove\` — delete the entry whose text uniquely contains \`old_text\`. Requires \`old_text\`.

If a write would overflow the cap, the call fails and you must consolidate before retrying.`;

const PROMPT_SNIPPET =
  "memory: persist or revise curated facts in memory.md / user.md.";

const PROMPT_GUIDELINES = [
  "Use the memory tool to record durable facts about the user, the environment, and project conventions.",
  "On overflow errors, consolidate existing entries with replace/remove before retrying — do not ask the user.",
];

function textResult(message: string): {
  content: { type: "text"; text: string }[];
  details: undefined;
} {
  return { content: [{ type: "text", text: message }], details: undefined };
}

type MemoryTarget = "memory" | "user";

function summarize(action: "add" | "replace" | "remove", target: MemoryTarget): string {
  switch (action) {
    case "add":
      return `memory: added entry to ${target}.md`;
    case "replace":
      return `memory: replaced entry in ${target}.md`;
    case "remove":
      return `memory: removed entry from ${target}.md`;
  }
}

/**
 * Build the `memory` tool. The handler closes over a single MemoryStore.
 *
 * Validation failures and store-level failures both throw — pi turns thrown
 * errors into `isError: true` tool results that the model can read and
 * recover from.
 */
export function createMemoryTool(store: MemoryStore): ToolDefinition {
  return defineTool({
    name: "memory",
    label: "Memory",
    description: DESCRIPTION,
    promptSnippet: PROMPT_SNIPPET,
    promptGuidelines: PROMPT_GUIDELINES,
    parameters: memorySchema,
    async execute(_toolCallId, params: MemoryToolInput) {
      const { action, target } = params;
      let result: StoreResult;
      switch (action) {
        case "add": {
          if (params.content === undefined) {
            throw new Error("memory.add requires `content`");
          }
          result = store.add(target, params.content);
          break;
        }
        case "replace": {
          if (params.old_text === undefined) {
            throw new Error("memory.replace requires `old_text`");
          }
          if (params.content === undefined) {
            throw new Error("memory.replace requires `content`");
          }
          result = store.replace(target, params.old_text, params.content);
          break;
        }
        case "remove": {
          if (params.old_text === undefined) {
            throw new Error("memory.remove requires `old_text`");
          }
          result = store.remove(target, params.old_text);
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
