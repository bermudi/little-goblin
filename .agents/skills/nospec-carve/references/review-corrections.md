# Review corrections

Read this only when directly applying accepted review findings. Batch conversion of `REVIEW.md` into queue units belongs to `nospec-shape`.

Read each finding's cited evidence and surrounding code before editing. Confirm the violated invariant rather than patching only the symptom. If evidence contradicts the classification, say so; do not blindly implement it.

Apply actionable findings and verify the correction. Trivial polish is optional; disputed, deferred, and speculative findings are not implementation instructions. Preserve behavior already approved and add a regression check where practical.

A finding that requires choosing among architectural directions is not fix-ready. Ask the decision owner or block the batch cycle instead of inventing a ruling. A broad rewrite is new shaping work, not a correction.
