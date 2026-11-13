import {
	Fragment,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type Dispatch,
	type ReactNode,
	type RefObject,
	type SetStateAction,
} from "react";
import { useChat } from "@ai-sdk/react";
import {
	DefaultChatTransport,
	type ChatTransport,
	type UIMessage,
} from "ai";
import {
	branchConversation,
	getConfig,
	getConversationConfig,
	getConversationMemory,
	getMessages,
	patchConfig,
	patchConversationConfig,
	patchConversationMemory,
	rateReply,
	stopConversation,
	toggleFavorite,
	uploadAttachment,
} from "./api.ts";
import { loadComposerDraft, saveComposerDraft } from "./composerDraft.ts";
import { useConfirm } from "./confirm.tsx";
import { Outline } from "./Outline.tsx";
import { usePhoneWidth } from "./usePhoneWidth.ts";
import { DocViewerProvider } from "./docview.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import { SkillPickerSheet } from "./SkillPickerSheet.tsx";
import { InterruptedTurns } from "./InterruptedTurns.tsx";
import { bytes } from "./opsShared.tsx";
import { FileIcon, MessageParts, parseAttachmentRef } from "./chat/MessageParts.tsx";
import { appendQuote, QuoteFab, type QuoteSpeaker } from "./chat/QuoteFab.tsx";
import { NotePicker } from "./chat/NotePicker.tsx";
import { ContextGauge } from "./chat/ContextGauge.tsx";
import {
	ActionBar,
	editedParts,
	FoldMark,
	foldStartExcerpt,
	MetaLine,
	messageText,
	quotaOf,
	turnMeta,
	unlandedMeta,
	UserActions,
} from "./chat/MetaLine.tsx";
import type { AttachmentRef } from "../../src/agent/attachments.ts";
import type {
	AppCompactionMark,
	AppConfigView,
	AppConversationMemoryView,
	AppLiveContext,
	AppRatedReply,
	AppReplyRating,
} from "../../src/http/app-wire.ts";

// One staged attachment. The list is owned above the composer (App),
// not inside it: the empty state's composer unmounts when its first
// send creates the conversation, and an upload resolving after that
// unmount must write into the lifted list, not the discarded
// component.
// Entries carry a client key — pasted images all arrive named
// "image.png", so filename can't pick which staging row an upload
// resolves. `speech` marks a voice note staged while a turn was
// running — send() re-applies the flag so intake still transcribes.
export interface StagedUpload {
	key: string;
	ref: AttachmentRef;
	uploading?: boolean;
	failed?: boolean;
	speech?: boolean;
	// Object URL for a local image preview — created at stage time,
	// revoked when the entry leaves the staged list.
	thumb?: string;
}

// A note picked for the next send — id only; the server expands it at
// intake. Lifted beside `staged` for the same reason: chips must
// outlive the empty-state composer.
export interface StagedNote {
	key: string;
	id: string;
	title: string;
}

// An explicit skill invocation (ruling 2026-10-21) — staged from the
// picker, sent as a data-skill part. Catalog refs resolve at
// admission; temp refs pin a fetched, verdict-stamped copy.
export interface StagedSkill {
	key: string;
	name: string;
	ref: { name: string } | { url: string; path: string };
}

// Staging dedups by reference, never display name — a catalog skill
// and a fetched copy that named itself the same are distinct skills,
// and two temp refs pin different sources. Catalog refs equal by
// name; temp refs by url and path together.
const skillRefEquals = (a: StagedSkill["ref"], b: StagedSkill["ref"]): boolean =>
	"name" in a
		? "name" in b && a.name === b.name
		: "url" in b && a.url === b.url && a.path === b.path;

