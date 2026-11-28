---
name: pass-cli
description: >
  Retrieve Proton Pass secrets or inject them into a command or config
  file with pass-cli — always through goblin's own scoped, audited agent
  session, never the operator's owner session.
license: Apache-2.0
metadata:
  topic: secrets
compatibility: Requires pass-cli, the goblin-task pass-keys profile for the task session, and an operator-provisioned goblin-dev agent; the bootstrap PAT lives in Secret Service/KWallet as goblin-dev, with per-item viewer grants (owner actions)
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
background pass-keys sync lane's). Never interleave calls within one
session. The operator provisions the OS-store bootstrap PAT named
`goblin-dev` through a process-only helper; never source a PAT env
file, print the PAT, or put it in argv/context. An expired task session
is renewed by `pass-keys login goblin-task`; a failed renewal goes to
the operator; never switch to the owner session.

Provider/MCP consumption is different: `pass-keys get`/`run` read local
encrypted snapshots with no Pass/network fallback. Do not use a snapshot
key to expose the bootstrap PAT or treat `pass-keys run` as a masked
`pass-cli run` replacement — it directly execs with child env keys.
Exports don't persist between bash calls — the guard rides in the same
shell as the command:

```bash
set +x
for name in "${!PROTON_PASS_@}"; do unset "$name" || exit 1; done
export PATH="$HOME/bin:$HOME/.local/bin:$PATH"
GOBLIN_HOME="${GOBLIN_HOME:-$HOME/goblin}"
export PROTON_PASS_SESSION_DIR="$GOBLIN_HOME/state/pass-cli-task"
# Tripwire: a symlink alias is still the owner's session directory.
[ "$(realpath -m "$PROTON_PASS_SESSION_DIR")" != "$(realpath -m "$HOME/.local/share/proton-pass-cli")" ] || {
  echo "refusing the owner session directory" >&2; exit 1; }
(umask 077; mkdir -p "$PROTON_PASS_SESSION_DIR")
info=$(pass-cli info 2>/dev/null) || info=
if ! printf '%s' "$info" | grep -Fq 'Personal Access Token' ||
   ! printf '%s' "$info" | grep -Fq '[Agent]'; then
  pass-keys login goblin-task
  info=$(pass-cli info 2>/dev/null) || info=
  if ! printf '%s' "$info" | grep -Fq 'Personal Access Token' ||
     ! printf '%s' "$info" | grep -Fq '[Agent]'; then
    echo "goblin's task session could not be renewed — tell the operator the pass-keys error above" >&2
    exit 1
  fi
fi
unset info
# Every call names its task in the audit trail: ≤300 chars, no secrets.
export PROTON_PASS_AGENT_REASON="task: <what you're doing>"
```

`info` must report both "Personal Access Token" and "[Agent]". Agent
sessions expire after about two hours; the guard renews the session
itself with `pass-keys login goblin-task`, which reads goblin's
bootstrap token inside pass-keys, so the token never reaches this
shell. A login error saying the token is invalid, expired or deleted
means the token is dead — tell the operator; never source a credential
file or display the token. A locked/unavailable wallet also needs
operator repair, not a plaintext-file fallback. NEVER fall back to the
owner session. OS-store encryption is not same-user isolation.

## Usage

```bash
export DEPLOY_TOKEN='pass://SHARE_ID/ITEM_ID/token'
pass-cli run -- bun scripts/release.ts        # masked; child-only value

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
operator exactly which item to grant to the `goblin-dev` agent (viewer).
The audit trail is `pass-cli agent monitor goblin-dev` — owner-side only;
you never run it.
