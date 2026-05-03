import { MemoryStore } from "./store.ts";
import type { ActiveScope, MemoryScope } from "./scope.ts";

/**
 * Per-turn memory aside.
 *
 * Returns `null` when both `memory.md` and `user.md` are empty/absent.
 * Otherwise returns a `Pick<CustomMessage, ...>` shaped payload suitable
 * for `AgentSession.sendCustomMessage(...)` with `deliverAs: "nextTurn"`.
 *
 * Spec contract (`specs/memory/spec.md`):
 *  - text begins with `[goblin memory snapshot]`
 *  - both `## memory.md` and `## user.md` sections present, in that order
 *  - empty individual files render as the literal `(empty)` body
 */
export interface MemorySnapshotPayload {
  customType: "goblin.memory.snapshot";
  content: string;
  display: false;
  details: undefined;
}

export interface FormatSnapshotArgs {
  store: MemoryStore;
  activeScope: ActiveScope;
  includePersona?: { name: string };
  includeAgents: boolean;
  getTopicName?: (chatId: number, topicId: number) => Promise<string | null>;
}

export async function formatSnapshot(
  args: FormatSnapshotArgs,
): Promise<MemorySnapshotPayload | null> {
  return formatScopedSnapshot(args);
}

async function formatScopedSnapshot(args: FormatSnapshotArgs): Promise<MemorySnapshotPayload | null> {
  const activeMemoryScope = activeMemoryScopeFor(args.activeScope);
  const memoryBody = args.store.read(activeMemoryScope).body;
  const userBody = args.store.read("user").body;
  const personaBody =
    args.includePersona === undefined
      ? undefined
      : args.store.read({ agent: { name: args.includePersona.name } }).body;
  const otherScopes = await formatOtherScopes(args);

  if (
    memoryBody.length === 0 &&
    userBody.length === 0 &&
    (personaBody === undefined || personaBody.length === 0) &&
    otherScopes.length === 0
  ) {
    return null;
  }

  const sections = [
    "[goblin memory snapshot]",
    `## scope\n${formatScope(args.activeScope, args.includePersona)}`,
    `## user.md\n${formatBody(userBody)}`,
    `## memory.md\n${formatBody(memoryBody)}`,
  ];
  if (personaBody !== undefined) {
    sections.push(`## agent persona\n${formatBody(personaBody)}`);
  }
  if (otherScopes.length > 0) {
    sections.push(`## other scopes\n${otherScopes.join("\n")}`);
  }

  return {
    customType: "goblin.memory.snapshot",
    content: sections.join("\n\n"),
    display: false,
    details: undefined,
  };
}

function activeMemoryScopeFor(activeScope: ActiveScope): MemoryScope {
  if (activeScope.topicScope === "general") return "general";
  return {
    topic: {
      chatId: activeScope.chatId,
      topicId: activeScope.topicScope.topicId,
    },
  };
}

function formatScope(activeScope: ActiveScope, includePersona: { name: string } | undefined): string {
  const scope =
    activeScope.topicScope === "general"
      ? "General (DM/supergroup-no-topic)"
      : `Topic: ${activeScope.chatId}/${activeScope.topicScope.topicId}`;
  return includePersona === undefined ? scope : `${scope}\nAgent: ${includePersona.name}`;
}

function formatBody(body: string): string {
  return body.length === 0 ? "(empty)" : body;
}

async function formatOtherScopes(args: FormatSnapshotArgs): Promise<string[]> {
  const index = args.store.listIndex({
    chatId: args.activeScope.chatId,
    includeAgents: args.includeAgents,
  });
  const activeTopicId =
    args.activeScope.topicScope === "general" ? null : args.activeScope.topicScope.topicId;

  // General scope appears when not in general
  const generalScope: string[] = [];
  if (args.activeScope.topicScope !== "general") {
    generalScope.push(`- general — ${index.general.description ?? "(no description)"}`);
  }

  const topics = await Promise.all(
    index.topics
      .filter((topic) => topic.topicId !== activeTopicId)
      .map(async (topic) => {
        const label = `topics/${topic.chatId}/${topic.topicId}`;
        let description = topic.description ?? null;
        if (description === null && args.getTopicName !== undefined) {
          try {
            description = await args.getTopicName(topic.chatId, topic.topicId);
          } catch {
            description = null;
          }
        }
        return `- ${label} — ${description ?? "(no description)"}`;
      }),
  );
  const agents = index.agents
    .filter((agent) => agent.name !== args.includePersona?.name)
    .map((agent) => `- agents/${agent.name} — ${agent.description ?? "(no description)"}`);
  return [...generalScope, ...topics, ...agents];
}
