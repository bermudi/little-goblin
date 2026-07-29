# Review loop

Read this only with `nospec run --review`.

After build units drain, the runner invokes a `nospec-trial` reviewer to write `REVIEW.md` and reads only its `- actionable: N` signal. Zero ends cleanly. A nonzero count invokes a restricted `nospec-shape` fixer, which appends one pending queue unit per coherent actionable finding without editing source. Subsequent `nospec-carve` workers implement those units before review repeats.

Review/fix rounds and worker ticks are bounded. Malformed review output, no appended units despite actionable findings, exhausted bounds, or remaining actionable state produces a non-clean handoff. Rerunning without `--review` cannot launder existing review debt into success.

`LOOP_REVIEW_CMD` and `LOOP_FIX_CMD` may select agents distinct from `LOOP_AGENT_CMD`. The loop owns invocation and stop conditions; Trial owns findings, Shape owns work-unit generation, and Carve owns source correction.
