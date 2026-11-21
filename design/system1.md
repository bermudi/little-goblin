# System One — goblin design

## What this is

System One is the working name for a *discriminative model*: one that
answers calibrated yes-probability (`noul`) questions about state instead
of generating text, cheap enough to ride every turn. The textbook name and
this working name are both recorded; which catches on is open.

**Naming rule:** identifiers that name the client, the gate or the concept
say `system1`; only model-id literals and model-choice tables say `jev` —
the model id names the model, not the system.

## The shared client

One `System1Client` is built at boot and shared by every consumer.

- **Models.** Default and backup are both `typesafe/jev-1.13` (operator
  ruling, 2026-10-05); the configured primary is
  `perplexity/pplx-decider-v1.2` (operator ruling, 2026-11-06).
- **Logging.** Never state text, credentials, response bodies, or endpoint
  URLs.

## Consumers

Each consumer owns its failure semantics: see `design/skills.md`,
`design/mail.md`, `design/telegram.md` and `design/model.md`.

## The loopback endpoint

The checker serves same-box callers (the `goblin-mail` wrapper). The
server binds loopback, and a loopback Host allowlist **is** the auth;
the text is never logged.

## Config

The optional bootstrap-only `system1` block is the shared client's own switch
(ruling 2026-10-12): set, the client exists and its non-reviewer consumers
attach, `reviewer` block or not (the skill-review gate itself still needs
`reviewer`); `reviewer` also implies the client, behaving identically.
`auth` names the `auth.jsonl` record, resolved live per call, falling back
to `reviewer.auth`; `model` is a bare decision-model id, never a
`<provider>/<model>` chat ref (deliberately outside provider validation);
`model`/`baseUrl` are boot-captured, so changes require an approved restart.
This block has no Settings controls yet; file edits follow the bootstrap and
recovery validation policy in `DESIGN.md` → Config.

With neither block there is no client: the layer is off.

## Model evaluation

`bun scripts/system1-eval.ts [--runs N] [--only check] [--out file] [--stored] model ...`
runs labeled cases through each check's real questions and state shape,
with the backup off, and judges them at the score production acts on. The
decision model catalog is
`https://openrouter.ai/api/v1/models?output_modalities=decisions`.

The cases are synthetic and the labels hand-written, so results compare
models; they do not measure accuracy on live traffic. `--stored` adds
hand-labeled real turns and sends their text to the provider.

Results, 2026-11-06, 54 cases, 3 runs each, 252 judged answers:

| Model | Correct | Brier | Median | Cost per call |
|---|---:|---:|---:|---:|
| `perplexity/pplx-decider-v1.2` | 249 | 0.017 | 368 ms | $0.000008 |
| `cloudflare/clef` | 249 | 0.017 | 433 ms | $0.000103 |
| `baseten/mammoth-1` | 249 | 0.027 | 284 ms | $0.000043 |
| `liquid/d1-ultra` | 247 | 0.018 | 383 ms | $0.000017 |
| `typesafe/jev-1.14` | 246 | 0.045 | 359 ms | $0.000028 |
| `typesafe/jev-1.13` | 245 | 0.035 | 291 ms | $0.000028 |
| `liquid/d1.1` | 245 | 0.029 | 373 ms | $0.000008 |
| `microsoft/microsoft-decision-1` | 243 | 0.021 | 445 ms | $0.000015 |
| `inception/mercury-decide` | 242 | 0.034 | 323 ms | $0.000008 |

`inception/mercury-decide:free` is gone: the API answers 404 and names the
paid slug. The operator chose `perplexity/pplx-decider-v1.2` to replace it.
That model also scored 14/14 on the loop cases with `--stored`, which include
three hand-labeled real turns.

## Provenance

Git owns the sequence; this doc is the shared gate's one home.
