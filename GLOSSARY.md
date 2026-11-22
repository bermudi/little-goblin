# Glossary

- **Attempt recorder:** the per-attempt object both turn engines report to. It keeps the step, text and tool records and builds the turn result (design/runtime-turn.md → Engine rules).
- **Delegation:** one run of an external coding harness that Goblin starts with the `delegate` tool, only when the operator asks for that harness. It runs as a named terminal on Goblin's private hc core; the operator can inspect it through hc or the app (design/delegation.md).
- **Harness:** a coding agent program that a delegation runs, such as codex or pi.
- **hc core:** the pinned herdr-core process that owns Goblin's named delegation terminals and survives Goblin restarts. Its session state is under `~/.local/state/herdr-core/` (design/delegation.md).
- **Ask-first harness:** a delegation harness with `askFirst: true`. The `delegate` tool tells goblin to ask the operator before each use. Settings → Delegation edits it.
- **Delegation family:** the five modules that implement delegations: `delegation-lifecycle.ts` (contracts + boot wiring), `delegation-paths.ts` (shared predicates), `delegation-notices.ts` (notice bodies + delivery), `delegation-actions.ts` (the five verbs), and `delegation-watcher.ts` (the scan lifecycle). Imports flow one way: watcher → actions → notices → paths.
- **Subagent:** a child conversation that Goblin starts with the `agent` tool. It runs on Goblin's own runtime, with an agent type's prompt, model and tools (design/agents.md).
- **Agent type:** a markdown file in `$GOBLIN_HOME/agents/` that sets a subagent's description, model, tools and system prompt. `general` and `computer` are built in.
- **Child conversation:** a conversation with a parent. A subagent runs in one; its final reply goes back to the parent as a notice.
- **Computer:** the built-in agent type whose child does screen work on a named desktop.
- **Settlement:** the point where a delegation or subagent run stops and states a result: done, needs input, or failed.
- **Notice:** the machine message that gives a settlement to Goblin and wakes the conversation.
- **Hindsight:** the separate memory service. It extracts, stores and searches memories for Goblin.
- **Bank:** the store of memories in Hindsight. Goblin uses the bank named `goblin`.
- **Exchange:** one operator message and Goblin's reply. It is the source that memory saves.
- **Unlanded turn:** a turn whose reply never landed — terminal error, fence, or process death. Its completed steps and the reply as streamed reach history as one system event; a journaled live turn stopped or failed before any output still records its outcome (design/runtime-turn.md → Unlanded-turn progress).
- **Retention:** saving an exchange to memory. Goblin queues it, then Hindsight extracts from it.
- **Fact:** one statement that the extraction LLM takes from an exchange. It is either `world` or `experience`.
- **Observation:** a merged statement that consolidation builds from facts.
- **Consolidation:** the automatic Hindsight step that merges facts into observations.
- **Mission:** the plain-language rule that guides a Hindsight step. `retain_mission` guides extraction and `observations_mission` guides consolidation.
- **Recall:** finding memories and adding them to the prompt before a reply.
- **Anchor:** the sequence number of the user message that a recall block or a retention attaches to.
- **Memory contexts:** saved recall blocks, one per conversation and anchor. The model view replays them ahead of the anchored message.
- **Outbox:** the durable table `memory_outbox`. Retentions wait in it until the service accepts them.
- **Screening:** the filter that replaces keys, tokens, and passwords with `[REDACTED:…]` before text reaches memory.
- **RRF:** reciprocal rank fusion. A model-free way to merge ranked lists; also the pinned reranker choice for the memory service.
- **System One:** Goblin's yes/no check layer. A decision model returns a probability for a question about the current state.
- **Decision model:** a model that answers typed questions with scores and does not write text.
- **Curator:** the deterministic pass that marks provenance-backed skills stale and archives unused ones into `workspace/skills-archive/`. It never deletes. `design/skills.md` → Self-authoring, /learn, curator.
- **Skill reviewer:** the background job (`src/reviewer.ts`) that runs after a turn when System One says it's worth it. It works on a private copy of the skills tree and can only propose skills, never install them. Not the turn itself; a turn can also write a proposed skill (self-authoring, `/learn`).
- **Proposed skill:** a complete, validated skill draft parked in `workspace/skills-proposed/`. It installs only on the operator's yes.
- **Temp skill:** a fetched, one-turn skill copy from a GitHub URL. It is injection-scored, never installed, and never a catalog entry.
- **Cycle guard:** `src/import-cycles.test.ts`. It freezes today's import cycles as clusters and fails on any cycle that grew past or appeared outside them; clusters are pruned by hand as cycles are untangled.
- **Feature folder:** a feature that lives as one directory under `src/` with a single public `index.ts` and its own tables. No folder uses it today; `module-boundaries.test.ts` still enforces the rule for the next one.
- **Parked block:** a capability's config kept under `config.parked` while the capability is off. Re-enabling restores it.
- **Turn:** one model run from an admitted trigger, including its tool calls and reply.
- **Epoch:** the monotonic counter on a conversation. A cancellation bumps it (`/stop`, `/new`) and ends the running turn in the same call; an action prepared under an older epoch is refused. Settings changes such as `/voice` do not bump it: they apply to the next reply.
- **Fence:** a re-check of authority at the moment of a side effect. A fenced action stops without acting.
- **Attempt:** one try at a turn on one model. A context overflow or a model fallback ends the attempt and starts a new one; the turn goes on.
- **Rail:** one way an attempt can end in failure: a journal fault, a fence, a context overflow, or a model error. Each rail decides whether the turn ends or resumes as a new attempt (`src/runtime-rails.ts`).
- **Roll:** a fresh app conversation made when the Rolling chat treats a
  message as a new subject. For example, after a quiet gap and a new-subject
  check, Goblin starts an empty conversation instead of adding the message to
  the old one.
