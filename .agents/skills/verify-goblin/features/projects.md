# Projects

## Sub-features

Create a project managed by goblin.

## How to get to it (user POV)

With the desktop Chats pane showing, click New project to open a dialog.

Project chats show on the project page, not in the sidebar unless pinned.
If the Projects section is closed, click the `Projects` button first. Then
`ab find role link click --name '<project name>'` opens the project page.
The all-projects page is in the You menu: click You, then Projects.

## Projects section disclosure

Use a fresh browser profile with an existing active project. In the desktop
Chats pane:

1. Before looking for a project link, find the `Projects` button. Its
   `aria-expanded` value should be `false`; the project link should not be
   visible, and New project should remain visible.
2. Click `Projects`. The active project link should appear and the button
   should report `aria-expanded="true"`.
3. Reload the page. The section should stay expanded.
4. Click `Projects` again. The link should disappear and the button should
   report `aria-expanded="false"`.
5. Open You, then Projects. The all-projects page should open.

## Pin a project chat

Open an unpinned chat from its project page. Open the chat title menu and
choose Pin. The chat should appear at the top of Chats, with its project name
beside the title. Unpinned project chats should remain on the project page,
not in Chats.

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
