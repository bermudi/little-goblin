import {
  Fragment,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport, getToolName, isToolUIPart,
  type ChatTransport, type UIMessage,
} from "ai";
import {
  branchConversation,
  getMessages,
  stopConversation,
} from "./api.ts";
import { useConfirm } from "./confirm.tsx";
import { Outline } from "./Outline.tsx";
import { usePhoneWidth } from "./usePhoneWidth.ts";
import { DocViewerProvider } from "./docview.tsx";
import { NoteConversationContext } from "./markdown.tsx";
import { copyInlineSelection, hasUiPart, MessageParts } from "./chat/MessageParts.tsx";
import { placeSentMedia } from "./chat/sentMedia.ts";
import { useTranscriptFollow } from "./chat/useTranscriptFollow.ts";
import { QuoteFab, type QuoteSpeaker } from "./chat/QuoteFab.tsx";
import { Composer } from "./chat/Composer.tsx";
import { SkillPickerSheet } from "./SkillPickerSheet.tsx";
import {
  draftFromMessages,
  draftToParts,
  isEmptyDraft,
  uploadState,
  type Chip,
  type Draft,
} from "./chat/draft.ts";
import { MessageBox, type MessageBoxHandle } from "./chat/MessageBox.tsx";
import { useAttachments } from "./chat/useAttachments.ts";
import { useSkillStaging } from "./chat/useSkillStaging.ts";
import {
  ActionBar,
  FoldMark,
  foldStartExcerpt,
  MetaLine,
  messageText,
  quotaOf,
  turnMeta,
  unlandedMeta,
  UserActions,
} from "./chat/MetaLine.tsx";
import { Age, messageCreatedAt } from "./chat/messageAge.tsx";
import type { AttachmentRef } from "../../src/agent/attachments.ts";
import type {
  AppCompactionMark,
  AppConfigView,
  AppConversationEvent,
  AppConversationMemoryView,
  AppLiveContext,
  AppPendingInput,
  AppRatedReply,
} from "../../src/http/app-wire.ts";
import { ResumeGate } from "./chat/resumeGate.ts";
import { makeSseParser } from "./sse.ts";
import { useLiveStoreOrNull } from "./useLive.tsx";
import { useReplyRatings } from "./chat/useReplyRatings.ts";
import { WorkHeader } from "./chat/WorkHeader.tsx";
import { LiveWork } from "./chat/LiveWork.tsx";

// ---------- the chat ----------

// A finished turn pings the OS only when the window isn't looking —
// the notification carries the answer's first line. Permission is
// requested once, from the send path's user gesture.
function notifyDone(title: string, text: string) {
  if (document.visibilityState !== "hidden") return;
  if (
    typeof Notification === "undefined" ||
    Notification.permission !== "granted"
  )
    return;
  const body = text.replace(/\s+/g, " ").trim().slice(0, 140);
  try {
    new Notification(title === "" ? "goblin" : `goblin — ${title}`, { body });
  } catch {
    /* some browsers only allow notifications from a service worker */
  }
}
function askNotifyPermission() {
  if (
    typeof Notification === "undefined" ||
    Notification.permission !== "default"
  )
    return;
  void Notification.requestPermission().catch(() => {});
}

function nowMinus(ms: number | undefined, now = Date.now()): number {
  return now - (ms ?? 0);
}

export function replyStarted(
  messages: readonly UIMessage[],
  settledTailId?: string,
): boolean {
  const hidden = placeSentMedia(messages).hidden;
  const visible = messages.filter((message) => !hidden.has(message));
  const lastUser = visible.findLastIndex((message) => message.role === "user");
  const lastAssistant = visible.findLastIndex((message) => message.role === "assistant");
  if (lastAssistant < lastUser || lastAssistant < 0) return false;
  const last = visible[lastAssistant];
  return last?.role === "assistant" && last.id !== settledTailId &&
    last.parts.some((p) => p.type !== "step-start");
}

