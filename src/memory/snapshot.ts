import { MemoryStore } from "./store.ts";
import type { MetricsStore } from "../metrics/mod.ts";
import { activeMemoryScopeFor, scopeTag } from "./scope.ts";
import type { ActiveScope } from "./scope.ts";
import {
  searchMemoryEntries,
  stripEntryMetadata,
  truncateResultText,
  type PersonaPolicy,
} from "./search.ts";
import { includeAgentsFor, personaPolicyForCaller, personaSectionFor, type MemoryCaller } from "./context.ts";
import { stripBodyMetadata } from "./entry.ts";

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
  customType: "goblin.memory.snapshot" | "goblin.memory.relevant";
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
  /** Optional metrics store to record the snapshot_built event. */
  metrics?: MetricsStore;
  /**
   * Frozen user.md body captured at session start. When supplied, relevant
   * memory dedups against this body instead of the current store state so new
   * entries written after session creation can still surface per-turn.
   */
  frozenUserBody?: string;
  /**
   * Frozen active memory.md body captured at session start. When supplied,
   * relevant memory dedups against this body instead of the current store state.
   */
  frozenActiveMemoryBody?: string;
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
    personaPolicy: personaPolicyForCaller(args.caller),
  });
}

/**
 * Build the per-turn `## relevant memory` aside. Uses hybrid search on the
 * current prompt text, deduplicates against the active scope body, and bounds
 * the result count (default 3, max 5). Returns `null` when there are no
 * relevant curated entries.
 */
export async function formatRelevantMemory(
  args: FormatSnapshotArgs,
): Promise<MemorySnapshotPayload | null> {
  if (args.promptText === undefined || args.promptText.trim().length === 0) {
    return null;
  }

  const resolved: ResolvedSnapshotArgs = {
    ...args,
    includePersona: personaSectionFor(args.caller),
    includeAgents: includeAgentsFor(args.caller),
    personaPolicy: personaPolicyForCaller(args.caller),
  };
  const activeMemoryScope = activeMemoryScopeFor(args.activeScope);
  const activeMemoryBody = args.frozenActiveMemoryBody ?? args.store.read(activeMemoryScope).body;
  const userMemoryBody = args.frozenUserBody ?? args.store.read("user").body;
  const lines = await buildRelevantMemoryLines(resolved, activeMemoryBody, userMemoryBody);
  if (lines.length === 0) return null;

  return {
    customType: "goblin.memory.relevant",
    content: `## relevant memory\n${lines.join("\n")}`,
    display: false,
    details: undefined,
  };
}

const FROZEN_SUMMARY_HEADER = "[goblin memory summary (frozen at session start)]";
const FROZEN_SUMMARY_SECTION_CAP = 500;

/**
 * Build a bounded frozen memory summary for injection into the system prompt.
 *
 * Spec contract (`specs/memory/spec.md`):
 *  - header is `[goblin memory summary (frozen at session start)]`
 *  - active scope description is always emitted (or `(no description)`)
 *  - `user.md` and active `memory.md` summaries are each capped at 500 chars
 *  - cross-scope index lists same-chat topics, max 10 entries, ordered by
 *    most-recently-updated scope first, then scope name ascending
 *  - if the total exceeds 1200 chars, trim the cross-scope index first, then
 *    the active `memory.md` summary at a word boundary, then the `user.md`
 *    summary; the header and active scope description are never truncated
 */
