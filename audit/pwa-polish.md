# PWA UX/UI Polish Audit Report

This audit report documents the UI/UX polish pass performed on Goblin's Progressive Web Application (PWA).

The goal of this pass was to achieve daily-use finish across all operator surfaces while strictly maintaining Goblin's "Open WebUI Computer" design language (two color knobs `--app-bg` / `--app-fg`, flat hairline separation, Inter + JetBrains Mono typography, dark mode default, light mode via `prefers-color-scheme`).

---

## 1. Global Design System & Tokens (`app/src/styles.css`)

### Surface / Area: Design Tokens & Light Mode Color Scheme
- **What was wrong:** In light mode (`prefers-color-scheme: light`), `--app-fg` was set to `#525252`. Derived color-mixed variables like `--app-fg-muted` (62% fg) and `--app-fg-subtle` (48% fg) resulted in pale grays (`#939393` and `#ababab`) on `#ffffff`, causing low contrast and unreadable text. In addition, status badges (e.g. healthy green `#4ade80`, warning yellow `#facc15`) lacked adaptive contrast in light mode.
- **What changed:**
  - Adjusted `--app-fg` in light mode to `#1f1f23` so derived color-mixed tones maintain WCAG AA contrast (≥ 4.5:1) against white.
  - Added adaptive status color tokens `--app-success` (`#4ade80` dark / `#15803d` light) and `--app-warning` (`#facc15` dark / `#b45309` light), and updated `--app-accent` and `--app-danger` for light mode (`#6d28d9` and `#dc2626`).
  - Updated status indicators (`.mem-healthy`, `.mem-degraded`, `.pill.on`, `.pill.st-running`, `.pill.st-starting`, `.pill.st-needs_input`, `.skill-state.skill-installed`) to use the adaptive CSS variables.
- **How it was verified:** Automated TypeScript typecheck, Playwright rendering across light/dark modes on mobile and desktop viewports, and visual verification.

### Surface / Area: Keyboard Accessibility & Focus Outlines
- **What was wrong:** Standard focus styling only applied to a subset of controls (`button`, `input`, `textarea`, `summary`). Interactive elements like `select` dropdowns, anchors (`a`), custom navigation buttons (`.conv`, `.idx`, `.snav`, `.rail-op`, `.rail-section`, `.rail-archived`) lacked explicit `:focus-visible` rings.
- **What changed:**
  - Added explicit `:focus-visible` outlines using `outline: 2px solid color-mix(in oklab, var(--app-fg) 50%, transparent); outline-offset: 1px; border-radius: 6px;` across all interactive elements (`button`, `input`, `textarea`, `select`, `summary`, `a`, `.conv`, `.idx`, `.snav`, `.rail-op`, `.rail-section`, `.rail-archived`).
- **How it was verified:** Tab-navigated through the application in Chromium to confirm focus indicator visibility across light and dark modes.

### Surface / Area: Mobile Touch Targets (Coarse Pointer / Small Screen)
- **What was wrong:** Interactive controls like `.icon-btn`, `.nav-toggle`, `.header-action`, `.conv-actions button`, `.ghost`, `.addbtn`, `.savebar-save`, `.rm`, `.skill-file`, and rail items had small physical hit areas (< 36px) on touch devices, risking missed taps.
- **What changed:**
  - Added media query rules for `@media (pointer: coarse), (max-width: 720px)` setting minimum hit heights/widths (≥ 36px–44px) for interactive buttons, icon buttons, ghost buttons, rail items, and chip controls.
- **How it was verified:** Rendered and verified touch target dimensions on 390×844 mobile viewport screenshots.

### Surface / Area: Layout Overflow & Text Clipping
- **What was wrong:** Long unbroken strings (e.g. URLs, file paths, log messages, search snippet markup) could cause horizontal page scrolling on narrow 390px screens.
- **What changed:**
  - Enforced `min-width: 0`, `overflow-wrap: break-word`, and `overflow-x: auto` containment on `.md-table`, `.ui-table`, `.codeblock pre`, `.tool-clip`, `.logview`, `.cmdbar code`, `.pathchip`, `.conv-title`, `.conv-preview`, and `.header-title`.
