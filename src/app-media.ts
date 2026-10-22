import { randomUUID } from "node:crypto";
import { copyFile, stat, unlink, writeFile } from "node:fs/promises";
import type { UIMessage, UIMessageChunk } from "ai";
import {
	attachmentPart,
	type AttachmentRef,
	isStoredAttachmentPath,
	persistAttachment,
} from "./agent/attachments.ts";
import type { OutgoingFile } from "./agent/tools/send.ts";
import { log } from "./log.ts";
import { FencedError, type TurnDone, type TurnSink } from "./runtime.ts";
import { attachmentContentType } from "./stateview.ts";

export interface AppMediaDeps {
	append(messages: UIMessage[], opts: { anchorSeq?: number | null }): void;
}

export function composeTurnSinks(...sinks: TurnSink[]): TurnSink {
	const sink: TurnSink = {
		onTextDelta(delta) {
			for (const s of sinks) s.onTextDelta(delta);
		},
		onReasoningDelta(delta) {
			for (const s of sinks) s.onReasoningDelta(delta);
		},
		onToolCall(toolName, input) {
			for (const s of sinks) s.onToolCall(toolName, input);
		},
		setAuthorityCheck(check, anchorSeq) {
			for (const s of sinks) s.setAuthorityCheck?.(check, anchorSeq);
		},
		async onDone(done) {
			for (const s of sinks) await s.onDone(done);
		},
	};
	if (sinks.some((s) => s.onStreamChunk !== undefined)) {
		sink.onStreamChunk = (chunk) => {
			for (const s of sinks) s.onStreamChunk?.(chunk);
		};
	}
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
	);
	return {
		ref: {
			path: saved.path,
			mediaType: attachmentContentType(file.filename),
			filename: file.filename,
			size: saved.size,
		},
		cleanup: saved.path,
	};
}

export function appMediaSink(
	convId: string,
	media: AppMediaDeps,
	emit?: (chunk: UIMessageChunk) => void,
	onDone?: (done: TurnDone) => void | Promise<void>,
): TurnSink {
	let authorized: (() => boolean) | null = null;
	let anchorSeq: number | null = null;
	const checkAuthority = () => {
		if (authorized !== null && !authorized()) throw new FencedError(convId);
	};
	const record = async (
		ref: AttachmentRef,
		caption: string | undefined,
		cleanup: string | null,
	) => {
		try {
			checkAuthority();
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
				{ anchorSeq },
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
		emit?.({ type: "data-attachment", data: ref } as UIMessageChunk);
		log.info("app media delivered", {
			conversation: convId,
			filename: ref.filename,
			mediaType: ref.mediaType,
			size: ref.size,
		});
	};
	return {
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
			);
			await record(
				{
					path: saved.path,
					mediaType: "audio/ogg",
					filename: "voice-note.ogg",
					size: saved.size,
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
		setAuthorityCheck(check, anchor) {
			authorized = check;
			anchorSeq = anchor ?? null;
		},
		async onDone(done) {
			await onDone?.(done);
		},
	};
}
