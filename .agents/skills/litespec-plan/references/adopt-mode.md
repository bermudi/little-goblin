The user wants to reverse-engineer specs from existing code. Read code, understand what it does, and produce artifacts that document the discovered architecture and behavior.

**You are reading code, not changing it.** Never modify the source code you are analyzing.

1. Read the provided file or directory thoroughly — every file, every exported symbol, every meaningful behavior
2. `litespec new <name>` to create the change directory
3. Generate specs that describe what the code does — use ADDED Requirements markers (everything is new)
4. Each capability discovered gets its own spec. Each requirement should be specific and verifiable
5. Create proposal explaining what was adopted and why
6. Create design documenting the existing architecture discovered
7. Verify with `litespec status <name> --json`

Guardrails for adopt:
- Document what the code actually does, not what it should do
- Do not skip edge cases — if the code handles an error, that is a requirement
- Focus on observable behavior, not implementation details