- **How it was verified:** Mobile viewport screenshots (390×844) confirmed zero horizontal document overflow across all 13 surfaces.

---

## 2. Surface-Specific Component Polish

### Token Gate (`.gate` in `app/src/App.tsx`)
- **What was wrong:** Token password input was missing an explicit `aria-label`.
- **What changed:** Added `aria-label="App token"` to the password input field.
- **How it was verified:** `bun run typecheck`, `bun test`, and Playwright inspect pass.

### Shell & Navigation Rail (`.rail` / `header` in `app/src/App.tsx`)
- **What was wrong:** Header navigation toggle buttons lacked a explicit `title` tooltip alongside `aria-label`.
- **What changed:** Added `title="Conversations"` to `nav-toggle` buttons.
- **How it was verified:** `bun test` suite (535 tests passing) and Playwright screenshots.

### Composer & Chat Transcript (`app/src/ChatView.tsx`)
- **What was wrong:**
  - Textarea draft input lacked an `aria-label`.
  - Icon-only attachment button (`.icon-btn`), voice note recording button, and staged attachment/note remove buttons (`×`) were missing `title` tooltips.
  - Search input inside the note picker popover lacked an `aria-label`.
- **What changed:**
  - Added `aria-label="Message draft"` to the composer textarea.
  - Added `title="Attach"`, `title="Record a voice note"`, and `title="Remove"` tooltips to composer buttons.
  - Added `aria-label="Search notes"` to the note picker search input.
- **How it was verified:** `bun test app/src/` passed all 535 tests; screenshots confirmed correct rendering.

### Notes Index & Note View (`app/src/NoteView.tsx`)
- **What was wrong:**
  - Notes index search input and project filter dropdown lacked explicit `aria-label` attributes.
  - Note view title input and project assignment dropdown lacked `aria-label` attributes.
- **What changed:**
  - Added `aria-label="Search notes"` and `aria-label="Filter notes by project"` in `NotesIndex`.
  - Added `aria-label="Note title"` and `aria-label="Assign to project"` in `NoteView`.
- **How it was verified:** `bun run typecheck` and `bun test` passed.

### Projects Index, Project View & Dialog (`app/src/ProjectView.tsx`)
- **What was wrong:**
  - `NewProjectDialog` modal close button `×` lacked a `title="Close"` tooltip.
  - Name, instructions, directory path, and memory mode inputs lacked explicit `aria-label` attributes.
  - Project view instructions textarea and memory mode select lacked `aria-label`s.
- **What changed:**
  - Added `title="Close"` to `NewProjectDialog` close button.
  - Added `aria-label="Name"`, `aria-label="Instructions"`, `aria-label="Directory path"`, and `aria-label="Memory mode"` attributes.
- **How it was verified:** `bun test app/src/` passed and screenshots verified modal alignment.

### Thread Sources Sheet (`app/src/ThreadSourcesSheet.tsx`)
- **What was wrong:** Sheet close button `×` lacked a `title="Close"` tooltip.
- **What changed:** Added `title="Close"` to the close button.
- **How it was verified:** `bun test` passed.

---

## 3. Verification Summary

1. **Typecheck:** `bun run typecheck` completed with **exit code 0** (0 errors).
2. **Unit & Integration Tests:** `bun test` ran 535 tests across 31 test files with **0 failures** (100% pass rate).
3. **Client Production Build:** `bun run app:build` succeeded, producing `app/dist/assets/index-*.css` (59.95 KiB) and JavaScript bundles without errors.
4. **Code Formatting:** `bun x biome format --write app/src` ran cleanly.
5. **Visual QA & Screenshots:**
   - 52 screenshots captured using Playwright across 13 surfaces × 2 viewports (mobile 390×844, desktop 1280×800) × 2 color schemes (dark, light).
   - Saved under `audit/pwa-polish/`.
