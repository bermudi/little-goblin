# Daily use

Everything happens in Telegram. There is no other UI except the Settings
mini app (which also lives behind a Telegram button).

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

## The four commands

Commands are settings-only, and each one is per-topic (the topic you're in).
Every settings change interrupts whatever that topic is currently doing, so
a reply always reflects the current settings — never a mix.

| Command | What it does |
|---|---|
| `/model` | With no argument: shows the current model and your favorites. `/model <provider/model-id>` switches. `/model reset` back to the default. |
| `/think` | With no argument: shows the current thinking level and what this model supports. `/think <level>` switches. `/think reset` back to the default. |
| `/voice` | Toggles voice-note replies for this topic. Needs `tts` configured (otherwise it tells you so). |
| `/stop` | Interrupts the running reply and drops anything queued behind it. |

Commands can be addressed (`/stop@yourbot`) in groups; a command addressed
to a different bot is ignored rather than fed to the model.

## How replies behave

- **Fire off several messages in a row** — they merge into one reply. The bot
  waits ~1.5 seconds after each message before starting, so a burst reads as
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

Two special cases: voice/audio/video notes are transcribed when
`transcription` is configured (see [Voice](voice.md)), and a caption that
happens to look like a command (e.g. `/model …`) is treated as a caption,
not a command, when it rides on media — the attachment wins.

Files up to 2 GB work if you're running the self-hosted Telegram bot API
(`telegram.apiRoot`); on the cloud API the usual Telegram limits apply.

## The Settings mini app

When `publicUrl` is set, the chat has a **Settings** menu button that opens
a form with every knob: model, title model, favorites, thinking (the
dropdown only offers levels the chosen model supports), speech,
transcription, allowed users, URLs, providers, log level. Save applies
immediately — no restart. It won't let you save a config that removes your
own user id.

Behind the scenes it's a page served by the bot on localhost, loaded by your
Telegram client over HTTPS — which is why `publicUrl` (a tailnet serve,
funnel, or reverse proxy in front of `http://127.0.0.1:<port>`) is needed.
Only people in `allowedUsers` can load it, and logins expire after a day.

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
