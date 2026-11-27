# Bots and side chats replace projects and loose chats

Operator rulings, 2026-11-27 (#976, #926). Not built. This record amends
[one assistant](one-assistant.md). The [loop rule](../../AGENTS.md#goblin-is-a-loop-with-tools-and-connectors-thats-it)
still outranks it: code gives bots chats, pages, messages and limits;
skills and instructions say how a bot does its work.

**Context.** The app had four places to talk: the Rolling chat, loose
chats, project chats and, soon, bot chats. Nothing said which one a thing
belongs to. Example: Goblin kept a list in a note, but the Rolling chat's
prompt shows no note titles, so the operator had to ask for the list by
name. The project page was hard to use, and bots need settings such as a
default model. The operator compared Grok Bot, Orca and DS-Bot. Each has one
main bot, bots with one job each, and no projects.

**Decision.**

- **[Little Goblin](../../GLOSSARY.md#little-goblin) is the main bot.** The
  Rolling chat becomes its [main chat](../../GLOSSARY.md#main-chat). The app
  shows the name in the list row, the right panel and the chat header.
  SOUL.md stays the operator's file.
- **Every bot has one shape:** a main chat, [side chats](../../GLOSSARY.md#side-chat),
  a bot page and the right panel. Little Goblin has this shape too.
- **No projects.** The Projects section, New project and the project page
  go. A bot page holds the bot's settings, such as its default model and
  thinking level. It is a new page, not the project page.
- **No Chats section.** New chat stays, as "New side chat". A side chat
  belongs to one bot. It shows under that bot's row in the left list, and
  only while that bot is open. A closed bot's row carries the most urgent
  mark of its side chats, in the order the list uses today. Search history
  still finds side chats and names their bot. A chevron on the bot's row
  also opens and folds its side chats by hand, so a phone can reach them
  (lead's pick, 2026-11-27, #978).
- **Three columns stay.** The left list holds Little Goblin and the bots.
  Little Goblin stays at the top and custom bots have their own **Bots**
  section. A bot's row opens its main chat.
  The centre holds the chat or the bot page. The right panel shows the open
  bot: its avatar, status, activity, schedule and memory. Needs you still
  shows every item.
- **Bots may message each other.** A [handover](../../GLOSSARY.md#handover)
  is one bot asking another to do work. Its rules:
  1. Only Little Goblin reads every bot's chat and memory. Other bots
     message; they do not read.
  2. A handover is a request, not the operator's word. Spending money and
     sending mail still ask the operator, whichever bot asked.
  3. After 5 handovers in a row without the operator, the chain stops and
     asks the operator.
  4. Every handover shows in the chats of both bots.
- **Group chats stay out.**
- **[Goals](../../GLOSSARY.md#goal) come after the first bot.** Bots are
  designed so they can update a goal's status line.
- **Moving existing chats.** Loose chats become side chats of Little
  Goblin. Project chats become ordinary chats, so they also become side
  chats of Little Goblin, and the Archive page needs no change. A project
  the operator names becomes a bot instead, and its chats become that bot's
  side chats. A project's instructions become the instructions of the bot
  it turns into; when it turns into side chats, they are kept as a note.
  A moved chat keeps what its project gave it:
  - **Memory.** A chat that the project kept out of memory stays out. The
    operator can turn memory on for each chat later.
  - **Working directory.** A chat keeps the project's directory as its
    working directory, because its sent prompt already names it. A project
    that becomes a bot gives it that directory as the bot's folder.
  - **Archive.** Chats of an archived project become archived chats, so
    they stay hidden and show on the Archive page.

### Converting a side chat

Operator rulings, 2026-11-27 (#983). An active Little Goblin side chat
becomes a bot's main chat. Conversion keeps the conversation ID, history,
model settings, working directory and system prompt snapshot. Use the chat
title as the suggested bot name. When the bot starts a fresh conversation,
it uses the app's model and thinking defaults unless overridden, a dedicated
bot folder, and the bot's instructions, initially blank. Later changes to
those defaults and instructions apply to fresh conversations.

Little Goblin's ID is `little-goblin`. Other bots have server-generated UUIDs.
A bot keeps its ID across renames and conversation rolls. The conversation
has one owner, so notes can use the same bot ID for all its chats.

The converted chat can search its bot's history. Previously recalled
Hindsight context still replays at its original position. New bot turns
skip Hindsight recall and retention (#926).

The bot page saves the display name separately from the original chat title.
**Move back to Little Goblin** is available while the converted chat is the
bot's only chat and the bot has no notes. A branch made from a bot chat is a
side chat of that bot. Moving back returns the same conversation to Little
Goblin and retires the bot ID. Converting the chat again creates a new bot ID.

**Rejected.**

- *A list of bots in place of today's layout.* The operator ruled that the
  three columns have room.
- *Side chats in the app-wide list*, and *a header switcher for them.* The
  first fills one list with every bot's side chats. The operator tried the
  second in a mockup and chose the left list.
- *Keep "Goblin in the middle" for messages.* The operator chose direct
  handovers, as Grok Bot and DS-Bot have. The four rules carry the risk
  that one-assistant named.
- *A bot's memory as a note.* Grok Bot, Orca, DS-Bot and the 2026-11-24
  ruling all keep it as a markdown file.

**Consequences.**

- A page that tricks one bot can now message every bot. Rule 2 limits what
  that message can do; it does not stop the message.
- Each handover costs a model run. Rule 3 bounds a loop between bots.
- Rule 1 is a tool rule. A bot with a shell can still open other files; a
  wall needs a sandbox (same as one-assistant).
- A closed bot hides its side chats. The mark on its row is what keeps their
  work visible, so a missing mark is a bug, not a style issue.
- Goblin's profile pages (Status, Memory, Skills, Log) need a place on
  Little Goblin's bot page. Not designed yet.
