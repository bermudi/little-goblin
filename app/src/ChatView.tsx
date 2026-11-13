import {
	Fragment,
	useEffect,
	useMemo,
	useRef,
	useState,
	type Dispatch,
	type ReactNode,
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
	getMessages,
	rateReply,
	stopConversation,
} from "./api.ts";
import { useConfirm } from "./confirm.tsx";
import { Outline } from "./Outline.tsx";
import { usePhoneWidth } from "./usePhoneWidth.ts";
import { DocViewerProvider } from "./docview.tsx";
import { InterruptedTurns } from "./InterruptedTurns.tsx";
import { MessageParts } from "./chat/MessageParts.tsx";
import { QuoteFab, type QuoteSpeaker } from "./chat/QuoteFab.tsx";
import {
	Composer,
	type StagedNote,
	type StagedSkill,
	type StagedUpload,
} from "./chat/Composer.tsx";
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
