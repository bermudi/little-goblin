# Main Goblin Prompt Ownership Is Explicit

## Status

accepted

## Context

Little Goblin runs inside `pi-coding-agent`, whose default resource loading can discover
system prompts, context files, skills, and compatibility instruction files intended for
coding assistants. That default behavior is useful for terminal coding agents, but it is
too broad for Goblin's main Telegram persona.

Goblin has three different prompt concerns that must not be conflated:

- **Deployment identity and voice**: who this deployed agent is, what it is called, and
  how it should feel to talk to.
- **Runtime mechanics**: how the little-goblin process works, including Telegram channel
  constraints, tool truthfulness, destructive-action boundaries, and memory-aside semantics.
- **Project guidance**: repository/workspace conventions for a session explicitly bound
  to a project directory.

If these concerns are left to implicit pi discovery, Goblin can accidentally inherit the
host user's coding-assistant instructions (for example `~/.agents/AGENTS.md`) and present
itself as a coding assistant. If source code hardcodes the deployed identity instead, the
public repo becomes private deployment configuration and clones cannot rename their agent
without patching code.

## Decision

The main Goblin runner SHALL own prompt and context loading explicitly.

Specifically:

- The main Goblin runner MUST use an explicit resource loader rather than allowing pi to
  implicitly construct the prompt/context surface.
- The main Goblin runner MUST disable pi context-file auto-loading.
- Deployment identity and voice MUST come from deployment-owned prompt files under
  `$GOBLIN_HOME`, with `$GOBLIN_HOME/SOUL.md` as the required source for the main agent's
  conversational identity and voice.
- Source code MUST NOT hardcode a deployed agent name, private user identity, or private
  persona into the main system prompt.
- Source code MAY provide a small product shell containing runtime mechanics and section
  framing, but that shell MUST NOT act as an identity fallback.
- Project guidance MUST be loaded only from the exact `AGENTS.md` in the session's bound
  `projectDir`, when one is configured. Goblin MUST NOT load global, ancestor, or
  compatibility instruction files as project guidance.
- Named and generic subagent prompt loading remains separately owned. This decision does
  not require subagents to adopt the main Goblin prompt stack.

## Consequences

- Startup can fail fast when required deployment prompt files are missing instead of
  letting pi's default assistant identity fill the gap.
- Onboarding must create deployment-owned prompt files instead of relying on source-code
  defaults.
- Operators choose whether to load user/global skills through explicit configuration, but
  skill loading does not imply context/instruction-file loading.
- Bound project instructions receive useful prompt weight while remaining scoped as
  project guidance rather than deployment identity.
- Future changes that add prompt files, compatibility context loading, subagent prompt
  inheritance, or broader project-context discovery must update or supersede this decision
  instead of quietly expanding implicit loading.

## Alternatives considered

- **Hardcode a generic Goblin identity in source:** Rejected. Even generic identity text
  becomes a deployed-persona fallback and risks public-repo/private-config leakage.
- **Use negative fallback instructions such as "do not be a coding assistant":** Rejected.
  Negative anti-persona prompts still activate the unwanted frame and do not solve prompt
  ownership.
- **Let pi auto-discover context files and rely on ordering:** Rejected. The problem is the
  implicit discovery surface, not just section order.
- **Sanitize project AGENTS.md:** Rejected for now. Sanitization is brittle; exact project
  guidance is included with positive scoping instead.
- **Apply the same SOUL.md model to subagents immediately:** Rejected for scope control.
  Subagent prompt ownership can be revisited separately.

## Related

- `specs/changes/goblin-system-prompt/`
- `specs/glossary.md` entries: `SOUL.md`, `product shell`, `project guidance`
