# Goblin Is One Assistant — Project Mode Is A Capability, Not A Product

## Status

accepted

## Context

Goblin was founded as "a Telegram-native personal AI agent" (single user, single
process, homelab). Over time, two further concerns arrived without a recorded
decision about how they relate to the founding concept:

1. **Project-directory mode** — when a chat surface is bound to a `projectDir`
   (via `/project`), the AgentRunner uses that directory as `cwd` and `agentDir`.
   Because pi auto-loads skills and `AGENTS.md` from `cwd`, this makes goblin
   useful as a remote agent over a real repository or workspace. The capability
   is real and load-bearing for the user's actual workflow.

2. **Telegram surface administration** — beta tools that mutate the forum
   surface goblin lives in (topic rename, reactions, chat actions). Of these,
   only `rename_topic` survived the 2026-05-14 rollback; the rest were deleted.

A recent architecture review surfaced that these three concerns — personal
assistant, project-directory "launcher", and Telegram "admin bot" — are tangled
together in the code at shared seams (`tg/intake.ts`, `agent/mod.ts`,
`agent/system-prompt.ts`, `sessions/manager.ts`). Several seams are shallow or
incoherent because they serve more than one product concept at once, and one of
them (`rename_topic`) directly contradicts an accepted decision: 0002 forbids
goblin from mutating topic UI state, yet `rename_topic` ships to every topic
turn.

Reviewing two independent external reference architectures
(`hermes-agent` by Nous Research, and `openclaw`) shows that both resolve the
same tension the same way: **they refuse to promote the launcher and admin
concerns to product status.** In each, there is exactly one product — the
personal assistant — and the other concerns are demoted:

- The "launcher" is a **tool or capability** of the one assistant. Hermes
  models it as a *coding posture* of the same agent (different `cwd`, resolved
  once, baked into the prompt). openclaw models it as a *bound session* where
  `--cwd` is decoupled from the chat surface. Neither treats it as a sibling
  product.
- Surface "admin" is **transport-layer capability** (forum topics, reactions,
  allowlists live inside channel adapters, exposed as tools). Neither has an
  "admin bot" persona.

Goblin's own canon already uses this vocabulary: the project-directory specs are
titled `Capability: AgentRunner Project Directory Support` and
`Capability: Project Directory Command`. The codebase was reaching for the
right word before this decision was written.

## Decision

Goblin is **one product**: a personal assistant. The two further concerns are
**capabilities of that one assistant**, not co-equal sub-products.

Specifically:

- **Project-directory mode is a capability, not a "launcher" product.** When a
  chat surface is bound to a `projectDir`, goblin remains the personal
  assistant — wearing a project coat. The "remote pi" utility is a side effect
  of allowing the assistant to start in a custom directory and letting pi's
  existing auto-loading (skills + `AGENTS.md`) do the rest. There is no second
  product, no launcher persona, and no charter to write.
- **Telegram surface administration is transport-layer capability, not an
  "admin bot" product.** Surface actions (reactions, file delivery, topic
  observation) are affordances of the bound assistant. Topic *mutation* by
  goblin remains forbidden by decision 0002.
- **`rename_topic` dissolves.** It is the only surviving "admin bot" tool and
  it directly violates 0002. A separate change (`dissolve-rename-topic`) removes
  the tool, its `getBetaTools` wiring, its canon requirement, and its tests.
- **The `ChatLocator` overload** (one `{chatId, topicId?}` key serving as
  conversation anchor, workspace binding, and tool-closure key) is acknowledged
  as a real seam and **deferred**. It is not addressed by this decision.

## Consequences

- No "satellite" or sub-product charters are created for the launcher or admin
  concerns. New project-directory or surface-admin features land as
  capabilities of the one assistant, governed by existing canon, not as peers
  that need their own founding concept.
- Decision 0002 is upheld in code as well as in docs: `rename_topic` is removed
  rather than rescued. The 2026-05-14 rollback of `react`/`chat_action` is
  treated as the correct direction, and this finishes it.
- The architecture review's "deepen the Telegram surface policy module"
  recommendation is **declined**: there is no second product to build policy
  for. The topic-mutation rule is enforced by 0002 plus the absence of the tool.
- The locator-overhaul work remains available for a future change if layout or
  binding churn across sessions, memory, and project binding continues to cause
  real bugs. This decision does not depend on it.
- A glossary entry for **capability** should be added to capture the term the
  canon already uses and this decision formalizes.

## Alternatives considered

- **Charter the launcher and admin as named satellites (direction A, original).**
  Rejected. Two independent production codebases independently refuse to promote
  these concerns to product status; both treat promotion as the expensive move
  that produces god-file sprawl and overlapping "run another agent" paths.
  little-goblin's existing structure (`projectDir` already moved off
  `SessionState` onto a chat-surface binding) is already walking the capability
  path.
- **Rewrite AGENTS.md to declare goblin genuinely multi-purpose (direction B).**
  Rejected. The evidence (8 of 15 canon modules serve M1; both accepted ADRs
  defend it; no active changes serve the other two concerns) shows the personal
  assistant is and remains the product. Declaring multi-purpose would dignify
  drift rather than resolve it.
- **Walk back project-directory mode entirely (direction C, applied to M2).**
  Rejected. It is real, load-bearing for the user's workflow, and already
  mostly decoupled. The intervention is to finish the decoupling, not to retire
  the capability.
- **Build a Telegram surface policy module (the architecture review's #2).**
  Declined. It would guard a class of tools that, after `rename_topic`
  dissolves, has no members and no roadmap joining it. Enforced by 0002 plus
  absence is stronger than any runtime gate.

## Related

- `specs/decisions/0002-topic-ui-is-user-owned.md` — the topic-mutation rule
  this decision upholds in code.
- `specs/decisions/0003-main-goblin-prompt-ownership.md` — already establishes
  that project guidance is a scoped section of the one assistant's prompt, not
  a separate identity. This decision is consistent with and builds on 0003.
- `specs/canon/agent-runner-project-dir/spec.md`,
  `specs/canon/project-command/spec.md` — titled "Capability:", the vocabulary
  this decision formalizes.
- `specs/changes/dissolve-rename-topic/` — the code change that enacts the
  `rename_topic` dissolution.
- External references reviewed: `hermes-agent` (Nous Research),
  `openclaw`. Both demote launcher/admin to capability/transport and were the
  convergent evidence for this decision.
