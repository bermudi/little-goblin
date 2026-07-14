# telegram-session-resume-name — Design

## Terminology

Avoid "active session" except in user-facing text. It is ambiguous.

- **bound session**: The session currently mapped from a `ChatLocator` in `config.json`. This is the session that handles the next message on that Telegram surface.
- **unbound session**: A session under `sessions/<id>/` that no current binding points to. It is not current anywhere, but it is still resumable.
- **resumable session**: Any non-archived session under `sessions/<id>/`, whether bound or unbound.
- **archived session**: A session moved under `sessions/archive/<id>/`. It is intentionally excluded from normal resolution and resume lookup.

## Command semantics

### `/new`

`/new` should be a non-destructive switch:

1. interrupt/cascade current work;
2. create a new session for the current Telegram surface;
3. bind the surface to the new session;
4. dispose the old runner if the surface was previously bound;
5. leave the old session directory under `sessions/<old-id>/`.

This makes the old session an unbound resumable session. It can be resumed by ID or name.

### `/archive`

`/archive` remains the explicit "put this away" command:

1. interrupt/cascade current work;
2. move the bound session to `sessions/archive/<id>/`;
3. clear every binding that references it;
4. dispose its runner.

Archived sessions are not returned by normal `list()` and are not considered by `/resume`.

### `/name`

`/name <name>` writes `SessionState.title` on the bound session. It does not rename Telegram topics and does not mutate memory scope descriptions.

### `/resume`

`/resume <id-or-name>` searches resumable sessions only:

- exact session ID;
- unique session ID prefix;
- exact `SessionState.title`.

If one session matches, bind the current Telegram surface to it and dispose the previously bound runner if switching sessions. Do not archive or delete the previously bound session.

If multiple sessions match, do not change bindings and report the candidates.

With no target, `/resume` lists named resumable sessions as a switchboard. Anonymous sessions are omitted; they are still resumable by ID if the user already has the ID from `/debug` or prior output.

## Why not revive archived sessions?

Because it makes `/archive` muddy. If `/archive` means "remove from normal rotation," then `/resume` should not silently undo it. Keeping archive out of resume preserves a simple model:

- `/new`: switch to fresh, keep old resumable.
- `/resume`: switch to existing resumable.
- `/archive`: intentionally remove from resumable set.

## Migration / compatibility

No data migration is required.

Existing archived sessions stay archived. If a user already archived something by accident, manual filesystem recovery or a future explicit `/unarchive` can handle that. This change only fixes behavior going forward.
