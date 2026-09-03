# Litespec limitations observed in little-goblin

Status: operational report, not a product contract or accepted decision  
Evidence window: issues #52 and #53  
Litespec version observed: `v2.0.0-beta.11.0.20260902020031-5fb67d146a8c`

## Executive summary

Litespec was useful. It kept work on owned branches, forced explicit contracts,
made evidence inspectable, and drove reviews that found real correctness and
safety bugs.

The same two issues also exposed a failure mode: an old receipt can be
re-evaluated against a later contract and become impossible to repair. Review
then cannot return `PASS`, even after the current contract, implementation,
tests, and fresh review are sound. The workflow offers no honest terminal state
except leaving the issue open forever or bypassing the gate manually.

The central improvement is to treat Litespec records as a versioned protocol,
not timeless Markdown. Historical records need explicit supersession and
quarantine semantics. Final approval also needs to be bound to the exact Git
commit being closed.

## What happened

At final closure:

- Issue #52 failed validation because five historical evidence comments were
  considered incomplete after their recorded `Verify` commands diverged from
  the amended current contract. A later re-plan marker therefore lacked the
  cycles it claimed.
- Issue #53 failed validation for the same reason on one historical
  completion-wake receipt.
- Later amendments and complete receipts could not supersede those historically
  incompatible interpretations.
- Both implementations eventually passed targeted independent review and
  typechecking. The combined final tree passed the full test suite, but neither
  issue could receive a formal Litespec `PASS`.
- Both issues were closed through an explicitly documented administrative
  exception. That was transparent, but it was outside the formal process.

This was not one isolated parser bug. It exposed gaps in protocol versioning,
migration, verification semantics, review-loop control, and closure authority.

## Findings

### 1. Historically valid evidence can become permanently fatal

**Severity:** Critical  
**Kind:** Storage-model and validator defect

The observed receipts contain the current required fields. They become
“incomplete” because validation checks their old `Verify` command against the
amended current contract. A later complete receipt does not supersede the
resulting error. Because the workflow treats comments as append-only, the
operator has no legal repair operation.

This combines the strictness of an immutable ledger with none of the normal
ledger repair mechanisms. Immutability is valuable only when corrective records
can change how prior records are interpreted.

**Improve it**

Give every receipt a stable ID and lifecycle:

```text
Receipt:
ID: <uuid>
Protocol: evidence/v2
Unit occurrence: 1
Unit heading: Completion wake delivery
Status: complete
```

Add append-only records such as:

```text
Quarantine legacy interpretation:
Receipt ID: <uuid-or-legacy-comment-id>
Reason: receipt cannot be replayed against its historical contract revision
Authorized by: <owner>
```

and:

```text
Supersedes:
Old receipt ID: <id>
New receipt ID: <id>
```

An unresolved current receipt should still block. A specifically quarantined
legacy interpretation should not. GitHub actor identity must be retained and
checked against repository-owned authorization policy; an `Authorized by:`
string is not itself authority.

### 2. Evidence and digest protocols are not versioned

**Severity:** Critical  
**Kind:** Compatibility defect

Old receipts are checked against the current receipt grammar, current `Verify`
command, and current digest algorithm. A later parser or contract-field change
can therefore invalidate evidence that was valid when recorded.

Digest amendments provide hash edges, but not the old canonical contract or the
algorithm that produced its hash.

**Improve it**

New records should include:

- `Protocol: evidence/vN`
- `Digest algorithm: unit-contract/vN`
- a canonical contract snapshot or content-addressed snapshot ID
- the validator version that accepted the record

Validate historical evidence with its recorded parser and contract snapshot,
then validate the amendment chain to the current revision. Treat existing
unversioned records as legacy v1 rather than silently reinterpreting them.

### 3. Mandatory red/green does not fit already-shipped outcomes

**Severity:** High  
**Kind:** Workflow-model limitation

Issue #53 contained a later unit whose behavior had already shipped as part of
an earlier unit. A behavioral pre-state could no longer be produced without
rewriting history. The unit was narrowed to a regression pin whose red state
was the absence of a named test.

That can be legitimate, but it proves test introduction rather than a product
behavior transition. Treating both as the same evidence class encourages
artificial `rg` checks that make the process green without strengthening the
behavioral claim.

**Improve it**

Declare the verification class in the unit:

- `behavior`: requires a failing behavioral pre-state and passing post-state
- `regression-pin`: requires baseline absence plus a test that exercises an
  already-shipped invariant
- `invariant`: supplemental static/property check; cannot complete a behavioral
  unit by itself

Current Litespec guidance rejects units whose outcomes overlap earlier units.
The observed repository had stale generated guidance, so the practical fix is
to enforce generator compatibility rather than add the rule again.

### 4. Review limits reset when the digest changes

**Severity:** Medium  
**Kind:** Scope-control limitation

The two-cycle rebuild limit is useful, but it is counted per contract digest.
Plan can amend the unit, create a new digest, and reset the loop. Repeated review
findings can therefore turn a bounded issue into an unbounded sequence of
amendments, verifier commits, rebuilds, and reviews.

