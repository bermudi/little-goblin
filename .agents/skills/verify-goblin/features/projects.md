# Projects

## Sub-features

Create a project managed by goblin.

## How to get to it (user POV)

With the desktop Chats pane showing, click New project to open a dialog.

Project chats show in the Chats pane inside their project's folder. If the
Projects section is closed, click `Show projects` first. Then
`ab find role button click --name '<project name>'` opens the folder.

## Projects section disclosure

Use a fresh browser profile with an existing active project. In the desktop
Chats pane:

1. Before looking for a project folder, find the `Show projects` button. The
   project folder should not be visible; the Projects label and New project
   control should remain visible.
2. Click `Show projects`. The active project folder should appear and the
   button should report expanded.
3. Reload the page. The section should stay expanded.
4. Click `Show projects` again. The folder should disappear while the label
   remains.
5. Click the `Projects` label. The all-projects page should open.

## Driving it with agent-browser

```sh
ab click 'button[aria-label="New project"]'
ab fill '[role="dialog"] input' 'verify project'
ab find role button click --name 'Create project'
sqlite3 -readonly "$HOME_DIR/state/goblin.sqlite" 'select name from projects'
```

Proof: the project is in the list and has a row.

On a 390×844 phone viewport, hold a `.conv-main` row with a touch pointer
for 600 ms, then release; the row's action sheet should open and the chat
route should stay put. In agent-browser, dispatch `pointerdown` with
`pointerType: "touch"` on `.conv-main`, wait 600 ms, then dispatch
`pointerup`. The open chat's title should also open a menu with the same
actions.

## Gotchas

The dialog's veil covers the rest of the app until it's closed.
