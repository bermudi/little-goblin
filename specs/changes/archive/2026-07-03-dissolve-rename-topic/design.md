# Design: dissolve-rename-topic

## Architecture

Pure deletion. No data flow changes — the tool simply ceases to exist in the
registry, so the LLM never sees it on a topic turn and cannot call it. The
strongest enforcement of decision 0002 is the absence of the tool.

```
 getBetaTools()  ──┬── createSendVoiceTool        (kept)
                   ├── createTextToSpeechTool    (kept)
                   ├── createSendPhotoTool       (kept)
                   ├── createSendDocumentTool    (kept)
                   ├── createReadFileTool        (kept)
                   └── createRenameTopicTool     ✂ removed
```

`handleTopicDescription` and the `forum_topic_created` / `forum_topic_edited`
handlers in `bot.ts` are untouched — they are M1 observation (writing the
user's topic name into memory), which 0002 explicitly permits. Only the M3
mutation tool goes.

## Decisions

### Delete the tool, do not gate it

**Chosen:** Remove `createRenameTopicTool` from code and spec entirely.

**Rejected alternative:** Keep the code but drop it from `getBetaTools()` so it
is dormant. Rejected — dormant code that contradicts an accepted decision is a
landmine. The spec also has to reflect reality; a spec requirement for a tool
that is never registered is incoherent.

### Keep `existsSync` / `readFile` imports in tools.ts

The proposal conditioned their removal on "only if they become unused." They
are not: `readFile`, `send_photo`, `send_document`, and `text_to_speech` all
use `existsSync`, and `read_file` / `text_to_speech` use `readFile`. Leave the
imports.

### No design or behavioral replacement

No new tool, no surface-policy module (decision 0004 declines it). If
agent-initiated topic mutation becomes a real want later, it is a fresh change
that supersedes 0002 with an explicit argument — not a rescue here.

## File Changes

### `src/tg/tools.ts` (modified)

Delete:
- `renameTopicSchema` (the `Type.Object` at line ~35)
- `RenameTopicInput` (the `Static<typeof renameTopicSchema>` type)
- `createRenameTopicTool` (the exported factory, lines ~174–195)

Keep `existsSync` and `readFile` imports — still used by other tools.

### `src/tg/intake.ts` (modified)

- Remove `createRenameTopicTool` from the import list (line ~17)
- Remove its invocation from `getBetaTools()` (line ~93)

### `src/tg/tools.test.ts` (modified)

- Remove the `createRenameTopicTool` import (line ~12)
- Remove the `RenameTopicCall` interface and `renames` field from the mock
  harness if no other test references them
- Remove the `describe("createRenameTopicTool", …)` block (lines ~417–473)

### `specs/canon/beta-tools/spec.md` (modified)

- Remove the "Rename topic tool renames forum topics" requirement and all its
  scenarios (lines ~117–160)
- Remove `rename_topic` / `createRenameTopicTool` references from the "Bot.ts
  instantiates tools per session" requirement scenarios (lines ~30–32, ~154–160)
- Remove the standalone "Rename topic schema for DMs" and "Rename topic missing
  title" scenarios (lines ~30–60)

### No changes to

- `src/bot.ts` `forum_topic_*` handlers — M1 observation, permitted by 0002
- `handleTopicDescription` — writes user's topic name to memory, M1
- Decision records 0002 / 0004 — accepted, not modified by this change