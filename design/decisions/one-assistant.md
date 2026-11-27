# One assistant, with bots for lasting work

> **Amended (operator, 2026-11-27, not built):** [bots and side chats](bots-and-side-chats.md)
> lets bots message each other, removes projects and loose chats, and
> renames the Rolling chat to Little Goblin's main chat. Where the two
> records differ, the newer one holds.

Operator rulings, 2026-11-24 (#924). [Bots](../../GLOSSARY.md#bot) are not
built. The [loop rule](../../AGENTS.md#goblin-is-a-loop-with-tools-and-connectors-thats-it)
still outranks this record: code gives bots chats, memory, messages and
limits; skills and instructions say how a bot does its work.

**Context.** Goblin had no stated goal. The Rolling chat, loose chats,
projects, programs, subagents and delegation grew side by side, and nothing
said which one a feature should extend. The operator wants one personal
assistant to hand everything to. DS-Bot is the model: a main agent, bots with
one endless chat each, and work that returns to whoever asked for it.

**Decision.**

- The operator talks to Goblin in the Rolling chat. Work handed over there
  reports there. Telegram is not needed for it.
- Goblin does errands. Work that lasts gets a bot.
- Goblin is in the middle: it messages and reads every bot. A bot reads its
  own chat, its own memory and the operator's profile. It answers Goblin.
- A bot's memory is a markdown file. Hindsight stays Goblin's alone, so there
  is still one bank ([projects](../projects.md#projects)).
- Read to know, message to act. Goblin reads a bot's memory file for a kept
  fact, searches its transcript for what was said, and messages it only for
  work or judgment.
- Transcript reads extend `history_search`: list the bots, read the newest
  messages of one, search one. No new family of session tools.
- Order: a tracking bot first, then handing the browser to the operator for
  sign-in, then payment (#863, #858). Each step adds one missing part.

**Rejected.**

- *Full DS-Bot*, where any bot messages and reads any other. More runs, and a
  page that tricks one bot reaches everything. It can be opened later; it is
  hard to close.
- *Messages only.* Each small question would cost a bot run.
- *Rooms*: a chat with instructions that Goblin cannot hand work to.
- *Projects and bots side by side.* Less to build, but every lasting job would
  ask which of the two it belongs to.
- *Group chats and more channels.* Each bot that speaks is a full model run,
  and [one app plus optional Telegram](../../DESIGN.md#non-goals) stands.

| Part | Ruling |
|---|---|
| Rolling chat | Keep. The app opens here; New chat gets smaller (#919) |
| Loose chats | Keep. Existing chats stay |
| Subagents, Hindsight, notes | Keep |
| `history_search` | Keep and extend |
| Coding | T3 Code. Goblin starts and watches threads |
| Telegram | Frozen. Fixes only; the DM stays |
| Delegation | Frozen. Fixes only, for runs where the operator names the harness |
| Projects | Become bots, after a first new bot works. Their chats stay readable |
| Programs | A bot owns its own. The rest stay with Goblin |
| Cut | Nothing ruled |

**Consequences.**

- `memory_excluded` blocks Hindsight and `history_search` together. A bot
  needs its own "no Hindsight" switch, or Goblin cannot search it.
- Recall is automatic only from Hindsight. Goblin needs a short list of bots
  and what each one knows, or it will not look.
- The memory file and the bot list must not rewrite a sent prompt. They freeze
  with the conversation's prompt, as USER.md does
  ([cache stability](../../DESIGN.md#cache-stability)). An edit shows at the
  next roll or compaction; what the bot saved is already in its chat.
- A bot with a shell can open other files. The read limit is a tool rule, not
  a wall. A wall needs a sandbox.
- Each handover costs a model run. Goblin must write handovers that stand
  alone, because the bot cannot read the Rolling chat.
- Work started in the Rolling chat wakes the newest roll (#923).
- Revisit "in the middle" if Goblin mostly relays between two bots.
