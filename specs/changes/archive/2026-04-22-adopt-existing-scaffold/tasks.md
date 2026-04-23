# Tasks

## Phase 1: Analysis

- [x] Read all source files across src/ directory
- [x] Document discovered capabilities and invariants

## Phase 2: Spec Creation

- [x] Create proposal.md with scope and motivation
- [x] Create config/spec.md with environment loading requirements
- [x] Create logging/spec.md with structured logging requirements
- [x] Create telegram/spec.md with middleware and locator requirements
- [x] Create sessions/spec.md with session lifecycle requirements
- [x] Create commands/spec.md with command handler requirements
- [x] Create models/spec.md with model registry requirements
- [x] Create orchestration/spec.md with startup/shutdown requirements

## Phase 3: Documentation

- [x] Create design.md with architecture and decisions
- [x] Create tasks.md with completion tracking

## Completed

1. **Read all source files** — Analyzed 18 source files across src/ directory
   - Core: `src/index.ts`, `src/bot.ts`, `src/config.ts`, `src/log.ts`
   - Telegram: `src/tg/mod.ts`, `src/tg/middleware.ts`, `src/tg/locator.ts`
   - Sessions: `src/sessions/mod.ts`, `src/sessions/manager.ts`, `src/sessions/types.ts`, `src/sessions/bindings.ts`, `src/sessions/state.ts`, `src/sessions/paths.ts`
   - Commands: `src/commands/mod.ts`, `src/commands/ping.ts`, `src/commands/new.ts`
   - Agent: `src/agent/models.ts`

2. **Create proposal.md** — Documented motivation and scope

3. **Create capability specs** — 7 spec files with requirements and scenarios:
   - `specs/config/spec.md` — 6 requirements, 14 scenarios
   - `specs/logging/spec.md` — 4 requirements, 9 scenarios
   - `specs/telegram/spec.md` — 4 requirements, 10 scenarios
   - `specs/sessions/spec.md` — 12 requirements, 16 scenarios
   - `specs/commands/spec.md` — 6 requirements, 8 scenarios
   - `specs/models/spec.md` — 6 requirements, 10 scenarios
   - `specs/orchestration/spec.md` — 9 requirements, 13 scenarios

4. **Create design.md** — Architecture overview and key decisions

5. **Create tasks.md** — This file

## Verification

- Run `litespec validate adopt-existing-scaffold` to verify all artifacts are valid
- Check that all ADDED requirements contain SHALL or MUST
- Verify each requirement has at least one Scenario with WHEN/THEN format