// Always present — on an empty conversation too. The draft is local;
// staged attachments arrive from above so they outlive this instance.
// onSend's result says whether the send was accepted — `false` keeps
// everything the operator composed so a failed lazy create leaves a
// resendable draft.
export function Composer({
	token,
	conversationId,
	draftScope,
	busy,
	liveCtx,
	staged,
	setStaged,
	stagedNotes,
	setStagedNotes,
	stagedSkills,
	setStagedSkills,
	stagedMemory,
	onStagedMemoryToggle,
	onSend,
	onStop,
	onCompacted,
	quote,
	focusSignal,
	stealFocus,
	draftRestore,
	onDraftRestored,
}: {
	token: string | null;
	conversationId?: string;
	// Durable-draft key — one per composer home: the conversation id,
	// the project id, "new" for the empty start state.
	draftScope: string;
	busy: boolean;
	// The in-flight turn's window occupancy, streamed over the chat
	// wire — the gauge's numbers while a turn runs.
	liveCtx?: AppLiveContext | null;
	staged: StagedUpload[];
	setStaged: Dispatch<SetStateAction<StagedUpload[]>>;
	stagedNotes: StagedNote[];
	setStagedNotes: Dispatch<SetStateAction<StagedNote[]>>;
	stagedSkills: StagedSkill[];
	setStagedSkills: Dispatch<SetStateAction<StagedSkill[]>>;
	// The not-yet-created conversation's memory choice — the conversation-
	// less composers (new chat, project page) can't GET a flag that
	// doesn't exist yet. `locked` means the destination already forces
	// exclusion (a memory-off project): the toggle reads off, disabled.
	stagedMemory?: { excluded: boolean; locked: boolean };
	onStagedMemoryToggle?: (excluded: boolean) => void;
	onSend: (parts: UIMessage["parts"]) => void | boolean | Promise<boolean>;
	// Present only where a live turn exists to interrupt (ChatView).
	onStop?: () => void;
	// A manual compact landed a pointer — the host re-reads history so
	// the transcript's fold marks update.
	onCompacted?: () => void;
	// A select-to-quote request — `n` bumps per click, so even repeated
	// text appends again. The speaker lands as the quote's annotation
	// line; null quotes stay unattributed.
	quote?: { text: string; speaker: QuoteSpeaker | null; n: number } | null;
	// Bumped by the caller when the composer should grab focus (the
	// "New conversation" click) — covers the already-mounted case that
	// an autoFocus attribute can't.
	focusSignal?: number;
	// The thread view's composer claims focus when it can: on mount and
	// whenever a turn settles (operator ask, 2026-11-07). One-way — the
	// conversation-less composers keep their explicit focusSignal only.
	stealFocus?: boolean;
	draftRestore?: { parts: UIMessage["parts"] } | null;
	onDraftRestored?: () => void;
}) {
	// The draft is durable per scope: restored at mount, stored on every
	// change. No debounce and no close guard — a tab close at any
	// instant (the Ctrl+W habit this exists for) finds the last
	// keystroke already persisted, so closing costs nothing and needs no
	// confirm dialog. A record that can't be read surfaces as an error
	// line and the composer starts empty; the first write replaces it —
	// prose that fails the record shape has no reader, and freezing it
	// would brick crash recovery over bytes nothing can parse.
	let draftLoadFailure: string | null = null;
	const [draft, setDraft] = useState(() => {
		try {
			return loadComposerDraft(draftScope) ?? "";
		} catch (e) {
			draftLoadFailure = `A saved draft couldn't be read (${e instanceof Error ? e.message : String(e)}) — typing here replaces it.`;
			return "";
		}
	});
	const [draftError, setDraftError] = useState<string | null>(draftLoadFailure);
	// The mount run writes nothing: on restore it would rewrite the
	// value it just loaded, and after a corrupt load it would delete
	// the unreadable record before the operator ever sees why.
	const draftPersisted = useRef(false);
	useEffect(() => {
		if (!draftPersisted.current) {
			draftPersisted.current = true;
			return;
		}
		try {
			saveComposerDraft(draftScope, draft);
			setDraftError(null);
		} catch (e) {
			setDraftError(
				`Couldn't save the draft locally (${e instanceof Error ? e.message : String(e)}) — closing the tab loses it.`,
			);
		}
	}, [draft, draftScope]);
	const sendingRef = useRef(false);
	const [sendError, setSendError] = useState<string | null>(null);
	const editedAfterSend = useRef(false);
	const [notePickerOpen, setNotePickerOpen] = useState(false);
	const [skillPickerOpen, setSkillPickerOpen] = useState(false);
	// Outside-press dismissal — the popover and its opener are both
	// exempt, or pointerdown on the opener would close it before its
	// own click could toggle.
	const notePickRef = useRef<HTMLDivElement | null>(null);
	const noteBtnRef = useRef<HTMLButtonElement | null>(null);
	useEffect(() => {
		if (!notePickerOpen) return;
		const onPointer = (e: Event) => {
			const t = e.target as Node | null;
			if (notePickRef.current?.contains(t) === true || noteBtnRef.current?.contains(t) === true)
				return;
			setNotePickerOpen(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			setNotePickerOpen(false);
		};
		document.addEventListener("pointerdown", onPointer, true);
		document.addEventListener("keydown", onKey, true);
		return () => {
			document.removeEventListener("pointerdown", onPointer, true);
			document.removeEventListener("keydown", onKey, true);
		};
	}, [notePickerOpen]);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	useEffect(() => {
		if ((focusSignal ?? 0) > 0) textareaRef.current?.focus();
	}, [focusSignal]);
	useEffect(() => {
		if (quote == null || quote.n === 0) return;
		editedAfterSend.current = true;
		setDraft((d) => appendQuote(d, quote.text, quote.speaker ?? undefined));
		const ta = textareaRef.current;
		if (ta !== null) {
			ta.focus();
			// The new draft isn't in the DOM yet — park the cursor at its
			// end on the next frame.
			requestAnimationFrame(() => ta.setSelectionRange(ta.value.length, ta.value.length));
		}
	}, [quote]);
	// The parent scopes this payload to its originating composer. Never
	// replace text the operator wrote after the cancelled send.
	useEffect(() => {
		if (draftRestore == null) return;
		const text = draftRestore.parts
			.filter((p) => p.type === "text")
			.map((p) => p.text)
			.join("\n\n");
		if (!editedAfterSend.current) setDraft(text);
		const uploads: StagedUpload[] = [];
		const notes: StagedNote[] = [];
		const skills: StagedSkill[] = [];
		for (const p of draftRestore.parts) {
			if (p.type === "data-attachment") {
				const data = parseAttachmentRef(p.data);
				if (data === null) continue; // malformed persisted blob — never restaged
				uploads.push({
					key: crypto.randomUUID(),
					ref: data,
					...(data.speech === true ? { speech: true } : {}),
				});
			} else if (p.type === "data-note") {
				const data = p.data as { id: string; title: string };
				notes.push({ key: crypto.randomUUID(), id: data.id, title: data.title });
			} else if (p.type === "data-skill") {
				// The ref rides verbatim for the resend — the chip's display
				// name derives like SkillChip's: the catalog name, or the
				// staged <digest>/<name>/SKILL.md layout's parent directory.
				const data = p.data as StagedSkill["ref"];
				skills.push({
					key: crypto.randomUUID(),
					name:
						"name" in data ? data.name : (data.path.split("/").filter(Boolean).at(-2) ?? "unknown"),
					ref: data,
				});
			}
		}
		if (uploads.length > 0)
			setStaged((prev) => [
				...prev,
				...uploads.filter((u) => !prev.some((e) => e.ref.path === u.ref.path)),
			]);
		if (notes.length > 0)
			setStagedNotes((prev) => [...prev, ...notes.filter((n) => !prev.some((e) => e.id === n.id))]);
		if (skills.length > 0)
			// Dedup against the growing merged list, not just prev — a
			// repeat inside the payload is the same duplicate as a staged
			// one.
			setStagedSkills((prev) => {
				const merged = [...prev];
				for (const s of skills)
					if (!merged.some((e) => skillRefEquals(e.ref, s.ref))) merged.push(s);
				return merged;
			});
		onDraftRestored?.();
		const ta = textareaRef.current;
		if (ta !== null) {
			ta.focus();
			requestAnimationFrame(() => ta.setSelectionRange(ta.value.length, ta.value.length));
		}
	}, [draftRestore]);
	// An entry leaves the staged list (sent or removed) — its preview
	// URL goes with it. A composer unmount revokes nothing: staged
	// entries outlive any one composer, and an undropped thumb dies
	// with the document itself.
	const dropEntry = (e: StagedUpload) => {
		if (e.thumb !== undefined) URL.revokeObjectURL(e.thumb);
	};
	const fileInput = useRef<HTMLInputElement>(null);
	// The mic's failure mode is silent by browser default (a denied
	// permission throws) — surface it like every other composer failure.
	const [micError, setMicError] = useState<"denied" | "unavailable" | null>(null);

	// Existing chats own their settings. The empty start screen edits only
	// the app's new-chat defaults; neither path changes Telegram.
	const [cfg, setCfg] = useState<AppConfigView | null>(null);
	const [configError, setConfigError] = useState<string | null>(null);
	const [configSaving, setConfigSaving] = useState(false);
	const [modelMenuOpen, setModelMenuOpen] = useState(false);
	const [modelSheetOpen, setModelSheetOpen] = useState(false);
	const modelKnobRef = useRef<HTMLSpanElement | null>(null);
	const modelBtnRef = useRef<HTMLButtonElement | null>(null);
	useEffect(() => {
		let live = true;
		setCfg(null);
		setConfigError(null);
		setModelMenuOpen(false);
		setModelSheetOpen(false);
		const load =
			conversationId === undefined
				? getConfig(token)
				: getConversationConfig(token, conversationId);
		load.then(
			(c) => live && setCfg(c),
			(err: unknown) => live && setConfigError(String(err)),
		);
		return () => {
			live = false;
		};
	}, [token, conversationId]);
	const setKnob = (patch: { model?: string; thinking?: string }) => {
		setConfigSaving(true);
		setConfigError(null);
		const save =
			conversationId === undefined
				? patchConfig(token, patch)
				: patchConversationConfig(token, conversationId, patch);
		void save
			.then(
				(c) => setCfg(c),
				(err: unknown) => setConfigError(String(err)),
			)
			.finally(() => setConfigSaving(false));
	};

	// Dismiss the model menu on any outside press or Escape — mirrors
	// the context gauge's popover; Escape hands focus back to the knob.
	useEffect(() => {
		if (!modelMenuOpen) return;
		const onPointer = (e: Event) => {
			if (modelKnobRef.current?.contains(e.target as Node | null) === true) return;
			setModelMenuOpen(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			setModelMenuOpen(false);
			modelBtnRef.current?.focus();
		};
		document.addEventListener("pointerdown", onPointer, true);
		document.addEventListener("keydown", onKey, true);
		return () => {
			document.removeEventListener("pointerdown", onPointer, true);
			document.removeEventListener("keydown", onKey, true);
		};
	}, [modelMenuOpen]);

	// Focus stealing (`stealFocus`, the thread view): on mount, at every
	// busy → idle settle, and when the window comes back to the
	// foreground — the moments the next keystroke is a reply — the
	// composer claims focus, so typing never needs a click first. "When
	// it can": never against a surface holding focus for its own typing
	// (matched by tag/contenteditable — bare DOM classes like
	// HTMLElement don't exist in bun's test runtime), never while a
	// composer popover is open — the picker flags here cover the states
	// living in this component (they ride a ref so the window-focus
	// listener's closure stays fresh without re-subscribing); the
	// `.composer-pick` DOM check covers popovers whose state lives
	// elsewhere, the context gauge's — never under any dialog, and
	// never on phone widths, where focus() pops the on-screen keyboard
	// over a thread the operator just opened to read. The refocus claim
	// skips the busy check deliberately: coming back to a streaming
	// turn to steer it is still typing into the box.
	const stealGuard = useRef({ pickers: false });
	stealGuard.current.pickers =
		notePickerOpen || skillPickerOpen || modelMenuOpen || modelSheetOpen;
	const phone = usePhoneWidth();
	const claimFocus = () => {
		// activeElement is an HTMLElement in practice; the cast only
		// reaches isContentEditable, which Element lacks.
		const el = document.activeElement as HTMLElement | null;
		if (el != null && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable))
			return;
		if (stealGuard.current.pickers) return;
		if (document.querySelector(".composer-pick") !== null) return;
		if (document.querySelector('[role="dialog"]') !== null) return;
		textareaRef.current?.focus();
	};
	useEffect(() => {
		if (!stealFocus || phone || busy) return;
		claimFocus();
	}, [stealFocus, phone, busy]);
	useEffect(() => {
		if (!stealFocus || phone) return;
		const onWinFocus = () => claimFocus();
		window.addEventListener("focus", onWinFocus);
		return () => window.removeEventListener("focus", onWinFocus);
	}, [stealFocus, phone]);

	// ref → catalog display name; the fallbacks are the ref's last path
	// segment, then the ref itself for single-segment ids.
	const modelNames = useMemo(() => {
		const names = new Map<string, string>();
		for (const group of cfg?.catalog ?? [])
			for (const m of group.models)
				if (m.name != null) names.set(`${group.provider}/${m.id}`, m.name);
		return names;
	}, [cfg?.catalog]);
	const friendly = (ref: string) => modelNames.get(ref) ?? ref.split("/").pop() ?? ref;

	// The star writes immediately — one POST, the response's list is
	// truth. A failure surfaces like every other knob error.
	const starModel = (ref: string, on: boolean) => {
		void toggleFavorite(token, ref, on).then(
			(res) => setCfg((c) => (c === null ? c : { ...c, favorites: res.favorites })),
			(err: unknown) => setConfigError(String(err)),
		);
	};

	const [memory, setMemory] = useState<AppConversationMemoryView | null>(null);
	const [memorySaving, setMemorySaving] = useState(false);
	const [memoryError, setMemoryError] = useState<string | null>(null);
	useEffect(() => {
		let live = true;
		setMemory(null);
		setMemoryError(null);
		if (conversationId === undefined) return;
		void getConversationMemory(token, conversationId).then(
			(view) => live && setMemory(view),
			(err: unknown) => live && setMemoryError(String(err)),
		);
		return () => {
			live = false;
		};
	}, [token, conversationId]);
	const toggleMemory = () => {
		if (conversationId === undefined || memory === null) return;
		setMemorySaving(true);
		setMemoryError(null);
		void patchConversationMemory(token, conversationId, !memory.memoryExcluded)
			.then(
				(view) => setMemory(view),
				(err: unknown) => setMemoryError(String(err)),
			)
			.finally(() => setMemorySaving(false));
	};

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
						// Release-sends, but not mid-turn — a second send while a
						// turn streams is the fork send()'s busy gate exists to
						// prevent. Stage the ref instead: the chip shows it, the
						// next send carries it with speech intact.
						if (busyRef.current) {
							setStaged((p) => [...p, { key: crypto.randomUUID(), ref, speech: true }]);
						} else {
							// A declined send (failed lazy create) re-stages the
							// note — the upload already landed server-side.
							void Promise.resolve(
								onSend([{ type: "data-attachment", data: { ...ref, speech: true } }]),
							).then((accepted) => {
								if (accepted === false)
									// Cancellation can restore this ref before onSend settles.
									setStaged((p) =>
										p.some((e) => e.ref.path === ref.path)
											? p
											: [...p, { key: crypto.randomUUID(), ref, speech: true }],
									);
							});
						}
					} catch {
						setStaged((p) => [
							...p,
							{
								key: crypto.randomUUID(),
								ref: { path: "", mediaType: file.type, filename: file.name, size: file.size },
								failed: true,
							},
						]);
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
		async (file: File) => {
			const key = crypto.randomUUID();
			const thumb = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
			setStaged((p) => [
				...p,
				{
					key,
					ref: { path: "", mediaType: file.type, filename: file.name, size: file.size },
					uploading: true,
					...(thumb !== undefined ? { thumb } : {}),
				},
			]);
			try {
				const { ref } = await uploadAttachment(token, file);
				setStaged((p) =>
					p.map((e) =>
						e.key === key ? { key, ref, ...(e.thumb === undefined ? {} : { thumb: e.thumb }) } : e,
					),
				);
			} catch {
				setStaged((p) =>
					p.map((e) => (e.key === key ? { ...e, uploading: false, failed: true } : e)),
				);
			}
		},
		[token, setStaged],
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
			if (!isFile(e)) return;
			e.preventDefault();
			for (const f of Array.from(e.dataTransfer?.files ?? [])) void pickFile(f);
		};
		window.addEventListener("dragover", over);
		window.addEventListener("drop", drop);
		return () => {
			window.removeEventListener("dragover", over);
			window.removeEventListener("drop", drop);
		};
	}, [pickFile]);

	const send = () => {
		// A send while a turn runs steers it (onSend drops the stale
		// reader first) — but without a stop path there is no steer
		// lane, so a lazy create still refuses mid-flight: a second
		// send must not fork a second conversation.
		if ((busy && onStop === undefined) || configSaving || sendingRef.current) return;
		const text = draft.trim();
		const ready = staged.filter((e) => e.uploading !== true && e.failed !== true);
		if (text === "" && ready.length === 0 && stagedNotes.length === 0 && stagedSkills.length === 0)
			return;
		const parts: UIMessage["parts"] = [];
		if (text !== "") parts.push({ type: "text", text });
		for (const e of ready)
			parts.push({
				type: "data-attachment",
				data: e.speech === true ? { ...e.ref, speech: true } : e.ref,
			} as UIMessage["parts"][number]);
		// Intake expands the id into the authoritative snapshot; the
		// title rides along only so the just-sent chip isn't bare.
		for (const n of stagedNotes)
			parts.push({
				type: "data-note",
				data: { id: n.id, title: n.title },
			} as UIMessage["parts"][number]);
		// Explicit invocations ride their own part; the server injects
		// the body into the owning turn.
		for (const s of stagedSkills)
			parts.push({ type: "data-skill", data: s.ref } as UIMessage["parts"][number]);
		// Clear only once the send is accepted — a compose wiped before
		// a lazy-create failure leaves nothing to resend (blob URLs are
		// unrecoverable). Typing that lands mid-flight survives: only
		// the sent prefix comes off.
		sendingRef.current = true;
		setSendError(null);
		void Promise.resolve()
			.then(() => onSend(parts) ?? true)
			.then((accepted) => {
				if (accepted === false) return;
				// The accept continuation can outlive this composer — a lazy
				// create swaps the view before it runs, and an unmounted
				// composer's persist effect never fires. Write the post-send
				// remainder to storage directly, against the stored text.
				try {
					const stored = loadComposerDraft(draftScope) ?? "";
					saveComposerDraft(
						draftScope,
						stored === draft ? "" : stored.startsWith(draft) ? stored.slice(draft.length) : stored,
					);
				} catch {
					// Unreadable records stay put, and a mounted composer's
					// effect still reports its own save failures.
				}
				setDraft((d) => (d === draft ? "" : d.startsWith(draft) ? d.slice(draft.length) : d));
				// Entries that weren't sent — uploads still in flight, failed
				// chips — stay staged. Clearing them would drop files the
				// operator still sees in the composer.
				for (const e of ready) dropEntry(e);
				setStaged((p) => p.filter((e) => !ready.includes(e)));
				setStagedNotes((p) => p.filter((n) => !stagedNotes.includes(n)));
				setStagedSkills((p) => p.filter((s) => !stagedSkills.includes(s)));
			})
			.catch((err: unknown) => {
				setSendError(`Could not send: ${err instanceof Error ? err.message : String(err)}`);
			})
			.finally(() => {
				sendingRef.current = false;
			});
	};

	return (
		<form
			className={recording ? "composer recording" : "composer"}
			onSubmit={(e) => {
				e.preventDefault();
				send();
			}}
			// A paste carrying files stages them like the picker did; a
			// text-only clipboard falls through to the textarea's own paste.
			// Read items, not files — WebKit leaves files empty on image
			// paste and only populates items.
			onPaste={(e) => {
				const files = Array.from(e.clipboardData?.items ?? []).flatMap((i) =>
					i.kind === "file" ? (i.getAsFile() ?? []) : [],
				);
				if (files.length === 0) return;
				e.preventDefault();
				for (const f of files) void pickFile(f);
			}}
		>
			<input
				ref={fileInput}
				type="file"
				hidden
				multiple
				onChange={(e) => {
					for (const f of Array.from(e.target.files ?? [])) void pickFile(f);
					e.target.value = "";
				}}
			/>
			{configError !== null && (
				<div className="error" role="alert">
					Model settings failed: {configError}
				</div>
			)}
			{memoryError !== null && (
				<div className="error" role="alert">
					Memory setting failed: {memoryError}
				</div>
			)}
			{micError !== null && (
				<div className="error" role="alert">
					Microphone {micError} — check the browser's permission for this page.
				</div>
			)}
			{(staged.length > 0 || stagedNotes.length > 0 || stagedSkills.length > 0) && (
				<div className="composer-attachments">
					{staged.map((e, i) => (
						<span key={e.key} className={e.failed === true ? "attachment failed" : "attachment"}>
							{e.thumb !== undefined ? (
								<img className="attachment-thumb" src={e.thumb} alt="" />
							) : (
								<FileIcon />
							)}
							<span className="attachment-name">
								{e.uploading === true ? "↑ " : e.failed === true ? "✗ " : ""}
								{e.ref.filename}
							</span>
							<span className="attachment-size">{bytes(e.ref.size)}</span>
							<button
								type="button"
								aria-label="Remove"
								title="Remove"
								onClick={() => {
									dropEntry(e);
									setStaged((p) => p.filter((_, j) => j !== i));
								}}
							>
								×
							</button>
						</span>
					))}
					{stagedNotes.map((n) => (
						<span key={n.key} className="attachment note-chip">
							<FileIcon />
							<span className="attachment-name">Note · {n.title}</span>
							<button
								type="button"
								aria-label="Remove"
								title="Remove"
								onClick={() => setStagedNotes((p) => p.filter((e) => e.key !== n.key))}
							>
								×
							</button>
						</span>
					))}
					{stagedSkills.map((s) => (
						<span
							key={s.key}
							className="attachment note-chip"
							title={
								"url" in s.ref
									? `Temp skill from ${s.ref.url} — the fetched copy rides the next turn`
									: `Skill ${s.name} — its SKILL.md rides the next turn`
							}
						>
							<span aria-hidden="true">⚡</span>
							<span className="attachment-name">
								{"url" in s.ref ? "Temp skill · " : "Skill · "}
								{s.name}
							</span>
							<button
								type="button"
								aria-label="Remove"
								title="Remove"
								onClick={() => setStagedSkills((p) => p.filter((e) => e.key !== s.key))}
							>
								×
							</button>
						</span>
					))}
				</div>
			)}
			{recording ? (
				<div className="rec-row">
					<span className="rec-dot" />
					<span className="rec-time">
						{Math.floor(recSec / 60)}:{String(recSec % 60).padStart(2, "0")}
					</span>
					<span className="rec-hint">recording — release sends</span>
					<button type="button" className="rec-cancel" onClick={() => stopRecording(true)}>
						cancel
					</button>
				</div>
			) : (
				<textarea
					ref={textareaRef}
					value={draft}
					rows={1}
					placeholder="Message goblin"
					aria-label="Message draft"
					onChange={(e) => {
						editedAfterSend.current = true;
						setDraft(e.target.value);
					}}
					onKeyDown={(e) => {
						// isComposing: Enter that confirms an IME candidate is
						// not a send.
						if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
							e.preventDefault();
							send();
						}
					}}
				/>
			)}
			<div className="composer-bar">
				<button
					type="button"
					className="icon-btn"
					aria-label="Attach"
					title="Attach"
					onClick={() => fileInput.current?.click()}
				>
					<svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.75"
						strokeLinecap="round"
						width="16"
						height="16"
					>
						<line x1="12" y1="5" x2="12" y2="19" />
						<line x1="5" y1="12" x2="19" y2="12" />
					</svg>
				</button>
				<button
					type="button"
					ref={noteBtnRef}
					className="icon-btn"
					aria-label="Attach a note"
					aria-expanded={notePickerOpen}
					title="Attach a note"
					onClick={() => setNotePickerOpen((v) => !v)}
				>
					<svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.75"
						strokeLinecap="round"
						strokeLinejoin="round"
						width="16"
						height="16"
					>
						<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
						<polyline points="14 2 14 8 20 8" />
						<line x1="9" y1="13" x2="15" y2="13" />
						<line x1="9" y1="17" x2="13" y2="17" />
					</svg>
				</button>
				<button
					type="button"
					className="icon-btn"
					aria-label="Invoke a skill"
					title="Invoke a skill"
					onClick={() => setSkillPickerOpen(true)}
				>
					<svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.75"
						strokeLinecap="round"
						strokeLinejoin="round"
						width="16"
						height="16"
					>
						<path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" />
					</svg>
				</button>
				{micSupported && (
					<button
						type="button"
						className={recording ? "icon-btn rec-active" : "icon-btn"}
						aria-label={recording ? "Stop and send" : "Record a voice note"}
						title={recording ? "Stop and send" : "Record a voice note"}
						onClick={() => (recording ? stopRecording(false) : void startRecording())}
					>
						<svg
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.75"
							strokeLinecap="round"
							strokeLinejoin="round"
							width="16"
							height="16"
						>
							<rect x="9" y="2" width="6" height="12" rx="3" />
							<path d="M5 10a7 7 0 0 0 14 0" />
							<line x1="12" y1="17" x2="12" y2="22" />
						</svg>
					</button>
				)}
				{memory !== null ? (
					<button
						type="button"
						className="ctx-btn"
						aria-label={
							memory.memoryExcluded
								? "Enable memory for this conversation"
								: "Exclude this conversation from memory"
						}
						title={
							memory.projectMemory === "off"
								? "This project's memory is off"
								: memory.memoryExcluded
									? "Memory is excluded — click to include this conversation"
									: "Memory is included — click to exclude this conversation"
						}
						disabled={
							busy || memorySaving || (memory.projectMemory === "off" && memory.memoryExcluded)
						}
						onClick={toggleMemory}
					>
						memory {memory.memoryExcluded ? "off" : "on"}
					</button>
				) : (
					stagedMemory !== undefined && (
						<button
							type="button"
							className="ctx-btn"
							aria-label={
								stagedMemory.excluded
									? "Enable memory for this conversation"
									: "Exclude this conversation from memory"
							}
							title={
								stagedMemory.locked
									? "This project's memory is off"
									: stagedMemory.excluded
										? "Memory is excluded — click to include this conversation"
										: "Memory is included — click to exclude this conversation"
							}
							disabled={busy || stagedMemory.locked}
							onClick={() => onStagedMemoryToggle?.(!stagedMemory.excluded)}
						>
							memory {stagedMemory.excluded ? "off" : "on"}
						</button>
					)
				)}
				{cfg !== null && (
					<>
						<span className="knob model-knob" ref={modelKnobRef}>
							<button
								ref={modelBtnRef}
								type="button"
								className="knob-btn"
								aria-label={
									conversationId === undefined ? "New app chat model" : "Conversation model"
								}
								title={cfg.model}
								aria-haspopup="menu"
								aria-expanded={modelMenuOpen}
								disabled={busy || configSaving}
								onClick={() => setModelMenuOpen((v) => !v)}
							>
								{friendly(cfg.model)}
							</button>
							{modelMenuOpen && (
								<div className="note-pick composer-pick model-pop" role="menu">
									<ul>
										{(() => {
											// Curated membership gates the quick menu: stars
											// first (favorites order), then the enabled rest
											// in list order. Uncurated = today's favorites.
											// ?? null: an older backend's config view lacks
											// the key — read as never curated, not a crash.
											const list = cfg.pickerModels ?? null;
											const stars =
												list === null
													? cfg.favorites
													: cfg.favorites.filter((f) =>
															list.some((r) => r.toLowerCase() === f.toLowerCase()),
														);
											const rest =
												list === null
													? []
													: list.filter(
															(r) =>
																r !== cfg.model &&
																!cfg.favorites.some(
																	(f) => f.toLowerCase() === r.toLowerCase(),
																),
														);
											return [...new Set([cfg.model, ...stars, ...rest])].map((ref) => (
												<li key={ref}>
													<button
														type="button"
														role="menuitemradio"
														aria-checked={ref === cfg.model}
														title={ref}
														onClick={() => {
															setModelMenuOpen(false);
															if (ref !== cfg.model) setKnob({ model: ref });
														}}
													>
														<span className="mi">
															<span>{friendly(ref)}</span>
															{friendly(ref) !== ref && <span className="mi-ref">{ref}</span>}
														</span>
														{ref === cfg.model && <span className="check">✓</span>}
													</button>
												</li>
											));
										})()}
										<li className="menu-div" aria-hidden="true" />
										<li>
											<button
												type="button"
												role="menuitem"
												onClick={() => {
													setModelMenuOpen(false);
													setModelSheetOpen(true);
												}}
											>
												All models…
											</button>
										</li>
									</ul>
								</div>
							)}
						</span>
						<label
							className="knob"
							title={
								conversationId === undefined
									? "Default thinking level for new app chats"
									: "Thinking level for this conversation"
							}
						>
							<select
								aria-label={
									conversationId === undefined ? "New app chat thinking" : "Conversation thinking"
								}
								value={cfg.thinking}
								onChange={(e) => setKnob({ thinking: e.target.value })}
								disabled={busy || configSaving}
							>
								{[...new Set([cfg.thinking, ...cfg.thinkingLevels])].map((l) => (
									<option key={l} value={l}>
										{l}
									</option>
								))}
							</select>
						</label>
						{modelSheetOpen && (
							<ModelPicker
								title={
									conversationId === undefined
										? "Default model for new app chats"
										: "Model for this conversation"
								}
								current={cfg.model}
								allowOff={false}
								favorites={cfg.favorites}
								pickerModels={cfg.pickerModels}
								catalog={cfg.catalog}
								provNames={cfg.catalog.map((g) => g.provider)}
								onPick={(ref) => {
									setModelSheetOpen(false);
									if (ref !== cfg.model) setKnob({ model: ref });
								}}
								onToggleFavorite={starModel}
								onClose={() => setModelSheetOpen(false)}
							/>
						)}
					</>
				)}
				<ContextGauge
					token={token}
					conversationId={conversationId}
					busy={busy}
					live={liveCtx}
					model={cfg?.model}
					onCompacted={onCompacted}
				/>
				{busy && onStop !== undefined && (
					// Stop means stop: ask the runtime to abort the turn, then
					// let go of this client's stream. History keeps what was written.
					<button type="button" className="stop-btn" aria-label="Stop" onClick={onStop}>
						<svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12">
							<rect x="7" y="7" width="10" height="10" rx="2" />
						</svg>
					</button>
				)}
				<button
					type="submit"
					className="send-btn"
					aria-label="Send"
					title={busy && onStop !== undefined ? "Send — steers the running turn" : "Send"}
					disabled={
						(busy && onStop === undefined) ||
						configSaving ||
						recording ||
						(draft.trim() === "" &&
							staged.every((e) => e.failed === true || e.uploading === true) &&
							stagedNotes.length === 0 &&
							stagedSkills.length === 0)
					}
				>
					<svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14">
						<path
							fillRule="evenodd"
							d="M8 14a.75.75 0 0 1-.75-.75V4.56L4.03 7.78a.75.75 0 0 1-1.06-1.06l4.5-4.5a.75.75 0 0 1 1.06 0l4.5 4.5a.75.75 0 0 1-1.06 1.06L8.75 4.56v8.69A.75.75 0 0 1 8 14Z"
							clipRule="evenodd"
						/>
					</svg>
				</button>
			</div>
			{sendError !== null && (
				<p className="error" role="alert">
					{sendError}
				</p>
			)}
			{draftError !== null && (
				<p className="error" role="alert">
					{draftError}
				</p>
			)}
			{notePickerOpen && (
				<NotePicker
					pickRef={notePickRef}
					token={token}
					onPick={(n) =>
						setStagedNotes((p) =>
							p.some((e) => e.id === n.id)
								? p
								: [...p, { key: crypto.randomUUID(), id: n.id, title: n.title }],
						)
					}
					onClose={() => setNotePickerOpen(false)}
				/>
			)}
			{skillPickerOpen && (
				<SkillPickerSheet
					token={token}
					onClose={() => setSkillPickerOpen(false)}
					onStage={(picked) =>
						setStagedSkills((p) =>
							p.some((e) => skillRefEquals(e.ref, picked.ref))
								? p
								: [...p, { key: crypto.randomUUID(), name: picked.name, ref: picked.ref }],
						)
					}
				/>
			)}
		</form>
	);
}

