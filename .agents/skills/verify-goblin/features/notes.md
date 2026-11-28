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

On a note, fill **Reason for next edit (optional)** and leave the field or
press Enter to finish the reason. Change its title or body and wait for Saved.
Edit it again with the reason field empty.
Open **Versions** and check that Edit history shows two distinct Operator
revisions and that only the first edit shows the reason you entered. Open
both diffs to check the changed text. Restore a snapshot and verify that
the restore appears as another Operator edit.

Change the body, start typing a reason, then switch tabs while the reason
field still has focus. The body saves, and that history row has no reason.
On return, check that the partial reason is still in the field. Finish it,
then change the note again and check that the next history row has that reason.

```sh
sqlite3 -readonly "$HOME_DIR/state/goblin.sqlite" 'select rev, author_bot_id, what, reason from note_edits order by note_id, rev'
```

## Gotchas

Saving isn't instant, so wait before reading the row.

The app groups restore snapshots for quick edits. Each content revision still
has its own history entry. To seed more restore snapshots, insert
extra rows into `note_versions` in the throwaway database (fiction, label it).
Give them revs below the note's own `rev`: the server snapshots the current rev
on the next save, so a row at the current rev makes every save fail with a
UNIQUE error ("Offline — retrying").
Use a long note: the list once drew over the text only when the note was taller
than the pane.
