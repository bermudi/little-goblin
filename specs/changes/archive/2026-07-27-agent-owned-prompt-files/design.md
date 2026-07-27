# agent-owned-prompt-files — design

## Notice path

The notice flow is:

```
pi tool event
  → AgentRunner.handleEvent
    → trackToolStart / handleToolEnd
      → resolve tool path (expand ~, then resolve against runtime CWD)
      → compare against reserved prompt-file set
      → callbacks.sendNotice(text)
        → MessageBuffer.sendNotice
          → sendSystemReply(..., tag="info", { silent: true })
            → bot.api.sendMessage
```

`AgentRunner` keeps a `Map<toolCallId, { toolName, args }>` populated on `tool_execution_start` and consumed on `tool_execution_end`. Only successful (`isError: false`) `write` and `edit` tools are considered. The path is resolved from the tool argument with `~` expansion matching pi's own path handling. Reserved paths are:

- `$GOBLIN_HOME/workspace/SOUL.md`
- `$GOBLIN_HOME/workspace/AGENTS.md`
- `$GOBLIN_HOME/workspace/HEARTBEAT.md`
- `$GOBLIN_HOME/state/sessions/<sessionId>/HEARTBEAT.md` (session-scoped heartbeat)

The notice text is bounded: `Modified prompt file \`<filename>\`: <summary>`. For `write`, the summary is `wrote N lines (C chars)` or `wrote empty file`. For `edit`, it is `N edit(s)`. No file content is included.

`MessageBuffer.sendNotice` records a `telegram` metrics event in the `system` channel, reusing the existing `classifyTelegramError` path.

## Subagent filter

`src/subagents/named-agents.ts` already builds a `DefaultResourceLoader` for generic subagents with `additionalSkillPaths` pinned to `$GOBLIN_HOME/workspace/skills/`. This change adds:

```ts
agentsFilesOverride: ({ agentsFiles }) => ({
  agentsFiles: agentsFiles.filter((f) => !deploymentPromptFiles.has(resolve(f.path))),
}),
```

where `deploymentPromptFiles` is the resolved set of the three workspace prompt files. Named agents continue to use `noContextFiles: true` and their own `AGENTS.md` as the system prompt, so they are not affected.

## Canon changes

- `specs/glossary.md:75` — `SOUL.md` is "agent-owned".
- `specs/canon/agent/spec.md` — prompt sections renamed to "Agent Identity and Voice" and "Agent Operating Rules".
- `src/agent/system-prompt.ts` — matching section labels and log note.
- `ARCHITECTURE.md` — remove "still contradict" language; mark workspace write authority as implemented.
- `AGENTS.md` — state that `workspace/` prompt files are agent-owned and that git in `workspace/` is the recovery path.
