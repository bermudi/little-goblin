# Proposal: dissolve-rename-topic

## Motivation

`rename_topic` is the only surviving "Telegram admin bot" tool, and it directly
contradicts an accepted decision. Decision 0002 (`topic-ui-is-user-owned`)
states unambiguously: *"Goblin MUST NOT rename a forum topic."* Yet
`createRenameTopicTool` is registered in `getBetaTools()` and exposed to the LLM
on every topic turn. The tool calls `bot.api.editForumTopic(chatId, topicId,
{ name })` — a topic-level mutation 0002 forbids.

This is not an accidental gap. The git history shows the beta-tools change
(which specified `rename_topic`) was authored 2026-04-22, eight days *before*
decision 0002 existed. When 0002 landed on 2026-04-30, the user reconciled it
against commands the same hour (`/archive`'s topic rename stripped "per decision
0002" 44 minutes later) but the beta-tools change was still in flight and never
got the same pass. It archived to canon on 2026-05-03 carrying the now-forbidden
tool, and no beta-tools artifact has ever mentioned 0002.

Decision 0004 (`one-assistant-capabilities-not-products`) formalizes that goblin
is one personal assistant and that surface administration is transport-layer
capability, **not** an "admin bot" product. `rename_topic` has no home in that
model. This change enacts the dissolution that 0004 calls for.

## Scope

Remove the `rename_topic` tool entirely — code and spec:

1. **`src/tg/tools.ts`** — delete `renameTopicSchema`, the `RenameTopicInput`
   type, and `createRenameTopicTool`. Remove the `existsSync`/`readFile` imports
   only if they become unused.
2. **`src/tg/intake.ts`** — remove `createRenameTopicTool` from the import and
   from `getBetaTools()`.
3. **`specs/canon/beta-tools/spec.md`** — remove the "Rename topic tool renames
   forum topics" requirement and all its scenarios; remove `rename_topic` /
   `createRenameTopicTool` references from the "Bot.ts instantiates tools per
   session" requirement scenarios.
4. **`src/tg/tools.test.ts`** — remove the `rename_topic` describe block and any
   helper imports it alone used.

## Non-Goals

- **`handleTopicDescription` stays.** It writes the user's topic name (from
  Telegram `forum_topic_*` events) into memory — goblin *observing* user-owned
  state, which 0002 explicitly permits ("Goblin observes topics… but never
  mutates them"). It is M1, not M3.
- **The `forum_topic_created` / `forum_topic_edited` handlers in `bot.ts`
  stay.** They feed `handleTopicDescription`; same observation direction.
- **No surface-policy module.** Decision 0004 declines the architecture
  review's recommendation to build one. The topic-mutation rule is enforced by
  0002 plus the absence of the tool.
- **No new tool replaces it.** If agent-initiated topic mutation becomes a real
  want later, that is a fresh change that supersedes 0002 with an explicit
  argument — not a rescue of an accidental tool.

## Approach

Pure deletion across four files. No behavioral change for any user-facing flow
that respects 0002 (no such flow could legally rename a topic). The LLM simply
no longer sees `rename_topic` in its tool list on topic turns — the strongest
possible enforcement, since a tool that doesn't exist cannot be called.

## Related

- `specs/decisions/0002-topic-ui-is-user-owned.md` — the rule this enforces.
- `specs/decisions/0004-one-assistant-capabilities-not-products.md` — the
  model decision that calls for this dissolution.
- `specs/changes/archive/remove-chat-action-react/` — the 2026-05-14 precedent
  for removing beta tools that violated the product's direction.
