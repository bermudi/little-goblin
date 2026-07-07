import { MemoryStore } from "./store.ts";
import { activeMemoryScopeFor } from "./scope.ts";
import type { ActiveScope } from "./scope.ts";
import {
  personaPolicyFor,
  searchMemoryEntries,
  stripEntryMetadata,
  type PersonaPolicy,
} from "./search.ts";
import { includeAgentsFor, personaSectionFor, type MemoryCaller } from "./context.ts";

/**
 * Per-turn memory aside.
 *
 * Returns `null` when both `memory.md` and `user.md` are empty/absent.
 * Otherwise returns a `Pick<CustomMessage, ...>` shaped payload suitable
 * for `AgentSession.sendCustomMessage(...)` with `deliverAs: "nextTurn"`.
 *
 * Spec contract (`specs/memory/spec.md`):
 *  - text begins with `[goblin memory snapshot]`
 *  - guardrail text follows the header stating memory may be stale/incomplete
 *    and current context overrides memory
 *  - both `## memory.md` and `## user.md` sections present, in that order
 *  - empty individual files render as the literal `(empty)` body
 */
export interface MemorySnapshotPayload {
  customType: "goblin.memory.snapshot";
  content: string;
  display: false;
  details: undefined;
}

/**
 * Guardrail text emitted immediately after the snapshot header on every
 * non-null snapshot. Marks memory as auxiliary and possibly stale, and
 * reminds the agent that current context overrides memory.
 *
 * Spec: `Snapshot marks memory as auxiliary and possibly stale`.
 */
export const SNAPSHOT_GUARDRAIL =
  "Memory may be stale or incomplete. Current user messages, recent tool results, and explicit instructions override memory.";

export interface FormatSnapshotArgs {
  store: MemoryStore;
  activeScope: ActiveScope;
  /**
   * Who the snapshot is for. Replaces the former `includePersona` /
   * `includeAgents` knobs — those are derived from `caller` inside the
   * formatter via {@link personaSectionFor} / {@link includeAgentsFor}.
   */
  caller: MemoryCaller;
  getTopicName?: (chatId: number, topicId: number) => Promise<string | null>;
  /**
   * Current prompt text. When supplied and non-empty, the snapshot appends a
   * bounded `## relevant memory` section with lexically-ranked entries from
   * the snapshot's scopes. Omitted on follow-up steers.
   */
  promptText?: string;
  /**
   * Cap on the number of relevant-memory entries. Defaults to 3, clamped to a
   * maximum of 5. Has no effect when `promptText` is absent.
   */
  relevantLimit?: number;
}

/**
 * Build the per-turn memory snapshot for a caller. The caller-typed entry
 * point: callers pass a {@link MemoryCaller} instead of raw policy knobs.
 * Internally derives `includePersona` / `includeAgents` from the caller kind.
 * The on-wire snapshot output is identical to the former knob-based path.
 *
 * Returns `null` when memory is empty/absent.
 */
export async function formatSnapshot(
  args: FormatSnapshotArgs,
): Promise<MemorySnapshotPayload | null> {
  return formatScopedSnapshot({
    ...args,
    includePersona: personaSectionFor(args.caller),
    includeAgents: includeAgentsFor(args.caller),
  });
}

/** Internal args: the public `caller` resolved back into the knob dialect. */
type ResolvedSnapshotArgs = Omit<FormatSnapshotArgs, "caller"> & {
  includePersona?: { name: string };
  includeAgents: boolean;
};

