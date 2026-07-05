/**
 * ASR barrel. Provider-shaped surface; only Groq is implemented today.
 *
 * Callers (intake) use `transcribeWithGroq` and the `AsrInput`/`AsrResult`
 * types. The discriminated union keeps semantic content judgments (empty
 * transcript → "no speech detected") in the caller, not here.
 */
export { transcribeWithGroq } from "./groq.ts";
export type { AsrInput, AsrResult, AsrModel } from "./groq.ts";