#52 demonstrates the intentional per-digest reset, not an actually infinite
loop. The design still permits unbounded total churn in theory, so an
issue-level limit would make the stop condition explicit.

**Improve it**

Track both:

- rebuild count per digest
- total rebuild and amendment count per unit and issue

Every amendment should declare its impact:

- clarification
- verifier strengthening
- newly discovered behavior
- scope expansion

New behavior or repeated scope expansion should become a new unit or a separate
issue. Add an issue-level review budget that requires explicit human approval
to exceed.

### 5. Review evidence is not bound to the final commit

**Severity:** High  
**Kind:** Enforcement gap

The review skill asks reviewers to replay evidence at pre, post, and `HEAD`.
The closure comments recorded merged SHAs and targeted review results in prose,
but the validator cannot verify that attestation or prove that the reviewed SHA
is the remote commit being merged or closed.

Both observed branches received issue-owned fixes after their latest unit
receipts. The code was independently reviewed, but the public Litespec ledger
did not attest to the final merged commit.

**Improve it**

Add an authenticated, machine-readable final attestation:

```text
Closure attestation:
Issue: 53
Contract revision: <digest>
Reviewed HEAD: <full sha>
Validator: <version>
Validator result: pass
Verdict: PASS
```

It should include every unit identity and digest plus the replay status of each
exact `Verify`. Bind it to the remote branch or PR commit, not merely local
`HEAD`. A GitHub App or equivalent closure controller must verify the attested
remote SHA and actor before closing; a local command or status check alone
cannot prevent manual issue closure or later commits.

### 6. GitHub issue-body mutation is not transactional

**Severity:** Medium  
**Kind:** Authority and concurrency limitation

The issue body is mutable while amendments are separate comments. Updating the
body and writing its witness cannot be atomic. Markdown normalization, a
concurrent edit, or a crash between those operations can leave authority
ambiguous.

Current digests cover selected fields, not a durable canonical contract
revision that can be recovered independently.

**Improve it**

Make the issue body a projection of a content-addressed contract revision
stored in an explicit repository-owned contract store:

1. Create a canonical contract snapshot.
2. Record its revision ID and payload hash.
3. Reserve the transition in that store with compare-and-swap semantics.
4. Update the GitHub body and append an amendment referencing both revisions.
5. Re-fetch and verify the projection.
6. Mark the reserved transition committed, or visibly pending repair if the
   GitHub operations fail.

Retain digest-only amendments as legacy witnesses.

### 7. Administrative exceptions exist in practice but not in the model

**Severity:** Critical  
**Kind:** Missing escape hatch

When validation became irreparable, the only practical choices were indefinite
limbo or manual closure. Manual closure was documented, but Litespec has no
formal way to distinguish it from a normal validated close.

An escape hatch is not a weakening if it is rarer, louder, and more explicit
than an ad hoc bypass.

**Improve it**

Add an `ADMINISTRATIVE WAIVER` terminal state requiring:

- authenticated GitHub actor identity checked against repository policy
- exact validation failures being waived
- reason repair is impossible
- reviewed final SHA
- independent code-review result
- residual risk
- migration or follow-up plan

The issue and dashboard must display `WAIVED`, never `PASS`. The same GitHub App
or closure controller should block normal closure unless either a valid `PASS`
or an authorized waiver exists.

### 8. Generated skills and validator versions can drift

**Severity:** Medium  
**Kind:** Deployment limitation

The repository's checked-in skills, installed binary, and source-built
validator can describe different protocols. Operators may follow instructions
that the active validator interprets differently.

**Improve it**

- Stamp generated skills with generator and protocol versions.
- Make `litespec validate` fail early on incompatible skill versions.
- Add `litespec doctor` to report binary, generated-skill, schema, and protocol
  compatibility.
- Require `litespec update` as an explicit, reviewable migration rather than
  allowing silent mixed-version operation.

## Recommended roadmap

### Phase 1: Stop permanent ledger deadlocks

1. Add protocol/version fields to new records.
2. Add explicit legacy-comment quarantine and receipt supersession.
3. Add fixtures copied from the structures of #52 and #53.
4. Display administrative waivers distinctly from passes.

### Phase 2: Bind closure to reality

1. Add final remote-SHA-keyed review attestations.
2. Add `litespec close` as the client for an authenticated closure controller.
3. Use a GitHub App or equivalent controller to reject ordinary closure without
   a current attestation.

### Phase 3: Control review scope

1. Add verification classes.
2. Enforce generated-skill compatibility so the existing overlap check is
   present everywhere.
3. Track issue-wide amendment and rebuild budgets.
4. Require human approval before expanding beyond the original boundary.

### Phase 4: Make contracts durable records

1. Store content-addressed canonical contract revisions.
2. Make issue bodies projections.
3. Use optimistic concurrency for amendments.
4. Preserve legacy digest chains without rewriting history.

## What should remain

The improvements should not remove the parts that worked:

- one owned branch per shaped issue
- clean pre/post commits
- exact verification commands
- append-only audit records
- independent review
- explicit contract amendments
- fail-loud boundary checks

The goal is not to make Litespec less strict. It is to make strictness
recoverable, versioned, bounded, and tied to the code actually being closed.