// Union of the view and durable history by message id — the reconcile
// merge for an idle reconnect. History is the truth for finished
// messages; the view may additionally hold a live tail the store has
// not seen yet (a just-sent user message, the assistant mid-stream),
// and that tail must survive: the store's interleaving stands whole
// and the tail appends after it — nothing local is ever dropped.
export function mergeTranscript(
  current: UIMessage[],
  history: UIMessage[],
): UIMessage[] {
  const currentIds = new Set(current.map((m) => m.id));
  const historyIds = new Set(history.map((m) => m.id));
  // Everything the view holds is durable — the store's causal order
  // wins outright, arrivals or not. A steered message sorts before the
  // reply that folded it in, which the optimistic tail-append gets
  // backwards.
  if (current.every((m) => historyIds.has(m.id))) {
    // Same id AND role — a stopped turn's streamed assistant partial and
    // its durable system record share an id; the durable role wins so
    // the local partial is replaced, not kept beside the record. Same
    // order still takes history's content: a reader dropped mid-reply
    // (the mid-turn send handoff) leaves a partial the store has
    // finished (#658); unchanged messages keep their reference.
    const sameOrder =
      current.length === history.length &&
      current.every(
        (m, i) => m.id === history[i]!.id && m.role === history[i]!.role,
      );
    if (!sameOrder) return history;
    const merged = current.map((message, i) =>
      JSON.stringify(message) === JSON.stringify(history[i])
        ? message
        : history[i]!,
    );
    return merged.every((message, i) => message === current[i])
      ? current
      : merged;
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

export function rewindTranscript(
  messages: UIMessage[],
  event: { messageId: string; replacedBy: string },
): UIMessage[] {
  const index = messages.findIndex((message) => message.id === event.messageId);
  if (index === -1) return messages;
  return messages.slice(0, index + (event.replacedBy === event.messageId ? 1 : 0));
}

interface EditingMessage {
  id: string;
  draft: Draft;
  kept: UIMessage["parts"];
}

function EditMessageBox({
  editing,
  token,
  busy,
  onDraftChange,
  onSave,
  onCancel,
  onOpenNote,
}: {
  editing: EditingMessage;
  token: string | null;
  busy: boolean;
  onDraftChange: (draft: Draft) => void;
  onSave: () => void;
  onCancel: () => void;
  onOpenNote?: ((id: string) => void) | undefined;
}) {
  const editRef = useRef<HTMLDivElement | null>(null);
  const boxRef = useRef<MessageBoxHandle | null>(null);
  useEffect(() => {
    boxRef.current?.focus("end");
  }, []);
  const insertChips = useCallback((chips: Chip[]) => {
    boxRef.current?.insertChips(chips);
  }, []);
  const dropTarget = useCallback((target: EventTarget | null) => {
    const root = editRef.current;
    return root !== null && target !== null && root.contains(target as Node);
  }, []);
  const { fileInput, pickFile, uploadErrors, noteUploadError } = useAttachments({
    token,
    busy: false,
    onSend: () => false,
    insertChips,
    dropTarget,
  });
  const { skillPickerOpen, setSkillPickerOpen, stageSkill } = useSkillStaging({ insertChips });
  const currentUploadState = uploadState(editing.draft);
  return (
    <div
      className="msg-edit"
      data-message-edit
      ref={editRef}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <input
        ref={fileInput}
        type="file"
        hidden
        multiple
        onChange={(event) => {
          for (const file of Array.from(event.target.files ?? [])) void pickFile(file);
          event.target.value = "";
        }}
      />
      <MessageBox
        ref={boxRef}
        initial={editing.draft}
        onChange={onDraftChange}
        onFiles={(files) => files.forEach((file) => void pickFile(file))}
        onOpenNote={onOpenNote}
        onUploadFailed={noteUploadError}
        token={token}
        ariaLabel="Edit message"
        placeholder="Edit message"
      />
      <div className="msg-edit-tools">
        <button type="button" aria-label="Attach a file" onClick={() => fileInput.current?.click()}>
          file
        </button>
        <button type="button" aria-label="Add a skill" onClick={() => setSkillPickerOpen(true)}>
          skill
        </button>
      </div>
      {uploadErrors.map((message) => (
        <div key={message} className="error" role="alert">
          {message}
        </div>
      ))}
      {currentUploadState !== "ready" && (
        <div className="composer-note" role="status">
          Upload still running. Save when it finishes.
        </div>
      )}
      <div className="msg-edit-actions">
        <button type="button" onClick={onCancel}>cancel</button>
        <button
          type="button"
          className="primary"
          onClick={onSave}
          disabled={
            busy ||
            (isEmptyDraft(editing.draft) && editing.kept.length === 0) ||
            currentUploadState !== "ready"
          }
        >
          save &amp; resend
        </button>
      </div>
      {skillPickerOpen && (
        <SkillPickerSheet
          token={token}
          onClose={() => setSkillPickerOpen(false)}
          onStage={stageSkill}
        />
      )}
    </div>
  );
}

export function ChatView({
  token,
  conversationId,
  title,
  seed,
  followAfter,
  onSeeded,
  onSendAccepted,
  onOpenNote,
  onBranched,
  onRoll,
  focusSignal,
  rollDisabled,
  rolling = false,
  notePins = false,
  onRollingAccepted,
  onFollowStarted,
  header,
  now = Date.now(),
}: {
  token: string | null;
  conversationId: string;
  title: string | null;
  // The message an empty-state send parked while its conversation was
  // being created — delivered once, on mount.
  seed: UIMessage["parts"] | null;
  followAfter?: string | undefined;
  onSeeded: () => void;
  onSendAccepted?: (() => void) | undefined;
  // Note chips + fenced note cards navigate to the note page in-app.
  onOpenNote?: ((id: string) => void) | undefined;
  // A branch opened a new conversation — the host refreshes and opens it.
  onBranched?: ((id: string) => void) | undefined;
  onRoll?: (() => Promise<string | null>) | undefined;
  focusSignal?: number | undefined;
  rollDisabled?: boolean | undefined;
  rolling?: boolean;
  notePins?: boolean;
  onRollingAccepted?: ((id: string, rolled: boolean, messageId: string) => void) | undefined;
  onFollowStarted?: (() => void) | undefined;
  header?: ReactNode;
  now?: number;
}) {
  const [initial, setInitial] = useState<{
    messages: UIMessage[];
    start: number;
    olderCursor: string | null;
    ratings: AppRatedReply[];
    rateableMessageIds: string[];
    compactions: AppCompactionMark[];
  } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [focusOnce, setFocusOnce] = useState(focusSignal ?? 0);
  useEffect(() => {
    if (initial !== null && focusOnce !== 0) setFocusOnce(0);
  }, [initial, focusOnce]);
  useEffect(() => {
    let live = true;
    getMessages(token, conversationId).then(
      (r) =>
        live &&
        setInitial({
          messages: r.messages,
          start: r.start ?? 0,
          olderCursor: r.olderCursor ?? null,
          ratings: r.ratings,
          rateableMessageIds: r.rateableMessageIds,
          compactions: r.compactions ?? [],
        }),
      (err) =>
        live &&
        setLoadError(
          err instanceof Error ? err.message : "history failed to load",
        ),
    );
    return () => {
      live = false;
    };
  }, [token, conversationId]);

  if (loadError !== null)
    return <div className="error">History failed to load: {loadError}</div>;
  if (initial === null) return <div className="loading">…</div>;
  return (
    <NoteConversationContext value={conversationId}>
      <Chat
        conversationId={conversationId}
        title={title}
        token={token}
        initial={initial.messages}
        initialStart={initial.start}
        initialOlderCursor={initial.olderCursor}
        initialRatings={initial.ratings}
        initialRateableIds={initial.rateableMessageIds}
        initialCompactions={initial.compactions}
        seed={seed}
        followAfter={followAfter}
        onSeeded={onSeeded}
        onSendAccepted={onSendAccepted}
        onOpenNote={onOpenNote}
        onBranched={onBranched}
        onRoll={onRoll}
        focusSignal={focusOnce}
        rollDisabled={rollDisabled}
        rolling={rolling}
        notePins={notePins}
        onRollingAccepted={onRollingAccepted}
        onFollowStarted={onFollowStarted}
        header={header}
        now={now}
      />
    </NoteConversationContext>
  );
}

function Chat({
  token,
  conversationId,
  title,
  initial,
  initialStart,
  initialOlderCursor,
  initialRatings,
  initialRateableIds,
  initialCompactions,
  seed,
  followAfter,
  onSeeded,
  onSendAccepted,
  onOpenNote,
  onBranched,
  onRoll,
  focusSignal,
  rollDisabled,
  rolling = false,
  notePins = false,
  onRollingAccepted,
  onFollowStarted,
  header,
  now,
}: {
  token: string | null;
  conversationId: string;
  title: string | null;
  initial: UIMessage[];
  // Absolute causal index of initial[0] — fold-mark indexes and the
  // paging cursor are transcript-absolute; the loaded base drops as
  // older pages prepend.
  initialStart: number;
  initialOlderCursor: string | null;
  initialRatings: AppRatedReply[];
  initialRateableIds: string[];
  initialCompactions: AppCompactionMark[];
  seed: UIMessage["parts"] | null;
  followAfter?: string | undefined;
  onSeeded: () => void;
  onSendAccepted?: (() => void) | undefined;
  onOpenNote?: ((id: string) => void) | undefined;
  // A branch exists now — the host refreshes the rail and opens it.
  onBranched?: ((id: string) => void) | undefined;
  onRoll?: (() => Promise<string | null>) | undefined;
  focusSignal?: number | undefined;
  rollDisabled?: boolean | undefined;
  rolling?: boolean;
  notePins?: boolean;
  onRollingAccepted?: ((id: string, rolled: boolean, messageId: string) => void) | undefined;
  onFollowStarted?: (() => void) | undefined;
  header?: ReactNode;
  now: number;
}) {
  // The transport only reconnects; sends go through postChat. token
  // null = trust mode — the server wants no credential.
  // The SDK has no callback for "the resume found no live turn" (on
  // 204 the status never moves), so this wrapper is the seam that sees
  // the reconnect answer and feeds the gate.
  // A fresh conversation's seed skips only its first reconnect GET.
  // Captured at mount because the seed prop is cleared by onSeeded.
  const [gate] = useState(
    () => new ResumeGate(seed !== null && seed.length > 0),
  );
  const {
    ratings,
    ratingPending,
    ratingErrors,
    rateableIds,
    rate,
    applyRatingSnapshot,
  } = useReplyRatings(token, conversationId, initialRatings, initialRateableIds);
  // Fold pointers as transcript marks — a pill rides where each fold
  // ran, after the last message that existed then. Replaced wholesale
  // on every history read; a rewind's deleted marks must not linger.
  const [marks, setMarks] = useState<AppCompactionMark[]>(initialCompactions);
  // History older than the live window, paged in from the top. It is
  // durable-only — mergeTranscript never reconciles it, so it stays a
  // separate prefix rather than riding useChat's array (the merge
  // would park it after the newest page). `loadedStart` tracks the
  // absolute index of the oldest loaded entry for mark mapping.
  const [older, setOlder] = useState<UIMessage[]>([]);
  const [loadedStart, setLoadedStart] = useState(initialStart);
  const [olderCursor, setOlderCursor] = useState<string | null>(
    initialOlderCursor,
  );
  const [olderLoading, setOlderLoading] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);
  const loadOlder = () => {
    if (olderCursor === null || olderLoading) return;
    setOlderLoading(true);
    setOlderError(null);
    anchorScroll.current = scrollRef.current?.scrollHeight ?? null;
    void getMessages(token, conversationId, olderCursor)
      .then(
        (r) => {
          setOlder((current) => {
            const held = new Set(current.map((m) => m.id));
            return [...r.messages.filter((m) => !held.has(m.id)), ...current];
          });
          setLoadedStart(r.start);
          setOlderCursor(r.olderCursor);
          setMarks(r.compactions ?? []);
          applyRatingSnapshot(r.ratings, r.rateableMessageIds);
        },
        (err: unknown) =>
          setOlderError(
            err instanceof Error ? err.message : "history failed to load",
          ),
      )
      .finally(() => setOlderLoading(false));
  };
  // Prepending a page must not jump the view: the scrollTop rides down
  // by the height the new rows added.
  const anchorScroll = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el !== null && anchorScroll.current !== null) {
      el.scrollTop += el.scrollHeight - anchorScroll.current;
      anchorScroll.current = null;
    }
  }, [older.length]);
  // Rewriting a prompt is a rewind: everything from that message onward
  // is dropped on the server before the edited text becomes the next
  // turn. The backup exists only for an edit that fails while the
  // transcript refresh cannot reach the server; in every other failure
  // the durable history reconciles the view.
  const [editing, setEditing] = useState<EditingMessage | null>(
    null,
  );
  const editBackup = useRef<UIMessage[] | null>(null);
  const confirm = useConfirm();
  // A branch is a copy in a new chat; the click opens it via the host's
  // navigation. Errors stay on the reply's action row.
  const [branchPending, setBranchPending] = useState<string | null>(null);
  const [branchErrors, setBranchErrors] = useState<Record<string, string>>({});
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
    });
    return {
      sendMessages: (options) => base.sendMessages(options),
      reconnectToStream: async (options) => {
        const { skipNetwork } = gate.beginReconnect();
        try {
          // The seeded first reconnect answers "nothing live" without a
          // GET or reconcile: a just-created conversation has neither.
          const stream = skipNetwork
            ? null
            : await base.reconnectToStream(options);
          if (!skipNetwork) gate.reconnectAnswered(stream !== null);
          // null is the server's 204 — nothing is live, and the runtime
          // persists each reply before it retires the wire, so durable
          // history is already final. The mount-time snapshot may be
          // older than that; the view reconciles.
          return stream;
        } finally {
          gate.probeSettled();
        }
      },
    };
  }, [token, gate]);
  // The running turn's window occupancy — each model step pushes it over
  // the wire as a transient data-context part (never persisted). The
  // gauge shows it while busy; cleared when a new turn starts so a fresh
  // turn never wears the previous turn's last figure.
  const [liveCtx, setLiveCtx] = useState<AppLiveContext | null>(null);
  const {
    messages,
    status,
    error,
    stop,
    setMessages,
    resumeStream,
  } = useChat({
    id: conversationId,
    messages: initial,
    transport,
    // Reconnect to a live turn on mount: a reload mid-turn resumes the
    // in-flight reply instead of showing a finished-looking chat whose
    // next send would steer a ghost turn.
    resume: true,
    onData: (part) => {
      if (part.type !== "data-context") return;
      const d = (
        typeof part.data === "object" && part.data !== null ? part.data : {}
      ) as Record<string, unknown>;
      const num = (v: unknown) => (typeof v === "number" ? v : null);
      const quota = quotaOf(d.quota);
      setLiveCtx({
        input: num(d.input),
        cacheRead: num(d.cacheRead),
        ...(quota !== undefined ? { quota } : {}),
      });
    },
    onFinish: ({ message, isAbort, isError }) => {
      gate.readerEnded();
      // The edit's server-side answer is final now — a later
      // onError must not resurrect the pre-edit transcript. The
      // SDK fires this on errored turns too, so the done-bell
      // waits for a real finish and the re-sync covers both.
      editBackup.current = null;
      // An aborted reader is not a finished reply — the bell belongs to the real finish.
      if (!isAbort && !isError) notifyDone(title ?? "", messageText(message));
      // Durable history is reconciled by the independent turn-end event.
    },
    onError: () => {
      gate.readerEnded();
      // The durable transcript is the truth in every failure mode: a
      // refused request never reached the store (the tail stands
      // there), and a post-commit failure already deleted it — only
      // the server knows which, so reconcile from it — by REPLACE,
      // not merge: the optimistic replacement carries a client id
      // the store never saw, and a merge would keep it beside the
      // original exchange the server still holds. The pre-edit
      // backup covers a refresh that cannot get there.
      const backup = editBackup.current;
      editBackup.current = null;
      if (backup === null) return;
      reloadTranscript("replace", backup);
    },
  });
  const reloadTranscript = (mode: "merge" | "replace", fallback?: UIMessage[]) => {
    void getMessages(token, conversationId).then(
      (r) => {
        setMessages((current) =>
          mode === "merge" ? mergeTranscript(current, r.messages) : r.messages,
        );
        applyRatingSnapshot(r.ratings, r.rateableMessageIds);
        setMarks(r.compactions ?? []);
      },
      () => {
        if (fallback !== undefined) setMessages(fallback);
      },
    );
  };
  const refreshTranscript = () => reloadTranscript("merge");
  const [pendingItems, setPendingItems] = useState<AppPendingInput[]>([]);
  const [draftRestore, setDraftRestore] = useState<{
    messages: UIMessage["parts"][];
    source?: "pending-edit";
    ids?: string[];
  } | null>(null);
  const takenPendingIds = useRef(new Set<string>());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const refreshPending = () => {
    void fetch(
      `/api/app/conversations/${encodeURIComponent(conversationId.slice(4))}/pending`,
      { headers: token === null ? {} : { authorization: `Bearer ${token}` } },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error(`pending input failed (${response.status})`);
        const value = (await response.json()) as { items?: AppPendingInput[] };
        if (!Array.isArray(value.items)) throw new Error("invalid pending input response");
        setPendingItems(value.items);
      })
      .catch(() => {});
  };
  const refreshPendingOnMount = useEffectEvent(() => refreshPending());
  useEffect(() => {
    refreshPendingOnMount();
  }, [conversationId, token]);
  // A failed /stop means the client dropped its stream but the turn
  // keeps running server-side and will write the reply the operator
  // asked to stop — that has to be visible, not swallowed.
  const [stopError, setStopError] = useState<string | null>(null);
  useEffect(() => {
    setMarks(initialCompactions);
  }, [initialCompactions]);

  const [resumed, setResumed] = useState(0);
  const onResume = useEffectEvent(() => {
    if (document.visibilityState !== "visible") return;
    setResumed((n) => n + 1);
    refreshTranscript();
    refreshPending();
  });
  useEffect(() => {
    const resume = () => onResume();
    document.addEventListener("visibilitychange", resume);
    return () => document.removeEventListener("visibilitychange", resume);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let retry = 250;
    let firstState = true;
    const run = async () => {
      while (!controller.signal.aborted) {
        try {
          const response = await fetch(
            `/api/app/conversations/${encodeURIComponent(conversationId.slice(4))}/events`,
            {
              headers: token === null ? {} : { authorization: `Bearer ${token}` },
              signal: controller.signal,
            },
          );
          if (!response.ok || response.body === null) throw new Error(`events failed (${response.status})`);
          retry = 250;
          const parse = makeSseParser((data) => {
            const event = JSON.parse(data) as AppConversationEvent;
            onConversationEvent(event, firstState);
            if (event.type === "state" && firstState) firstState = false;
          });
          const reader = response.body.getReader();
          while (!controller.signal.aborted) {
            const { value, done } = await reader.read();
            if (done) break;
            parse(value);
          }
        } catch (err) {
          if (controller.signal.aborted) return;
          console.warn("conversation events disconnected", err);
        }
        await new Promise((resolve) => setTimeout(resolve, retry));
        retry = Math.min(retry * 2, 10_000);
      }
    };
    void run();
    return () => controller.abort();
  }, [token, conversationId, resumed]);

  const scrollRef = useRef<HTMLDivElement>(null);
  // The outline rail is a pointer/keyboard affordance — phones don't
  // hover, so it never mounts there (the stylesheet hides it too).
  const phone = usePhoneWidth();
  // Select-to-quote: each QuoteFab click bumps `n`; the Composer appends
  // the text as a blockquote with the quoted speaker's annotation.
  const [quote, setQuote] = useState<{
    text: string;
    speaker: QuoteSpeaker | null;
    messageId: string | null;
    n: number;
  }>({
    text: "",
    speaker: null,
    messageId: null,
    n: 0,
  });
  const contentRef = useRef<HTMLDivElement>(null);
  const follow = useTranscriptFollow(scrollRef, contentRef, followAfter);
  const [eventsLive, setEventsLive] = useState(false);
  const [workStartedAt, setWorkStartedAt] = useState(() => nowMinus(0));
  const workStartKnown = useRef(false);
  const [finishedWork, setFinishedWork] = useState<{
    id: string;
    durationMs: number;
  } | null>(null);
  const [submitPending, setSubmitPending] = useState(false);
  const [settledTailId, setSettledTailId] = useState<string | null>(null);
  const busy = eventsLive || submitPending || status === "submitted" || status === "streaming";
  useLayoutEffect(() => {
    if (!busy) {
      workStartKnown.current = false;
    } else if (!workStartKnown.current) {
      workStartKnown.current = true;
      setWorkStartedAt(nowMinus(0));
    }
  }, [busy]);
  const [sendFailure, setSendFailure] = useState<string | null>(null);
  const resumeFromEvents = () => {
    if (gate.requestResume())
      void resumeStream().catch((err: unknown) =>
        console.error("Couldn't resume stream", err),
      );
  };
  const live = useLiveStoreOrNull();
  const onConversationEvent = useEffectEvent(
    (event: AppConversationEvent, firstState: boolean) => {
      const activeReader = gate.readerAttached;
      const rememberFinishedWork = () => {
        if (!replyStarted(displayed, settledTailId ?? undefined)) return;
        const hidden = placeSentMedia(displayed).hidden;
        const reply = displayed.findLast(
          (message) => message.role === "assistant" && !hidden.has(message),
        );
        if (reply?.parts.some((part) => isToolUIPart(part) && getToolName(part) !== "ui")) {
          setFinishedWork({ id: reply.id, durationMs: Math.max(0, nowMinus(workStartedAt)) });
        }
      };
      if (event.type === "state") {
        if (event.live) {
          workStartKnown.current = true;
          setWorkStartedAt(nowMinus(event.elapsedMs));
        } else if (gate.serverLive) {
          rememberFinishedWork();
        }
        if (!firstState) refreshTranscript();
        gate.serverLive = event.live;
        setEventsLive(event.live);
        if (event.live) setSubmitPending(false);
        if (event.live && !activeReader) resumeFromEvents();
      } else if (event.type === "turn-start") {
        workStartKnown.current = true;
        setFinishedWork(null);
        setWorkStartedAt(nowMinus(event.elapsedMs));
        const tail = displayed.at(-1);
        if (tail?.role === "assistant") setSettledTailId(tail.id);
        gate.serverLive = true;
        setEventsLive(true);
        setSubmitPending(false);
        if (!activeReader) resumeFromEvents();
      } else if (event.type === "turn-end") {
        rememberFinishedWork();
        setSettledTailId(null);
        follow.endTurn();
        gate.serverLive = false;
        setEventsLive(false);
        setSubmitPending(false);
        refreshTranscript();
        refreshPending();
        if (live !== null && live.status() !== "live") void live.refresh("conversations");
      } else if (event.type === "rewound") {
        setMessages((current) => rewindTranscript(current, event));
        refreshTranscript();
      } else if (event.type === "pending") {
        setSubmitPending(false);
        refreshPending();
      }
    },
  );
  // Reload-window reconciliation: a turn that completed between the
  // history snapshot and the idle reconnect is durably stored but
  // missing from the snapshot — re-read history once and merge. A new
  // turn that started meanwhile is accounted for by the merge (its
  // persisted user message arrives; a live local tail is never
  // dropped). A failed re-read leaves the snapshot standing.
  const onIdle = useEffectEvent(() => reloadTranscript("merge"));
  const onSettled = useEffectEvent(() => {
    if (gate.serverLive && !gate.readerAttached) resumeFromEvents();
  });
  useEffect(
    () => gate.subscribe({ idle: onIdle, settled: onSettled }),
    [gate],
  );

  const postChat = async (
    body: Record<string, unknown>,
    routeRolling = false,
    postedMessageId?: string,
  ) => {
    const response = await fetch("/api/app/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(routeRolling ? { rolling: true, ...body } : { conversationId, ...body }),
    });
    if (response.status !== 202) {
      const detail = (await response.json().catch(() => null)) as { error?: unknown } | null;
      throw new Error(typeof detail?.error === "string" ? detail.error : `send failed (${response.status})`);
    }
    const result = (await response.json()) as {
      pendingId?: unknown;
      conversationId?: unknown;
      rolled?: unknown;
    };
    onSendAccepted?.();
    if (rolling && typeof result.conversationId === "string" && postedMessageId !== undefined)
      onRollingAccepted?.(result.conversationId, result.rolled === true, postedMessageId);
    return result;
  };
  const submit = async (
    message: { parts?: UIMessage["parts"]; text?: string },
    whenBusy: "steer" | "followUp" = "steer",
  ): Promise<boolean> => {
    setSettledTailId(null);
    setLiveCtx(null);
    setSendFailure(null);
    const optimistic: UIMessage = {
      id: crypto.randomUUID(),
      role: "user",
      parts: message.parts ?? [{ type: "text", text: message.text ?? "" }],
    };
    const wasBusy = busy;
    if (!wasBusy) {
      workStartKnown.current = true;
      setWorkStartedAt(nowMinus(0));
      setFinishedWork(null);
    }
    if (wasBusy) follow.jumpToEnd();
    else follow.followReply(optimistic.id);
    const optimisticPendingId = `optimistic-${optimistic.id}`;
    if (wasBusy) {
      setPendingItems((current) => [
        ...current,
        {
          id: optimisticPendingId,
          mode: whenBusy,
          message: optimistic as unknown as AppPendingInput["message"],
          createdAt: new Date(now).toISOString(),
          status: "waiting",
        },
      ]);
    } else {
      setMessages((current) => [...current, optimistic]);
    }
    setSubmitPending(true);
    try {
      const result = await postChat({ message: optimistic, whenBusy }, rolling, optimistic.id);
      if (typeof result.pendingId === "string") {
        setMessages((current) => current.filter((item) => item.id !== optimistic.id));
        setPendingItems((current) =>
          current.map((item) =>
            item.id === optimisticPendingId ? { ...item, id: result.pendingId as string } : item,
          ),
        );
        refreshPending();
      }
      return true;
    } catch (err) {
      setMessages((current) => current.filter((item) => item.id !== optimistic.id));
      setPendingItems((current) => current.filter((item) => item.id !== optimisticPendingId));
      setSubmitPending(false);
      setSendFailure(err instanceof Error ? err.message : "send failed");
      return false;
    }
  };
  const submitLatest = useRef(submit);
  useLayoutEffect(() => {
    submitLatest.current = submit;
  });
  const onUiAction = useCallback((text: string) => void submitLatest.current({ text }), []);

  const mergeDraftRestore = (parts: UIMessage["parts"], ids: string[]) => {
    setDraftRestore((current) => ({
      messages: [...(current?.messages ?? []), parts],
      source: "pending-edit",
      ids: [...(current?.ids ?? []), ...ids],
    }));
  };

  const dequeuePending = async (item: AppPendingInput, edit: boolean) => {
    takenPendingIds.current.add(item.id);
    try {
      const response = await fetch(
        `/api/app/conversations/${encodeURIComponent(conversationId.slice(4))}/pending/${encodeURIComponent(item.id)}`,
        {
          method: "DELETE",
          headers: token === null ? {} : { authorization: `Bearer ${token}` },
        },
      );
      if (response.status === 409) {
        refreshPending();
        refreshTranscript();
        return;
      }
      if (!response.ok) throw new Error(`pending input action failed (${response.status})`);
      const body = (await response.json()) as { message: AppPendingInput["message"] };
      setPendingItems((current) => current.filter((row) => row.id !== item.id));
      if (edit)
        mergeDraftRestore(body.message.parts as UIMessage["parts"], []);
      refreshPending();
    } catch (err) {
      takenPendingIds.current.delete(item.id);
      setSendFailure(err instanceof Error ? err.message : "pending input action failed");
    }
  };

  const returnPendingRow = async (id: string): Promise<void> => {
    try {
      const response = await fetch(
        `/api/app/conversations/${encodeURIComponent(conversationId.slice(4))}/pending/${encodeURIComponent(id)}`,
        {
          method: "DELETE",
          headers: token === null ? {} : { authorization: `Bearer ${token}` },
        },
      );
      if (response.status === 409) return;
      if (!response.ok) console.warn(`pending input return failed (${response.status})`);
    } catch (err) {
      console.warn("pending input return failed", err);
    }
  };

  const { stick } = follow;
  useLayoutEffect(stick, [stick, messages, busy]);

  // A seed arrives once (empty-state send → conversation created → this view mounts).
  const seeded = useRef(false);
  const followStarted = useRef(false);
  const submitSeed = useEffectEvent((parts: UIMessage["parts"]) => submit({ parts }));
  useEffect(() => {
    if (seeded.current || seed === null || seed.length === 0) return;
    seeded.current = true;
    onSeeded();
    void submitSeed(seed).catch((err: unknown) => console.error("Couldn't submit seeded message", err));
  }, [seed, onSeeded]);
  useEffect(() => {
    if (followAfter === undefined || followStarted.current) return;
    followStarted.current = true;
    onFollowStarted?.();
  }, [followAfter, onFollowStarted]);

  // The rendered transcript: paged-in durable prefix, then the live
  // window (newest durable page plus any optimistic tail). Fold-mark
  // indexes are transcript-absolute — subtracting loadedStart maps
  // them onto displayed; marks deeper than the loaded range hold
  // until their page arrives.
  const displayed = useMemo(() => [...older, ...messages], [older, messages]);
  const placedMedia = useMemo(() => placeSentMedia(displayed), [displayed]);
  const visible = useMemo(
    () => displayed.filter((m) => !placedMedia.hidden.has(m)),
    [displayed, placedMedia],
  );
  // The retry affordance belongs to the newest answer — anything older
  // gets copy/read only.
  const lastAssistantId = messages.findLast(
    (m) => m.role === "assistant" && !placedMedia.hidden.has(m),
  )?.id;
  const liveReplyId = busy && replyStarted(displayed, settledTailId ?? undefined)
    ? lastAssistantId
    : undefined;
  const idleWithReply =
    !eventsLive && !submitPending && displayed.at(-1)?.role === "assistant";
  useEffect(() => {
    if (idleWithReply) follow.endTurn();
  }, [idleWithReply, follow]);
  const viewMarks = useMemo(
    () =>
      marks
        .map((mark) => ({
          ...mark,
          afterIndex: mark.afterIndex - loadedStart,
          firstKeptIndex: mark.firstKeptIndex - loadedStart,
        }))
        .filter((mark) => mark.afterIndex >= -1),
    [marks, loadedStart],
  );
  // Fold marks interleave by display index — the pill sits where the
  // fold ran, after the last message that existed then; afterIndex -1
  // is a fold older than every message, rendered at the top. The
  // newest pointer is the live boundary the model's context currently
  // starts from. Two folds can land on one index, so each slot holds
  // a list.
  const marksByIndex = new Map<number, AppCompactionMark[]>();
  const topMarks: AppCompactionMark[] = [];
  for (const mark of viewMarks) {
    if (mark.afterIndex < 0) {
      topMarks.push(mark);
      continue;
    }
    const list = marksByIndex.get(mark.afterIndex) ?? [];
    list.push(mark);
    marksByIndex.set(mark.afterIndex, list);
  }
  const liveMark = viewMarks[viewMarks.length - 1];

  const beginEdit = (m: UIMessage) => {
    if (busy) return;
    const editable = m.parts.filter(
      (part) =>
        part.type === "text" ||
        part.type === "data-attachment" ||
        part.type === "data-note" ||
        part.type === "data-skill",
    );
    setEditing({
      id: m.id,
      draft: draftFromMessages([editable]),
      kept: m.parts.filter((part) => part.type !== "data-chat-note-notices" && !editable.includes(part)),
    });
  };
  const cancelEdit = () => setEditing(null);
  const saveEdit = async (m: UIMessage) => {
    if (busy || editing === null || editing.id !== m.id) return;
    const index = messages.findIndex((x) => x.id === m.id);
    if (index === -1) return;
    if (uploadState(editing.draft) !== "ready") return;
    if (isEmptyDraft(editing.draft) && editing.kept.length === 0) return;
    const parts = [...draftToParts(editing.draft), ...editing.kept];
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
    editBackup.current = messages;
    setEditing(null);
    workStartKnown.current = true;
    setWorkStartedAt(nowMinus(0));
    setFinishedWork(null);
    setSettledTailId(null);
    setLiveCtx(null);
    setMessages(messages.slice(0, index));
    const optimistic: UIMessage = {
      id: crypto.randomUUID(),
      role: "user",
      parts,
    };
    follow.followReply(optimistic.id);
    setMessages([...messages.slice(0, index), optimistic]);
    setSubmitPending(true);
    void postChat({ message: optimistic, editMessageId: m.id }).catch((err: unknown) => {
      editBackup.current = null;
      reloadTranscript("replace", messages);
      setSubmitPending(false);
      setSendFailure(err instanceof Error ? err.message : "edit failed");
    });
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

  const waitingItems = pendingItems.filter((item) => item.status !== "notSent");
  const notSentItems = pendingItems.filter((item) => item.status === "notSent");
  const pendingRow = (item: AppPendingInput) => (
    <div className="pending-input" key={item.id}>
      <button
        type="button"
        className="pending-input-edit"
        aria-label={
          item.status === "notSent"
            ? "Edit not sent message"
            : `Edit ${item.mode === "followUp" ? "queued" : "steer"} input`
        }
        onClick={() => void dequeuePending(item, true)}
      >
        {item.status === "notSent" ? null : (
          <span className="pending-input-mode">
            {item.mode === "followUp" ? "Queued" : "Steer"}
          </span>
        )}
        <span>{messageText(item.message as unknown as UIMessage)}</span>
      </button>
      <button
        type="button"
        className="pending-input-remove"
        aria-label={
          item.status === "notSent" ? "Remove not sent message" : "Remove pending input"
        }
        onClick={() => void dequeuePending(item, false)}
      >
        ×
      </button>
    </div>
  );

  return (
    <DocViewerProvider token={token} conversationId={conversationId}>
      <div className="chat">
        {header}
        <QuoteFab
          root={scrollRef}
          onQuote={(text, speaker, messageId) =>
            setQuote((q) => ({ text, speaker, messageId, n: q.n + 1 }))
          }
        />
        {/* The outline is a hover rail — a pointer affordance, so it does
				    not exist in a phone DOM at all. */}
        {phone ? null : (
          <Outline messages={visible} scrollRef={scrollRef} onGesture={follow.gesture} />
        )}
        <div className="transcript" ref={scrollRef}>
          <div className="transcript-inner" ref={contentRef}>
            {displayed.length === 0 && <p className="empty">Say something.</p>}
            {olderCursor !== null && (
              <button
                type="button"
                className="load-older"
                onClick={loadOlder}
                disabled={olderLoading}
              >
                {olderLoading ? "Loading…" : "Load older"}
              </button>
            )}
            {olderError !== null && (
              <div className="error" role="alert">
                Older messages failed to load: {olderError}
              </div>
            )}
            {topMarks.map((mark, i) => (
              <FoldMark
                key={`top-${i}`}
                mark={mark}
                live={mark === liveMark}
                keptStart={foldStartExcerpt(mark, displayed)}
              />
            ))}
            {displayed.map((m, i) => {
              let el: ReactNode = null;
              const placeholder = busy && m.role === "assistant" &&
                m.id === lastAssistantId && m.id !== settledTailId &&
                m.parts.every((p) => p.type === "step-start");
              if (placedMedia.hidden.has(m) || placeholder) {
                if (!marksByIndex.has(i)) return null;
              } else if (m.role === "user") {
                const isEditing = editing !== null && editing.id === m.id;
                const prevUser = displayed[i - 1]?.role === "user";
                const nextUser = displayed[i + 1]?.role === "user";
                el = (
                  <div
                    className={`msg user${prevUser ? " after-user" : ""}${nextUser ? " before-user" : ""}`}
                    data-outline-anchor={m.id}
                    data-message-id={m.id}
                    onCopy={copyInlineSelection}
                  >
                    {isEditing ? (
                      <EditMessageBox
                        editing={editing}
                        token={token}
                        busy={busy}
                        onDraftChange={(draft) =>
                          setEditing((current) =>
                            current !== null && current.id === m.id
                              ? { ...current, draft }
                              : current,
                          )
                        }
                        onSave={() => void saveEdit(m)}
                        onCancel={cancelEdit}
                        onOpenNote={onOpenNote}
                      />
                    ) : (
                      <>
                        <UserFold>
                          <MessageParts
                            parts={m.parts}
                            token={token}
                            onOpenNote={onOpenNote}
                            clipFences
                          />
                        </UserFold>
                        <UserActions
                          message={m}
                          disabled={busy}
                          onEdit={
                            i >= older.length ? () => beginEdit(m) : undefined
                          }
                        />
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
                        messages={hasUiPart(m.parts) ? displayed : undefined}
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
                        messages={hasUiPart(m.parts) ? displayed : undefined}
                        onOpenNote={onOpenNote}
                      />
                    </details>
                  );
                  if (unlanded.reply !== null) {
                    const at = messageCreatedAt(m);
                    el = (
                      <div className="msg assistant unlanded">
                        <MessageParts
                          parts={unlanded.reply}
                          sentMedia={placedMedia.byReply.get(m.id)}
                          token={token}
                          messages={hasUiPart(unlanded.reply) ? displayed : undefined}
                          onOpenNote={onOpenNote}
                          ended
                        />
                        <div className="msg-meta">
                          {label}
                          {at !== null && (
                            <>
                              {" · "}
                              <Age at={at} />
                            </>
                          )}
                        </div>
                        {note}
                      </div>
                    );
                  } else {
                    el = <div className="msg system">{note}</div>;
                  }
                }
              } else {
                const meta = turnMeta(m);
                const hasTools = m.parts.some(
                  (p) => isToolUIPart(p) && getToolName(p) !== "ui",
                );
                let header: ReactNode = null;
                if (m.id === liveReplyId) {
                  header = <WorkHeader startedAt={workStartedAt} />;
                } else if (hasTools && meta !== null) {
                  header = <WorkHeader durationMs={meta.durationMs} />;
                } else if (hasTools && finishedWork?.id === m.id) {
                  header = <WorkHeader durationMs={finishedWork.durationMs} />;
                }
                el = (
                  <div
                    className={
                      status === "streaming" && m.id === lastAssistantId
                        ? "msg assistant streaming"
                        : "msg assistant"
                    }
                    data-message-id={m.id}
                  >
                    {header}
                    <MessageParts
                      parts={m.parts}
                      sentMedia={placedMedia.byReply.get(m.id)}
                      token={token}
                      busy={busy}
                      working={m.id === liveReplyId}
                      streaming={
                        status === "streaming" && m.id === lastAssistantId
                      }
                      messages={hasUiPart(m.parts) ? displayed : undefined}
                      onOpenNote={onOpenNote}
                      onAction={onUiAction}
                    />
                    <ActionBar
                      message={m}
                      isLastAssistant={m.id === lastAssistantId}
                      busy={busy}
                      onRetry={() => {
                        setSettledTailId(null);
                        workStartKnown.current = true;
                        setWorkStartedAt(nowMinus(0));
                        setFinishedWork(null);
                        setLiveCtx(null);
                        setSendFailure(null);
                        const lastUserIndex = messages.map((item) => item.role).lastIndexOf("user");
                        if (lastUserIndex < 0) return;
                        follow.followReply(messages[lastUserIndex]!.id);
                        setMessages(messages.slice(0, lastUserIndex + 1));
                        setSubmitPending(true);
                        void postChat({ retry: true }).catch((err: unknown) => {
                          refreshTranscript();
                          setSubmitPending(false);
                          setSendFailure(err instanceof Error ? err.message : "retry failed");
                        });
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
                      keptStart={foldStartExcerpt(mark, displayed)}
                    />
                  ))}
                </Fragment>
              );
            })}
            {busy && !replyStarted(displayed, settledTailId ?? undefined) && (
              <div className="msg assistant pending">
                <WorkHeader startedAt={workStartedAt} />
                <details className="worked live">
                  <summary><LiveWork /></summary>
                </details>
                <div className="msg-actions pending-actions" aria-hidden="true">
                  <button tabIndex={-1}>copy</button>
                </div>
              </div>
            )}
            {waitingItems.length > 0 && (
              <section className="pending-inputs" aria-label="Pending input">
                <h3>Pending input</h3>
                {waitingItems.map(pendingRow)}
              </section>
            )}
            {notSentItems.length > 0 && (
              <section className="pending-inputs" aria-label="Not sent">
                <h3>Not sent</h3>
                {notSentItems.map(pendingRow)}
              </section>
            )}
          {error !== undefined && (
            <div className="error">The turn failed: {error.message}</div>
          )}
          {sendFailure !== null && (
            <div className="error" role="alert">{sendFailure}</div>
          )}
          </div>
          {follow.below && (
            <div className="jump-latest-slot">
              <button
                type="button"
                className={busy ? "jump-latest live" : "jump-latest"}
                aria-label="Jump to latest"
                onClick={follow.jumpToEnd}
              >
                ↓
              </button>
            </div>
          )}
        </div>
        {stopError !== null && (
          <div className="error" role="alert">
            Stop request failed — the turn keeps running server-side:{" "}
            {stopError}
          </div>
        )}
        <Composer
          token={token}
          conversationId={conversationId}
          draftScope={conversationId}
          busy={busy}
          liveCtx={liveCtx}
          onOpenNote={onOpenNote}
          notes={notePins ? { kind: "chat", conversationId, rolling } : undefined}
          onGoToQuote={(messageId) => {
            const source = scrollRef.current?.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
            if (!(source instanceof HTMLElement)) return false;
            source.scrollIntoView({ block: "center" });
            source.classList.add("quote-source-flash");
            setTimeout(() => source.classList.remove("quote-source-flash"), 1200);
            follow.gesture("up");
            return true;
          }}
          quote={quote}
          draftRestore={draftRestore}
          onDraftRestored={() => {
            const ids = draftRestore?.ids ?? [];
            setDraftRestore(null);
            if (ids.length === 0) return;
            setTimeout(() => {
              void Promise.allSettled(ids.map((id) => returnPendingRow(id))).then(() => {
                if (alive.current) refreshPending();
              });
            }, 0);
          }}
          stealFocus
          onCompacted={refreshTranscript}
          onRoll={onRoll}
          focusSignal={focusSignal ?? 0}
          rollDisabled={displayed.length === 0 || rollDisabled === true}
          onSend={(parts, whenBusy) => {
            askNotifyPermission();
            return submit({ parts }, whenBusy);
          }}
          onStop={() => {
            setStopError(null);
            // The stop route settles the turn before responding — the
            // unlanded record is in history by then, so one refresh
            // swaps the local partial for the durable record.
            void stopConversation(token, conversationId)
              .then((result) => {
                if (!alive.current) return;
                refreshTranscript();
                const returned = result.notSent.filter(
                  (entry) => !takenPendingIds.current.has(entry.id),
                );
                if (returned.length === 0) return;
                for (const entry of returned)
                  mergeDraftRestore(
                    entry.message.parts as UIMessage["parts"],
                    [entry.id],
                  );
              })
              .catch((err: unknown) => {
                if (!alive.current) return;
                setStopError(
                  err instanceof Error ? err.message : "request failed",
                );
                refreshPending();
              });
            void stop();
          }}
        />
        {confirm.view}
      </div>
    </DocViewerProvider>
  );
}

// A long user message folds to a preview so a paste doesn't own the
// transcript; the full text stays in the DOM for select and find. The
// fold is decided from rendered height (the CSS cap), not source lines:
// soft-wrapped lines join into one paragraph.
function UserFold({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (el === null || open) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    const ro = new window.ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);
  return (
    <>
      <div ref={box} className={open ? "user-fold" : overflows ? "user-fold folded clipped" : "user-fold folded"}>
        {children}
      </div>
      {(open || overflows) && (
        <button
          type="button"
          className="user-fold-toggle"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </>
  );
}
