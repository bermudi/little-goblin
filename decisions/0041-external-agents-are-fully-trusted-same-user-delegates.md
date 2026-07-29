---
nospec: true
id: 0041
date: 2026-07-28
status: accepted
spine: false
amends: [0036]
---

# 0041: External Agents Are Fully Trusted Same-User Delegates

## Context

The quarantined external-agent security proposal treated project CWD, a narrow argument surface, and read-only or workspace-write profiles as confinement. That posture does not match Goblin's trust model. The main Goblin model already acts with the operator's Unix-user authority, including an unrestricted shell, and external coding agents are delegated instances of that same trusted operator authority.

A project working directory and provider permission mode may reduce accidents, but neither confines a same-user child process. The child can address any path and credential store available to the Unix user. Pretending otherwise creates a decorative security boundary while making legitimate unattended delegation harder.

Goblin's own Telegram and model-provider secrets are a separate operational concern. Provider CLIs normally authenticate through their own user-scoped credential stores; ambient inheritance of Goblin's process environment would unnecessarily duplicate credentials into child environments.

## Decision

Goblin's main model and the external agents it spawns SHALL be treated as fully trusted delegates within the authority of the Unix user running Goblin. The same-user operating-system boundary is the explicit security floor. Goblin SHALL NOT claim project-root, working-directory, adapter, permission-profile, or protocol controls as confinement against an external agent.

The model MAY select an external agent's working directory, invocation parameters, and permission profile. Supported profiles SHALL include an unattended dangerous profile that permits the configured backend to act without interactive approval. These selections remain structured external-agent inputs and SHALL be captured with the delegated-run record so the actual execution context is observable. This ruling does not decide whether backend executable selection or explicit child-environment overrides become model-facing.

Goblin SHALL NOT inject its own ambient process secrets into external-agent child environments by default. In particular, Telegram credentials and Goblin's model-provider credentials SHALL not be inherited merely because they exist in `process.env`. External CLIs authenticate through their own same-user credential stores. This default reduces accidental secret duplication; it is not a security boundary, because a fully trusted same-user child may access any file or credential store available to that user. Any future explicit credential forwarding must be deliberate rather than ambient parent-environment inheritance.

For external-agent runs, this decision amends decision 0036's statement that the captured Execution Environment bounds filesystem and project authority. An external-agent run still captures its owner Conversation, origin Surface, lifetime, and Conversation Execution Environment for provenance, routing, and default context, but its model-selected working directory and invocation may operate outside that environment. Decision 0032 continues to govern the main Conversation runtime and pi history; it is not amended.

## Consequences

External agents can work across repositories, choose backend options appropriate to the task, and run unattended when the model selects the dangerous profile. The implementation must replace the current fixed project-directory tool input and two-profile schema with explicit model-facing launch choices, validate their structure, and record the selected context without presenting validation as confinement.

A malicious or mistaken prompt can cause an external agent to read, modify, or delete any data accessible to the Goblin Unix user, including Goblin state, unrelated repositories, and CLI credential stores. Operators requiring stronger isolation must supply it below Goblin with a separate Unix account, container, VM, or other OS sandbox; Goblin does not provide that isolation.

Excluding ambient Goblin secrets remains useful defense against accidental propagation, but it cannot support a claim that the child is untrusted. Permission prompts and provider sandboxes may remain backend affordances, not Goblin's security floor.
