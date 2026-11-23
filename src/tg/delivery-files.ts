import { InputFile, type Api } from "grammy";
import { stat } from "node:fs/promises";
import type { Conversation } from "../conversation-read.ts";
import { sniffImage } from "../agent/tools/read.ts";
import { DeliveryUncertainError, MAX_SEND_BYTES, type OutgoingFile } from "../agent/tools/send.ts";
import { log } from "../log.ts";
import { after, type Timer } from "../timing.ts";
import { TelegramTimeoutError, withTimeout } from "./deadline.ts";

// The files/albums cluster of the Telegram delivery sink — photo
// batching (the media-group window, sendMediaGroup with solo fallback)
// and document sends — lifted out of makeDeliverySink (#458). delivery.ts
// owns every mutable turn binding; this module touches it only through
// the live accessors on FileDeliveryCtx, never a captured value.

export interface FileDeliveryCtx {
	api: Api;
	conv: Conversation;
	enqueue(fn: () => Promise<void>): void;
	/** The current serialized-send chain tail — read live, never captured. */
	settled(): Promise<void>;
	mayDeliver(): boolean;
	/** Live read of the uncertain-delivery latch. */
	uncertain(): boolean;
	markUncertain(error: unknown, kind: string, chunk?: number): void;
	/** Post-send typing ping (the sink's repingTyping). */
	noteLanded(): void;
	/** Live read of the authority check (reassigned by setAuthorityCheck). */
	authoritative(): boolean;
}

