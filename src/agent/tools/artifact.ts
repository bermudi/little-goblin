// The presentation seam: publish a workspace or sandbox file as an
// immutable artifact the app renders as a card — markdown, self-contained
// HTML, images, audio and video open in the app's reader, everything
// else downloads. The model keeps a small reference; the bytes travel
// file → attachment store → HTTP → render, never through context.
// App-channel only (mounted like ui); script-callable, which is what
// makes composition end in a card without a second model pass.

import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { tool } from "ai";
import type { LanguageModelV4ToolResultOutput } from "@ai-sdk/provider";
import { z } from "zod";
import { persistAttachment } from "../attachments.ts";
import { readWorkspaceFile, WORKSPACE_READ_MAX_BYTES } from "../../box-files.ts";
import { log } from "../../log.ts";
import { PodmanError } from "../../podman.ts";
import { SandboxError, type Sandboxes } from "../../sandboxes.ts";
import { type Artifact, artifactOf, fileSourceSchema } from "./artifact-schema.ts";

// The app byte budget, shared with the workspace reader — an artifact's
// whole point is being opened in the app.
export const ARTIFACT_MAX_BYTES = WORKSPACE_READ_MAX_BYTES;

export interface ArtifactToolDeps {
	conversation: string;
	workspace: string;
	// Absent when the sandbox feature is off — sandbox sources then
	// refuse cleanly instead of failing deep in podman.
	sandboxes?: Sandboxes | undefined;
}

const inputSchema = z.object({
	source: fileSourceSchema,
	title: z.string().min(1).max(200).optional(),
});

export const artifactTool = (deps: ArtifactToolDeps) =>
	tool({
		description: `Publish a file as a durable artifact card in the goblin app — markdown, self-contained HTML, images, audio and video open in the app's reader; other file types become downloads. The card is an immutable snapshot: editing or deleting the source afterwards does not rewrite it, and the file's bytes never enter your context. Use it when the operator should read, play, or keep generated work — a document, a report, a demo — not for files that only matter to you. source.target "workspace" resolves the path inside this conversation's working directory; "sandbox" reads a regular file straight out of the container, like sandbox export without landing it in the workspace first.`,
		inputSchema,
		toModelOutput: ({ output }): LanguageModelV4ToolResultOutput => {
			const a = artifactOf(output);
			if (a !== null) {
				return {
					type: "text",
					value: `published "${a.title ?? a.name}" — ${a.name}, ${a.mediaType}, ${a.size} bytes`,
				};
			}
			const err =
				typeof output === "object" && output !== null
					? (output as { error?: unknown }).error
					: undefined;
			return { type: "text", value: typeof err === "string" ? err : "artifact failed" };
		},
		execute: async (input, { abortSignal }): Promise<{ artifact: Artifact } | { error: string }> => {
			let data: Uint8Array;
			if (input.source.target === "workspace") {
				const r = readWorkspaceFile(deps.workspace, input.source.path, ARTIFACT_MAX_BYTES);
				if ("error" in r) return { error: r.error };
				data = r.data;
			} else {
				const sandboxes = deps.sandboxes;
				if (sandboxes === undefined) return { error: "sandbox is not configured" };
				try {
					const out = await sandboxes.catFile(deps.conversation, input.source.path, {
						...(abortSignal !== undefined ? { abortSignal } : {}),
					});
					data = out.data;
				} catch (err) {
					if (err instanceof SandboxError || err instanceof PodmanError) {
						return { error: err.message };
					}
					throw err;
				}
				if (data.byteLength > ARTIFACT_MAX_BYTES) {
					return {
						error: `refused: ${input.source.path} exceeds the ${ARTIFACT_MAX_BYTES / (1024 * 1024)} MiB artifact cap`,
					};
				}
			}
			abortSignal?.throwIfAborted();
			const name = basename(input.source.path);
			const saved = await persistAttachment(
				`artifact-${randomUUID()}`,
				name,
				"artifact",
				async (temp) => {
					await Bun.write(temp, data);
				},
			);
			const mediaType = Bun.file(saved.path).type || "application/octet-stream";
			const artifact: Artifact = {
				path: saved.path,
				name,
				...(input.title !== undefined ? { title: input.title } : {}),
				mediaType,
				size: saved.size,
				source: input.source,
			};
			log.info("artifact published", {
				conversation: deps.conversation,
				name: artifact.name,
				mediaType: artifact.mediaType,
				size: artifact.size,
				target: input.source.target,
			});
			return { artifact };
		},
	});
