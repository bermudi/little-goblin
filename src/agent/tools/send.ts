import { statSync } from "node:fs";
import { basename } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { log } from "../../log.ts";
import { resolvePath, unicodeTwin } from "./paths.ts";

// Telegram's local-mode ceiling — the self-hosted bot-api serves uploads
// to 2GB. Cloud Bot API caps at 50MB; local mode is the deployment, so
// the tool gates on the deployment's limit, not the cloud's.
export const MAX_SEND_BYTES = 2 * 1024 * 1024 * 1024;

export interface OutgoingFile {
	path: string;
	filename: string;
	caption?: string;
	// Forces the document path: sendPhoto re-encodes (lossy) and strips
	// GIF animation — a document is byte-exact.
	asFile?: boolean;
}

// Raised by the delivery sink when Telegram abandons a send at its
// timeout: the request wasn't cancelled, so it may still land and the
// outcome is unknown (design/telegram.md → Delivery). Lives next to
// OutgoingFile because it is part of the deliver() contract — the sink
// (tg/) throws it with the raw timeout as `cause`, the tool words its
// result from it. Never an invitation to resend.
export class DeliveryUncertainError extends Error {
	constructor(original: unknown) {
		super("delivery uncertain — the file may have arrived; check Telegram before retrying");
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
			"Send a file from the workspace to the operator via Telegram. Images arrive as photo previews, everything else as documents. Use this whenever the operator should receive a file — never paste file bytes into chat.",
		inputSchema: sendFileInputSchema,
		execute: async ({ path, caption, as_file }) => {
			const abs = resolvePath(cwd, path);
			// Same twin rule as the other file tools: an NFC/NFD variant
			// must resolve to the one file, never fork beside it.
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
					// Ambiguous, not failed — the upload may have landed. Word it
					// so the model checks instead of resending.
					log.warn("send_file delivery uncertain", err);
					return {
						error:
							"delivery uncertain — the file may have arrived on Telegram; check it there before retrying, never resend it",
					};
				}
				log.warn("send_file delivery failed", err);
				return { error: `send failed: ${String(err)}` };
			}
			return { sent: file.filename, bytes: st.size };
		},
	});
}
