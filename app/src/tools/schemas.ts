// Wire narrowers for the bespoke tool renderers — the client's copy of
// each tool's contract, mirroring src/agent/tools/*.ts. Schemas require
// only the fields the UI reads: a payload that fails narrowing renders
// through the generic fallback, never a crash and never a blank.

import { z } from "zod";

// Every tool's structured refusal — `{error}` is a returned value, not a
// thrown one, so it arrives as output-available and must be handled as a
// normal (failed) output, distinct from the part's output-error state.
const toolError = z.object({ error: z.string() });

export const searchInputSchema = z.object({ query: z.string() });
export const searchOutputSchema = z.union([z.string(), toolError]);

export const fetchInputSchema = z.object({ url: z.string() });
export const fetchOutputSchema = z.union([
	z.string(),
	toolError.extend({ kind: z.string().optional() }),
	z.object({
		pdf: z.object({ path: z.string(), url: z.string(), size: z.number() }),
	}),
]);

export const bashInputSchema = z.object({ command: z.string() });
export const bashOutputSchema = z.union([
	z.object({
		exit_code: z.number().nullable(),
		output: z.string(),
		timed_out: z.boolean().optional(),
		truncated: z.boolean().optional(),
	}),
	toolError,
]);

export const readInputSchema = z.object({ path: z.string() });
export const readOutputSchema = z.union([
	z.object({ content: z.string(), lines: z.number(), shown: z.number() }),
	toolError,
]);

export const editInputSchema = z.object({
	path: z.string(),
	old_string: z.string(),
	new_string: z.string(),
	replace_all: z.boolean().optional(),
});
export const editOutputSchema = z.union([z.object({ replaced: z.number() }), toolError]);

export const writeInputSchema = z.object({ path: z.string(), content: z.string() });
export const writeOutputSchema = z.union([z.object({ bytes: z.number() }), toolError]);
