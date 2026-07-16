# Dream Cross Session Promotion Rule

## Status

accepted

## Context

REM and deep sleep aggregate concept tags and short-term entries across all sessions. When a theme or short-term entry originates from multiple sessions, the promotion target scope must be deterministic. Without a rule, promotions could land in arbitrary scopes or duplicate across scopes.

## Decision

For each theme or short-term entry promoted by REM or deep sleep, the pipeline SHALL collect its origin sessions and promote to the scope associated with the highest session count. Ties SHALL be broken by the most recent `updated_at`, then by scope name ascending. If the origin sessions are all from transcript scopes without a clear curated target, the promotion SHALL default to `general`.

## Consequences

Promotions are deterministic and reproducible. A theme discussed heavily in one topic scope lands there, not in `general`. The `general` scope acts as the fallback for cross-chat or unscoped patterns. Future dreaming changes can reference this ruling instead of re-deriving the rule from spec text.
