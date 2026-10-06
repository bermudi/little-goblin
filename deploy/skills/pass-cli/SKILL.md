---
name: pass-cli
description: >
  Retrieve Proton Pass secrets or inject them into a command or config
  file with pass-cli — always through goblin's own scoped, audited agent
  session, never the operator's owner session.
license: Apache-2.0
metadata:
  topic: secrets
compatibility: Requires the pass-cli CLI plus goblin's agent token, provisioned by the operator at $GOBLIN_HOME/pass-cli.env (pass-cli agent create goblin + per-item viewer grants — both owner actions)
---

# pass-cli — Proton Pass secrets during tasks

Use a secret by the least-exposing route. This skill covers finding an
accessible item, passing a secret to a process, rendering a requested
config file, or reading a TOTP code. It never administers vaults,
shares, agents, or grants — those are owner actions.

| Need | Route |
| --- | --- |
| A program needs a secret, you don't | `pass-cli run` with `pass://` refs — output masked, value reaches the child only |
| A requested config artifact needs a secret | `pass-cli inject` to an explicit path (default 0600) |
| An interactive login needs a one-time code | `pass-cli item totp` — the only value allowed into context; it dies in seconds |
| Find what's accessible | `pass-cli vault list`, `item list --output json` — metadata only |

Never `item view` (it prints values — once a secret enters context it
has leaked), never `--no-masking`, never item/vault/agent/share writes.
If a task seems to need a value in context, restructure so the consuming
process reads it (`run`/`inject`); if impossible, ask the operator to
retrieve it himself.

## The session guard — mandatory before every call

Unguarded, `pass-cli` resolves to the operator's owner session
(`~/.local/share/proton-pass-cli`): full account, no audit trail.
Every call runs as goblin's own agent token in its OWN session dir —
`$GOBLIN_HOME/state/pass-cli-task`, NOT `state/pass-cli` (that one is the
pass-keys lane's; a task session must never interleave with cache warms).
Exports don't persist between bash calls — the guard rides in the same
shell as the command:

```bash
GOBLIN_HOME="${GOBLIN_HOME:-$HOME/goblin}"
export PROTON_PASS_SESSION_DIR="$GOBLIN_HOME/state/pass-cli-task"
# Tripwire: never the owner's session directory.
[ "$PROTON_PASS_SESSION_DIR" != "$HOME/.local/share/proton-pass-cli" ] || {
  echo "refusing the owner session directory" >&2; exit 1; }
(umask 077; mkdir -p "$PROTON_PASS_SESSION_DIR")
if ! pass-cli info 2>/dev/null | grep -q 'Personal Access Token'; then
  [ -r "$GOBLIN_HOME/pass-cli.env" ] || {
    echo "goblin's agent token is not provisioned — ask the operator to write $GOBLIN_HOME/pass-cli.env" >&2
    exit 1; }
  . "$GOBLIN_HOME/pass-cli.env"   # owner-written; never print or inspect it
  : "${PROTON_PASS_PAT:?pass-cli.env lacks PROTON_PASS_PAT}"
  pass-cli logout --force 2>/dev/null || true   # drops a stale AGENT session only
  PROTON_PASS_PERSONAL_ACCESS_TOKEN="$PROTON_PASS_PAT" pass-cli login || exit 1
  unset PROTON_PASS_PAT PROTON_PASS_PERSONAL_ACCESS_TOKEN
fi
# Every call names its task in the audit trail: ≤300 chars, no secrets.
export PROTON_PASS_AGENT_REASON="task: <what you're doing>"
```

`info` reporting "Personal Access Token" is the authentication check —
agent sessions expire (~2h), so re-login is routine. A login failure of
`invalid, expired or has been deleted` means goblin's token is dead:
tell the operator to renew `pass-cli.env`. NEVER fall back to the owner
session.

## Usage

```bash
export DEPLOY_TOKEN='pass://SHARE_ID/ITEM_ID/token'
pass-cli run -- ./deploy.sh                     # masked; child-only value

pass-cli run --env-file .env.secrets -- ./cmd   # refs in a gitignored file

pass-cli inject --in-file tpl.yaml --out-file .runtime/cfg.yaml
# inject only to an explicit path the task asked for, and --force only
# with the operator's explicit OK for that file. Treat output as secret.

pass-cli vault list --output json
pass-cli item list --vault-name "Vault" --output json   # metadata only
pass-cli item totp --share-id ID --item-id ID            # needs the reason
```

`--show-secrets` is refused in agent sessions — don't work around it.
Item-not-found or permission errors mean missing access: tell the
operator exactly which item to grant to the `goblin` agent (viewer).
The audit trail is `pass-cli agent monitor goblin` — owner-side only;
you never run it.
