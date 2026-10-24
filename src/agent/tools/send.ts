import { statSync } from "node:fs";
import { basename } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { log } from "../../log.ts";
import { resolvePath, unicodeTwin } from "./paths.ts";

export const MAX_SEND_BYTES = 2 * 1024 * 1024 * 1024;

export interface OutgoingFile {
	path: string;
	filename: string;
	caption?: string;
	asFile?: boolean;
}

export class DeliveryUncertainError extends Error {
	constructor(original: unknown) {
		super("delivery uncertain — the file may have arrived; check the destination before retrying");
		this.name = "DeliveryUncertainError";
		this.cause = original;
	}
}

export const sendFileInputSchema = z.object({
	path: z.string().describe("File path, relative to the working directory or absolute"),
	caption: z
		.string()
		.max(1024)
		.optional()
		.describe("Optional caption shown under the file (max 1024 chars)"),
	as_file: z
		.boolean()
		.optional()
		.describe(
			"Send as an uncompressed document instead of a photo preview — byte-exact, and preserves GIF animation",
		),
});

export function sendFileTool(cwd: string, deliver: (file: OutgoingFile) => Promise<void>) {
	return tool({
		description:
			"Send a file from the workspace to the operator. Channels show image previews when they support them, otherwise they attach the document. Use this whenever the operator should receive a file — never paste file bytes into chat.",
		inputSchema: sendFileInputSchema,
		execute: async ({ path, caption, as_file }) => {
			const abs = resolvePath(cwd, path);
			const target = unicodeTwin(abs) ?? abs;
			let st: ReturnType<typeof statSync>;
			try {
				st = statSync(target);
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT") {
					return { error: `file not found: ${path}` };
				}
				throw err;
			}
			if (st.isDirectory()) return { error: `is a directory: ${path}` };
			if (st.isCharacterDevice() || st.isBlockDevice() || st.isFIFO() || st.isSocket()) {
				return {
					error: `refusing to send special file (device/fifo/socket): ${path}`,
				};
			}
			if (st.size === 0) return { error: `file is empty: ${path}` };
			if (st.size > MAX_SEND_BYTES) {
				return {
					error: `file too large: ${path} (${st.size} bytes, max ${MAX_SEND_BYTES})`,
				};
			}
			const file: OutgoingFile = {
				path: target,
				filename: basename(target),
				...(caption !== undefined ? { caption } : {}),
				...(as_file ? { asFile: true } : {}),
			};
			try {
				await deliver(file);
			} catch (err) {
				if (err instanceof DeliveryUncertainError) {
					log.warn("send_file delivery uncertain", err);
					return {
						error:
							"delivery uncertain — the file may have arrived; check the destination before retrying, never resend it",
					};
				}
				log.warn("send_file delivery failed", err);
				return { error: `send failed: ${String(err)}` };
			}
			return { sent: file.filename, bytes: st.size };
		},
	});
}
