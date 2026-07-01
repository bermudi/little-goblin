# beta-tools

## REMOVED Requirements

### Rename topic tool removed
- The `rename_topic` tool and its `createRenameTopicTool` factory are removed. Decision 0002 (`topic-ui-is-user-owned`) forbids goblin from renaming a forum topic; exposing the tool to the LLM on every topic turn violates that rule. Decision 0004 (`one-assistant-capabilities-not-products`) confirms there is no "admin bot" product for the tool to belong to. The 2026-05-14 removal of `react` and `chat_action` is treated as the correct direction; this finishes it. Topic mutation remains the user's action; goblin continues to *observe* topic state via `handleTopicDescription` (which writes the user's topic name into memory), as 0002 explicitly permits.