// ---------- the chat ----------

// A finished turn pings the OS only when the window isn't looking —
// the notification carries the answer's first line. Permission is
// requested once, from the send path's user gesture.
function notifyDone(title: string, text: string) {
	if (document.visibilityState !== "hidden") return;
	if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
	const body = text.replace(/\s+/g, " ").trim().slice(0, 140);
	try {
		new Notification(title === "" ? "goblin" : `goblin — ${title}`, { body });
	} catch {
		/* some browsers only allow notifications from a service worker */
	}
}
function askNotifyPermission() {
	if (typeof Notification === "undefined" || Notification.permission !== "default") return;
	void Notification.requestPermission().catch(() => {});
}

// Union of the view and durable history by message id — the reconcile
// merge for an idle reconnect. History is the truth for finished
// messages; the view may additionally hold a live tail the store has
// not seen yet (a just-sent user message, the assistant mid-stream),
// and that tail must survive: the store's interleaving stands whole
// and the tail appends after it — nothing local is ever dropped.
export function mergeTranscript(current: UIMessage[], history: UIMessage[]): UIMessage[] {
	const currentIds = new Set(current.map((m) => m.id));
	const historyIds = new Set(history.map((m) => m.id));
	// Everything the view holds is durable — the store's causal order
	// wins outright, arrivals or not. A steered message sorts before the
	// reply that folded it in, which the optimistic tail-append gets
	// backwards; identical order keeps the live reference untouched.
	if (current.every((m) => historyIds.has(m.id))) {
		// Same id AND role — a stopped turn's streamed assistant partial and
		// its durable system record share an id; the durable role wins so
		// the local partial is replaced, not kept beside the record.
		const sameOrder =
			current.length === history.length &&
			current.every((m, i) => m.id === history[i]!.id && m.role === history[i]!.role);
		return sameOrder ? current : history;
	}
	const arrivals = history.filter((m) => !currentIds.has(m.id));
	// Nothing new durably — the view stands (a shrunk history is an
	// anomaly; the live view wins).
	if (arrivals.length === 0) return current;
	// The store owns the interleaving of every message it holds — an
	// answer belongs between its question and the next one, not below
	// both. The view's contribution is only the messages the store
	// hasn't seen, appended after it as the tail.
	return [...history, ...current.filter((m) => !historyIds.has(m.id))];
}

