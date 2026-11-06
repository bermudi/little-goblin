# Notes

## Sub-features

Create a note, edit its title, list it.

## How to get to it (user POV)

Sidebar → Notes → New note.

## Driving it with agent-browser

```sh
ab click 'button[aria-label="Notes"]'
ab find role button click --name 'New note'
ab fill '[aria-label="Note title"]' 'verify note'
ab press Tab
ab wait 1500
sqlite3 -readonly "$HOME_DIR/state/goblin.sqlite" 'select title from notes'
```

Proof: the row has the new title and it survives a reload.

## Gotchas

Saving isn't instant, so wait before reading the row.
