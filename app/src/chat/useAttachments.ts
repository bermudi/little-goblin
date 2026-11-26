import { useCallback, useEffect, useRef, useState } from "react";
import type { UIMessage } from "ai";
import { uploadAttachment } from "../api.ts";
import { startUpload } from "./uploads.ts";
import type { Chip } from "./draft.ts";

export function useAttachments({
	token,
	busy,
	onSend,
	insertChips,
	dropTarget,
}: {
	token: string | null;
	busy: boolean;
	onSend: (parts: UIMessage["parts"]) => void | boolean | Promise<boolean>;
	insertChips: (chips: Chip[]) => void;
	dropTarget?: ((target: EventTarget | null) => boolean) | undefined;
}) {
	const fileInput = useRef<HTMLInputElement>(null);
	// The mic's failure mode is silent by browser default (a denied
	// permission throws) — surface it like every other composer failure.
	const [micError, setMicError] = useState<"denied" | "unavailable" | null>(null);
	const [uploadErrors, setUploadErrors] = useState<string[]>([]);
	const noteUploadError = useCallback((message: string) => {
		setUploadErrors((prior) => (prior.includes(message) ? prior : [...prior, message]));
	}, []);
	const clearUploadErrors = useCallback(() => setUploadErrors([]), []);

	// Voice notes: hold-to-record is MediaRecorder + upload; the server
	// transcribes speech:true attachments at intake. Release sends —
	// the same shape Telegram voice notes take in this channel.
	const [recording, setRecording] = useState(false);
	const [recSec, setRecSec] = useState(0);
	const recorder = useRef<MediaRecorder | null>(null);
	const recCancel = useRef(false);
	useEffect(() => {
		if (!recording) return;
		const t = setInterval(() => setRecSec(Math.floor((Date.now() - recStart.current) / 1000)), 250);
		return () => clearInterval(t);
	}, [recording]);
	const recStart = useRef(0);
	// Leaving the view mid-recording must tear the capture down: the
	// composer's stop affordances unmount with it, so the unmount itself
	// stops the recorder — its onstop then releases the tracks and, with
	// recCancel set, skips the send. recDead covers the getUserMedia
	// window: a permission grant landing after unmount releases the
	// fresh tracks immediately instead of opening a mic nobody owns.
	const recDead = useRef(false);
	useEffect(() => {
		recDead.current = false;
		return () => {
			recDead.current = true;
			recCancel.current = true;
			const r = recorder.current;
			recorder.current = null;
			if (r !== null && r.state !== "inactive") r.stop();
		};
	}, []);
	// The recorder's onstop runs after render — read the live busy flag
	// through a ref, not the prop captured when recording started.
	const busyRef = useRef(busy);
	busyRef.current = busy;
	const onSendRef = useRef(onSend);
	onSendRef.current = onSend;
	const insertChipsRef = useRef(insertChips);
	insertChipsRef.current = insertChips;
	const micSupported =
		typeof navigator !== "undefined" &&
		navigator.mediaDevices !== undefined &&
		typeof MediaRecorder !== "undefined";
	const startRecording = async () => {
		if (recording || !micSupported) return;
		setMicError(null);
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			if (recDead.current) {
				// Unmounted while the permission prompt was up — release the
				// device we just received; nobody is recording into it.
				for (const t of stream.getTracks()) t.stop();
				return;
			}
			const mime = ["audio/ogg;codecs=opus", "audio/webm;codecs=opus", "audio/mp4"].find((m) =>
				MediaRecorder.isTypeSupported(m),
			);
			const r = new MediaRecorder(stream, mime === undefined ? undefined : { mimeType: mime });
			const chunks: Blob[] = [];
			r.ondataavailable = (e) => {
				if (e.data.size > 0) chunks.push(e.data);
			};
			r.onstop = () => {
				for (const t of stream.getTracks()) t.stop();
				recorder.current = null;
				setRecording(false);
				if (recCancel.current || chunks.length === 0) return;
				const type = r.mimeType || "audio/webm";
				const ext = type.includes("ogg") ? "ogg" : type.includes("mp4") ? "m4a" : "webm";
				const file = new File(chunks, `voice-note.${ext}`, { type });
				void (async () => {
					try {
						const { ref } = await uploadAttachment(token, file);
						if (busyRef.current || recDead.current) {
							insertChipsRef.current([{ kind: "file", state: "ready", ref: { ...ref, speech: true } }]);
						} else {
							void Promise.resolve(
								onSendRef.current([{ type: "data-attachment", data: { ...ref, speech: true } }]),
							).then((accepted) => {
								if (accepted === false)
									insertChipsRef.current([
										{ kind: "file", state: "ready", ref: { ...ref, speech: true } },
									]);
							});
						}
					} catch (e) {
						noteUploadError(
							`The voice note failed to upload: ${e instanceof Error ? e.message : String(e)}`,
						);
					}
				})();
			};
			recCancel.current = false;
			recStart.current = Date.now();
			setRecSec(0);
			r.start(250);
			recorder.current = r;
			setRecording(true);
		} catch (err) {
			// Permission denied or no device — say so; every other composer
			// failure surfaces, and a button that silently does nothing
			// reads as broken.
			setMicError(
				err instanceof Error && err.name === "NotAllowedError" ? "denied" : "unavailable",
			);
		}
	};
	const stopRecording = (cancel: boolean) => {
		recCancel.current = cancel;
		recorder.current?.stop();
	};

	const pickFile = useCallback(
		(file: File) => {
			setUploadErrors([]);
			insertChipsRef.current([startUpload(token, file)]);
		},
		[token],
	);

	// Drop target: the whole window. Unhandled file drops trigger the
	// browser default — navigating the PWA to the file and losing the
	// page — so preventDefault runs even when nothing gets staged.
	// Non-file drags keep their native handling.
	useEffect(() => {
		const isFile = (e: DragEvent) => e.dataTransfer?.types.includes("Files") === true;
		const over = (e: DragEvent) => {
			if (isFile(e)) e.preventDefault();
		};
		const drop = (e: DragEvent) => {
			const node = e.target instanceof Node ? e.target : null;
			const element = node instanceof Element ? node : node?.parentElement;
			if (
				!isFile(e) ||
				(dropTarget === undefined &&
					element !== null &&
					element !== undefined &&
					element.closest("[data-message-edit]") !== null) ||
				(dropTarget !== undefined && !dropTarget(e.target))
			)
				return;
			e.preventDefault();
			for (const f of Array.from(e.dataTransfer?.files ?? [])) pickFile(f);
		};
		window.addEventListener("dragover", over);
		window.addEventListener("drop", drop);
		return () => {
			window.removeEventListener("dragover", over);
			window.removeEventListener("drop", drop);
		};
	}, [dropTarget, pickFile]);

	return {
		fileInput,
		micError,
		uploadErrors,
		noteUploadError,
		clearUploadErrors,
		micSupported,
		recording,
		recSec,
		startRecording,
		stopRecording,
		pickFile,
	};
}
