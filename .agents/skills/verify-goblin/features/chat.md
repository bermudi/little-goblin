# Chat

## Sub-features

Send a message, stream a reply, list the conversation in the rail.

## How to get to it (user POV)

The app opens on it. Type in the composer and press Send. "New conversation" in the sidebar starts another.

## Driving it with agent-browser

```sh
ab fill '[aria-label="Message draft"]' 'hello'
ab click 'button[aria-label="Send"]'
ab wait --text 'verify-reply: hello'
sqlite3 -readonly "$HOME_DIR/state/goblin.sqlite" 'select count(*) from conversations'
```

Proof: the reply is on screen, the conversation is in the rail, the meta line names `fake/verify-model`, the row exists, and `fake-model.log` has a `POST /v1/chat/completions`.

Before sending, open the model picker and choose another model. The control
is for this chat, not the app default. Send a message and verify the new
conversation uses that model; Settings > Models > Default models > App chats
must still show its prior value. An untouched composer must still use the
current default.

### Sent files

Send `[sent-media]` and wait for `verify-sent-media: sent both copies`.
The app should show two `verify-sent-media.txt` download buttons. Each
follows the closed tool activity that sent it, with `First copy.` and
`Second copy.` on opposite sides of `Sending another copy.`. Click either
button to download the file, then reload and check the order again.

Send the marker again in the same chat. There should now be four buttons,
two per reply, even though the fake model reuses its tool call IDs.

## Gotchas

The fake model takes the rail title from its own reply, so the title starts with `verify-reply:`. Thinking can't be exercised with it. Tool calls can, through the markers: `[agent <task>]`, `[delegate <harness> <cwd> <task>]`, `[post <text>]` (see [posts.md](posts.md)) — see [delegation.md](delegation.md).

To test Stop or a failed turn, put `[slow]` in the message (one word every 400ms, so there's time to press Stop) or `[fail]` (a few words, then the connection breaks). The fake checks the last user-role message as goblin sends it, and an unlanded-turn record from a previous turn quotes that turn's text. So after a `[slow]` turn is stopped, a `[fail]` turn also streams slowly before it fails.

To watch a long reply stream after tool calls, put `[long]` in the message: two `read_file` calls a second apart, then a reply several screens long, one line every 60ms. It starts with `verify-long: the head of the answer` and ends with `verify-long: the tail of the answer`.
