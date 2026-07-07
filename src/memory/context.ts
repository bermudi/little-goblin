import type { PersonaPolicy } from "./search.ts";

/**
 * Who is asking for memory context. The three-way distinction is the single
 * input that determines memory visibility — which persona scopes are searched,
 * whether the `## agent persona` section renders, and whether `## other scopes`
 * lists other agents.
 *
 * - `main` — the goblin agent. Sees all personas, all scopes.
 * - `named-subagent` — a named subagent. Sees only its own persona scope.
 * - `anonymous-subagent` — an anonymous subagent. Sees no persona scopes.
 *
 * Today `activeScope.namedAgent` distinguishes main from named-subagent, but
 * CANNOT distinguish main from anonymous-subagent (both have `namedAgent: null`).
 * Only the caller knows which it is — that knowledge is what this union types.
 */
export type MemoryCaller =
  | { kind: "main" }
  | { kind: "named-subagent"; name: string }
  | { kind: "anonymous-subagent" };

/**
 * Derive the persona-eligibility policy for a caller. The single home for the
 * caller-kind → persona-policy mapping; was previously scattered as
 * `includeAgents` booleans and hand-rolled `{ kind: ... }` literals across
 * `snapshot.ts`, `tool.ts`, and the call sites in `agent/mod.ts` and
 * `subagents/execution.ts`.
 *
 * - `main` → `{ kind: "all" }` (search every persona scope).
 * - `named-subagent` → `{ kind: "own", name }` (search only this persona).
 * - `anonymous-subagent` → `{ kind: "none" }` (search no persona scopes).
 *
 * Note: `personaPolicyFor(activeScope)` in `search.ts` derives `{kind:"all"}`
 * vs `{kind:"own"}` from `activeScope.namedAgent`. That works for main and
 * named-subagent (where namedAgent is set), but it returns `{kind:"all"}` for
 * anonymous subagents (whose namedAgent is null) — wrong. This caller-typed
 * resolver is the correct one for search-tool persona gating.
 * `personaPolicyFor(activeScope)` remains for the internal snapshot
 * relevant-memory path which still keys off `activeScope`.
 */
export function personaPolicyForCaller(caller: MemoryCaller): PersonaPolicy {
  switch (caller.kind) {
    case "main":
      return { kind: "all" };
    case "named-subagent":
      return { kind: "own", name: caller.name };
    case "anonymous-subagent":
      return { kind: "none" };
  }
}

/**
 * Derive the snapshot's persona-section inclusion from a caller.
 * `includePersona` renders the `## agent persona` section: only named
 * subagents have a persona body to show.
 */
export function personaSectionFor(caller: MemoryCaller): { name: string } | undefined {
  return caller.kind === "named-subagent" ? { name: caller.name } : undefined;
}

/**
 * Derive whether the snapshot's `## other scopes` section lists other agents.
 * Only the main goblin agent sees other agents' scopes; subagents do not.
 */
export function includeAgentsFor(caller: MemoryCaller): boolean {
  return caller.kind === "main";
}
