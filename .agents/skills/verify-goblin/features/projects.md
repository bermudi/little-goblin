# Projects

## Sub-features

Create a project managed by goblin.

## How to get to it (user POV)

Sidebar → Projects → New project, which opens a dialog.

## Driving it with agent-browser

```sh
ab click 'button[aria-label="Projects"]'
ab find role button click --name 'New project'
ab fill '[role="dialog"] input' 'verify project'
ab find role button click --name 'Create project'
sqlite3 -readonly "$HOME_DIR/state/goblin.sqlite" 'select name from projects'
```

Proof: the project is in the list and has a row.

## Gotchas

The dialog's veil covers the rest of the app until it's closed.
