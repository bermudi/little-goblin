# Scouting

Read this only when inspection and discussion cannot resolve consequential uncertainty. Scouting is human-present and begins read-only.

State the question and the observation that would answer it. Then build the cheapest runnable experiment capable of producing that observation: for example, a UI interaction, integration-seam probe, or small state machine.

Bound and sandbox external effects and real data. Isolate throwaway edits in a disposable worktree or branch when they should not enter the change. Omitted production concerns remain unproven.

React to the running artifact while the human is present. Treat prototype code as evidence, not authority: extract the clarified outcome and accepted rulings, then discard it. Code intended to remain is implementation and needs normal testing and verification through `nospec-carve`.

Return the actual problem, evidence, constraints, and next action—which may be implementation, further shaping, a decision request, or no change.
