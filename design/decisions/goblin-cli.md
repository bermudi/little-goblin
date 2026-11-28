# Goblin commands reached from bash (trial)

Status: trial passed, ruled 2026-11-27 on
[#993](https://github.com/bermudi/little-goblin/issues/993). The 2026-10-10
rejection in [tools.md → Scripting](../tools.md#scripting) stands until the
real-case measurement below. The trial stays off in production.

**Context.** Every request sends every tool schema. With all tools mounted
that is 27 tools and about 40 KB, roughly 10k tokens; most turns use two or
three tools. Hiding tools and loading them later is cache-safe only where a
tool can join mid-chat without rewriting the prompt start:

- Claude Code already hides Goblin's MCP tools behind its own ToolSearch.
- Codex can append tools (#959), and a search that Goblin answers keeps
  the cache warm.
- OpenRouter, openai-compatible, responses and zai resend the whole list
  each request. Any change there rewrites the cached start, which is a P0
  under [Cache stability](../../DESIGN.md#cache-stability).

A tool the model only reads about, never declared, was never called (6 of
6 live runs on `gpt-6-luna`). A command that the model runs through `bash`
needs no declaration. Every route then sees one fixed tool list, and help
text is ordinary tool output, so it is cache-safe everywhere. Bash-only
agents also beat typed-tool agents at lower cost ("Is Bash All You Need?",
arXiv 2609.11999).

The 2026-10-10 ruling rejected bash-spawned processes that call back to
Goblin over a loopback port, for two reasons. A local test answers both
for a channel that belongs to one bash call:

- *A process can outlive `/stop` and the epoch fence.* A background job
  that called `goblin` after its bash call returned was refused.
- *A port is ambient authority for every same-uid process.* The channel is
  a socket on an inherited file descriptor, with no port and no path.
  Another same-uid process could not open `/proc/<pid>/fd/3`.

**Decision.** Build one command, `goblin note`, and measure it before
building more. The trial is off unless config turns it on, so production
chats do not change until the operator rules on the result.

- **One private channel per bash call.** When the trial is on, the bash
  tool spawns with Bun's IPC channel. Goblin closes the channel when that
  bash call returns, for any reason: exit, timeout or abort. A call that
  arrives later fails at once, with a message and a nonzero exit. A call
  that arrived before the bash process ended finishes first, so the bash
  result never comes back ahead of an effect it started, and its record
  is in that result.
- **Only `goblin` sees the channel.** Bun sets `NODE_CHANNEL_FD` on the
  child even when the caller passes its own env. Any bun or node program
  that inherits it gets `process.send` and may switch to its worker mode.
  Goblin removes the variable before the model's command runs, and the
  `goblin` command restores it only for itself.
- **One call at a time per channel.** Replies on the shared socket go to
  whichever reader takes them first. A lock on the inherited socket does
  not keep siblings apart, because they share the open file. So the
  command takes a lock on a separate per-call lock file. Parallel
  `goblin` calls in one bash call wait their turn.
- **Calls are real calls under the real name.** Goblin answers each
  request in-process through the fence's dispatch, the same path a
  `script` nested call takes: authority epoch, journal, recovery guard,
  and the turn's abort signal. The journal records it as `note`, with the
  child call id `<bash call id>/<n>`. The callable set is an allowlist
  intersected with the turn's assembled tools after guest filtering. A
  turn without `note` gets no `goblin note`.
- **Stop cuts off a running call.** The turn's abort reaches the tool's
  execute, the channel closes, and bash's process group is killed as it
  is today.
- **Pipes work both ways.** Output goes to stdout as plain text where the
  tool returns text, and as JSON otherwise. Errors go to stderr with exit
  1. Text the tool takes as a body can come from stdin.
- **Help comes from the tool.** `goblin --help` and `goblin note --help`
  are made from the tool's description and input schema. `goblin --help`
  prints every command in full: description, actions and flags, so one
  call is enough (operator, 2026-11-27: the first measurement spent two
  help calls per new chat, one for the list and one for the flags). The bash
  description gets one fixed sentence that names `goblin --help`. It never
  lists the commands, so a change to the command set never changes the
  tool list.
- **The app shows the nested call.** The bash result carries a short
  record of each `goblin` call: tool, arguments, result and whether it
  failed, cut short the way `script` cuts its records. The bash card lists
  them, with the same input and result summary that a direct call's card
  shows. A bash result without `goblin` calls stays byte-for-byte as
  today, so old chats keep their cached start. Full cards for nested
  calls would need bash to rewrite its model output, which touches the
  cache rule; not in the trial.

**Not in the trial:** other commands; commands that wait on the operator,
such as mail approval, which can outlast the bash timeout; removing typed
tools; shrinking schemas; the container `sandbox`, which gets no channel.

**Consequences.** The trial reports, on Codex (`gpt-6-luna`) and
OpenRouter (`minimax/minimax-m3.1-flash`) with public prompts: how often
the model finds and uses `goblin note` with the typed `note` tool hidden,
compared with the typed tool; extra model requests per task; and input and
cached tokens. OpenRouter runs pin a session id, because #991 is not fixed.

**Result (2026-11-27).** Both models found and used `goblin note` in 60
of 60 runs, and no run called an undeclared tool. With the full
`goblin --help`, a new chat reads help once. Codex then makes 0.6 extra
requests per task with about the same input tokens, and OpenRouter about
one. Hiding one tool saves no tokens: `goblin note --help` is about the
size of the `note` declaration. Numbers are on #993.

**Next (operator, 2026-11-27).** Mark a set of rarely used tools as
commands, and measure a full-list chat against a short typed list plus
commands. The operator approves the tool set before any code. Then the
operator rules on which tools stay typed and whether the 2026-10-10
rejection is replaced.

Accepted risks:

- Every descendant of the bash call inherits the socket. A program the
  model starts in that call could write to it directly. That program
  already holds the bash call's authority, and the channel dies with the
  call.
- The added sentence changes the bash description once when the trial is
  turned on. On routes that resend the whole list, that costs one cold
  cache read per open chat.
