# skill-catalog-resolution — Tasks

## Phase 1: Resolve explicit skill catalogs

- [ ] Create `src/agent/skills/types.ts` with validated source/selection/policy/resolved DTOs, default policy, canonical sorting, and stable fingerprint helpers.
- [ ] Create `src/agent/skills/resolver.ts` using pi's public skill loader separately for exact Goblin, personal/project environment, and host roots; treat missing optional roots as empty.
- [ ] Implement policy filtering, selected-name failure, canonical-file dedupe, distinct-name collision failure, source/path diagnostics, and no ancestor/package/agentDir discovery. Satisfies “Skill catalogs resolve through explicit source authority.”
- [ ] Add resolver tests for all source/environment combinations, malformed skills, same-file symlinks, cross-source collisions, missing selected names, exact project boundaries, and deterministic fingerprints.
- [ ] Export the narrow API from `src/agent/skills/mod.ts` and `src/agent/mod.ts`.
- [ ] Run focused resolver tests and `bun run typecheck`.

## Phase 2: Make resolved skills authoritative at runtime

- [ ] Resolve default policy only after dispatcher Surface/Conversation environment agreement and before constructing any pi/project effects.
- [ ] Change AgentRunner/PiAgentBackend inputs from raw skill discovery config to frozen `ResolvedSkillSet`.
- [ ] Construct `DefaultResourceLoader` with `noSkills: true`, `noContextFiles: true`, and only selected skill files as additional paths; keep explicit Goblin system prompt and `$GOBLIN_HOME/state/pi` agentDir.
- [ ] Emit structured creation/failure logs containing source modes, names, paths, diagnostics, Conversation, and environment identity without skill bodies.
- [ ] Add dispatcher/runner/backend tests for personal/project defaults, excluded host skills, exact root authority, malformed catalogs, mismatch-before-resolution, and explicit loader options.
- [ ] Run touched agent/orchestration tests and `bun run typecheck`.

## Phase 3: Remove process-wide skillSources

- [ ] Remove `skillSources` from `ConfigFileSchema`, `Config`, loading, fixtures, and resource-loader branches.
- [ ] Reject the obsolete JSON5 field with an actionable validation error rather than stripping it silently.
- [ ] Update configuration/canon-facing tests and sample configuration documentation without introducing another global source switch.
- [ ] Run `bun test src/config.test.ts` plus touched agent tests, `bun run typecheck`, and `litespec validate skill-catalog-resolution`.
