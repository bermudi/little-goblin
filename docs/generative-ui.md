# Generative UI, in plain language

**Short version:** "generative UI" just means *the answer comes back as an
interface instead of a paragraph*. In goblin there is exactly one tool that
does this, it is called `ui`, and it only exists in the **app** — Telegram
never sees it. The model fills in a JSON form that describes a small layout,
and the app draws that layout with goblin's own widgets.

This is **our own code**, built on the AI SDK we already use everywhere. It is
not json-render (a separate Vercel side-project — see the pin at the bottom).

## Why it exists

Some answers are barely readable as prose. Compare a rail-vs-car comparison,
a morning timeline, or "pick one of these four" written as sentences, versus
the same thing as columns, stats, or tappable buttons. Generative UI is for
the cases where *layout carries meaning*. It is deliberately **not the
default** — plain text stays the normal answer.

## The pipeline, one step at a time

1. **Only in the app.** When a turn runs in an app conversation, the server
   adds the `ui` tool to the model's toolbox
   (`src/agent/turn-tools.ts`: `ui: channelOf(conv.id) === "app"`). Telegram
   and guest turns never get it.

2. **The model decides.** The tool's *description* coaches it: text is the
   default; use `ui` when layout matters; never repeat in prose what the
   interface already shows.

3. **The model calls `ui` with JSON.** The JSON is the interface. A tiny
   example:

   ```json
   {
     "title": "Getting to work",
     "blocks": [
       { "type": "stats", "items": [
         { "label": "Drive", "value": "24 min" },
         { "label": "Tram",  "value": "37 min" }
       ]},
       { "type": "steps", "items": [
         { "title": "Leave by 07:40" },
         { "title": "Change at Central" }
       ]}
     ]
   }
   ```

4. **The blocks come from a fixed menu.** There is no free-form HTML in the
   normal path. The model can only pick from these:

   - **Leaves** (the actual widgets): `text`, `callout`, `stats`, `table`,
     `steps`, `chart` (bar/line/pie), `choices` (tappable buttons), `form`,
     `html` (the escape hatch, below).
   - **Containers**: `tabs` and `columns`.
   - It is **two levels deep only** — containers hold leaves, never other
     containers. No recursion. (Recursive schemas confuse OpenAI-compatible
     providers, and one rejected schema would break every app turn.)

   The menu and its exact rules live in `src/agent/tools/ui-schema.ts`
   (zod schemas — the single source of truth for both server and app).

5. **The server checks the JSON.** Before the interface is allowed to render,
   the server validates it with zod. Because real models *do* make small
   mistakes, there is a **repair pass** first (`normalizeUiInput`): if a block
   is missing its `type` field, the repair can infer it by matching the keys
   that are present; it also drops stray half-written fragments. Probed live,
   `zai/glm-5.3-flash` broke 9 of 22 comparison answers this way — repair cut
   that to 3. If validation still fails, the model sees a normal tool error
   and may retry. The model never gets a blank screen.

6. **The JSON is stored as the message itself.** The interface isn't a
   separate file or a saved "app" — the `ui` tool call *is* the record, saved
   in the conversation history like any other tool call. That means reload,
   resume, and spin-off copies all carry the interface for free, and the model
   sees its own past interface as a past tool call. (Store format = wire
   format.)

7. **The app draws it.** On the client, `app/src/ui/UiPart.tsx` takes the
   tool part and renders the right widgets from `app/src/ui/blocks.tsx`, using
   goblin's design tokens. **While it streams**, every block that already
   validates renders immediately and the one still arriving shows a skeleton —
   so the interface grows in as the model writes it.

8. **Interaction is honest.** Tabs and form inputs keep their state in React,
   client-side only (the tab you opened dies with the page). A real action — a
   tapped choice, a submitted form — **posts an ordinary, visible user
   message** starting with `[ui] ...` through the composer, exactly as if you
   had typed it. There is no hidden back-channel, so the transcript never
   lies. Buttons are disabled while a turn is running.

9. **The escape hatch — `html`.** Some answers need live computation: a
   calculator, a bill splitter, a tiny game. For those only, the model can
   emit an `html` leaf, which renders inside a sandboxed `<iframe>`
   (`allow-scripts`, but **not** `allow-same-origin`, plus an injected CSP).
   It cannot read goblin's tokens, storage, or DOM, and it only mounts once
   the HTML is fully written. This is the one deliberate prompt-injection
   surface we accept — the design ruling in `design/app.md` explains the
   tradeoff.

## The safety story (why this isn't scary)

- The model can only use widgets **we** define; it never emits raw React or
  runs server code.
- The one place it can run code is the `html` frame, and that frame is
  isolated from the rest of the app.
- "Actions" (taps/submits) are just normal messages — nothing bypasses the
  conversation.

## Where the code lives

| Piece | File |
| --- | --- |
| The tool: description, validation, `execute` | `src/agent/tools/ui.ts` |
| The component menu + repair pass (shared, server & client) | `src/agent/tools/ui-schema.ts` |
| Channel gating (app only) | `src/agent/turn-tools.ts`, `src/agent/tools/mod.ts` |
| Tool-part → widget dispatch | `app/src/ui/UiPart.tsx` |
| The widgets themselves | `app/src/ui/blocks.tsx`, `Chart.tsx`, `HtmlFrame.tsx` |
| Inline placement in the transcript (never inside the "Worked" fold) | `app/src/ChatView.tsx` |
| The formal design ruling | `design/app.md` → "Intelligent UI" |

---

## 📌 Parked candidate — json-render

**Pinned 2026-10-22.** Not adopted; revisit before the component library grows
much past its current 11 types, or before anyone proposes a second client
platform.

- **What it is:** <https://json-render.dev/> — a Vercel *Labs* framework
  (`@json-render/core`, `@json-render/react`, ...) for the same idea:
  model emits JSON constrained to a catalog of components you define; your
  components render it natively. It is a **framework layered on top of the
  AI SDK** (its docs install `ai` + `@ai-sdk/react` and use `streamText`),
  not a replacement for it.
- **How it differs from our `ui` tool:** it ships the catalog/registry/spec
  machinery as reusable packages, plus data binding (`$state`), visibility
  conditions, watchers, computed values, code export, devtools, and
  renderers for react-native / email / PDF / Vue / Svelte / Solid / remotion.
  Our equivalent is a single hand-built tool with no shared state.
- **Why we have not adopted it:**
  1. It clashes with the settled ruling that the interface is **chat-native
     and stateless**, with **store format = wire format** (the tool part in
     `UIMessage` history). json-render is a runtime spec stream.
  2. It is philosophically **against** any arbitrary-code path, so it has no
     equivalent to our sandboxed `html` escape hatch — which we want.
  3. Current scope fits in ~fifteen small components; adopting a framework
     would be more surface area, not a swap.
- **When to look again:** if we outgrow 11–15 component types, want the same
  interfaces on a non-React surface, or start hand-rolling shared state /
  visibility logic that json-render already ships.

See also: `AGENTS.md`/`DESIGN.md` for the "borrow mechanisms, never scope"
rule that governs how we'd evaluate it.