export async function formatFrozenSummary(
  args: Omit<FormatSnapshotArgs, "promptText" | "relevantLimit">,
): Promise<string | null> {
  const activeMemoryScope = activeMemoryScopeFor(args.activeScope);
  const active = args.store.read(activeMemoryScope);
  const user = args.store.read("user");

  const activeBodyRaw = stripBodyMetadata(active.body);
  const userBodyRaw = stripBodyMetadata(user.body);

  // Cross-scope index: peer topics, the general scope (when not active), and
  // agent persona scopes (for the main goblin agent). Excludes the active
  // topic/agent and sorts by most-recently-updated scope first.
  const includeAgents = includeAgentsFor(args.caller);
  const index = await args.store.listIndex({
    chatId: args.activeScope.chatId,
    includeAgents,
    getTopicName: args.getTopicName,
  });
  const activeTopicId = args.activeScope.topicScope === "general" ? null : args.activeScope.topicScope.topicId;
  const activeAgentName = args.activeScope.namedAgent?.name;

  const indexEntries: { scope: string; description: string | null; updatedAt: number | null }[] = [];

  for (const t of index.topics) {
    if (t.topicId === activeTopicId) continue;
    indexEntries.push({
      scope: `topics/${t.chatId}/${t.topicId}`,
      description: t.description ?? t.name ?? null,
      updatedAt: null,
    });
  }

  if (args.activeScope.topicScope !== "general") {
    const general = args.store.read("general");
    if (general.description !== undefined || general.body.length > 0) {
      indexEntries.push({ scope: "general", description: general.description ?? null, updatedAt: null });
    }
  }

  if (includeAgents) {
    for (const a of index.agents) {
      if (a.name === activeAgentName) continue;
      indexEntries.push({
        scope: `agents/${a.name}`,
        description: a.description ?? null,
        updatedAt: null,
      });
    }
  }

  const lastUpdated = args.store.getScopesLastUpdated(indexEntries.map((e) => e.scope));
  for (const e of indexEntries) {
    e.updatedAt = lastUpdated.get(e.scope) ?? null;
  }

  const sorted = indexEntries
    .sort((a, b) => {
      const aUpdated = a.updatedAt ?? 0;
      const bUpdated = b.updatedAt ?? 0;
      if (aUpdated !== bUpdated) return bUpdated - aUpdated;
      return a.scope.localeCompare(b.scope);
    })
    .slice(0, 10);
  const indexLines = sorted.map((e) => `- ${e.scope} — ${e.description ?? "(no description)"}`);

  const hasAnyContent =
    activeBodyRaw.length > 0 ||
    userBodyRaw.length > 0 ||
    indexLines.length > 0 ||
    (active.description !== undefined && active.description.length > 0);
  if (!hasAnyContent) return null;

  const activeScopeLine = `Active scope: ${active.description ?? "(no description)"}`;

  const activeIsEmpty = activeBodyRaw.length === 0;
  const userIsEmpty = userBodyRaw.length === 0;
  let activeSummary = activeIsEmpty ? "(empty)" : truncateWithEllipsis(activeBodyRaw, FROZEN_SUMMARY_SECTION_CAP);
  let userSummary = userIsEmpty ? "(empty)" : truncateWithEllipsis(userBodyRaw, FROZEN_SUMMARY_SECTION_CAP);
  let activeSummaryTrim = !activeIsEmpty;
  let userSummaryTrim = !userIsEmpty;

  function totalLength(): number {
    const parts = [FROZEN_SUMMARY_HEADER, SNAPSHOT_GUARDRAIL, activeScopeLine];
    if (userSummary.length > 0) parts.push(`## user.md\n${userSummary}`);
    if (activeSummary.length > 0) parts.push(`## memory.md\n${activeSummary}`);
    if (indexLines.length > 0) parts.push(`## other scopes\n${indexLines.join("\n")}`);
    return parts.join("\n\n").length;
  }

  function buildSummary(): string {
    const parts = [FROZEN_SUMMARY_HEADER, SNAPSHOT_GUARDRAIL, activeScopeLine];
    if (userSummary.length > 0) parts.push(`## user.md\n${userSummary}`);
    if (activeSummary.length > 0) parts.push(`## memory.md\n${activeSummary}`);
    if (indexLines.length > 0) parts.push(`## other scopes\n${indexLines.join("\n")}`);
    return parts.join("\n\n");
  }

  // Trim the cross-scope index first, then the active memory summary, then the
  // user summary. The header and active scope line are never trimmed.
  while (totalLength() > FROZEN_SUMMARY_CAP) {
    if (indexLines.length > 0) {
      indexLines.pop();
      continue;
    }
    if (activeSummaryTrim && activeSummary.length > 3) {
      activeSummary = truncateWithEllipsis(
        activeSummary,
        Math.max(3, Math.floor(activeSummary.length * 0.75)),
      );
      continue;
    }
    if (userSummaryTrim && userSummary.length > 3) {
      userSummary = truncateWithEllipsis(
        userSummary,
        Math.max(3, Math.floor(userSummary.length * 0.75)),
      );
      continue;
    }
    break;
  }

  return buildSummary();
}

