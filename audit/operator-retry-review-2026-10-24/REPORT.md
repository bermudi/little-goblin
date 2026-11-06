# Operator retry review — 2026-10-24

## Findings

1. **Blocking: live instructions contradict the available Herdr tools.**
   Live `skills/herdr/SKILL.md` v2.1 tells Goblin to drive operator panes
   through raw CLI. The repo seed v2.2, system-prompt builder, and guarded
   tool say the opposite. `proxy-operator` and AGENTS additionally instruct
   CLI workspace creation and stop/resume migration. Current `herdr` exposes
   only list/read/prompt; `delegate` creates ordinary workspaces, not native
   Herdr worktrees. A better model cannot follow all those instructions.
   Evidence: `deploy/skills/herdr/SKILL.md:23–33,88–111`;
   `src/agent/prompt.ts:304–331`; `src/agent/tools/herdr.ts:13–27,75–80`;
   `src/delegation-lifecycle.ts:572`.

2. **High: staffing policy overstates operator permission.**
   USER.md says installed harnesses are already approved choices. The
   subsequent operator correction explicitly explained quotas/promos and
   selected pi+glm-5.3 for that round. The live proxy skill hard-codes that
   menu and treats promotion inference as generally available. `delegate`
   has no per-call model/args field: switching the coordinator's model is
   not a worker-model switch. Drafts require an applicable explicit choice
   and verification of configured workers, without repeatedly asking for
   a choice already supplied. Evidence: conversation user turns 34/36;
   `src/agent/tools/delegate.ts:201–209,297–340`.

3. **High: remembered verification is false, and gate wording is weak.**
   AGENTS says both branches merged "after clean verification." The recorded
   tool sequence merged --model with only builder checks; the independent
   verifier was for /commands. The skill's categorical "pre-existing
   failures don't block" also conflates baseline failure with evidence
   sufficient to verify the changed behavior. Drafts label the historical
   evidence accurately and tie verification to the candidate SHA and task.
   Evidence: conversation assistant turns 49/54 and their recorded calls.

4. **High: visibility migration destroys a working result path.**
   The live skill normalizes starting in goblin, stopping the delegation,
   resuming in default, and promising polling. That loses the delegation
   watcher and can lose correct launch cwd. It is not necessary to watch a
   goblin delegation. Project handover has a newer responsibility mechanism,
   but it is conditional on project context/tool availability; the original
   captured tool inventory did not include it. Drafts separate managed
   delegation, bare operator panes, and project-managed handover.
   Evidence: `design/delegation.md`; `src/agent/tools/responsibility.ts`;
   `src/agent/tools/delegate.ts`; original conversation capture.

5. **High: stop instructions claim a capability prose cannot provide.**
   talk-first says "the moment" input arrives, no more tools, and the
   proposed draft both forbids tools and suggests killing a task. A typed
   message is steering at a model-call boundary, not an out-of-band abort.
   The app Stop button POSTs cancellation; runtime aborts/fences its own
   turn, not external workers. The model must obey STOP when received, but
   the skill cannot preempt a call or prove worker termination. Exact
   handling of the historical STOP incident remains unverified.
   Evidence: `DESIGN.md` Turn/authority sections; `src/runtime.ts:459–510`;
   `src/http/app-conversations.ts:1063–1077`; `app/src/ChatView.tsx:2956–2963`.

6. **High: proposals amplify speculation and contain unsafe evidence recipes.**
   Proposed proxy v1.2 turns missing information into a definitive incident
   story and compares Git path strings without canonicalizing them. Proposed
   Herdr v2.2 treats session commands/process output as ground truth for all
   activity and excuses a failed grep. A command string establishes intent,
   not successful execution; snapshots do not prove a checkout was never
   modified. Broad transcript/process-argument inspection can expose secrets.
   Do not approve those proposals wholesale. Drafts require bounded evidence,
   honest uncertainty, canonical Git paths, and no raw CLI workaround.

