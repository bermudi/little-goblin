import { useEffect, useMemo, useRef, useState } from "react";
import type { UIMessage } from "ai";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@ui-sdk/react/menu";
import {
	getConfig,
	getConversationConfig,
	getConversationMemory,
	patchConversationConfig,
	patchConversationMemory,
	previewConfig,
	toggleFavorite,
} from "../api.ts";
import { loadComposerDraft, saveComposerDraft } from "../composerDraft.ts";
import {
	draftFromMessages,
	draftText,
	emptyDraft,
	isEmptyDraft,
	uploadState,
	type Chip,
	type Draft,
} from "./draft.ts";
import { ModelPicker } from "../ModelPicker.tsx";
import { SkillPickerSheet } from "../SkillPickerSheet.tsx";
import { ContextGauge } from "./ContextGauge.tsx";
import { NotePicker } from "./NotePicker.tsx";
import { quoteBlock, type QuoteSpeaker } from "./QuoteFab.tsx";
import { MessageBox, type MessageBoxHandle } from "./MessageBox.tsx";
import { useAttachments } from "./useAttachments.ts";
import { useSkillNoteStaging } from "./useSkillNoteStaging.ts";
import { useSubmit } from "./useSubmit.ts";
import { useKeyboard } from "./useKeyboard.ts";
import { usePhoneWidth } from "../usePhoneWidth.ts";
import type {
	AppConfigView,
	AppConversationMemoryView,
	AppLiveContext,
	AppModelSettings,
} from "../../../src/http/app-wire.ts";

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
	stagedMemory,
	onStagedMemoryToggle,
	onSend,
	onStop,
	onCompacted,
	onOpenNote,
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
	// The not-yet-created conversation's memory choice — the conversation-
	// less composers (new chat, project page) can't GET a flag that
	// doesn't exist yet. `locked` means the destination already forces
	// exclusion (a memory-off project): the toggle reads off, disabled.
	stagedMemory?: { excluded: boolean; locked: boolean };
	onStagedMemoryToggle?: (excluded: boolean) => void;
	onSend: (
		parts: UIMessage["parts"],
		whenBusy?: "steer" | "followUp",
		initialModelSettings?: AppModelSettings,
	) => void | boolean | Promise<boolean>;
	// Present only where a live turn exists to interrupt (ChatView).
	onStop?: () => void;
	// A manual compact landed a pointer — the host re-reads history so
	// the transcript's fold marks update.
	onCompacted?: () => void;
	// A chip's popover asked to open the note it names.
	onOpenNote?: ((id: string) => void) | undefined;
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
	draftRestore?: { messages: UIMessage["parts"][]; source?: "pending-edit" } | null;
	onDraftRestored?: () => void;
}) {
	const phoneWidth = usePhoneWidth();
	// The draft is durable per scope: restored at mount, stored on every
	// change. No debounce and no close guard — a tab close at any
	// instant (the Ctrl+W habit this exists for) finds the last
	// keystroke already persisted, so closing costs nothing and needs no
	// confirm dialog. A record that can't be read surfaces as an error
	// line and the composer starts empty; the first write replaces it —
	// prose that fails the record shape has no reader, and freezing it
	// would brick crash recovery over bytes nothing can parse.
	let draftLoadFailure: string | null = null;
	const [draft, setDraft] = useState<Draft>(() => {
		try {
			return loadComposerDraft(draftScope) ?? emptyDraft();
		} catch (e) {
			draftLoadFailure = `A saved draft couldn't be read (${e instanceof Error ? e.message : String(e)}) — typing here replaces it.`;
			return emptyDraft();
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
	const [cfg, setCfg] = useState<AppConfigView | null>(null);
	const [configError, setConfigError] = useState<string | null>(null);
	const [configNote, setConfigNote] = useState<string | null>(null);
	const [configSaving, setConfigSaving] = useState(false);
	const [draftModelSelected, setDraftModelSelected] = useState(false);
	const configSave = useRef({ seq: 0 });
	const [modelMenuOpen, setModelMenuOpen] = useState(false);
	const [modelSheetOpen, setModelSheetOpen] = useState(false);
	const modelKnobRef = useRef<HTMLSpanElement | null>(null);
	const modelBtnRef = useRef<HTMLButtonElement | null>(null);
	useEffect(() => {
		let live = true;
		const save = configSave.current;
		setCfg(null);
		setConfigError(null);
		setConfigNote(null);
		setConfigSaving(false);
		setDraftModelSelected(false);
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
			save.seq++;
		};
	}, [token, conversationId, draftScope]);
	const setKnob = (patch: { model?: string; thinking?: string }) => {
		if (cfg === null) return;
		const scope = configSave.current;
		const seq = ++scope.seq;
		setConfigSaving(true);
		setConfigError(null);
		setConfigNote(null);
		const save =
			conversationId === undefined
				? previewConfig(token, {
						model: patch.model ?? cfg.model,
						thinking: patch.thinking ?? cfg.thinking,
					})
				: patchConversationConfig(token, conversationId, patch);
		void save
			.then(
				(c) => {
					if (scope.seq !== seq) return;
					setCfg(c);
					if (conversationId === undefined) setDraftModelSelected(true);
					const notes: string[] = [];
					if (c.thinkingClamped !== undefined) {
						notes.push(
							`thinking clamped ${c.thinkingClamped.from} → ${c.thinkingClamped.to} — the model doesn't offer ${c.thinkingClamped.from}`,
						);
					}
					if (c.appliesFrom === "next-turn") {
						notes.push("the running turn keeps its model — the switch applies from the next turn");
					}
					setConfigNote(notes.length === 0 ? null : notes.join(" · "));
				},
				(err: unknown) => {
					if (scope.seq === seq) setConfigError(String(err));
				},
			)
			.finally(() => {
				if (scope.seq === seq) setConfigSaving(false);
			});
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
	const sendWithModelSettings = (
		parts: UIMessage["parts"],
		whenBusy?: "steer" | "followUp",
	) =>
		onSend(
			parts,
			whenBusy,
			conversationId === undefined && draftModelSelected && cfg !== null
				? { model: cfg.model, thinking: cfg.thinking }
				: undefined,
		);

	const boxRef = useRef<MessageBoxHandle | null>(null);
	// Programmatic box writes (restores) must not read as operator edits —
	// the cancelled-send restore keeps its "nothing typed since" guard.
	// The mount sync's own onChange is skipped the same way: it reports
	// the draft it just loaded, not a keystroke.
	const programmatic = useRef(false);
	const mountSync = useRef(true);
	const runBox = (fn: () => void) => {
		programmatic.current = true;
		try {
			fn();
		} finally {
			programmatic.current = false;
		}
	};
	const insertChips = (chips: Chip[]) => {
		runBox(() => boxRef.current?.insertChips(chips));
	};
	const { send, sendError, sendNote, editedAfterSend } = useSubmit({
		busy,
		onStop,
		configSaving,
		draftScope,
		boxRef,
		onSend: sendWithModelSettings,
	});
	const onBoxChange = (next: Draft) => {
		if (mountSync.current) mountSync.current = false;
		else if (!programmatic.current) editedAfterSend.current = true;
		setDraft(next);
	};
	const { notePickerOpen, setNotePickerOpen, skillPickerOpen, setSkillPickerOpen, notePickRef, noteBtnRef, pickNote, stageSkill } =
		useSkillNoteStaging({ insertChips });
	const latestDraftRestoreBindings = useRef({
		editedAfterSend,
		onDraftRestored,
	});
	latestDraftRestoreBindings.current = {
		editedAfterSend,
		onDraftRestored,
	};
	useEffect(() => {
		if (quote == null || quote.n === 0) return;
		editedAfterSend.current = true;
		const quoted = quoteBlock(quote.text, quote.speaker ?? undefined);
		const head = draftText(draft).trimEnd();
		runBox(() => boxRef.current?.appendText(head === "" ? `${quoted}\n\n` : `\n\n${quoted}\n\n`));
		boxRef.current?.focus("end");
	}, [quote, draft, editedAfterSend]);
	// The parent scopes this payload to its originating composer. Pending
	// edits always restore, ahead of any newer draft; cancelled-send restores
	// keep the edit guard so they never replace newer operator text.
	useEffect(() => {
		if (draftRestore == null) return;
		const { editedAfterSend, onDraftRestored } = latestDraftRestoreBindings.current;
		const incoming = draftFromMessages(draftRestore.messages);
		if (draftRestore.source === "pending-edit") {
			runBox(() => boxRef.current?.prepend(incoming));
		} else if (!editedAfterSend.current) {
			runBox(() => boxRef.current?.setDraft(incoming));
		}
		onDraftRestored?.();
		boxRef.current?.focus("end");
	}, [draftRestore]);
	const { fileInput, micError, micSupported, recording, recSec, startRecording, stopRecording, pickFile } =
		useAttachments({
			token,
			busy: busy || (conversationId === undefined && configSaving),
			onSend: sendWithModelSettings,
			insertChips,
		});
	useKeyboard({
		focusRef: boxRef,
		focusSignal,
		stealFocus,
		busy,
		pickersOpen: notePickerOpen || skillPickerOpen || modelMenuOpen || modelSheetOpen,
	});
	return (
		<form
			className={recording ? "composer recording" : "composer"}
			onSubmit={(e) => {
				e.preventDefault();
				send();
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
			{configNote !== null && (
				<div className="composer-note" role="status">
					{configNote}
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
			{sendNote !== null && (
				<div className="composer-note" role="status">
					{sendNote}
				</div>
			)}
			{recording && (
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
			)}
			<MessageBox
				ref={boxRef}
				initial={draft}
				onChange={onBoxChange}
				onEnter={(mode) => send(mode)}
				onFiles={(files) => {
					for (const f of files) pickFile(f);
				}}
				onOpenNote={onOpenNote}
				token={token}
				ariaLabel="Message draft"
				placeholder="Message goblin"
			/>
			<div className="composer-bar">
				{phoneWidth ? (
					<Menu
						onAction={(value) => {
							if (value === "file") fileInput.current?.click();
							else if (value === "note") setNotePickerOpen(true);
							else if (value === "skill") setSkillPickerOpen(true);
						}}
					>
						<MenuTrigger ref={noteBtnRef} className="icon-btn" aria-label="Add" title="Add">
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
						</MenuTrigger>
						<MenuContent className="title-menu">
							<MenuItem value="file">Attach a file</MenuItem>
							<MenuItem value="note">Attach a note</MenuItem>
							<MenuItem value="skill">Invoke a skill</MenuItem>
						</MenuContent>
					</Menu>
				) : (
					<>
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
					</>
				)}
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
									conversationId === undefined ? "Model for this chat" : "Conversation model"
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
									{/* The model quick menu is a plain ul, not the command
										primitive — but it shares the note picker's list
										rules (no bullets, capped scroll, row buttons),
										which the widening renamed from `.note-pick ul` to
										this class. */}
									<ul className="note-pick-list">
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
									? "Thinking level for this chat"
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
										? "Model for this chat"
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
				{busy && onStop !== undefined && isEmptyDraft(draft) ? (
					// Stop means stop: ask the runtime to abort the turn, then
					// let go of this client's stream. History keeps what was written.
					<button type="button" className="stop-btn" aria-label="Stop" onClick={onStop}>
						<svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12">
							<rect x="7" y="7" width="10" height="10" rx="2" />
						</svg>
					</button>
				) : (
				<div className="composer-send">
				{busy && onStop !== undefined && (
					<button
						type="button"
						className="queue-btn"
						aria-label="Queue as follow-up"
						title="Queue as follow-up (Alt+Enter)"
						disabled={configSaving || recording || isEmptyDraft(draft) || uploadState(draft) !== "ready"}
						onClick={() => send("followUp")}
					>
						Queue
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
						isEmptyDraft(draft) ||
						uploadState(draft) !== "ready"
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
				)}
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
					onPick={pickNote}
					onClose={() => setNotePickerOpen(false)}
				/>
			)}
			{skillPickerOpen && (
				<SkillPickerSheet
					token={token}
					onClose={() => setSkillPickerOpen(false)}
					onStage={stageSkill}
				/>
			)}
		</form>
	);
}
