# Home screen

## Sub-features

The start page, a mark on each chat (needs you, new reply, working), side chats under Little Goblin, the Active section, subagent folds, and Goblin's face.

## How to get to it (user POV)

Open the app: it shows Little Goblin's main chat (the Rolling chat). On a desktop the list is the left column; on a phone press Back once.

## Driving it with agent-browser

```sh
DB="$HOME_DIR/state/goblin.sqlite"
rows() { ab eval 'JSON.stringify([...document.querySelectorAll(".rail-body .conv, .rail-body .kidtoggle")].filter(r => r.offsetParent !== null).map(r => (r.dataset.mark || "-") + " | " + r.innerText.replace(/\n/g, " / ").slice(0, 80)), null, 1)'; }
ab set viewport 1280 800; ab open "$URL"
ab get url                                              # ends in /app/rolling
for t in alpha beta; do
  ab click 'button[aria-label="New side chat"]'
  ab fill '[aria-label="Message draft"]' "$t"; ab click 'button[aria-label="Send"]'
  ab wait --text "verify-reply: $t"
done
sqlite3 -readonly "$DB" 'select title, read_seq from conversations'   # 2: read on screen
```

Working, then a new reply. `[slow]` streams for 16 s, so leave the chat while it runs:

```sh
ab fill '[aria-label="Message draft"]' '[slow] gamma'; ab click 'button[aria-label="Send"]'
ab wait 600; ab click '.rail-body a[href="/app/rolling"]'
rows                    # the side chat under Little Goblin, "working | Working / ..."
ab wait 17000; rows     # "new | New reply / ..."
```

Open the chat: its dot goes away on every device, and `read_seq` moves. The row stays where it is until you leave it.

Needs you. Mail is off here, so write the draft (a fake one, to an `example.com` address) into the throwaway database. With a chat's id as `target` the chat gets the `!`; with `dm:1` it is a row of its own that opens `/app/programs`:

```sh
ID=$(sqlite3 -readonly "$DB" "select id from conversations where title like '%alpha'")
sqlite3 "$DB" "insert into mail_outbox (to_json, subject, body, target, status, created_at, expires_at) values
  ('[\"shop@example.com\"]', 'Order the light', 'x', '$ID', 'pending', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day')),
  ('[\"bank@example.com\"]', 'Ask about the fee', 'x', 'dm:1', 'pending', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day'))"
ab wait 1500; rows
ab eval 'document.querySelector(".goblin-panel-toggle").getAttribute("aria-label")'   # Little Goblin, 2 need you
sqlite3 "$DB" "update mail_outbox set status = 'discarded'"                           # both rows lose the mark
```

A subagent: send `[agent find a hotel]` in `alpha`, then open the child and send `[slow] more` there. From any other chat, `alpha` is "working" with a closed "1 subagent" fold.

Questions: send `[ask When should the nudge fire?|9:00|11:00]` in an ordinary chat. The question card appears outside Worked and the chat gets the amber `!` with `Asks: When should the nudge fire?`. Tap a choice to send the `[ask]` answer and close it; reopen another question and choose **No answer needed** to close without a message. Finally send `[ask-close <id>]` in the newest roll to close a question asked in an older roll.

An older roll: make a second roll ([rolling.md](rolling.md)), open an ordinary chat, then set the first roll's `read_seq` to 0. The Little Goblin row gets the dot and opens that roll.

Project chat: give a chat a `project_id` and `read_seq = 0`. Its row in Active ends with "in <project>", also when its last line is long.

Phone: `ab set viewport 390 844`. A fresh `$URL` shows Little Goblin's main chat, Back shows the list, and a reload there stays on the list.

Side chats: every chat outside a project shows under the Little Goblin row as a `.side-chat` row. The `Side chats` chevron (`button[aria-label="Side chats"]`, `aria-expanded`) folds and opens them; on a phone it is the only way to reach them from the list. Opening Little Goblin's main chat or a side chat opens them; opening a project chat or project page folds them. While folded, the Little Goblin row carries the most urgent side-chat mark, with a line such as `New reply in alpha` or `Working in gamma`.

Convert a side chat: open it, open the menu in its title, choose **Convert to bot…**, enter a name, and confirm. Its row moves to **Bots**. Click the row to open the same conversation and see the bot in the right panel. Open **Bot settings** from the title menu or select the avatar in the panel. After renaming, the row and panel use the new name. **Move back to Little Goblin** returns the chat to Little Goblin’s side chats with the same URL and transcript. Branching from the bot chat adds a bot side chat and hides **Move back to Little Goblin**. Check active bots with `sqlite3 -readonly "$DB" 'SELECT name, conversation_id FROM bots JOIN bot_chats ON bots.id = bot_chats.bot_id'`.

Lost line: see [live.md](live.md). The marks turn grey.

Proof: the `rows` output and a screenshot for each state, in both themes (`ab set media light`), and the `read_seq` values.

## Gotchas

On a phone the page also holds a hidden copy of the sidebar. Use `.chatlist-screen` there and `.rail-body` on a desktop.
A `target` that is not a conversation address makes the Attention list fail: the face then shows `?`.
Opening the URL that is already open is a reload, so it does not prove the start page. Go to another page first.