- **Rolling chat:** the one chat-list entry that routes app messages to the
  current app conversation and starts a fresh one when the quiet-gap rule says
  to. For example, the second message inside the gap stays in the same
  conversation.
- **Wake:** a durable queued trigger that asks a conversation to start a turn. `wake-store.ts` and `wake-dispatcher.ts` own it.
- **Watch:** a one-shot request, made with the `watch` tool, to wake a conversation when a T3 Code thread, a GitHub PR or a set time changes. Example: after asking a T3 thread for a fix, Goblin watches that thread and gets one turn when it stops.
- **Fold:** one compaction: older messages become a summary, a recent tail stays verbatim. The full history stays on disk.
- **Fold mark:** the pill in the app transcript that shows where a fold ran and expands to its summary.
- **Idle fold:** a fold that runs on its own shortly before an idle app conversation's prompt cache expires, so the summary reads warm cache.
- **Code-made parts:** the sections of a fold summary that code writes, never a model: verbatim operator messages and the identifier index. Later folds carry them forward untouched.
- **Boot notice:** the DM a boot owes the operator for a crash it found at journal open — one interrupted turn, or stranded input. It waits in the `boot_notices` table until a send lands, surviving boots that died before the Telegram attach (#579).
- **Intake:** the path a Telegram update takes from the access gate to the coalescing buffer — redelivery dedupe, command gates, media extraction, and the durable inbox journal. `src/tg/intake.ts`; design/telegram.md → Telegram intake & delivery.
- **Flush:** what happens when the coalescing window closes — rolling-dm routing and navigation archives, then durable admission of the batch. `src/tg/flush.ts`; a sibling of Intake joined only by bot assembly.
- **Whistle:** the default speech-transcription engine. A Cactus Compute model; Goblin runs its `needle` binary locally on CPU with the `whistle.cact` weights, both sha256-pinned and auto-fetched into the whistle cache. `src/agent/transcribe-whistle.ts`; design/asr.md.
- **Pending input:** an app message sent while a turn runs. It waits in the conversation's inbox (`app_pending_input`), outside history, until the runtime claims it. A **steer** joins the running turn at its next model call; a **follow-up** starts the next turn. Until the claim, the operator can edit or remove it (design/app.md).
- **Turn script:** an engine-neutral list of scripted model calls (reply, hold, fail) that a test queues to drive turns through the real Runtime. One adapter per engine renders it: `sdkScript` (AI SDK) and `claudeScript` (Claude Code). See `src/testkit/turn-script.ts`.
- **Engine rules:** the optional turn rules each turn engine declares it follows (`EngineRules` in `src/turn/engine.ts`): tool launch gate, pre-emptive fold, content-filter re-ask, transient retry, context fill. The runtime owns them (the last four in `src/turn/step-rules.ts`); an engine reports its model-call boundaries, and `src/turn/engine-rules.test.ts` checks each declaration against behaviour (design/runtime-turn.md → Engine rules).
- **Memory runaway:** a test process stuck in synchronous code that keeps allocating, such as bun printing a whole happy-dom tree for a failed assertion (#798). Its main thread never yields, so test timeouts and `afterEach` never run. The memory net ends it with a `memory runaway:` report on stderr.
- **Memory net:** the first `bun test` preload, `src/test-memory-net.ts`. A worker thread watches the process RSS and, past 75% of the cgroup memory cap (at most 3 GiB), prints the running test's name and kills the process before the kernel does (DESIGN.md → Test posture → Memory net, #818).
- **Goblin panel:** the app's right-hand column about Goblin itself, beside chat pages: its avatar and whether it is working, the Needs you list, and the Activity, Scheduled and Library tabs. On a phone it opens as a bottom sheet from Goblin's avatar. It exists so the operator can see what Goblin is doing without leaving the chat; for example, a running codex delegation shows under Activity (design/app.md → App navigation).
- **Needs you:** the top of the Goblin panel, listing what waits on the operator: approvals, delegation questions, memory problems. It is the old Attention list under a plainer name. An item opens where its evidence shows, such as a new program's diff; the panel never approves anything itself.
- **Goblin's profile:** the Status, Memory, Skills and Log pages shown under one header with Goblin's avatar. Tapping the avatar in the Goblin panel opens it. It holds the pages the operator needs rarely, so they stay out of the chat list.
