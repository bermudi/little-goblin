import { randomUUID } from "node:crypto";
import { copyFile, stat, unlink, writeFile } from "node:fs/promises";
import type { Message, MessageChunk } from "./message.ts";
import {
	attachmentPart,
	type AttachmentRef,
	isStoredAttachmentPath,
	persistAttachment,
} from "./agent/attachments.ts";
import type { OutgoingFile } from "./agent/tools/send.ts";
import { log } from "./log.ts";
import { FencedError } from "./runtime.ts";
import type { TurnDone, TurnSink } from "./turn/sink.ts";
import { attachmentContentType } from "./stateview.ts";

export interface AppMediaDeps {
	append(messages: Message[], opts: { anchorSeq?: number | null; exclude?: boolean }): void;
}

export function composeTurnSinks(...sinks: TurnSink[]): TurnSink {
	const core = {
		onTextDelta(delta: string) {
			for (const s of sinks) s.onTextDelta(delta);
		},
		onReasoningDelta(delta: string) {
			for (const s of sinks) s.onReasoningDelta(delta);
		},
		onToolCall(toolName: string, input: unknown) {
			for (const s of sinks) s.onToolCall(toolName, input);
		},
		setAuthorityCheck(
			check: () => boolean,
			anchorSeq?: number | null,
			memoryExcluded?: () => boolean,
		) {
			for (const s of sinks) s.setAuthorityCheck?.(check, anchorSeq, memoryExcluded);
		},
		async onDone(done: TurnDone) {
			for (const s of sinks) await s.onDone(done);
		},
	};
	const delivery = sinks.some((s) => s.delivery === "stream") ? "stream" : "headless";
	const sink: TurnSink =
		delivery === "stream"
			? {
					...core,
					delivery,
					onStreamChunk(chunk) {
						for (const s of sinks) {
							if (s.delivery === "stream") s.onStreamChunk(chunk);
						}
					},
				}
			: { ...core, delivery };
	if (sinks.some((s) => s.onVoiceNote !== undefined)) {
		sink.onVoiceNote = async (audio) => {
			for (const s of sinks) await s.onVoiceNote?.(audio);
		};
	}
	if (sinks.some((s) => s.onFile !== undefined)) {
		sink.onFile = async (file) => {
			for (const s of sinks) await s.onFile?.(file);
		};
	}
	if (sinks.some((s) => s.onVoiceSynthesisStart !== undefined)) {
		sink.onVoiceSynthesisStart = () => {
			const stoppers = sinks
				.map((s) => s.onVoiceSynthesisStart?.())
				.filter((stop): stop is () => void => stop !== undefined);
			return () => {
				for (const stop of stoppers) stop();
			};
		};
	}
	return sink;
}

async function outgoingAttachment(
	file: OutgoingFile,
): Promise<{ ref: AttachmentRef; cleanup: string | null }> {
	if (isStoredAttachmentPath(file.path)) {
		const { size } = await stat(file.path);
		return {
			ref: {
				path: file.path,
				mediaType: attachmentContentType(file.filename),
				filename: file.filename,
				size,
			},
			cleanup: null,
		};
	}
	const saved = await persistAttachment(
		`file-${randomUUID()}`,
		file.filename,
		"app file",
		async (temp) => {
			await copyFile(file.path, temp);
		},
		undefined,
		attachmentContentType(file.filename),
	);
	return {
		ref: {
			path: saved.path,
			mediaType: attachmentContentType(file.filename),
			filename: file.filename,
			size: saved.size,
			...(saved.sha256 !== undefined ? { sha256: saved.sha256 } : {}),
		},
		cleanup: saved.path,
	};
}

export function appMediaSink(
	convId: string,
	media: AppMediaDeps,
	emit?: (chunk: MessageChunk) => void,
	onDone?: (done: TurnDone) => void | Promise<void>,
): TurnSink {
	let authorized: (() => boolean) | null = null;
	let anchorSeq: number | null = null;
	let inputExcluded: (() => boolean) | undefined;
	const checkAuthority = () => {
		if (authorized !== null && !authorized()) throw new FencedError(convId);
	};
	const record = async (
		ref: AttachmentRef,
		caption: string | undefined,
		cleanup: string | null,
	) => {
		let excluded = false;
		try {
			checkAuthority();
			excluded = inputExcluded?.() === true;
			media.append(
				[
					{
						id: `media-${randomUUID()}`,
						role: "assistant",
						parts:
							caption === undefined || caption === ""
								? [attachmentPart(ref)]
								: [attachmentPart(ref), { type: "text", text: caption }],
					},
				],
				{ anchorSeq, ...(excluded ? { exclude: true } : {}) },
			);
		} catch (err) {
			if (cleanup !== null) {
				try {
					await unlink(cleanup);
				} catch (cleanupErr) {
					log.warn("app media cleanup failed", cleanupErr, {
						conversation: convId,
						path: cleanup,
					});
				}
			}
			throw err;
		}
		emit?.({ type: "data-attachment", data: ref } as MessageChunk);
		log.info("app media delivered", {
			conversation: convId,
			filename: ref.filename,
			mediaType: ref.mediaType,
			size: ref.size,
			ownedInputExcluded: excluded,
		});
	};
	return {
		delivery: "headless",
		onTextDelta() {},
		onReasoningDelta() {},
		onToolCall() {},
		async onVoiceNote(audio) {
			checkAuthority();
			const saved = await persistAttachment(
				`voice-${randomUUID()}`,
				"voice-note.ogg",
				"app voice",
				async (temp) => {
					await writeFile(temp, audio);
				},
				undefined,
				"audio/ogg",
			);
			await record(
				{
					path: saved.path,
					mediaType: "audio/ogg",
					filename: "voice-note.ogg",
					size: saved.size,
					...(saved.sha256 !== undefined ? { sha256: saved.sha256 } : {}),
				},
				undefined,
				saved.path,
			);
		},
		async onFile(file) {
			checkAuthority();
			const { ref, cleanup } = await outgoingAttachment(file);
			await record(ref, file.caption, cleanup);
		},
		setAuthorityCheck(check, anchor, memoryExcluded) {
			authorized = check;
			anchorSeq = anchor ?? null;
			inputExcluded = memoryExcluded;
		},
		async onDone(done) {
			await onDone?.(done);
		},
	};
}
