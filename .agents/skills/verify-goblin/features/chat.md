# Chat

## Sub-features

Send a message, stream a reply, list the conversation in the rail.

## How to get to it (user POV)

The app opens in the [Rolling chat](rolling.md). Press New side chat (`+` above the list) for an ordinary chat, type in the composer and press Send.

## Driving it with agent-browser

```sh
ab click 'button[aria-label="New side chat"]'
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

### Working reply

Send `[work]`. The waiting card shows a timer and Thinking. The live fold
shows the newest thought and running call. Reload during work and check
the timer continues. `Between calls.` is followed by 4 seconds of silence.
Check that Thinking shows under it during the silence. The line between
calls uses the present tense. Check that the final reply has a Worked timer
and closed activity folds. Repeat on
phone width. Send `[think]` and check the settled reply has no timer.

## Gotchas

The fake model takes the rail title from its own reply, so the title starts with `verify-reply:`. Tool calls can be exercised through the markers: `[agent <task>]`, `[delegate <harness> <cwd> <task>]`, `[post <text>]` (see [posts.md](posts.md)) — see [delegation.md](delegation.md).

To test Stop or a failed turn, put `[slow]` in the message (one word every 400ms, so there's time to press Stop) or `[fail]` (a few words, then the connection breaks). The fake checks the last user-role message as goblin sends it, and an unlanded-turn record from a previous turn quotes that turn's text. So after a `[slow]` turn is stopped, a `[fail]` turn also streams slowly before it fails.

To watch a long reply stream after tool calls, put `[long]` in the message: two `bash` calls a second apart, then a reply several screens long, one line every 60ms. It starts with `verify-long: the head of the answer` and ends with `verify-long: the tail of the answer`.
The live line stays under the text until the reply ends.

`agent-browser fill` on the composer (`[aria-label="Message draft"]`) puts its text in front of the draft that is already there; it does not replace the draft (2026-11-26). Send from an empty composer, or read the composer's text before you rely on it.

### Long Worked list

An open "Worked" list is capped at 40vh and scrolls inside itself (#936). The fake model stops at two calls per turn, which is below the cap. To see the cap, open the fold and copy a row inside the page: clone a `li`, set `data-fill="copy"` on the copy, label it "a copy made in the page", and insert the copies before the first row so the real calls stay at the end. Check `ul.clientHeight` against `0.4 * innerHeight`.

`agent-browser mouse wheel` moved nothing on this page, the chat included (2026-11-25). To scroll the list, click a row inside it and press PageDown.

To check that the list follows new calls, arm the copies before the send: a `MutationObserver` opens the new fold and fills its list as soon as the first call's row appears. Fill until the list overflows by more than 48 px, or "at the end" and "scrolled up" read the same.
