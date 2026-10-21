// The artifact wire contract, shared server ↔ app: where the bytes
// came from (source), what was durably stored (artifact), and what a
// script collected from a nested publication (presentation). Leaf-level
// like ui-schema.ts — zod only, so the client program can import it.

import { z } from "zod";

/** Locates the mutable source bytes. "workspace" resolves inside the
 *  conversation's working directory (realpath containment — absolute
 *  paths that land outside are refused); "sandbox" reads a regular file
 *  out of the conversation's container. */
export const fileSourceSchema = z.object({
	target: z.enum(["workspace", "sandbox"]),
	path: z.string().min(1).max(4096),
});
export type FileSource = z.infer<typeof fileSourceSchema>;

/** The immutable published copy: bytes in the attachment store (served
 *  to the app by basename under /api/app/attachments/), metadata on the
 *  wire. Editing or deleting the source never rewrites a published
 *  artifact — history shows the snapshot, not the file's future. */
export const artifactSchema = z.object({
	// The attachment store path; the app uses its basename.
	path: z.string(),
	name: z.string(),
	title: z.string().optional(),
	mediaType: z.string(),
	size: z.number(),
	source: fileSourceSchema,
});
export type Artifact = z.infer<typeof artifactSchema>;

/** A nested publication collected by script — `call` is the stable
 *  child call id (`<scriptCallId>/<n>`), so the card keeps its identity
 *  across reconnect and reload. */
export const artifactPresentationSchema = z.object({
	call: z.string(),
	artifact: artifactSchema,
});
export type ArtifactPresentation = z.infer<typeof artifactPresentationSchema>;

/** Narrows a tool output to its artifact, for both the direct `artifact`
 *  result ({artifact}) and anything that embeds one. */
export function artifactOf(output: unknown): Artifact | null {
	const candidate =
		typeof output === "object" && output !== null
			? (output as { artifact?: unknown }).artifact
			: undefined;
	const parsed = artifactSchema.safeParse(candidate);
	return parsed.success ? parsed.data : null;
}

/** Narrows a script tool output to its collected presentations. */
export function presentationsOf(output: unknown): ArtifactPresentation[] {
	const candidate =
		typeof output === "object" && output !== null
			? (output as { presentations?: unknown }).presentations
			: undefined;
	const parsed = z.array(artifactPresentationSchema).safeParse(candidate);
	return parsed.success ? parsed.data : [];
}
