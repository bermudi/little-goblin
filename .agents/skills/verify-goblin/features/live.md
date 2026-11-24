# Live app state

## Sub-features

The app's lists update by themselves: chats, subagents, titles, busy marks and posts. When the line to the server is down for 3 seconds, the chat list says so.

## How to get to it (user POV)

Nothing to open. Leave one browser on any page, change something from another one, and look at the first.

## Driving it with agent-browser

Use two sessions: `A` only watches, `B` acts.

```sh
A() { agent-browser --session "verify-<name>-a" "$@"; }
B() { agent-browser --session "verify-<name>-b" "$@"; }
A set viewport 1280 800; A open "$URL"
B set viewport 1280 800; B open "$URL"
A eval 'window.__mark = "not reloaded"'
```

A chat from the other browser:

```sh
B fill '[aria-label="Message draft"]' 'made on the other device'
B click 'button[aria-label="Send"]'
A wait --text 'made on the other device'
B wait --text 'verify-reply: made on the other device'
```

A subagent. The fake model turns `[agent <task>]` into one real `agent` call, so the server makes the child chat itself:

```sh
B fill '[aria-label="Message draft"]' '[agent research the launch date]'
B click 'button[aria-label="Send"]'
A wait --text 'verify-reply: research the launch date'
```

The child's row is indented under the parent's row, and `goblin.log` has `agent child spawned` with both ids.

A rename and a child row, written by another process. Goblin's own stores do not see these writes, so the row proves that the server watches the database:

```sh
DB="$HOME_DIR/state/goblin.sqlite"
CID=$(sqlite3 -readonly "$DB" 'select id from conversations where parent_conversation_id is null order by created_at desc limit 1')
sqlite3 "$DB" "update conversations set title = 'renamed elsewhere' where id = '$CID'"
A wait --text 'renamed elsewhere'
sqlite3 "$DB" "insert into conversations (id, chat_id, title, cwd, created_at, parent_conversation_id, agent_type, memory_excluded)
  values ('app/11111111-2222-4333-8444-555555555555', 0, 'Research the launch date', '$HOME_DIR/workspace', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '$CID', 'general', 1)"
A wait --text 'Research the launch date'
```

Busy state. The fake model streams `[slow]` for 16 seconds:

```sh
B open "$URL"
B fill '[aria-label="Message draft"]' '[slow] count for me'
B click 'button[aria-label="Send"]'
A wait --text 'Working · 1 job'
A wait --text 'Nothing running.'     # on an instance with no post yet
```

The lost line:

```sh
A set offline on
sleep 4
A eval 'document.querySelector(".live-lost")?.innerText'   # Reconnecting. Marks may be old.
sqlite3 "$DB" "update conversations set title = 'renamed while offline' where id = '$CID'"
A set offline off
A wait --text 'renamed while offline'
A eval 'document.querySelectorAll(".live-lost").length'    # 0
A eval 'window.__mark'                                     # not reloaded
```

Proof: each text shows in `A` within about a second, `window.__mark` is still set at the end, the open chat's header in `B` shows the new title, and `goblin.log` has `app live attach` and `app live detach` for each browser and outage. Do it once more with `B` at 390 × 844: the phone shows the subagent row and the lost line too.

A skill folder is outside the database, so the 10 s sweep finds it. A broken one must warn once:

```sh
mkdir -p "$HOME_DIR/workspace/skills/broken-skill"
printf -- '---\nname: other-name\ndescription: broken on purpose\n---\nbody\n' \
  > "$HOME_DIR/workspace/skills/broken-skill/SKILL.md"
sleep 35
rg -c '"msg":"skill skipped"' "$HOME_DIR/state/goblin.log"    # 1
printf -- '---\nname: broken-skill\ndescription: repaired\n---\nbody\n' \
  > "$HOME_DIR/workspace/skills/broken-skill/SKILL.md"
sleep 12
rg -c 'skill catalog problem cleared' "$HOME_DIR/state/goblin.log"    # 1
```

## Gotchas

"Nothing running." gives way to the newest posts once a post exists; then wait for "Idle" under Goblin's name.
Once the Rolling chat has a preview, its row no longer reads "Goblin Always here". Use `a[href="/app/rolling"]`. On a phone the page also holds a hidden copy of the sidebar, so use `.chatlist-screen a[href="/app/rolling"]`.

`set offline on` tells the page that it is offline. A server that dies without notice is a different path: stop the server process and start it again on the same port and home.
