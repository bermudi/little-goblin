# Migration hunt: everyday journeys

What would a long-time **openclaw** (`~/build/testing/openclaw/`) or
**hermes-agent** (`~/build/testing/hermes-agent/`) user find odd, confusing,
or broken in their first weeks of daily use of goblin?

- **Odd** = differs from what they're used to, with no visible reason.
- **Broken** = something goblin claims to do but does partly, silently, or
  only once.

The sense of "normal" comes only from the two references (their docs and
code). Goblin's own history — git log, issues, `audit/`, past bug reports —
is off-limits for this hunt: findings must come from the references and
goblin's current source, not from what goblin already knows about itself.

## Scope filter (mandatory)

A missing feature that is out of goblin's scope (`DIRECTION.md` non-goals;
`ROADMAP.md` baseline) is **not** a finding. Report a gap only when goblin
already offers the capability and the migrating user's expectation breaks
inside it. If unsure, record it as a **scope question** for the operator,
not as a bug.

## The journeys

Fifteen everyday journeys, all of which goblin offers today. One
investigator walks each one: cites how the references do it, cites how
goblin does it, answers the five questions per step (input intact? results
used/saved/returned? survives restart? failure visible? would the user be
surprised?), and proves each finding on a throwaway instance
(`bun run try migration-<slug>` → `bun run try down migration-<slug>`) or
labels it **unverified** with what would prove it.

| # | Journey | What the user does | Reference starting points | Goblin starting points |
|---|---------|--------------------|---------------------------|------------------------|
| 1 | first-setup | Install, configure, boot, first message answered, first app conversation | openclaw onboard wizard (`docs/start/`, `docs/install/`); hermes `setup-hermes.sh`, `website/docs/getting-started/quickstart.md` | `docs/setup.md`, `scripts/install.sh`, `src/doctor.ts`, boot seeding |
| 2 | everyday-chat | Text message in; burst merging; typing + status lines; long-reply splitting; end marker + ratings; threading | openclaw `docs/concepts/messages.md`, `streaming.md`, `typing-indicators.md`, `markdown-formatting.md`, `reactions.md`; hermes `website/docs/user-guide/messaging/telegram.md` | `docs/usage.md` → How replies behave, `src/tg/`, turn runtime |
| 3 | message-actions | Reply to / quote / forward / edit / delete a message | openclaw `docs/channels/telegram.md` + `docs/channels/telegram/`; hermes `website/docs/user-guide/messaging/telegram.md` | `src/tg/` intake, conversation addressing |
| 4 | interrupt-and-steer | `/stop` mid-flight; more messages while it works; queueing; superseded marker | openclaw `docs/concepts/queue.md`, `queue-steering.md`, `docs/tools/steer.md`; hermes bot-mode/session docs | `/stop`, queue + superseded marker in `docs/usage.md`, turn runtime |
| 5 | long-conversation | Weeks-long topic: auto-compact, `/compact`, what the model sees after compaction, mid-conversation identity edits, context window view | openclaw `docs/concepts/compaction.md`, `session-pruning.md`, `context.md`; hermes micro-compaction, context-compression docs, checkpoints-and-rollback | `design/compaction.md`, `/compact`, prompt snapshot boundary, app context window (`src/window-capture.ts`) |
| 6 | media-and-voice | Send photos/docs/voice/video/stickers (± caption); transcription on arrival; `/voice` mode; 🔊 button; read-aloud | openclaw `docs/tools/media-overview.md`, `docs/tools/tts.md`; hermes voice-mode, tts, document-extraction, vision | `docs/voice.md`, `docs/usage.md` → Sending media, attachment intake, `transcribe`/`speak` tools |
| 7 | restart-resume | Service restarts mid-conversation/mid-turn; history, queue, programs, memory queue survive; what's memory-only | openclaw `docs/concepts/session-state.md`, gateway lifecycle; hermes session-storage, state-db-recovery, gateway-session-lifecycle | `src/boot.ts`, SQLite stores, wake-store crash/retry reconciliation, `docs/memory.md` queue |
| 8 | scheduled-work | "Every weekday at 8:30, brief me" → proposal → approve → fires; missed occurrences; edit/pause/delete; webhooks | openclaw `docs/automation/cron-jobs.md`, `tasks.md`, `standing-orders.md`; hermes cron docs, daily-briefing-bot, heartbeat, loops | `docs/usage.md` → Programs, Webhooks, `src/programs.ts`, `src/scheduler.ts` |
| 9 | memory | "Remember this"; "what did I say last week"; `/memory` status/on/off; `/forget`; retention queue; memories browser | openclaw `docs/concepts/memory.md`, `memory-builtin.md`, `memory-search.md`, `memory-provenance.md`, `user-model.md`; hermes memory.md, memory-providers, curator | `docs/memory.md`, `/memory`, `/forget`, `memory_search`/`memory_reflect` tools |
| 10 | persona-and-skills | SOUL/operating-notes/user-model edits; "I prefer X" → remembered; install/update/remove skills by chat; auto-proposed skills | openclaw `docs/concepts/soul.md`, `user-model.md`, `docs/tools/skills.md` + `creating-skills.md`; hermes SOUL.md, personality, use-soul-with-hermes, work-with-skills | `docs/usage.md` → identity files, `docs/skills.md`, workspace seeding, skills-proposed |
| 11 | model-switching | Switch model / thinking level per topic or in the app; settings mini app; root vs Telegram defaults; mid-conversation switch | openclaw `docs/concepts/models.md`, `model-failover.md`; hermes configuring-models, provider-routing, fallback-providers | `docs/configuration.md`, Settings mini app, app model+thinking knobs |
| 12 | errors-and-limits | Provider 429/5xx mid-turn; auth failure; retry/failover behavior; what the user sees vs what only the log knows | openclaw `docs/concepts/retry.md`, `model-failover.md`; hermes fallback-providers, troubleshooting-agent-quality | `⚠` error path, delivery/runtime error handling, `src/log.ts` events |
| 13 | two-doors | Telegram topics and the app/PWA side by side: disjoint conversations, app features, context window view, offline shell, Settings mini app | openclaw multi-channel routing + Control UI + companion apps; hermes multi-connection-desktop, web-dashboard | `docs/usage.md` → The app / Settings mini app, `design/app.md`, `src/http/` |
| 14 | delegate-coding | "Fix issue N in repo X" → coding agent delegated; progress, steering, result, PR readiness | openclaw `docs/tools/subagents.md`, `acp-agents.md`, `swarm.md`, `delegate-architecture.md`; hermes delegation.md, delegation-patterns | `design/delegation.md`, `src/subagents/`, issue builds + PR readiness (`docs/usage.md`) |
| 15 | ongoing-concerns | "Keep an eye on X" / take over running work → project + responsibility; feed pills/posts; Attention; corrections; pause/resume; completion evidence | openclaw `docs/automation/tasks.md`, `taskflow.md`, `docs/tools/goal.md`; hermes goals, kanban, heartbeat | `DIRECTION.md` → Feed/Responsibility sections, `design/programs.md`, `design/app.md`, responsibilities/feed |