/** Internal args: the public `caller` resolved back into the knob dialect. */
type ResolvedSnapshotArgs = Omit<FormatSnapshotArgs, "caller"> & {
  includePersona?: { name: string };
  includeAgents: boolean;
  personaPolicy: PersonaPolicy;
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
    ? await buildRelevantMemoryLines(args, memoryBody, userBody)
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

  const content = sections.join("\n\n");

  const countBodyEntries = (body: string): number => {
    if (body.length === 0) return 0;
    return body.split("\n§\n").filter((s) => s.trim().length > 0).length;
  };
  const entryCount =
    countBodyEntries(memoryBody) +
    countBodyEntries(userBody) +
    (personaBody ? countBodyEntries(personaBody) : 0) +
    relevantLines.length;

  args.metrics?.record({
    type: "event",
    name: "snapshot_built",
    scope: null,
    extra: {
      empty: false,
      entryCount,
      charLength: content.length,
    },
  });

  return {
    customType: "goblin.memory.snapshot",
    content,
    display: false,
    details: undefined,
  };
}

const DEFAULT_RELEVANT_LIMIT = 3;
const MAX_RELEVANT_LIMIT = 5;
const FROZEN_SUMMARY_CAP = 1200;

function truncateWithEllipsis(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 3) return "...";
  const limit = max - 3;
  const candidate = text.slice(0, limit);
  const boundary = candidate.lastIndexOf(" ");
  // If the first word is longer than the limit, fall back to a hard slice.
  const trimmed = boundary > 0 ? candidate.slice(0, boundary) : candidate;
  return trimmed + "...";
}

/**
 * Build the `## relevant memory` section lines for the current prompt. Runs
 * hybrid search on the prompt text, drops any result whose display text already
 * appears in the active `## memory.md` or `## user.md` bodies (i.e. the frozen
 * summary), and bounds the result count to the configured limit (default 3,
 * max 5). Returns an empty array when there are no matches after dedup.
 */
async function buildRelevantMemoryLines(
  args: ResolvedSnapshotArgs,
  activeMemoryBody: string,
  userMemoryBody: string,
): Promise<string[]> {
  const persona = args.personaPolicy;
  const requested = args.relevantLimit ?? DEFAULT_RELEVANT_LIMIT;
  const limit = Math.min(Math.max(1, requested), MAX_RELEVANT_LIMIT);

  const out = await searchMemoryEntries({
    store: args.store,
    activeScope: args.activeScope,
    persona,
    query: args.promptText ?? "",
    corpus: "memory", // per-turn relevant memory is curated-only; transcripts never appear here
    limit: 50, // fetch a wide net, then dedup + bound
    metrics: args.metrics,
  });

  // Build the dedup set from the active scope's body and user.md. Strip
  // reflected-entry metadata and apply the same display truncation used for
  // search results so long active entries match their truncated search forms.
  const dedupSet = new Set(
    [...splitEntries(activeMemoryBody), ...splitEntries(userMemoryBody)]
      .map(stripEntryMetadata)
      .map(truncateResultText)
      .filter((t) => t.length > 0),
  );

  // The active memory scope is already represented in the frozen summary (or
  // the current turn's context); the per-turn aside is for cross-scope memory.
  const activeMemoryScopeTag = scopeTag(activeMemoryScopeFor(args.activeScope));
  const lines: string[] = [];
  for (const r of out.results) {
    // Skip results from the active scope itself; its contents are already in
    // the conversation context. Verbatim dedup against active/user bodies
    // handles remaining duplicates from other scopes.
    if (r.scope === activeMemoryScopeTag) continue;
    // Verbatim dedup against the frozen-summary bodies: skip any result whose
    // display text already appears as an entry in `## memory.md` or `## user.md`.
    if (dedupSet.has(r.text)) continue;
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
  if (body.length === 0) return "(empty)";
  return stripBodyMetadata(body);
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
