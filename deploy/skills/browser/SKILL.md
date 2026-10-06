---
name: browser
description: >
  Real browser automation for pages the fetch tool can't handle —
  JavaScript-heavy apps, login walls behind cookies, anything that needs
  clicking or forms. Drives the agent-browser CLI (Rust, CDP,
  accessibility-tree snapshots with @eN element refs) through bash.
license: Apache-2.0
metadata:
  version: "1.0"
  topic: browser-automation
compatibility: Requires the agent-browser CLI and a Chrome/Chromium binary; if the CLI is missing (e.g. a rebuilt box), restore it with npm i -g agent-browser && agent-browser install
allowed-tools:
  - Bash(agent-browser:*)
---

# browser

Headless Chrome, driven through the `agent-browser` CLI via bash. This
file is a discovery stub, not the usage guide — the CLI serves its own
version-matched instructions:

```bash
agent-browser skills get core        # workflows, patterns, troubleshooting
agent-browser skills get core --full # + full command reference
```

Read that before the first `agent-browser` command in a task. If
`skills get` is unavailable on the installed version, fall back to
`agent-browser --help` and `agent-browser snapshot --help`.

## If the CLI is missing

`agent-browser: command not found` means the capability is down, not
gone — a rebuilt box or fresh install just needs it back:

```bash
npm i -g agent-browser && agent-browser install
```

`install` fetches the version-matched skills docs; the CLI manages its
own Chromium, so nothing else is needed. The operator doesn't need to
be involved unless the install fails.

## Modes on this machine

**Default — headless managed Chrome.** Plain `agent-browser <command>`;
the CLI manages its own headless Chromium. Use this for everything
public: scraping, testing, form-filling, screenshots. Never pass
`--headed` — this box has no display. Managed Chrome trips Cloudflare
regardless of flags; don't point it at the operator's personal accounts.

**Operator's browser — attach-only, only when he starts it.** For pages
needing his real session (personal accounts, Cloudflare-protected
services), the browser is his: he launches it with remote debugging, he
closes it. Attach, work in your own tab, clean up, get out:

```bash
export AGENT_BROWSER_CDP=9222 AGENT_BROWSER_PIN_TAB=1
```

- `--pin-tab` is not optional: it opens a fresh tab instead of adopting
  his active one, and a lost binding fails with `tab_gone` instead of
  silently acting on his other tabs.
- Never `close`, `quit`, or `close --all` in this mode. Close only tabs
  you opened.
- Never read credentials — not from password managers, not from filled
  login fields, not via eval or screenshots. The operator's autofill
  handles logins; you may click, never extract.
- Nothing listening on 9222? Don't launch anything — say so and wait.

## When to use what

- Server-rendered pages, docs, articles → `fetch` tool (cheaper, faster).
- Search first (`search` tool), then `fetch` the result URLs; reach for
  the browser only when fetch returns a JS-shell/empty-extraction note,
  or the task needs interaction.
- Results you want to keep quoting belong in files (`write_file`) —
  browser sessions are ephemeral.
