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

The app only writes a version every 10 minutes (`APP_VERSION_GAP_MS`), so
several quick edits give one version. To see a full Versions list, insert
extra rows into `note_versions` in the throwaway database (fiction, label it).
Give them revs below the note's own `rev`: the server snapshots the current rev
on the next save, so a row at the current rev makes every save fail with a
UNIQUE error ("Offline — retrying").
Use a long note: the list once drew over the text only when the note was taller
than the pane.
