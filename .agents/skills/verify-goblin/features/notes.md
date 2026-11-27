# Notes

## Sub-features

Create and edit a note. Filter the Notes manager and move, archive, restore,
or delete a selection.

## How to get to it (user POV)

You → Settings → Notes. Little Goblin's Library → All notes also opens
the manager.

## Driving it with agent-browser

```sh
ab find role button click --name 'You'
ab find role menuitem click --name 'Settings'
ab find role button click --name 'Notes Move, archive, and restore notes'
ab find role button click --name 'New note'
ab fill '[aria-label="Note title"]' 'verify note'
ab press Tab
ab wait 1500
sqlite3 -readonly "$HOME_DIR/state/goblin.sqlite" 'select title from notes'
```

Proof: the row has the new title and it survives a reload.

Create a second note the same way. Go back to Notes, check both rows,
choose Move to… → Global → Move, then filter to Global. Both rows should
show Global. Select both again and archive them. In Archived, restore
one and confirm permanent deletion of the other. Verify that Active shows
the restored note, that neither list shows the deleted one, and check the
database:

```sh
sqlite3 -readonly "$HOME_DIR/state/goblin.sqlite" 'select title, bot_id, archived_at from notes'
```

A Global row has a null `bot_id`. Little Goblin's rows use `little-goblin`.

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
