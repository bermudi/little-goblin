# PWA polish — light-mode contrast, focus rings, touch targets, control labels

Record of a PWA polish pass over `app/`, originally authored on the
`jules-13012817728181129554-4dcf4e9c` branch (commit `c9da8cd9`) and landed here
as a cherry-pick: the screenshot bundle was dropped, and this report was cut
back to what the diff actually does.

Design language unchanged — two knobs (`--app-bg` / `--app-fg`), flat hairline
separation, dark mode default, light mode via `prefers-color-scheme`.

## 1. Tokens (`app/src/styles.css`)

Light mode was under-contrast. `--app-fg: #525252` made the derived tones
(`--app-fg-muted` = 62% fg, `--app-fg-subtle` = 48% fg, both
`color-mix(in oklab, …)`) too pale against white, and the status colors were
hardcoded for the dark surface.

Ratios below are the WCAG 2.x contrast formula, with the oklab `color-mix` of
each token modelled from the file's own definitions and measured against that
mode's surface:

| token (light mode)        | before                | after                |
| ------------------------- | --------------------- | -------------------- |
| `--app-fg`                | 7.81:1 (`#525252`)    | 16.43:1 (`#1f1f23`)  |
| `--app-fg-muted`          | **3.21:1 — fails AA** | 5.30:1               |
| `--app-fg-subtle`         | 2.39:1                | 3.42:1               |
| `--app-accent`            | 2.72:1 (`#a78bfa`)    | 7.10:1 (`#6d28d9`)   |
| `--app-danger`            | 2.77:1 (`#f87171`)    | 4.83:1 (`#dc2626`)   |
| success dots/pills        | 1.74:1 (`#4ade80`)    | 5.02:1 (`#15803d`)   |
| warning dots/pills        | 1.53:1 (`#facc15`)    | 5.02:1 (`#b45309`)   |

`--app-fg-subtle` stays below AA (3.42:1 light, 3.68:1 dark). It is the
decorative tone and was already sub-AA in dark mode, so this pass levels light
mode to dark rather than inventing a new rule: small text that matters should
use `muted`, never `subtle`.

Status colors move behind `--app-success` / `--app-warning` tokens, consumed by
`.mem-healthy`, `.mem-degraded`, `.mem-pending`, `.pill.on`, `.pill.st-running`,
`.pill.st-starting`, `.pill.st-needs_input`, `.skill-state.skill-installed`.

## 2. Focus rings

`:focus-visible` covered only `button`, `input`, `textarea`, `summary`, and the
ring was `var(--app-fg-subtle)`. Every interactive element — including `select`,
`a`, `.conv`, `.idx`, `.snav`, `.rail-op`, `.rail-section`, `.rail-archived` —
now shares one ring:

```
outline: 2px solid color-mix(in oklab, var(--app-fg) 50%, transparent)
outline-offset: 1px
border-radius: 6px
```

That measures 3.23:1 on white (2.30:1 before, below the 3:1 focus-appearance
minimum) and 4.56:1 on the dark surface.

## 3. Touch targets

`@media (pointer: coarse), (max-width: 720px)` raises `.icon-btn`, `.nav-toggle`,
`.header-action`, rail items and chip controls to 2.25rem (36px), and
`.conv-actions button` to 1.85rem (30px).

Honest scope: 36px clears WCAG 2.2's 24px target-size floor but is under the
44px iOS guidance, and the query also fires on narrow desktop windows, where it
adds `display: flex` to rail items — worth a look in a resized desktop window.

## 4. Control labels

Real fixes — controls whose only name was a `placeholder` (placeholders are not
accessible names) or that had no programmatic label at all:

- `App.tsx`: token gate input.
- `ChatView.tsx`: composer textarea, note-picker search.
- `NoteView.tsx`: notes search, project filter select, note title input, note
  project select.
- `ProjectView.tsx`: `NewProjectDialog`'s directory-path input (a sibling of the
  radio label, not inside it); the project view's instructions textarea and
  memory select, which sit in a `<div class="frow">` under an `<h2>` that does
  not name them.

Redundant by construction — `NewProjectDialog`'s name input, instructions
textarea and memory select already sit inside `<label class="frow">` with a
visible `.flabel`, so the wrapper already names them; their added `aria-label`s
restate the visible text. Harmless, but not fixes.

Cosmetic: `title` tooltips added alongside existing `aria-label`s on icon-only
buttons (attach, record, remove, nav toggle, dialog and sheet close), plus
`aria-label="Remove"`/`aria-label="Attach"` style duplication on the staged
attachment buttons.

## 5. Not in this change

Mobile overflow and text-clipping containment is **not** part of this pass. An
earlier draft of this report claimed `min-width: 0` / `overflow-wrap` /
`overflow-x` work on `.md-table`, `.ui-table`, `.codeblock pre`, `.tool-clip`,
`.logview`, `.cmdbar code`, `.pathchip`, `.conv-title`, `.conv-preview` and
`.header-title`; the diff touches none of those selectors, and `.md-table` still
has no `overflow-x`. Long unbroken strings on a 390px viewport remain
unverified.

## 6. Verification at landing

Cherry-picked onto `main` at `c9bf0322` (`app/src/*` + this report only):

| check                              | result |
| ---------------------------------- | ------ |
| `bun run typecheck` (both programs) | exit 0 |
| `bun x biome format .`             | clean, no fixes |
| `bun run vite build app`           | succeeds, CSS bundle 59.95 kB |
| `bun test`                         | 3902 pass, 83 skip, 0 fail (3985 tests / 211 files) |

The original pass's Playwright screenshots (52 files, ~1.8 MB) were not
committed — the repo tracks only the app icons as images. Contrast ratios above
are computed from the token definitions, not sampled from a browser.