export function ChatView({
	token,
	conversationId,
	title,
	seed,
	staged,
	setStaged,
	stagedNotes,
	setStagedNotes,
	stagedSkills,
	setStagedSkills,
	noteProjectId,
	onSeeded,
	onTurnDone,
	onSendAccepted,
	onOpenNote,
	onBranched,
}: {
	token: string | null;
	conversationId: string;
	title: string | null;
	// The message an empty-state send parked while its conversation was
	// being created — delivered once, on mount.
	seed: UIMessage["parts"] | null;
	// The staged-upload list App owns — carried in so the conversation's
	// composer renders the same entries the empty state's did.
	staged: StagedUpload[];
	setStaged: Dispatch<SetStateAction<StagedUpload[]>>;
	// Same lift as staged — note chips picked before the first send
	// carry into the new conversation's composer.
	stagedNotes: StagedNote[];
	setStagedNotes: Dispatch<SetStateAction<StagedNote[]>>;
	// Skill invocations staged before the first send carry the same way.
	stagedSkills: StagedSkill[];
	setStagedSkills: Dispatch<SetStateAction<StagedSkill[]>>;
	// The conversation's project — a note-card "New note" binds to it.
	noteProjectId?: string | null | undefined;
	onSeeded: () => void;
	onTurnDone: () => void;
	// A send's stream response began — the server persisted the user
	// message before answering, so the conversation's activity stamp
	// already moved. The host refreshes the rail here, not only at
	// turn end, so the time tracks the send itself.
	onSendAccepted?: (() => void) | undefined;
	// Note chips + fenced note cards navigate to the note page in-app.
	onOpenNote?: ((id: string) => void) | undefined;
	// A branch opened a new conversation — the host refreshes and opens it.
	onBranched?: ((id: string) => void) | undefined;
}) {
	const [initial, setInitial] = useState<{
		messages: UIMessage[];
		ratings: AppRatedReply[];
		rateableMessageIds: string[];
		compactions: AppCompactionMark[];
	} | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	useEffect(() => {
		let live = true;
		getMessages(token, conversationId).then(
			(r) =>
				live &&
				setInitial({
					messages: r.messages,
					ratings: r.ratings,
					rateableMessageIds: r.rateableMessageIds,
					compactions: r.compactions ?? [],
				}),
			(err) => live && setLoadError(err instanceof Error ? err.message : "history failed to load"),
		);
		return () => {
			live = false;
		};
	}, [token, conversationId]);

	if (loadError !== null) return <div className="error">History failed to load: {loadError}</div>;
	if (initial === null) return <div className="loading">…</div>;
	return (
		<Chat
			conversationId={conversationId}
			title={title}
			token={token}
			initial={initial.messages}
			initialRatings={initial.ratings}
			initialRateableIds={initial.rateableMessageIds}
			initialCompactions={initial.compactions}
			seed={seed}
			staged={staged}
			setStaged={setStaged}
			stagedNotes={stagedNotes}
			setStagedNotes={setStagedNotes}
			stagedSkills={stagedSkills}
			setStagedSkills={setStagedSkills}
			noteProjectId={noteProjectId}
			onSeeded={onSeeded}
			onTurnDone={onTurnDone}
			onSendAccepted={onSendAccepted}
			onOpenNote={onOpenNote}
			onBranched={onBranched}
		/>
	);
}