7. **Medium: cleanup and memory edits become unauthorized follow-on work.**
   The live proxy says to let panes go and remove dead worktrees; AGENTS
   demands same-turn skill edits without waiting for review. Those directions
   encourage closing resources and writing lessons even when the operator
   wants inspection or answers only. Drafts separate completion, cleanup,
   publication, and STOP. The essential invariants also appear in always-loaded
   AGENTS rather than relying solely on probabilistic skill selection.

8. **Medium: stale files and frozen prompts contaminate a model comparison.**
   The old workflow is marked superseded but still has executable-looking
   procedures and in-flight claims. Leave it historical, not active guidance.
   Pending proposals can also overwrite intended corrections if approved later.
   System guidance/catalog snapshots refresh at conversation boundaries;
   editing files or changing models alone does not establish a fresh snapshot.
   Use a new conversation and explicitly invoke reviewed skills for the retry.
   Evidence: `src/agent/prompt.ts:1–6,220–245`; `design/skills.md` Invocation
   and reviewer sections; live historical workflow.

## Prepared, not installed

- `skills/proxy-operator/SKILL.md`: coordination procedure; explicit authority;
  supported routes; pre-dispatch isolation; commit-specific evidence; no
  migration trick, unattended-polling promise, or implicit cleanup.
- `skills/herdr/SKILL.md`: matches current tool boundaries and distinguishes
  delegation results from project observation and bare pane status.
- `skills/talk-first/SKILL.md`: answer-only behavior without fabricated state
  or impossible cancellation promises.
- `workspace/AGENTS.md`: corrected notes plus always-loaded invariants;
  7,934 characters (under the draft's 8,000-character target).
- `workspace/USER.md`: narrowly corrected staffing/allowance entry; other
  preference entries preserved. In particular, the broad XY-question rule
  was not used as permission to reopen the settled product direction.
- `workspace-changes.diff`: exact memory-file changes for review.
- `baseline.json`: hashes of the inspected live files/proposals/workflow.
- `RETRY.md`: model-neutral preflight and behavioral checks.

No live workspace files, proposals, model choices, config, source, panes,
workers, worktrees, or services were modified. No deployment, model call,
Herdr probe, build, push, or merge was performed. Existing untracked audit
work was preserved. The draft does not implement missing lifecycle tools.

## Verification performed

- `skills-ref validate` passed for all three draft skills.
- Goblin's actual `loadCatalog` accepted all three; zero skipped entries.
- 146 tests passed across delegate/herdr/responsibility tools, skill catalog,
  and prompt assembly; zero failures.
- 31 selected stop/cancel/steer tests passed across runtime, conversation HTTP,
  and app ChatView; 186 tests filtered out; zero failures.
- Test outputs: `/tmp/goblin-operator-review-tests.log` and
  `/tmp/goblin-operator-review-cancel-tests.log` (temporary local evidence).

These are schema/contract tests with test fixtures, not a live Herdr drift
check, deployed-version verification, model compliance test, full test suite,
or proof that STOP cancels external workers. No new model was selected.

## Before retry

Approve the draft instructions before publishing them. Recheck baseline
hashes to avoid overwriting later edits. Do not blindly approve the older
reviewer-owned proposals; decide separately whether to discard or revise
them. Do not hand-edit the reviewer-owned pending drafts.

Start a fresh conversation with an operator-selected coordinator model.
Keep the worker setup fixed and explicitly authorized if the comparison is
about coordinator quality. Confirm the execution topology before dispatch:

- **Supported now:** new managed worker in a verified Git worktree through
  delegate, watchable by attaching to goblin; or existing default-session
  agents handed over in a project exposing responsibility tools.
- **Still a capability gap:** creating new named native Herdr worktree
  workspaces in default through the current guarded tool. If that remains
  mandatory, scope tooling work separately or have the operator prepare
  those resources. Do not silently switch topology to make a retry pass.

Changing both the model and instructions tests the revised setup, not the
isolated causal effect of the model. For a subsequent model comparison,
hold this reviewed instruction set and the task/worker setup constant.
