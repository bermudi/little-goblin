# Effect-TS and goblin

Answer to "what is effect.ts and how would it relate here?" (2026-11-19).
An explainer for the operator, not a ruling: if Effect ever enters the
tree, the ruling lands in `design/<area>.md` and this page links it.

## What Effect is

Not a file in this repo. [Effect](https://effect.website/docs/introduction)
is a TypeScript *framework* (npm package `effect`; "Effect-TS" names it and
its ecosystem), not a library you call in places. The core idea: a
computation is a value — `Effect<A, E, R>` describes something that, when
run, produces an `A`, can fail with the typed error `E`, and needs the
services in `R` from its environment. Nothing executes until one `run`
call at the edge. The rest is consequences:

- **Typed errors.** Failure is a channel in the type. `catchTag` picks one
  case; the compiler sees what is left unhandled.
- **Layers.** Dependency injection as values: a `Layer` builds a service
  from other layers, with acquisition and release, composed into a runtime.
- **Fibers.** Structured concurrency: fork, join, race — and interruption
  that is guaranteed to run finalizers.
- **Scopes.** Resource safety: `acquireRelease` ties cleanup to a scope;
  interrupt, throw, or exit — the release runs.
- **Stream, Schema, platform.** Pull-based streams; a zod-style validator
  that also owns the type (`Effect.Schema`); `@effect/platform` (HTTP and
  friends) on the same primitives.
- **`@effect/ai`.** Effect's own LLM layer: a provider-agnostic model
  interface, tool calling with structured outputs decoded by Effect
  Schema, streaming ([intro](https://effect.website/docs/v3/ai/introduction),
  [announcement](https://effect.website/blog/effect-ai)).

## How it maps onto goblin

| Effect idea | goblin's existing answer | Verdict |
|---|---|---|
| `@effect/ai` | The Vercel AI SDK holds the platform role: `ai` imports fenced to a shrinking allowlist (#597), `useChat` UIMessage wire, `src/turn/engine.ts` as the neutral engine contract | A second AI platform, not a library. It could only enter as a third engine behind `engine.ts`, and the app wire pins the output side to UIMessage either way |
| `Effect.Schema` | zod at every boundary; tools are zod-input `defineTool`s whose `inputJsonSchema` is held equal to the SDK's (`src/tool.test.ts`, #595) | A second validator plus conversion at the hottest boundary — the AI SDK speaks zod |
| Typed error channel `E` | `BoundaryError` with missing/transient/fatal, classified once in the adapter (#449) | Same idea, coarser grain. Nicer in Effect; not nicer by a rewrite |
| `Scope` / `acquireRelease` | `await using` + `src/dispose.ts`, enforced by test (#447) | Already borrowed — through the language feature TS grew for exactly this |
| Fibers / interruption | `abortSignal` threaded into every tool `execute`; `/stop` supersession; claim → effect → settle ordering (#448) | Effect's guarantees are stronger in general, but goblin's runtime rules are about durable claims and byte-stable replay, which fibers do not give |
| `Layer` | `index.ts` wires and never rules | Formal DI in a one-process, one-operator app is ceremony |
| `Stream` | Async-iterables over the SDK stream; UIMessage wire to `useChat` | Same pull model; no runtime switch needed |

## The honest overlap

What Effect would genuinely buy: interruption with guaranteed
finalizers, typed errors end to end, and testable environment services
(`Clock`, `Random`) — the things that keep large teams safe. Goblin
already runs the local version of each: `src/dispose.ts`,
`BoundaryError`, and a log contract that must reconstruct any run from
one log file.

What it would cost: the whole tree changes idiom (generators or `pipe`
in place of `async/await`); every AI SDK touchpoint grows a `runPromise`
boundary; two validators live at once; and prompt assembly moves — P0
cache-bust territory (DESIGN.md → Cache stability) if the rewrite ever
stops the prefix being append-only bytes. `module-boundaries.test.ts`
would gain a guest on a list that only shrinks.

The hybrid pattern people do run — AI SDK for the model, Effect around
the tools — still means two runtimes owning one turn loop. For goblin
that is cost with no second real use.

## Ruling of this page

- **Adopt: nothing today.** No `effect` dependency. The platform role is
  filled, zod owns the boundaries, and fail-loud covers the error story.
- **Borrow mechanisms, not scope** — the openclaw/hermes rule, applied to
  a library. `dispose.ts` is that borrow, via `using`. If another
  mechanism earns its place (layer-style construction inside one
  adapter, say), take the idea, not the package.
- **Revisit trigger:** a subsystem whose interruption and finalizer needs
  outgrow `AbortSignal` + `await using` — a queued-turn scheduler with
  backpressure guarantees, say. Then it enters inside one adapter or
  feature folder, never repo-wide, and the ruling moves to
  `design/<area>.md` with this page linking it.
