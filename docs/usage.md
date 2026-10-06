# Daily use

Two conversation doors: Telegram chat, and the app — a small web client
for the reading Telegram's client does badly (long replies, long lists).
A third surface, the Settings mini app, lives behind a Telegram button
and owns settings, not conversations.

## Topics are conversations

Each forum topic is its own conversation with its own history and settings.
No `/new`, no `/resume` — that job belongs to Telegram:

- **Start something:** create a topic, say hi.
- **Resume something:** post in the old topic. Full history is there.
- **No topics?** A chat without topics is one standing conversation.

A topic Telegram created with a placeholder name ("New Chat") gets
auto-titled from your first message — if `titleModel` is configured. Rename
it yourself at any point and your name always wins; the bot won't overwrite
an explicit rename.

## The six commands

Commands are settings and controls, not conversations. The settings ones are
per-topic (the topic you're in), and every settings change interrupts
whatever that topic is currently doing, so a reply always reflects the
current settings — never a mix.

| Command | What it does |
|---|---|
| `/voice` | Toggles voice-note replies for this topic. Speech is on by default; it needs `ffmpeg` and can be turned off with `tts: ""`. |
| `/stop` | Interrupts the running reply and drops anything queued behind it. |
| `/compact` | Compacts this topic's older history into a summary right now — the same thing the bot does automatically once a turn crosses 75% of the context window. Recent messages stay; nothing is deleted. |
| `/memory` | With no argument: memory status (health, queue, last recall, blocked rows) and whether this topic is included. `/memory on`·`off` set per-topic inclusion; `/memory retry`·`dismiss` handle blocked retention. [Memory](memory.md) has the full picture. |
| `/forget` | Deletes remembered content: `/forget <query>` lists matching sources, `/forget delete <n>` removes one for good — irreversible, and suppressed from future retention. |
| `/start` | A canned hello (Telegram sends it when a chat first opens). Nothing more. |

Commands can be addressed (`/stop@yourbot`) in groups; a command addressed
to a different bot is ignored rather than fed to the model.

## How replies behave

- **Fire off several messages in a row** — they merge into one reply. The bot
  waits ~500 ms after each message before starting, so a burst reads as
  one thought.
- While it works you see "typing…", plus status lines (`⚙ bash …`) as it
  uses tools.
- Finished replies get a 🫡 reaction on the last message — the end marker.
- If something goes wrong you get a short `⚠ …` message; the full detail is
  in the log, never in your chat.
- `/stop` a reply mid-flight and the chat shows `⏹ superseded` on what was
  sent so far — or nothing at all if nothing had gone out yet.

Long replies are split across messages automatically. Replies are threaded
to the message that triggered them.

## Sending media

Photos, documents, voice notes, audio files, videos, GIFs, video circles,
stickers — just send them, optionally with a caption. What happens:

1. The file is saved into `workspace/attachments/` where the bot (and you,
   over SSH) can reach it.
2. A model that understands that kind of media gets the file itself.
3. A model that doesn't gets the saved path instead — and can still read or
   process it with its tools. Nothing is ever silently dropped because the
   model couldn't see it.

Two special cases: voice and video notes are transcribed on arrival when
`transcription` is configured (see [Voice](voice.md)) — other audio files
are transcribed only if you ask — and a caption that happens to look like
a command (e.g. `/compact …`) is treated as a caption, not a command, when
it rides on media — the attachment wins.

Files up to 2 GB work if you're running the self-hosted Telegram bot API
(`telegram.apiRoot`); on the cloud API the usual Telegram limits apply.

## The Settings mini app

When `publicUrl` is set, the chat has a **Settings** menu button that opens
a form for common settings: model, title model, favorites, thinking (the
dropdown only offers levels the chosen model supports), speech,
transcription, allowed users, URLs, providers, log level. Save applies
immediately — no restart. It won't let you save a config that removes your
own user id. Delegation, Gmail, and the skill reviewer still require editing
`goblin.json5` by hand and restarting; saving in the app preserves them.

Behind the scenes it's a page served by the bot on localhost, loaded by your
Telegram client over HTTPS — which is why `publicUrl` (a tailnet serve,
funnel, or reverse proxy in front of `http://127.0.0.1:<port>`) is needed.
Only people in `allowedUsers` can load it, and logins expire after a day.

## The app

`<publicUrl>/app/` serves a standalone client — same door, no Telegram
client involved. It exists for the reading Telegram does badly: unchunked
long replies with real markdown, a proper conversation list, and no
4-second WebView cold start. It's installable as a PWA — add it to your
home screen and it opens in about a second.

Conversations are **disjoint**. A conversation born in the app lives only
in the app; Telegram topics live only in Telegram — nothing mirrors or
crosses, and an app reply can't ring your phone (Telegram stays the bell
for its own). Both pools share the same model, tools, config, and memory:
it's the same goblin behind a different door.

What works there: text, file uploads, hold-to-record voice notes
(transcribed at intake like Telegram voice notes when `transcription` is
set), read-aloud on replies, stop, retry, rename, delete, search, and the
model + thinking knobs. What's absent by design: the delegation and mail
tools — their results wake Telegram surfaces an app turn doesn't have, so
they're simply not in the app channel's tool set.

With `appToken` set, the app asks for the token once, proves it, and
keeps it on the device; unset means trust mode — anyone who can reach the
tailnet door is in. Trust mode must never sit behind a public `funnel`
URL — see [Security](security.md#the-app-channels-auth).

## The bot's identity files

- `workspace/SOUL.md` — who the bot is. Edit it (by hand or by telling the
  bot) and the change is live on the next message.
- `workspace/AGENTS.md` — the bot's operating notes, owned by the bot
  itself (it starts as a stub the bot is expected to grow). Same deal:
  edits apply next turn.
- `workspace/USER.md` — the bot's model of *you*: stable preferences as
  directives, each with an observation date. When you change your mind,
  the bot marks the old entry superseded instead of stacking a
  contradiction. Same deal: edits apply next turn.
- `workspace/skills/` — repeatable tasks the bot has learned; see
  [Skills](skills.md).

## Programs

Ask in the chat where you want the replies: "every weekday at 8:30,
brief me on the news" creates a program pinned to that chat (or topic).
A program is standing authority for one concern — a charter plus a
schedule. The bot writes crons it can restate; anything vaguer it will
confirm with you first. Replies arrive as ordinary messages in the same
place. Programs survive restarts; a fire missed while the bot was down
runs once when it comes back, then continues on schedule. Tell the bot
"list my programs" / "delete the news brief" to manage them.

### Webhooks

A program can also wake on demand: ask for a hook ("give the build
watcher a webhook") and the bot sends you a secret URL — anyone who
POSTs to it fires the program with the request body as the event. The
URL reaches the outside through the same door as the mini app: with
`tailscale serve` it's tailnet-only; `funnel` (or any public proxy)
makes it reachable by GitHub, CI, etc. POSTs over 32 KiB are refused
and a program fires at most once per minute. Ask the bot to rotate the
URL if it leaks, or to disable the hook entirely.
