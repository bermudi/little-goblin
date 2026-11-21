import {
  Fragment,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type ChatTransport, type UIMessage } from "ai";
import {
  branchConversation,
  getMessages,
  stopConversation,
} from "./api.ts";
import { useConfirm } from "./confirm.tsx";
import { Outline } from "./Outline.tsx";
import { usePhoneWidth } from "./usePhoneWidth.ts";
import { DocViewerProvider } from "./docview.tsx";
import { hasUiPart, MessageParts } from "./chat/MessageParts.tsx";
import { useTranscriptFollow } from "./chat/useTranscriptFollow.ts";
import { QuoteFab, type QuoteSpeaker } from "./chat/QuoteFab.tsx";
import { Composer } from "./chat/Composer.tsx";
import type { StagedNote, StagedSkill, StagedUpload } from "./chat/staged.ts";
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
import { useReplyRatings } from "./chat/useReplyRatings.ts";

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

export function replyStarted(
  messages: readonly UIMessage[],
  settledTailId?: string,
): boolean {
  const last = messages.at(-1);
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
  now = Date.now(),
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
      now={now}
    />
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
  const [editing, setEditing] = useState<{ id: string; draft: string } | null>(
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
      onTurnDone();
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
    parts: UIMessage["parts"];
    source?: "pending-edit";
  } | null>(null);
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
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          while (!controller.signal.aborted) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const frames = buffer.split("\n\n");
            buffer = frames.pop() ?? "";
            for (const frame of frames) {
              const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
              if (data === undefined) continue;
              const event = JSON.parse(data) as AppConversationEvent;
              onConversationEvent(event, firstState);
              if (event.type === "state" && firstState) firstState = false;
            }
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
  }, [token, conversationId]);

  const scrollRef = useRef<HTMLDivElement>(null);
  // The outline rail is a pointer/keyboard affordance — phones don't
  // hover, so it never mounts there (the stylesheet hides it too).
  const phone = usePhoneWidth();
  // Select-to-quote: each QuoteFab click bumps `n`; the Composer appends
  // the text as a blockquote with the quoted speaker's annotation.
  const [quote, setQuote] = useState<{
    text: string;
    speaker: QuoteSpeaker | null;
    n: number;
  }>({
    text: "",
    speaker: null,
    n: 0,
  });
  const contentRef = useRef<HTMLDivElement>(null);
  const follow = useTranscriptFollow(scrollRef, contentRef);
  const [eventsLive, setEventsLive] = useState(false);
  const [submitPending, setSubmitPending] = useState(false);
  const [settledTailId, setSettledTailId] = useState<string | null>(null);
  const busy = eventsLive || submitPending || status === "submitted" || status === "streaming";
  const [sendFailure, setSendFailure] = useState<string | null>(null);
  const resumeFromEvents = () => {
    if (gate.requestResume())
      void resumeStream().catch((err: unknown) =>
        console.error("Couldn't resume stream", err),
      );
  };
  const onConversationEvent = useEffectEvent(
    (event: AppConversationEvent, firstState: boolean) => {
      const activeReader = gate.readerAttached;
      if (event.type === "state") {
        if (!firstState) refreshTranscript();
        gate.serverLive = event.live;
        setEventsLive(event.live);
        if (event.live) setSubmitPending(false);
        if (event.live && !activeReader) resumeFromEvents();
      } else if (event.type === "turn-start") {
        const tail = displayed.at(-1);
        if (tail?.role === "assistant") setSettledTailId(tail.id);
        gate.serverLive = true;
        setEventsLive(true);
        setSubmitPending(false);
        if (!activeReader) resumeFromEvents();
      } else if (event.type === "turn-end") {
        setSettledTailId(null);
        follow.endTurn();
        gate.serverLive = false;
        setEventsLive(false);
        setSubmitPending(false);
        refreshTranscript();
        refreshPending();
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

  const postChat = async (body: Record<string, unknown>) => {
    const response = await fetch("/api/app/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify({ conversationId, ...body }),
    });
    if (response.status !== 202) {
      const detail = (await response.json().catch(() => null)) as { error?: unknown } | null;
      throw new Error(typeof detail?.error === "string" ? detail.error : `send failed (${response.status})`);
    }
    const result = (await response.json()) as { pendingId?: unknown };
    onSendAccepted?.();
    return result;
  };
  const submit = async (
    message: { parts?: UIMessage["parts"]; text?: string },
    whenBusy: "steer" | "followUp" = "steer",
  ) => {
    setSettledTailId(null);
    setLiveCtx(null);
    setSendFailure(null);
    const optimistic: UIMessage = {
      id: crypto.randomUUID(),
      role: "user",
      parts: message.parts ?? [{ type: "text", text: message.text ?? "" }],
    };
    const wasBusy = busy;
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
        },
      ]);
    } else {
      setMessages((current) => [...current, optimistic]);
    }
    setSubmitPending(true);
    try {
      const result = await postChat({ message: optimistic, whenBusy });
      if (typeof result.pendingId === "string") {
        setMessages((current) => current.filter((item) => item.id !== optimistic.id));
        setPendingItems((current) =>
          current.map((item) =>
            item.id === optimisticPendingId ? { ...item, id: result.pendingId as string } : item,
          ),
        );
        refreshPending();
      }
    } catch (err) {
      setMessages((current) => current.filter((item) => item.id !== optimistic.id));
      setPendingItems((current) => current.filter((item) => item.id !== optimisticPendingId));
      setSubmitPending(false);
      setSendFailure(err instanceof Error ? err.message : "send failed");
    }
  };
  const submitLatest = useRef(submit);
  useLayoutEffect(() => {
    submitLatest.current = submit;
  });
  const onUiAction = useCallback((text: string) => void submitLatest.current({ text }), []);

  const dequeuePending = async (item: AppPendingInput, edit: boolean) => {
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
        setDraftRestore({
          parts: body.message.parts as UIMessage["parts"],
          source: "pending-edit",
        });
      refreshPending();
    } catch (err) {
      setSendFailure(err instanceof Error ? err.message : "pending input action failed");
    }
  };

  const { stick } = follow;
  useLayoutEffect(stick, [stick, messages, busy]);

  // A seed arrives once (empty-state send → conversation created → this view mounts).
  const seeded = useRef(false);
  const submitSeed = useEffectEvent((parts: UIMessage["parts"]) => submit({ parts }));
  useEffect(() => {
    if (seeded.current || seed === null || seed.length === 0) return;
    seeded.current = true;
    onSeeded();
    void submitSeed(seed).catch((err: unknown) => console.error("Couldn't submit seeded message", err));
  }, [seed, onSeeded]);

  // The retry affordance belongs to the newest answer — anything older
  // gets copy/read only.
  const lastAssistantId = [...messages]
    .reverse()
    .find((m) => m.role === "assistant")?.id;

  // The rendered transcript: paged-in durable prefix, then the live
  // window (newest durable page plus any optimistic tail). Fold-mark
  // indexes are transcript-absolute — subtracting loadedStart maps
  // them onto displayed; marks deeper than the loaded range hold
  // until their page arrives.
  const displayed = useMemo(() => [...older, ...messages], [older, messages]);
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
    editBackup.current = messages;
    setEditing(null);
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

  return (
    <DocViewerProvider token={token} conversationId={conversationId}>
      <div className="chat">
        <QuoteFab
          root={scrollRef}
          onQuote={(text, speaker) =>
            setQuote((q) => ({ text, speaker, n: q.n + 1 }))
          }
        />
        {/* The outline is a hover rail — a pointer affordance, so it does
				    not exist in a phone DOM at all. */}
        {phone ? null : (
          <Outline messages={displayed} scrollRef={scrollRef} onGesture={follow.gesture} />
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
              let el: ReactNode;
              if (m.role === "user") {
                const isEditing = editing !== null && editing.id === m.id;
                const prevUser = displayed[i - 1]?.role === "user";
                const nextUser = displayed[i + 1]?.role === "user";
                el = (
                  <div
                    className={`msg user${prevUser ? " after-user" : ""}${nextUser ? " before-user" : ""}`}
                    data-outline-anchor={m.id}
                  >
                    {isEditing ? (
                      <div className="msg-edit">
                        <textarea
                          value={editing.draft}
                          rows={Math.min(
                            10,
                            Math.max(2, editing.draft.split("\n").length),
                          )}
                          onChange={(e) =>
                            setEditing({ id: m.id, draft: e.target.value })
                          }
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
                              editing.draft.trim() === "" &&
                              !m.parts.some((p) => p.type !== "text")
                            }
                          >
                            save &amp; resend
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <UserFold>
                          <MessageParts
                            parts={m.parts}
                            token={token}
                            noteProjectId={noteProjectId}
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
                        noteProjectId={noteProjectId}
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
                        noteProjectId={noteProjectId}
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
                          token={token}
                          noteProjectId={noteProjectId}
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
                el = (
                  <div
                    className={
                      status === "streaming" && m.id === lastAssistantId
                        ? "msg assistant streaming"
                        : "msg assistant"
                    }
                  >
                    <MessageParts
                      parts={m.parts}
                      token={token}
                      noteProjectId={noteProjectId}
                      busy={busy}
                      streaming={
                        status === "streaming" && m.id === lastAssistantId
                      }
                      messages={hasUiPart(m.parts) ? displayed : undefined}
                      onOpenNote={onOpenNote}
                      onNotesChanged={onTurnDone}
                      onAction={onUiAction}
                    />
                    <ActionBar
                      message={m}
                      isLastAssistant={m.id === lastAssistantId}
                      busy={busy}
                      onRetry={() => {
                        setSettledTailId(null);
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
              <div className="msg assistant pending shimmer">…</div>
            )}
            {pendingItems.length > 0 && (
              <section className="pending-inputs" aria-label="Pending input">
                <h3>Pending input</h3>
                {pendingItems.map((item) => (
                  <div className="pending-input" key={item.id}>
                    <button
                      type="button"
                      className="pending-input-edit"
                      aria-label={`Edit ${item.mode === "followUp" ? "queued" : "steer"} input`}
                      onClick={() => void dequeuePending(item, true)}
                    >
                      <span className="pending-input-mode">
                        {item.mode === "followUp" ? "Queued" : "Steer"}
                      </span>
                      <span>{messageText(item.message as unknown as UIMessage)}</span>
                    </button>
                    <button
                      type="button"
                      className="pending-input-remove"
                      aria-label="Remove pending input"
                      onClick={() => void dequeuePending(item, false)}
                    >
                      ×
                    </button>
                  </div>
                ))}
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
          staged={staged}
          setStaged={setStaged}
          stagedNotes={stagedNotes}
          setStagedNotes={setStagedNotes}
          stagedSkills={stagedSkills}
          setStagedSkills={setStagedSkills}
          quote={quote}
          draftRestore={draftRestore}
          onDraftRestored={() => setDraftRestore(null)}
          stealFocus
          onCompacted={refreshTranscript}
          onSend={(parts, whenBusy) => {
            askNotifyPermission();
            void submit({ parts }, whenBusy);
          }}
          onStop={() => {
            setStopError(null);
            // The stop route settles the turn before responding — the
            // unlanded record is in history by then, so one refresh
            // swaps the local partial for the durable record.
            void stopConversation(token, conversationId)
              .then(() => refreshTranscript())
              .catch((err: unknown) =>
                setStopError(
                  err instanceof Error ? err.message : "request failed",
                ),
              );
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
