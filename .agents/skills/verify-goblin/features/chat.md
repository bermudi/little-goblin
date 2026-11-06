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

## Gotchas

The fake model takes the rail title from its own reply, so the title starts with `verify-reply:`. Tool calls and thinking can't be exercised with it.