function Chat({
	token,
	conversationId,
	title,
	initial,
	initialRatings,
	initialRateableIds,
	initialCompactions,
	seed,
	staged,
	setStaged,
	stagedNotes,
	setStagedNotes,
	stagedSkills,
	setStagedSkills,
	noteProjectId,
	onSeeded,
	onTurnDone,
	onSendAccepted,
	onOpenNote,
	onBranched,
}: {
	token: string | null;
	conversationId: string;
	title: string | null;
	initial: UIMessage[];
	initialRatings: AppRatedReply[];
	initialRateableIds: string[];
	initialCompactions: AppCompactionMark[];
	seed: UIMessage["parts"] | null;
	staged: StagedUpload[];
	setStaged: Dispatch<SetStateAction<StagedUpload[]>>;
	stagedNotes: StagedNote[];
	setStagedNotes: Dispatch<SetStateAction<StagedNote[]>>;
	stagedSkills: StagedSkill[];
	setStagedSkills: Dispatch<SetStateAction<StagedSkill[]>>;
	noteProjectId?: string | null | undefined;
	onSeeded: () => void;
	onTurnDone: () => void;
	// See ChatView's prop doc — fired by the transport once per accepted
	// send, while the turn is still running.
	onSendAccepted?: (() => void) | undefined;
	onOpenNote?: ((id: string) => void) | undefined;
	// A branch exists now — the host refreshes the rail and opens it.
	onBranched?: ((id: string) => void) | undefined;
}) {
	// The transport speaks this channel's contract: one user message per
	// POST, keyed by the app conversation id. A regenerate rides the
	// same endpoint as `retry` — no append, the stored user event
	// anchors the new answer. token null = trust mode — the server
	// wants no credential.
	//
	// A wrapper, not a bare DefaultChatTransport: the SDK exposes no
	// callback for "the resume found no live turn" (on 204 the status
	// never moves and the messages stand), so the transport is the one
	// seam that can see the idle answer. The ref is wired by the effect
	// below useChat — the reconnect's answer resolves after a network
	// round-trip, so it can never beat that effect's assignment.
	const idleReconnect = useRef<() => void>(() => {});
	// Same latest-ref shape as idleReconnect: the host's callback is an
	// inline closure, so it must not enter the transport's useMemo deps —
	// a new transport identity would re-seat useChat on every host render.
	const sendAccepted = useRef<(() => void) | undefined>(undefined);
	sendAccepted.current = onSendAccepted;
	const [ratings, setRatings] = useState<Record<string, AppRatedReply>>(() =>
		Object.fromEntries(initialRatings.map((r) => [r.messageId, r])),
	);
	const [ratingPending, setRatingPending] = useState<string | null>(null);
	const [ratingErrors, setRatingErrors] = useState<Record<string, string>>({});
	const [rateableIds, setRateableIds] = useState<ReadonlySet<string>>(
		() => new Set(initialRateableIds),
	);
	// Fold pointers as transcript marks — a pill rides where each fold
	// ran, after the last message that existed then. Replaced wholesale
	// on every history read; a rewind's deleted marks must not linger.
	const [marks, setMarks] = useState<AppCompactionMark[]>(initialCompactions);
	// Rewriting a prompt is a rewind: everything from that message onward
	// is dropped on the server before the edited text becomes the next
	// turn. The backup exists only for an edit that fails while the
	// transcript refresh cannot reach the server; in every other failure
	// the durable history reconciles the view.
	const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null);
	const editRestore = useRef<UIMessage[] | null>(null);
	// Set when an edit's error path takes over reconciliation. The SDK
	// calls onError before onFinish on an errored turn (onError in its
	// catch, onFinish in the finally), and onFinish's merge-based
	// re-sync would otherwise run after the error path's replace —
	// re-admitting the failed optimistic message the replace removed.
	const editFailed = useRef(false);
	const confirm = useConfirm();
	// A branch is a copy in a new chat; the click opens it via the host's
	// navigation. Errors stay on the reply's action row.
	const [branchPending, setBranchPending] = useState<string | null>(null);
	const [branchErrors, setBranchErrors] = useState<Record<string, string>>({});
	const applyRatingSnapshot = (next: AppRatedReply[], nextIds: string[]) => {
		setRatings(Object.fromEntries(next.map((rating) => [rating.messageId, rating])));
		setRateableIds(new Set(nextIds));
	};
	const transport = useMemo<ChatTransport<UIMessage>>(() => {
		const base = new DefaultChatTransport({
			api: "/api/app/chat",
			headers: token === null ? {} : { authorization: `Bearer ${token}` },
			// Resumable streams: on mount, useChat(resume) asks the
			// transport to reconnect to a live turn — the GET returns the
			// wire's replay + tail, or 204 when nothing is running and
			// history stands. The URL is ours, not the SDK's default
			// append, so the conversation id keeps the app channel's
			// shape.
			prepareReconnectToStreamRequest: ({ id }) => ({
				api: `/api/app/conversations/${encodeURIComponent(id.slice(4))}/stream`,
			}),
			prepareSendMessagesRequest: ({ trigger, messageId, messages, body }) => ({
				body:
					trigger === "regenerate-message"
						? { conversationId, retry: true }
						: {
								conversationId,
								message:
									trigger === "submit-message"
										? (messages.find((m) => m.id === messageId) ?? messages[messages.length - 1])
										: messages[messages.length - 1],
								// An edit rides the normal send: the message is the
								// replacement text, the id names the durable event
								// the server cuts at. Anything else is ignored.
								...(typeof body?.editMessageId === "string"
									? { editMessageId: body.editMessageId }
									: {}),
							},
			}),
		});
		return {
			sendMessages: async (options) => {
				const stream = await base.sendMessages(options);
				// Response headers mean the POST handler already ran
				// runtime.submit — the user message is durable and the
				// conversation's activity stamp has moved. The rail
				// refreshes on this, not onFinish: a long turn must not
				// hold the new time hostage until it ends.
				sendAccepted.current?.();
				return stream;
			},
			reconnectToStream: async (options) => {
				const stream = await base.reconnectToStream(options);
				// null is the server's 204 — nothing is live, and the runtime
				// persists each reply before it retires the wire, so durable
				// history is already final. The mount-time snapshot may be
				// older than that; the view reconciles.
				if (stream === null) idleReconnect.current();
				return stream;
			},
		};
	}, [token, conversationId]);
	// The running turn's window occupancy — each model step pushes it over
	// the wire as a transient data-context part (never persisted). The
	// gauge shows it while busy; cleared when a new turn starts so a fresh
	// turn never wears the previous turn's last figure.
	const [liveCtx, setLiveCtx] = useState<AppLiveContext | null>(null);
	const { messages, sendMessage, regenerate, status, error, stop, setMessages, resumeStream } =
		useChat({
			id: conversationId,
			messages: initial,
			transport,
			// Reconnect to a live turn on mount: a reload mid-turn resumes the
			// in-flight reply instead of showing a finished-looking chat whose
			// next send would steer a ghost turn.
			resume: true,
			onData: (part) => {
				if (part.type !== "data-context") return;
				const d = (typeof part.data === "object" && part.data !== null ? part.data : {}) as Record<
					string,
					unknown
				>;
				const num = (v: unknown) => (typeof v === "number" ? v : null);
				const quota = quotaOf(d.quota);
				setLiveCtx({
					input: num(d.input),
					cacheRead: num(d.cacheRead),
					...(quota !== undefined ? { quota } : {}),
				});
			},
			onFinish: ({ message, isAbort, isError }) => {
				// The edit's server-side answer is final now — a later
				// onError must not resurrect the pre-edit transcript. The
				// SDK fires this on errored turns too, so the done-bell
				// waits for a real finish and the re-sync covers both.
				editRestore.current = null;
				// An aborted reader (stop, or the drop before a steer) is not a
				// finished reply — the bell belongs to the real finish.
				if (!isAbort && !isError) notifyDone(title ?? "", messageText(message));
				onTurnDone();
				// An errored edit was reconciled by onError — its replace
				// must not be re-merged against the optimistic view it
				// discarded.
				if (editFailed.current) editFailed.current = false;
				else refreshTranscript();
			},
			onError: () => {
				// The durable transcript is the truth in every failure mode: a
				// refused request never reached the store (the tail stands
				// there), and a post-commit failure already deleted it — only
				// the server knows which, so reconcile from it — by REPLACE,
				// not merge: the optimistic replacement carries a client id
				// the store never saw, and a merge would keep it beside the
				// original exchange the server still holds. The pre-edit
				// backup covers a refresh that cannot get there.
				const backup = editRestore.current;
				editRestore.current = null;
				if (backup === null) return;
				editFailed.current = true;
				void getMessages(token, conversationId).then(
					(r) => {
						setMessages(r.messages);
						applyRatingSnapshot(r.ratings, r.rateableMessageIds);
						setMarks(r.compactions ?? []);
					},
					() => setMessages(backup),
				);
			},
		});
	const refreshTranscript = () => {
		void getMessages(token, conversationId).then(
			(r) => {
				setMessages((current) => mergeTranscript(current, r.messages));
				applyRatingSnapshot(r.ratings, r.rateableMessageIds);
				setMarks(r.compactions ?? []);
			},
			() => {},
		);
	};
	// A failed /stop means the client dropped its stream but the turn
	// keeps running server-side and will write the reply the operator
	// asked to stop — that has to be visible, not swallowed.
	const [stopError, setStopError] = useState<string | null>(null);
	useEffect(() => {
		setRatings(Object.fromEntries(initialRatings.map((r) => [r.messageId, r])));
		setRatingPending(null);
		setRatingErrors({});
		setRateableIds(new Set(initialRateableIds));
		setMarks(initialCompactions);
	}, [initialRatings, initialRateableIds, initialCompactions]);
	const rate = (messageId: string, rating: AppReplyRating) => {
		if (ratingPending !== null) return;
		setRatingPending(messageId);
		setRatingErrors((errors) => {
			const next = { ...errors };
			delete next[messageId];
			return next;
		});
		void rateReply(token, conversationId, messageId, rating)
			.then(
				(res) => setRatings((current) => ({ ...current, [messageId]: res.rating })),
				(err: unknown) =>
					setRatingErrors((errors) => ({
						...errors,
						[messageId]: err instanceof Error ? err.message : "rating failed",
					})),
			)
			.finally(() => setRatingPending(null));
	};

	// Reload-window reconciliation: a turn that completed between the
	// history snapshot and the idle reconnect is durably stored but
	// missing from the snapshot — re-read history once and merge. A new
	// turn that started meanwhile is accounted for by the merge (its
	// persisted user message arrives; a live local tail is never
	// dropped). A failed re-read leaves the snapshot standing.
	useEffect(() => {
		idleReconnect.current = () => {
			void getMessages(token, conversationId).then(
				(r) => {
					setMessages((current) => mergeTranscript(current, r.messages));
					setRatings(Object.fromEntries(r.ratings.map((rating) => [rating.messageId, rating])));
					setRateableIds(new Set(r.rateableMessageIds));
					setMarks(r.compactions ?? []);
				},
				() => {},
			);
		};
		return () => {
			idleReconnect.current = () => {};
		};
	}, [token, conversationId, setMessages]);

	const scrollRef = useRef<HTMLDivElement>(null);
	// The outline rail is a pointer/keyboard affordance — phones don't
	// hover, so it never mounts there (the stylesheet hides it too).
	const phone = usePhoneWidth();
	// Select-to-quote: each QuoteFab click bumps `n`; the Composer appends
	// the text as a blockquote with the quoted speaker's annotation.
	const [quote, setQuote] = useState<{ text: string; speaker: QuoteSpeaker | null; n: number }>({
		text: "",
		speaker: null,
		n: 0,
	});
	// Follow-mode: the transcript auto-scrolls to the tail while the view
	// is pinned there; scrolling up unpins it, scrolling back (or sending)
	// re-pins. Streaming chunks ride the same effect — the tail follows
	// output only while the operator is already at the tail.
	const pinned = useRef(true);
	const busy = status === "submitted" || status === "streaming";

	// A mid-turn send steers or queues. Drop this client's reader first:
	// the new POST's stream replays the wire from sentence one onto the
	// same assistant message id — a handoff, not a second writer. The
	// await is load-bearing: the aborted reader's teardown flips status
	// back to "ready" a tick after stop() returns control, and a send
	// fired before it lands gets clobbered into a busy:false window —
	// no stop button, and the next send forks a second writer.
	const submit = async (message: Parameters<typeof sendMessage>[0]) => {
		pinned.current = true;
		setLiveCtx(null);
		if (busy) await stop();
		await sendMessage(message);
	};

	useEffect(() => {
		const el = scrollRef.current;
		if (el !== null && pinned.current) el.scrollTop = el.scrollHeight;
	}, [messages, busy]);

	// A seed arrives once (empty-state send → conversation created → this
	// view mounts with it). The ref guards re-runs; onSeeded clears the
	// parking slot so a remount can never re-deliver it.
	const seeded = useRef(false);
	useEffect(() => {
		if (seeded.current || seed === null || seed.length === 0) return;
		seeded.current = true;
		pinned.current = true;
		onSeeded();
		void sendMessage({ parts: seed });
	}, [seed, sendMessage, onSeeded]);

	// The retry affordance belongs to the newest answer — anything older
	// gets copy/read only.
	const lastAssistantId = [...messages].reverse().find((m) => m.role === "assistant")?.id;

	// Fold marks interleave by display index — the pill sits where the
	// fold ran, after the last message that existed then; afterIndex -1
	// is a fold older than every message, rendered at the top. The
	// newest pointer is the live boundary the model's context currently
	// starts from. Two folds can land on one index, so each slot holds
	// a list.
	const marksByIndex = new Map<number, AppCompactionMark[]>();
	const topMarks: AppCompactionMark[] = [];
	for (const mark of marks) {
		if (mark.afterIndex < 0) {
			topMarks.push(mark);
			continue;
		}
		const list = marksByIndex.get(mark.afterIndex) ?? [];
		list.push(mark);
		marksByIndex.set(mark.afterIndex, list);
	}
	const liveMark = marks[marks.length - 1];

	const beginEdit = (m: UIMessage) => {
		if (busy) return;
		setEditing({ id: m.id, draft: messageText(m) });
	};
	const cancelEdit = () => setEditing(null);
	const saveEdit = async (m: UIMessage) => {
		if (busy || editing === null || editing.id !== m.id) return;
		const index = messages.findIndex((x) => x.id === m.id);
		if (index === -1) return;
		const draft = editing.draft;
		const parts = editedParts(m, draft);
		const tail = messages.length - index - 1;
		// A rewind is destructive by design. Say so when it is about to
		// drop real messages; the branch action is the way to keep them.
		if (
			tail > 0 &&
			!(await confirm.ask({
				message: `Editing this message drops the ${tail} message${tail === 1 ? "" : "s"} after it. Branch first if you want to keep them.`,
				confirmLabel: "Edit anyway",
				danger: true,
			}))
		) {
			return;
		}
		editRestore.current = messages;
		setEditing(null);
		pinned.current = true;
		setLiveCtx(null);
		setMessages(messages.slice(0, index));
		void sendMessage({ parts }, { body: { editMessageId: m.id } });
	};
	const branch = (m: UIMessage) => {
		if (busy || branchPending !== null) return;
		setBranchPending(m.id);
		setBranchErrors((errors) => {
			const next = { ...errors };
			delete next[m.id];
			return next;
		});
		branchConversation(token, conversationId, m.id)
			.then(
				(created) => onBranched?.(created.id),
				(err: unknown) =>
					setBranchErrors((errors) => ({
						...errors,
						[m.id]: err instanceof Error ? err.message : "branch failed",
					})),
			)
			.finally(() => setBranchPending(null));
	};

	return (
		<DocViewerProvider token={token} conversationId={conversationId}>
			<div className="chat">
				<QuoteFab
					root={scrollRef}
					onQuote={(text, speaker) => setQuote((q) => ({ text, speaker, n: q.n + 1 }))}
				/>
				{/* The outline is a hover rail — a pointer affordance, so it does
				    not exist in a phone DOM at all. */}
				{phone ? null : <Outline messages={messages} scrollRef={scrollRef} />}
				<div
					className="transcript"
					ref={scrollRef}
					onScroll={(e) => {
						const el = e.currentTarget;
						pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
					}}
				>
					<div className="transcript-inner">
						{messages.length === 0 && <p className="empty">Say something.</p>}
						{topMarks.map((mark, i) => (
							<FoldMark
								key={`top-${i}`}
								mark={mark}
								live={mark === liveMark}
								keptStart={foldStartExcerpt(mark, messages)}
							/>
						))}
						{messages.map((m, i) => {
							let el: ReactNode;
							if (m.role === "user") {
								const isEditing = editing !== null && editing.id === m.id;
								el = (
									<div className="msg user" data-outline-anchor={m.id}>
										{isEditing ? (
											<div className="msg-edit">
												<textarea
													value={editing.draft}
													rows={Math.min(10, Math.max(2, editing.draft.split("\n").length))}
													onChange={(e) => setEditing({ id: m.id, draft: e.target.value })}
													aria-label="Edit message"
													// autofocus is intended: opening the editor is the user's request
													autoFocus
												/>
												<div className="msg-edit-actions">
													<button type="button" onClick={cancelEdit}>
														cancel
													</button>
													<button
														type="button"
														className="primary"
														onClick={() => void saveEdit(m)}
														disabled={
															editing.draft.trim() === "" && !m.parts.some((p) => p.type !== "text")
														}
													>
														save &amp; resend
													</button>
												</div>
											</div>
										) : (
											<>
												<MessageParts
													parts={m.parts}
													token={token}
													noteProjectId={noteProjectId}
													onOpenNote={onOpenNote}
													clipFences
												/>
												<UserActions message={m} disabled={busy} onEdit={() => beginEdit(m)} />
											</>
										)}
									</div>
								);
							} else if (m.role === "system") {
								const unlanded = unlandedMeta(m);
								if (unlanded === null) {
									el = (
										<div className="msg system">
											<MessageParts
												parts={m.parts}
												token={token}
												noteProjectId={noteProjectId}
												messages={messages}
												onOpenNote={onOpenNote}
											/>
										</div>
									);
								} else {
									// The one record of a turn that ended without a
									// reply: the streamed reply renders as the card the
									// operator watched, the model-facing text stays a
									// foldable note, and there is nothing to act on.
									const label =
										unlanded.kind === "aborted"
											? "Stopped"
											: unlanded.kind === "failed"
												? "Failed"
												: "Interrupted";
									const note = (
										<details className="unlanded-note">
											<summary>
												{unlanded.reply !== null
													? "What the next turn is told"
													: `Turn ${label.toLowerCase()} — record`}
											</summary>
											<MessageParts
												parts={m.parts}
												token={token}
												noteProjectId={noteProjectId}
												messages={messages}
												onOpenNote={onOpenNote}
											/>
										</details>
									);
									if (unlanded.reply !== null) {
										el = (
											<div className="msg assistant unlanded">
												<MessageParts
													parts={unlanded.reply}
													token={token}
													noteProjectId={noteProjectId}
													messages={messages}
													onOpenNote={onOpenNote}
													ended
												/>
												<div className="msg-meta">{label}</div>
												{note}
											</div>
										);
									} else {
										el = <div className="msg system">{note}</div>;
									}
								}
							} else {
								const meta = turnMeta(m);
								el = (
									<div className="msg assistant">
										<MessageParts
											parts={m.parts}
											token={token}
											noteProjectId={noteProjectId}
											busy={busy}
											streaming={status === "streaming" && m.id === lastAssistantId}
											messages={messages}
											onOpenNote={onOpenNote}
											onNotesChanged={onTurnDone}
											onAction={(text) => void submit({ text })}
										/>
										<ActionBar
											message={m}
											isLastAssistant={m.id === lastAssistantId}
											busy={busy}
											onRetry={() => {
												setLiveCtx(null);
												void regenerate();
											}}
											token={token}
											rateable={rateableIds.has(m.id)}
											rating={ratings[m.id]?.rating ?? null}
											ratingPending={ratingPending === m.id}
											ratingError={ratingErrors[m.id] ?? null}
											onRate={(vote) => rate(m.id, vote)}
											onBranch={() => branch(m)}
											branchPending={branchPending === m.id}
											branchError={branchErrors[m.id] ?? null}
										/>
										{meta !== null && <MetaLine meta={meta} />}
									</div>
								);
							}
							const marksAt = marksByIndex.get(i);
							return (
								<Fragment key={m.id}>
									{el}
									{marksAt?.map((mark, j) => (
										<FoldMark
											key={`${mark.boundarySeq}-${mark.createdAt}-${j}`}
											mark={mark}
											live={mark === liveMark}
											keptStart={foldStartExcerpt(mark, messages)}
										/>
									))}
								</Fragment>
							);
						})}
						{busy && <div className="msg assistant pending shimmer">…</div>}
						{error !== undefined && <div className="error">The turn failed: {error.message}</div>}
						<InterruptedTurns
							key={conversationId}
							token={token}
							conversationId={conversationId}
							busy={busy}
							onResumed={async () => {
								onTurnDone();
								await resumeStream();
							}}
						/>
					</div>
				</div>
				{stopError !== null && (
					<div className="error" role="alert">
						Stop request failed — the turn keeps running server-side: {stopError}
					</div>
				)}
				<Composer
					token={token}
					conversationId={conversationId}
					draftScope={conversationId}
					busy={busy}
					liveCtx={liveCtx}
					staged={staged}
					setStaged={setStaged}
					stagedNotes={stagedNotes}
					setStagedNotes={setStagedNotes}
					stagedSkills={stagedSkills}
					setStagedSkills={setStagedSkills}
					quote={quote}
					stealFocus
					onCompacted={refreshTranscript}
					onSend={(parts) => {
						askNotifyPermission();
						void submit({ parts });
					}}
					onStop={() => {
						setStopError(null);
						// The stop route settles the turn before responding — the
						// unlanded record is in history by then, so one refresh
						// swaps the local partial for the durable record.
						void stopConversation(token, conversationId)
							.then(() => refreshTranscript())
							.catch((err: unknown) =>
								setStopError(err instanceof Error ? err.message : "request failed"),
							);
						void stop();
					}}
				/>
				{confirm.view}
			</div>
		</DocViewerProvider>
	);
}
