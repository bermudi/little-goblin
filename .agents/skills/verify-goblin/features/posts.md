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

### See all and the Activity page

The panel shows eight rows. With more, its footer shows "See all", which opens `/app/activity` (on phone it closes the sheet first). The page loads 50 posts and "Show older" loads the rest. To get past one page without 60 model turns, seed old posts into the throwaway database, then make one or two real posts so a row links to its chat:

```sh
for i in $(seq -w 1 58); do
  sqlite3 "$HOME_DIR/state/goblin.sqlite" "insert into posts (conversation_id, text, created_at) values ('telegram/seed', 'Seeded post $i', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 hours', '+$i minutes'))"
done
ab find role button click --name "See all"
ab get url                                  # /app/activity
ab eval 'document.querySelectorAll(".activity-page .goblin-panel-row").length'   # 50
ab find role button click --name "Show older"
ab eval 'document.querySelectorAll(".activity-page .goblin-panel-row").length'   # every kept post
```

Proof: the panel keeps eight rows, the page reaches the oldest post, "Show older" goes away at the end, and a post row still opens its chat.

## Gotchas

`bun run try` restarts the instance on a new commit or a dirty tree, with a fresh home: seed again after it.


The panel refreshes on a 10 s poll, so wait before looking for the row.
