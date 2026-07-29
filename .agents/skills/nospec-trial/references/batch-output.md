# Batch review output

Read this only when the runner requests `REVIEW.md`. Write exactly `## Standards`, `## Intent`, `## Speculative`, and `## Summary`.

```markdown
- S1 | actionable | high
  evidence: `path/to/file:42` — "quoted code"
  finding: The change violates the canonical parser boundary.
  fix direction: Route queue consumers through the canonical parser.
```

Use `S`, `I`, or `X` ids by section. Write `No issues found.` for a clean section.

```markdown
## Summary
- standards: 1
- intent: 0
- speculative: 0
- actionable: 1
- trivial: 0
- disputed: 0
- deferred: 0
```

Count only actionable findings in `- actionable: N`; that line is the runner's continue/stop signal. The runner does not interpret finding content.
