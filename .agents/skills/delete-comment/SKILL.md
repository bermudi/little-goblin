---
name: delete-comment
description: Audit a bounded slice of Goblin's TypeScript comments, preserve important decisions, and shrink the comment lint baseline. Use when asked to remove, classify, or audit code comments.
---

# Delete comments

Agree the files in scope. This is a behavior-preserving cleanup. Do not fix
an implementation problem in the same pass.

1. Run `bun scripts/comment-audit.ts --report` from the repository root.
   It parses tracked and staged TypeScript and TSX. Comment-only lines are
   potential line savings. An inline comment on a line with code is not a
   line saved.
2. Read the source and nearby tests and design notes. Classify each prose
   comment in scope:
   - **Tautology:** It says what the code already says. Delete it.
   - **Stale:** It describes something that no longer happens. Delete it.
   - **Excuse:** It hides a real implementation problem. Delete it and
     file a separate issue with evidence under the issue workflow. Do not
     file an issue for a harmless trade-off or a guess.
   - **Decision record:** It explains an important choice that is not
     obvious from the code. Delete the comment. Keep the reason in an
     existing design note, or put it in a short
     [ADR](../../../design/decisions/README.md) if it has no home.
3. Preserve comment-shaped data in strings and fixtures. Preserve compiler
   and tool directives, meaningful metadata, and required legal notices.
   Add no new prose comments.
4. Compare syntax before and after, excluding comments and locations. Pay
   attention to line breaks that affect parsing and to JSX whitespace. Run
   the focused tests and the capped typecheck in `AGENTS.md`.
5. Stage new source files so they are in scope. Run
   `bun scripts/comment-audit.ts --prune`, then
   `bun scripts/comment-audit.ts --check` and `git diff --check`. Pruning
   cannot allow a new comment. Do not initialize or widen the baseline to
   make a change pass. Commit the pruned baseline with the cleanup.

Report the slice, deleted comment-only lines, decisions preserved, issues
filed, and checks run. For a repository-wide estimate, use the report's
comment-only count and state that it excludes required directives and
inline comments on code lines.
