# Review findings to queue units

Read this only when the loop invokes Shape as its fixer. Do not edit source, `REVIEW.md`, `EVIDENCE.md`, existing units, or statuses.

Append one `Status: pending` unit per coherent actionable finding. Do not queue trivial, disputed, deferred, or speculative findings. If evidence contradicts a classification, report that instead of blindly queueing it. A finding requiring a new architectural direction is a blocker, not a fix unit.

Each appended unit should cite the finding and evidence in `Read first:`, preserve applicable queue and design constraints, include a no-regression acceptance criterion, and verify both the correction and previously approved behavior where practical.

Do not reorder or rewrite existing units. Append nothing when no actionable finding remains. Stop after the queue edit and report classification and appended-unit counts; the runner owns orchestration and preflight.