## Verification rules for investigators

- Throwaway instances only (`verify-goblin` skill): `bun run try
  migration-<slug>`, always `bun run try down migration-<slug>` afterwards —
  even after failures. Never touch the real service, `~/goblin`, or Telegram.
- **No browser automation** in this hunt (the operator's machine runs several
  agents at once; headless Chrome is a full core each). Prove via the
  instance's HTTP routes, its SQLite state (`sqlite3 -readonly`), `state/`
  logs, `fake-model.log`, and module-level probes.
- The instance ships a **fake model** (`verify-reply: <last user message>`);
  investigators cannot add API keys (secrets never enter context), so
  model-dependent behavior is proved at module level with a scripted fake, or
  labelled **unverified** with the concrete step that would prove it.
- No real model calls.
- The checkout stays pristine: no edits; scratch probes under
  `/tmp/migration-hunt/<slug>/`; goblin modules imported by absolute path,
  bun run from the repo root so `bunfig.toml`'s testkit preload loads.
- Evidence files go to `~/.cache/goblin-verify/evidence/migration-<slug>/`.
- Off-limits reading: git log/history, GitHub issues, `audit/`, past bug
  reports.

## Output contract (per journey)

One `JourneyReport`: `walkthrough` (how the journey goes in goblin today, no
findings), `findings[]` (expectation with reference `file:line`,
goblinBehavior with `file:line`, kind odd|broken, hurt high|medium|low,
evidence seen|unverified, provesIt, fixDirection), `scopeQuestions[]`
(possible out-of-scope gaps, phrased as questions for the operator),
`evidenceTrail[]` (one line per command/probe actually run and what it
showed).
