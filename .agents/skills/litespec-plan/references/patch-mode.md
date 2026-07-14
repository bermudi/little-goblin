### Patch Mode

Detect patch mode from `.litespec.yaml` in the change directory. When `mode: patch` is set, skip proposal, design, and tasks — proceed directly to delta spec creation and validation.

Use patch when:
- The change touches **one capability** with a small, clear delta
- No design discussion is needed
- Examples: adding a CLI flag, tweaking output format, fixing a small behavioral bug

Do NOT use patch when:
- The change touches multiple capabilities
- You need to REMOVE requirements (use propose instead)
- The change needs design discussion or phased tasks

```
patch → implement → archive
```

1. **Create the change:** `litespec patch <name> <capability>`
2. **Write the delta:** Edit the spec.md with ADDED or MODIFIED requirements and scenarios
3. **Validate:** `litespec validate <name>`
4. **Hand off:** Tell the user the patch is ready. They implement and run `litespec archive <name>` when satisfied
