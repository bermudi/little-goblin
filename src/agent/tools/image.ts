// Image generation behind generate_image (design/tools.md → Image
// generation): the engine (src/agent/image.ts) owns the provider call;
// this layer owns the file boundary — durable attachment writes, then
// delivery. Saved bytes land in the attachments dir like intake media
// (one naming convention, already inside the model's readable world);
// Telegram delivery sends each as a photo preview, so the operator
// sees the result inline without a follow-up send_file call.

import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tool } from "ai";
import { z } from "zod";
import type { AuthStore } from "../../auth.ts";
import { imageSizeSchema, type ConfigRef } from "../../config.ts";
import { log } from "../../log.ts";
import { persistAttachment } from "../attachments.ts";
import { generateImages, IMAGE_MAX_N } from "../image.ts";
import { DeliveryUncertainError, type OutgoingFile } from "./send.ts";

export interface ImageToolDeps {
	configRef: ConfigRef;
	auth: AuthStore;
	/** Conversation id for the generation-call log lines. */
	conversation: string;
	/** Per-channel delivery (Telegram sends photos); absent on channels
	 *  without a file sink — the tool still saves and reports paths. */
	deliver?: ((file: OutgoingFile) => Promise<void>) | undefined;
	/** Test door over the provider edge. */
	fetchFn?: typeof fetch | undefined;
}

export const imageInputSchema = z.object({
	prompt: z
		.string()
		.min(1)
		.describe("What to generate — be specific about subject, style, composition"),
	size: imageSizeSchema
		.optional()
		.describe('Pixel dimensions "WxH" — defaults to the configured size, else the provider\'s'),
	n: z
		.number()
		.int()
		.min(1)
		.max(IMAGE_MAX_N)
		.optional()
		.describe(`How many images (1-${IMAGE_MAX_N}) — each is a separate billed generation`),
});

export function imageTool(deps: ImageToolDeps) {
	return tool({
		description: `Generate images with the configured image model. Saves to the workspace's attachment store and delivers inline where the channel supports it — otherwise the saved paths are the result; they work with vision (inspect a result) and send_file where it is mounted (resend it).`,
		inputSchema: imageInputSchema,
		execute: async ({ prompt, size, n }, options) => {
			let images;
			try {
				images = await generateImages(
					{ prompt, ...(size !== undefined ? { size } : {}), ...(n !== undefined ? { n } : {}) },
					{
						configRef: deps.configRef,
						auth: deps.auth,
						conversation: deps.conversation,
						// exactOptionalPropertyTypes: never assign an explicit
						// undefined to an optional field.
						...(options.abortSignal ? { signal: options.abortSignal } : {}),
						...(deps.fetchFn !== undefined ? { fetchFn: deps.fetchFn } : {}),
					},
				);
			} catch (err) {
				log.warn("generate_image failed", err, { conversation: deps.conversation });
				return { error: `image generation failed: ${String(err)}` };
			}
			const saved: {
				path: string;
				filename: string;
				bytes: number;
				mediaType: string;
				delivered: boolean;
				deliveryNote?: string;
			}[] = [];
			let delivered = 0;
			for (const [i, img] of images.entries()) {
				const filename = `image${images.length === 1 ? "" : `-${i + 1}`}.${img.ext}`;
				const { path, size: fileSize } = await persistAttachment(
					`img-${randomUUID()}`,
					filename,
					"image",
					async (temp) => {
						await writeFile(temp, img.bytes);
					},
				);
				// Delivery mirrors send_file's contract: an uncertain send is
				// reported, never silently retried — the saved path is the
				// fallback the model can hand the operator.
				let sent = false;
				let sendError: string | null = null;
				if (deps.deliver) {
					try {
						await deps.deliver({
							path,
							filename,
							caption: prompt.slice(0, 1024),
						});
						sent = true;
						delivered++;
					} catch (err) {
						sendError =
							err instanceof DeliveryUncertainError
								? "delivery uncertain — the image may have arrived; check Telegram before resending"
								: `delivery failed: ${String(err)}`;
						log.warn("generate_image delivery failed", err, { path });
					}
				}
				saved.push({
					path,
					filename,
					bytes: fileSize,
					mediaType: img.mediaType,
					delivered: sent,
					...(sendError !== null ? { deliveryNote: sendError } : {}),
				});
			}
			return {
				images: saved,
				model: deps.configRef.current.image?.model,
				delivered,
			};
		},
	});
}
