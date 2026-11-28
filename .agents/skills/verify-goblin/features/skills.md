# Skills

## Sub-features

Browse installed skills and pending proposals in the Skills page. Explicitly
invoke a catalog skill from the chat composer; the selected skill body is
injected into that turn and the invocation is stored on the user message.
The skill reviewer drafts skills after a turn.

## How to get to it (user POV)

- **Browse:** Goblin's profile → Skills. Proposed skills appear before installed ones.
- **Discard:** Skills page → a proposed skill → **Discard**. Also from
  **Needs you**, which opens the same page.
- **Invoke:** Chat composer → **Invoke a skill** → select a catalog entry →
  send a message. On phone widths, **Invoke a skill** is an item in the
  composer's **Add** menu, beside **Attach a file** and **Attach a note**.

Skills are directories under `workspace/skills/` with a `SKILL.md` file.
Goblin's seed includes built-in skills; the following small fixture gives a
stable row to select on a throwaway instance:

```sh
mkdir -p "$HOME_DIR/workspace/skills/verify-example"
cat > "$HOME_DIR/workspace/skills/verify-example/SKILL.md" <<'EOF'
---
name: verify-example
description: A throwaway skill for verifying catalog invocation.
---

# Verify example

When invoked, include the marker `verify-skill-body-loaded` in your response.
EOF
```

## Driving it with agent-browser

Set `URL` to the instance URL printed by `bun run try` (it already ends in `/app/`):

```sh
agent-browser --session verify-skills open "${URL}skills"
agent-browser --session verify-skills wait --text 'verify-example'
agent-browser --session verify-skills find role button click --name 'New side chat'
agent-browser --session verify-skills fill '[aria-label="Message draft"]' 'Use the skill for this turn.'
agent-browser --session verify-skills find role button click --name 'Invoke a skill'
agent-browser --session verify-skills find text 'verify-example' click
agent-browser --session verify-skills find role button click --name 'Send'
agent-browser --session verify-skills wait --text 'verify-reply: Use the skill for this turn.'
```

The fake reply will not follow the skill's instruction. Prove the invocation
instead from the durable user event and the log:

```sh
sqlite3 -readonly "$HOME_DIR/state/goblin.sqlite" \
  "select seq, json_extract(p.value,'$.data.name') as skill
   from events, json_each(json_extract(events.data,'$.message.parts')) p
   where role='user' and json_extract(p.value,'$.type')='data-skill';"
rg '"msg":"skill body injected"' "$HOME_DIR/state/goblin.log"
```

Expected: a user event part with `type` `data-skill` and `data.name`
`verify-example`; a `skill body injected` log line with the same skill name.
The assistant transcript includes the `[skill: verify-example]` marker.

## Discarding a proposal

Stage a draft on the instance, then discard it from the Skills page:

```sh
D="$HOME_DIR/workspace/skills-proposed/weather-demo"
mkdir -p "$D"
printf -- '---\nname: weather-demo\ndescription: demo\n---\n\nSay hi.\n' > "$D/SKILL.md"
agent-browser --session verify-skills open "${URL}skills"
agent-browser --session verify-skills wait --text 'weather-demo'
agent-browser --session verify-skills find role button click --name 'Discard'
agent-browser --session verify-skills wait 1000
find "$HOME_DIR/workspace/skills-proposed" "$HOME_DIR/workspace/skills-discarded" -name SKILL.md
rg '"msg":"skill proposal discarded"' "$HOME_DIR/state/goblin.log"
```

Expected: the card is gone without a prompt. The draft is unchanged at
`skills-discarded/weather-demo.<timestamp>/SKILL.md`, and the log line names
that folder in `keptAs`.

## Reviewing a turn into a skill

Start the instance with the skill reviewer on. A marker in a message makes the
scripted models review that turn: `[review <new|edit|both> <score|down>]`. The
score answers "will the operator need this again?"; `down` fails that question.
`edit` writes `verify-example`, so make that fixture first (above).

```sh
URL=$(GOBLIN_TRY_REVIEWER=1 bun run --silent try verify-review)
HOME_DIR=/tmp/goblin-verify/verify-review
ab() { agent-browser --session verify-review "$@"; }
ab open "$URL"
ab click 'button[aria-label="New chat"]'
ab fill '[aria-label="Message draft"]' '[review new 0.41]'
ab click 'button[aria-label="Send"]'
ab wait --text 'verify-reply: [review new 0.41]'
ab wait 3000
rg '"msg":"reviewer (gate|reuse|review done)"' "$HOME_DIR/state/goblin.log"
ls "$HOME_DIR/workspace/skills-proposed"
```

Expected: one `reviewer reuse` line with `reuse` 0.41, `threshold` 0.6 and
`held` true; no proposal, and nothing about one in the chat list. Repeat with:

- `[review new 0.9]` or `[review new 0.6]`: proposed; the chat's row in the
  chat list shows `proposed skill: verify-review-new`.
- `[review edit 0.1]`: proposed, and no `reviewer reuse` line.
- `[review both 0.1]`: only `verify-example` is proposed.
- `[review new down]`: proposed; the line has `fallback` true and no score.

Discard `verify-review-new` between runs: an edit of a pending draft is not a
new skill, so the question is not asked.

## Gotchas

The Skills page displays the installed catalog and proposals; it is not a
skill editor. This feature means Agent Skills (`SKILL.md` directories), not
the app's **Skills** test-map or generic agent capabilities.

The fixture is throwaway state, not a repository or production skill. The
fake model lets you prove the picker, stored part, and body injection, but
cannot prove that a real model follows the skill. Temporary GitHub skills
use a separate preview-and-confirm flow and need a reachable public GitHub
URL plus the System One gate; this map covers an installed catalog skill.