export function makeFileDelivery(
	ctx: FileDeliveryCtx,
	opts: { mediaGroupWindowMs: number },
): {
	sendFile(file: OutgoingFile): Promise<void>;
	flushPhotoBatch(): void;
} {
	const { api, conv } = ctx;

	interface QueuedPhoto {
		file: OutgoingFile;
		bytes: number;
		error?: unknown;
	}
	let photoQueue: QueuedPhoto[] = [];
	let photoBatchWait: Promise<void> | null = null;
	let photoBatchResolve: (() => void) | null = null;
	let photoKick: Timer | null = null;

	function flushPhotoBatch(): void {
		if (photoBatchResolve === null) return;
		if (photoKick !== null) {
			photoKick.cancel();
			photoKick = null;
		}
		const batch = photoQueue;
		photoQueue = [];
		const resolve = photoBatchResolve;
		photoBatchResolve = null;
		photoBatchWait = null;
		ctx.enqueue(async () => {
			try {
				await sendPhotoBatch(batch);
			} finally {
				resolve();
			}
		});
	}

	function joinPhotoBatch(q: QueuedPhoto): Promise<void> {
		photoQueue.push(q);
		if (photoBatchWait === null) {
			photoBatchWait = new Promise<void>((resolve) => {
				photoBatchResolve = resolve;
			});
			photoKick = after(opts.mediaGroupWindowMs, "telegram photo batch", flushPhotoBatch);
		}
		return photoBatchWait;
	}

	async function sendPhotoSolo(
		q: QueuedPhoto,
		thread: { message_thread_id?: number },
	): Promise<void> {
		if (q.bytes > MAX_SEND_BYTES)
			throw new Error(`file too large: ${q.file.path} (${q.bytes} bytes, max ${MAX_SEND_BYTES})`);
		if (!ctx.mayDeliver()) return;
		try {
			const sent = await withTimeout(
				api.sendPhoto(conv.chatId, new InputFile(q.file.path, q.file.filename), {
					...thread,
					...(q.file.caption !== undefined ? { caption: q.file.caption } : {}),
				}),
				"sendPhoto",
			);
			log.debug("file delivered", {
				conversation: conv.id,
				message: sent.message_id,
				path: q.file.path,
				bytes: q.bytes,
				kind: "photo",
				...(conv.threadId !== null ? { thread: conv.threadId } : {}),
			});
			ctx.noteLanded();
		} catch (err) {
			if (err instanceof TelegramTimeoutError) {
				ctx.markUncertain(err, "sendPhoto");
				throw new DeliveryUncertainError(err);
			}
			throw err;
		}
	}

	async function sendPhotoBatch(batch: QueuedPhoto[]): Promise<void> {
		if (ctx.uncertain()) {
			for (const q of batch) {
				q.error = new Error("not sent — delivery stopped after an uncertain timeout");
			}
			return;
		}
		if (!ctx.mayDeliver()) return;
		const thread = conv.threadId !== null ? { message_thread_id: conv.threadId } : {};
		const sendable: QueuedPhoto[] = [];
		for (const q of batch) {
			try {
				q.bytes = (await stat(q.file.path)).size;
				sendable.push(q);
			} catch {
				q.error = new Error(`file unreadable: ${q.file.path}`);
			}
		}
		const delivered = new Set<QueuedPhoto>();
		const markUnsent = (): void => {
			if (!ctx.uncertain()) return;
			for (const q of sendable) {
				if (!delivered.has(q) && q.error === undefined) {
					q.error = new Error("not sent — delivery stopped after an uncertain timeout");
				}
			}
		};
		let fallback: QueuedPhoto[] | null = null;
		for (let at = 0; at < sendable.length; at += 10) {
			if (!ctx.mayDeliver()) {
				markUnsent();
				return;
			}
			const group = sendable.slice(at, at + 10);
			if (group.length === 1) {
				try {
					await sendPhotoSolo(group[0]!, thread);
					delivered.add(group[0]!);
				} catch (err) {
					if (err instanceof DeliveryUncertainError) {
						for (const q of sendable) if (!delivered.has(q)) q.error = err;
						return;
					}
					group[0]!.error = err;
					delivered.add(group[0]!);
				}
				continue;
			}
			const media = group.map((q) => ({
				type: "photo" as const,
				media: new InputFile(q.file.path, q.file.filename),
				...(q.file.caption !== undefined ? { caption: q.file.caption } : {}),
			}));
			try {
				const sent = await withTimeout(
					api.sendMediaGroup(conv.chatId, media, thread),
					"sendMediaGroup",
				);
				for (const q of group) delivered.add(q);
				log.debug("media group delivered", {
					conversation: conv.id,
					messages: sent.length,
					files: group.length,
					...(conv.threadId !== null ? { thread: conv.threadId } : {}),
				});
				ctx.noteLanded();
			} catch (err) {
				if (err instanceof TelegramTimeoutError) {
					ctx.markUncertain(err, "sendMediaGroup");
					const wrapped = new DeliveryUncertainError(err);
					for (const q of sendable) if (!delivered.has(q)) q.error = wrapped;
					return;
				}
				log.warn("media group failed — falling back to solo sends", err, {
					conversation: conv.id,
					chat: conv.chatId,
					files: sendable.length - delivered.size,
				});
				fallback = sendable.filter((q) => !delivered.has(q));
				break;
			}
		}
		if (fallback === null) return;
		for (const q of fallback) {
			if (!ctx.mayDeliver()) {
				markUnsent();
				return;
			}
			try {
				await sendPhotoSolo(q, thread);
			} catch (err) {
				q.error = err;
				if (err instanceof DeliveryUncertainError) {
					for (const rest of fallback) if (rest.error === undefined) rest.error = err;
					return;
				}
			}
		}
	}

	async function sendFile(file: OutgoingFile): Promise<void> {
		if (!ctx.authoritative()) return;
		const sniff = sniffImage(file.path);
		const photo = !file.asFile && sniff !== null && sniff.mediaType !== "image/gif";
		if (photo) {
			const q: QueuedPhoto = { file, bytes: 0 };
			const wait = joinPhotoBatch(q);
			await wait;
			if (q.error !== undefined) throw q.error;
			return;
		}
		const st = await stat(file.path).catch((err: unknown) => {
			throw new Error(`file unreadable: ${file.path} (${String(err)})`);
		});
		return sendDocumentSolo(file, st.size);
	}

	async function sendDocumentSolo(file: OutgoingFile, bytes: number): Promise<void> {
		if (bytes > MAX_SEND_BYTES)
			throw new Error(`file too large: ${file.path} (${bytes} bytes, max ${MAX_SEND_BYTES})`);
		let failure: { err: unknown } | undefined;
		ctx.enqueue(async () => {
			if (ctx.uncertain()) {
				failure = {
					err: new Error("not sent — delivery stopped after an uncertain timeout"),
				};
				return;
			}
			if (!ctx.mayDeliver()) return;
			const extra = {
				...(conv.threadId !== null ? { message_thread_id: conv.threadId } : {}),
				...(file.caption !== undefined ? { caption: file.caption } : {}),
			};
			try {
				const sent = await withTimeout(
					api.sendDocument(conv.chatId, new InputFile(file.path, file.filename), extra),
					"sendDocument",
				);
				log.debug("file delivered", {
					conversation: conv.id,
					message: sent.message_id,
					path: file.path,
					bytes,
					kind: "document",
					...(conv.threadId !== null ? { thread: conv.threadId } : {}),
				});
				ctx.noteLanded();
			} catch (err) {
				if (err instanceof TelegramTimeoutError) {
					ctx.markUncertain(err, "sendDocument");
					err = new DeliveryUncertainError(err);
				}
				failure = { err };
				throw err;
			}
		});
		await ctx.settled();
		if (failure !== undefined) throw failure.err;
	}

	return { sendFile, flushPhotoBatch };
}
