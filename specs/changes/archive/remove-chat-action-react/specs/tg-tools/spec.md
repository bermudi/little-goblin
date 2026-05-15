# tg-tools

## REMOVED Requirements

### chat_action tool removed
- The `chat_action` tool is removed from the tool registry. The buffer layer already sends "typing" automatically on a 4-second interval while the agent is working. The tool's additional actions (`upload_photo`, `record_voice`, `upload_document`) cost a full tool-call round trip for negligible UX benefit.

### react tool removed
- The `react` tool is removed from the tool registry. It burns a tool call for pure decoration with no information return. Reactions can be added later as automatic buffer-layer behavior if desired.