async function formatScopedSnapshot(args: ResolvedSnapshotArgs): Promise<MemorySnapshotPayload | null> {
  const activeMemoryScope = activeMemoryScopeFor(args.activeScope);
  const memoryBody = args.store.read(activeMemoryScope).body;
  const userBody = args.store.read("user").body;
  const personaBody =
    args.includePersona === undefined
      ? undefined
      : args.store.read({ agent: { name: args.includePersona.name } }).body;
  const otherScopes = await formatOtherScopes(args);

  // Relevant memory is computed only when prompt text is supplied. It is
  // omitted from follow-up steers (the caller does not pass prompt text).
  const relevantLines = args.promptText !== undefined && args.promptText.trim().length > 0
    ? await formatRelevantMemory(args, memoryBody)
    : [];

  if (
    memoryBody.length === 0 &&
    userBody.length === 0 &&
    (personaBody === undefined || personaBody.length === 0) &&
    otherScopes.length === 0 &&
    relevantLines.length === 0
  ) {
    return null;
  }

  // Section order: scope, user.md, memory.md, relevant memory, agent persona,
  // other scopes. Relevant memory sits between memory.md and the persona/
  // other-scopes sections so the active body stays primary.
  const sections = [
    "[goblin memory snapshot]",
    SNAPSHOT_GUARDRAIL,
    `## scope\n${await formatScope(args.activeScope, args.includePersona, args.getTopicName)}`,
    `## user.md\n${formatBody(userBody)}`,
    `## memory.md\n${formatBody(memoryBody)}`,
  ];
  if (relevantLines.length > 0) {
    sections.push(`## relevant memory\n${relevantLines.join("\n")}`);
  }
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

const DEFAULT_RELEVANT_LIMIT = 3;
const MAX_RELEVANT_LIMIT = 5;

/**
 * Build the `## relevant memory` section lines for the current prompt. Runs
 * the lexical search helper against the snapshot's scopes (same chat plus
 * eligible persona scopes), drops any result whose display text already
 * appears verbatim in the active `## memory.md` body, and bounds the result
 * count to the configured limit (default 3, max 5). Returns an empty array
 * when there are no matches after dedup.
 */
async function formatRelevantMemory(
  args: ResolvedSnapshotArgs,
  activeMemoryBody: string,
): Promise<string[]> {
  const persona: PersonaPolicy = args.includePersona !== undefined
    ? { kind: "own", name: args.includePersona.name }
    : personaPolicyFor(args.activeScope);
  const requested = args.relevantLimit ?? DEFAULT_RELEVANT_LIMIT;
  const limit = Math.min(Math.max(1, requested), MAX_RELEVANT_LIMIT);

  const out = await searchMemoryEntries({
    store: args.store,
    activeScope: args.activeScope,
    persona,
    query: args.promptText ?? "",
    limit: 50, // fetch a wide net, then dedup + bound
  });

  // Build the dedup set from the active scope's body. Strip reflected-entry
  // metadata so a reflected active entry (whose search display text omits the
  // metadata comment) is matched against its stripped form, not the raw
  // metadata-wrapped form. Otherwise reflected active entries would fail the
  // verbatim check and reappear under `## relevant memory`.
  const activeBodySet = new Set(splitEntries(activeMemoryBody).map(stripEntryMetadata));
  const lines: string[] = [];
  for (const r of out.results) {
    // Verbatim dedup against the active scope's body: skip any result whose
    // display text already appears as an entry in `## memory.md`.
    if (activeBodySet.has(r.text)) continue;
    lines.push(`- [${r.scope}] ${r.text}`);
    if (lines.length >= limit) break;
  }
  return lines;
}

/** Split a memory body into individual entry texts by the `\n§\n` delimiter. */
function splitEntries(body: string): string[] {
  if (body.length === 0) return [];
  return body.split("\n§\n");
}

async function formatScope(
  activeScope: ActiveScope,
  includePersona: { name: string } | undefined,
  getTopicName?: (chatId: number, topicId: number) => Promise<string | null>,
): Promise<string> {
  let scope: string;
  if (activeScope.topicScope === "general") {
    scope = "General";
  } else {
    const name =
      getTopicName === undefined
        ? null
        : await getTopicName(activeScope.chatId, activeScope.topicScope.topicId).catch(
            () => null,
          );
    scope = name !== null && name.length > 0 ? `Topic: ${name}` : "Topic";
  }
  return includePersona === undefined ? scope : `${scope}\nAgent: ${includePersona.name}`;
}

function formatBody(body: string): string {
  return body.length === 0 ? "(empty)" : body;
}

async function formatOtherScopes(args: ResolvedSnapshotArgs): Promise<string[]> {
  const index = await args.store.listIndex({
    chatId: args.activeScope.chatId,
    includeAgents: args.includeAgents,
  });
  const activeTopicId =
    args.activeScope.topicScope === "general" ? null : args.activeScope.topicScope.topicId;

  // General scope appears when not in general AND general has content
  const generalScope: string[] = [];
  if (args.activeScope.topicScope !== "general") {
    const generalParsed = args.store.read("general");
    const generalHasContent = generalParsed.description !== undefined || generalParsed.body.length > 0;
    if (generalHasContent) {
      generalScope.push(`- general — ${generalParsed.description ?? "(no description)"}`);
    }
  }

  const topics = await Promise.all(
    index.topics
      .filter((topic) => topic.topicId !== activeTopicId)
      .map(async (topic) => {
        const label = `topics/${topic.chatId}/${topic.topicId}`;
        let description = topic.description ?? null;
        if (description === null && args.getTopicName !== undefined) {
          try {
            const fetched = await args.getTopicName(topic.chatId, topic.topicId);
            description = fetched && fetched.length > 0 ? fetched : null;
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
