# Feed posts

## Sub-features

Goblin calls the `post` tool; the post shows in the Goblin panel's Activity tab and opens its chat.

## How to get to it (user POV)

Desktop: the Goblin panel is the right column beside any chat page, Activity tab first. Phone: tap Goblin's avatar in a chat header to open the panel as a sheet.

## Driving it with agent-browser

The fake model turns `[post <text>]` in the last user message into one `post` tool call with that text, untouched (spaces and line breaks included, so the tool's own trimming and length checks are reachable), then replies with the usual echo.

```sh
ab fill '[aria-label="Message draft"]' '[post Backup finished.
All 3 disks OK.] check the disks'
ab click 'button[aria-label="Send"]'
ab wait --text 'verify-reply: [post'
ab wait 11000   # the panel polls activity every 10 s
ab snapshot -i | grep 'post ·'
ab find role button click --name "Backup finished. All 3 disks OK. post · now"
sqlite3 -readonly "$HOME_DIR/state/goblin.sqlite" 'select id, conversation_id, text from posts'
grep '"post added"' "$HOME_DIR/state/goblin.log"
```

Proof: a button row with the post text and `post · now` under the Activity tab, the line break kept, the `posts` row, and the `post added` log line. Clicking the row opens the chat the post came from; a post made in the Rolling chat opens `/app/rolling`.

## Gotchas

The panel refreshes on a 10 s poll, so wait before looking for the row.
