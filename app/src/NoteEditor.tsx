// Milkdown editor for /app/n/<id> — lazy-imported from NoteView so the
// editor stack stays out of the main chunk. Owns the autosave loop:
// a baseline (the markdown last produced by THIS serializer — never
// the raw server body, whose syntax the parser normalizes) and a
// debounce; saves ride PATCH with If-Match = baseline rev, so
// concurrent writers conflict instead of clobbering. A conflict —
// from a 409 or handed in by the page — blocks every automatic write
// until the operator explicitly resolves it.
//
// Selection rewrite (design/projects.md → AI rewrite): the toolbar
// captures a ProseMirror selection and locks the editor; the model's
// proposal is a preview until the operator applies it, and the
// accepted body — built from a DETACHED transaction, never dispatched
// — lands through the same guarded PATCH with source "rewrite".

import { Editor, defaultValueCtx, editorViewCtx, rootCtx, serializerCtx } from "@milkdown/kit/core";
import type { Node as PMNode } from "@milkdown/kit/prose/model";
import { Plugin } from "@milkdown/kit/prose/state";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { history } from "@milkdown/kit/plugin/history";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { $prose, getMarkdown, markdownToSlice, replaceAll } from "@milkdown/kit/utils";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { ApiError, NoteConflictError, patchNote, rewriteNote } from "./api.ts";
import {
	clearNoteDraft,
	discardNoteDraft,
	loadNoteDraft,
	rawNoteDraft,
	writeNoteDraft,
	type NoteDraft,
} from "./noteDraft.ts";
import type { AppNote } from "../../src/http/app-wire.ts";

export interface NoteEditorHandle {
	// A server-side content change landed (append, restore, someone
	// else saved). Adopt it — replaces the doc and rebases the
	// baseline to the serializer's own output; clears the conflict.
	reload(note: AppNote): void;
	// A write that can't have changed the body (title, pin, archive,
	// move) reports the note back: advance the If-Match rev without
	// touching content — but only if the returned body is still the
	// one the server last acknowledged. A moved body means an agent
	// (or another tab) wrote between our ack and this response: a
	// clean editor reloads it; a dirty one raises the conflict bar.
	adoptRev(note: AppNote): void;
	// Synchronous — an in-flight save also counts as unsafe to reload.
	dirty(): boolean;
	// Run the pending save now (synchronous serialization — the
	// listener lags edits ~200ms). Blocked while a conflict stands.
	flush(): void;
	flushAndWait(): Promise<boolean>;
	// The one title write lane — queues into the SAME save loop as the
	// body so a title PATCH never races a body PATCH onto one rev.
	// Resolves true only when the server acked this exact title;
	// false on conflict, offline, a permanent refusal, or a not-ready
	// editor. The PATCH carries the current serialized body with the
	// title so both land atomically.
	saveTitle(title: string): Promise<boolean>;
	// An external conflict (the page's focus refresh or a title 409):
	// block automatic writes and raise the bar.
	conflict(note: AppNote): void;
	// The conflict bar's two answers: "theirs" reloads the live note;
	// "mine" force-writes local content (and title, when the caller
	// carries a draft) on top of theirs.rev — a repeated 409 reblocks.
	resolve(mode: "theirs" | "mine", theirs: AppNote, title?: string): void;
	// The save-loop tests drive document changes through this.
	editor(): Editor | null;
}

export type SaveStatus = "saved" | "saving" | "offline" | "conflict" | "error";

// One open rewrite flow: the immutable capture taken while the
// selection still stood (the panel's input steals the DOM selection
// right after), then input → generating → preview → applying.
// "saving" is the pre-flush of pending edits; "blocked" is a pre-flush
// that couldn't land — no generation on a body the server never took.
interface RewriteFlow {
	from: number;
	to: number;
	doc: PMNode;
	selection: string;
	phase: "saving" | "input" | "generating" | "preview" | "applying" | "blocked";
	instruction: string;
	replacement: string | null;
	error: string | null;
}

const DEBOUNCE_MS = 1000;

const NoteEditor = forwardRef<
	NoteEditorHandle,
	{
		token: string | null;
		noteId: string;
		// The whole note, not just body/rev — a stale draft restores
		// behind the conflict bar, which needs the genuine current
		// server record rather than invented metadata or a refetch.
		initialNote: AppNote;
		// A successful autosave/resolve reports the note back so the page
		// tracks the live rev for flag writes and titles.
		onSaved: (note: AppNote) => void;
		// A save hit a rev that isn't ours — the page shows the bar.
		onConflict: (theirs: AppNote) => void;
		onDirty?: (dirty: boolean) => void;
		// A rewrite flow locks the editor; the page locks its own
		// actions (title, flags, archive, restore, chat) for the same
		// window so nothing races the pending apply.
		onRewriteBusy?: (busy: boolean) => void;
		// The apply PATCH itself is held: conflict resolution must not
		// launch an ordinary save that races it.
		onRewriteApplying?: (applying: boolean) => void;
		// Tests shorten the debounce; the product keeps a second.
		saveDelayMs?: number;
	}
>(function NoteEditor(
	{
		token,
		noteId,
		initialNote,
		onSaved,
		onConflict,
		onDirty,
		onRewriteBusy,
		onRewriteApplying,
		saveDelayMs,
	},
	ref,
) {
	const containerRef = useRef<HTMLDivElement>(null);
	const editorRef = useRef<Editor | null>(null);
	const baselineRef = useRef(initialNote.body);
	// The raw body the server last acknowledged (initial load, reload,
	// successful PATCH) — adoptRev compares responses against it.
	const serverBodyRef = useRef(initialNote.body);
	const revRef = useRef(initialNote.rev);
	// The monotonic state token: rev orders only content writes, so a
	// flag response that bumps nothing else still advances stateRev —
	// stale-response guards run on it, never on rev or updatedAt.
	const stateRevRef = useRef(initialNote.stateRev);
	// The title the server last acknowledged — a saveTitle() resolves
	// true only once a response carries exactly the requested title.
	const titleAckRef = useRef(initialNote.title);
	// A reload()/adoptRev() landing before Editor.create resolves — or
	// a newer initialNote prop from the same window — queues here; the
	// create continuation applies the freshest of the two under draft
	// suppression before baseline/draft recovery decide anything.
	const startupRemoteRef = useRef<AppNote | null>(null);
	const initialNoteRef = useRef(initialNote);
	initialNoteRef.current = initialNote;
	// The server state the stored draft stands on. While a conflict
	// stands this keeps the draft's ORIGINAL base — a capture during
	// the block must not rebase onto the newer remote, or a revisit
	// would see a matching base and autosave stale local text over it.
	const draftBaseRef = useRef({ rev: initialNote.rev, body: initialNote.body });
	// Suppresses draft capture during mount/recovery and programmatic
	// reloads — a restore is not an edit, and the mount-time parse
	// normalization must never write or autosave.
	const suppressDraftRef = useRef(true);
	// The exact serialized record this editor last stored — compare-
	// delete, so a late ack clears only its own write.
	const lastDraftRef = useRef<string | null>(null);
	// A stored record that failed to load stays on the key verbatim
	// until the operator handles it — every capture path funnels
	// through persistDraft, which refuses while this stands.
	const preservedRef = useRef(false);
	const [preserved, setPreserved] = useState(false);
	const dirtyRef = useRef(false);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const savingRef = useRef(false);
	// A save requested while one is in flight — runs once it settles,
	// carrying its options (a forced resolve keeps force + title).
	const pendingRef = useRef<{
		keepalive: boolean;
		force?: boolean;
		title?: string;
		preflush?: boolean;
	} | null>(null);
	// A standing conflict blocks every automatic write until resolve().
	const conflictRef = useRef<AppNote | null>(null);
	// Set at unmount: callbacks and scheduling stop; the cleanup drain
	// keeps the editor alive just long enough to flush the pending
	// write, then destroys it — drainDead breaks the loop on a write
	// that can't land detached.
	const unmountedRef = useRef(false);
	const drainDeadRef = useRef(false);
	// A permanent write failure (4xx, deleted note) — the buffer stays
	// dirty but nothing auto-reschedules; the next edit retries.
	const hardFailRef = useRef(false);
	const inFlightRef = useRef<Promise<void> | null>(null);
	// The live PM selection, mirrored for the toolbar button — it must
	// be a doc-position range, not the DOM selection the panel steals.
	const selRef = useRef<{ from: number; to: number; empty: boolean }>({
		from: 0,
		to: 0,
		empty: true,
	});
	// Editor editable-lock while a rewrite flow is open.
	const rewriteActiveRef = useRef(false);
	const rewriteAbortRef = useRef<AbortController | null>(null);
	// One applying window — the page's resolution buttons disable on
	// its edges; release paths stay idempotent.
	const rewriteApplyingRef = useRef(false);
	// Request identity — a stale generation response (superseded or
	// canceled) is dropped, never applied. Bumped per flow, so a
	// late continuation of a closed flow can't touch a newer one.
	const rewriteReqRef = useRef(0);
	const [rewrite, setRewrite] = useState<RewriteFlow | null>(null);
	// Mirror for the imperative handle — resolve() refuses to launch
	// an ordinary save while an apply PATCH is held.
	const rewriteRef = useRef<RewriteFlow | null>(null);
	rewriteRef.current = rewrite;
	const [selEmpty, setSelEmpty] = useState(true);
	const [ready, setReady] = useState(false);
	const [status, setStatus] = useState<SaveStatus>("saved");
	const [statusDetail, setStatusDetail] = useState<string | null>(null);
	// A draft-storage failure is separate from the save status — an
	// autosave result must not paint over "recovery is broken".
	const [draftError, setDraftError] = useState<string | null>(null);
	const onSavedRef = useRef(onSaved);
	const onConflictRef = useRef(onConflict);
	const onDirtyRef = useRef(onDirty);
	const onRewriteBusyRef = useRef(onRewriteBusy);
	const onRewriteApplyingRef = useRef(onRewriteApplying);
	onSavedRef.current = onSaved;
	onConflictRef.current = onConflict;
	onDirtyRef.current = onDirty;
	onRewriteBusyRef.current = onRewriteBusy;
	onRewriteApplyingRef.current = onRewriteApplying;

	function markStatus(s: SaveStatus, detail?: string): void {
		if (unmountedRef.current) return;
		setStatusDetail(detail ?? null);
		setStatus(s);
	}

	function markDirty(dirty: boolean): void {
		if (dirtyRef.current === dirty) return;
		dirtyRef.current = dirty;
		if (!unmountedRef.current) onDirtyRef.current?.(dirty);
	}

	// Storage failures stay visible: an ErrorEvent diagnostic plus a
	// persistent alert, so a broken draft never masquerades as
	// recovery. No note body or token ever enters either.
	function reportDraftError(verb: "preserved" | "loaded" | "cleared", e: unknown): void {
		// A raw SyntaxError message can quote its input (V8) — stored
		// bytes are note content and never reach the alert/diagnostic.
		const msg =
			e instanceof SyntaxError
				? "stored record is malformed"
				: e instanceof Error
					? e.message
					: String(e);
		window.dispatchEvent(new ErrorEvent("error", { message: `note draft ${verb} failed: ${msg}` }));
		if (!unmountedRef.current) setDraftError(`Local draft could not be ${verb}: ${msg}`);
	}

	// Store the live body as the durable draft, standing on whatever
	// base draftBaseRef currently names; returns the exact snapshot
	// stored, or null when storage refused. A detached component may
	// only overwrite the snapshot it last wrote — after unmount a
	// newer editor owns the record, and a late drain/ack write must
	// never roll it back.
	function persistDraft(md: string, ownedOnly = false): string | null {
		// The preserved record owns the key — overwriting bytes nobody
		// could read back would destroy the unsaved work they hold.
		// Captures resume only on the operator's explicit discard.
		if (preservedRef.current) return null;
		const draft: NoteDraft = {
			version: 1,
			noteId,
			baseRev: draftBaseRef.current.rev,
			baseBody: draftBaseRef.current.body,
			body: md,
		};
		try {
			const snap =
				unmountedRef.current || ownedOnly
					? lastDraftRef.current !== null
						? writeNoteDraft(draft, lastDraftRef.current)
						: null
					: writeNoteDraft(draft);
			if (snap === null) return null;
			lastDraftRef.current = snap;
			if (!unmountedRef.current) setDraftError(null);
			return snap;
		} catch (e) {
			reportDraftError("preserved", e);
			return null;
		}
	}

	function dropDraft(snapshot: string): void {
		try {
			clearNoteDraft(noteId, snapshot);
			if (!unmountedRef.current) setDraftError(null);
		} catch (e) {
			reportDraftError("cleared", e);
		}
	}

	// Every document change: baseline-equal means the buffer landed or
	// was never dirty — clear only THIS editor's last snapshot, and
	// only while no conflict stands: under one, even baseline-equal
	// local text IS the conflict's local side and must stay
	// recoverable. Anything else is unsaved local work and persists.
	function captureDraft(md: string): void {
		if (md === baselineRef.current && conflictRef.current === null) {
			const snap = lastDraftRef.current;
			lastDraftRef.current = null;
			if (snap !== null) dropDraft(snap);
			return;
		}
		persistDraft(md);
	}

	// The operator's explicit calls on a preserved record: Download
	// hands back the raw bytes (recovery), Discard frees the key so the
	// live buffer becomes the draft again.
	function downloadPreservedDraft(): void {
		let raw: string | null;
		try {
			raw = rawNoteDraft(noteId);
		} catch (e) {
			reportDraftError("loaded", e);
			return;
		}
		if (raw === null || typeof URL.createObjectURL !== "function") return;
		const url = URL.createObjectURL(new Blob([raw], { type: "text/plain" }));
		const a = document.createElement("a");
		a.href = url;
		a.download = `goblin-note-draft-${noteId}.txt`;
		a.click();
		// Some engines start the download on a later task — a same-tick
		// revoke can cancel it, and this is the only salvage path.
		setTimeout(() => URL.revokeObjectURL(url), 0);
	}

	function discardPreservedDraft(): void {
		try {
			discardNoteDraft(noteId);
		} catch (e) {
			reportDraftError("cleared", e);
			return;
		}
		preservedRef.current = false;
		setPreserved(false);
		setDraftError(null);
		// The live buffer may still be unsaved work — capture it now
		// that the record's key is free.
		persistLive();
	}

	// Synchronous persist for unload boundaries — runs even while a
	// conflict or rewrite blocks every automatic write.
	function persistLive(): void {
		const ed = editorRef.current;
		if (ed === null) return;
		captureDraft(ed.action(getMarkdown()));
	}

	function clearTimer(): void {
		if (timerRef.current !== null) {
			clearTimeout(timerRef.current);
			timerRef.current = null;
		}
	}

	function schedule(): void {
		if (unmountedRef.current || conflictRef.current !== null || rewriteActiveRef.current) return;
		clearTimer();
		timerRef.current = setTimeout(() => void save(revRef.current), saveDelayMs ?? DEBOUNCE_MS);
	}

	async function save(
		expectedRev: number,
		opts: {
			keepalive?: boolean;
			force?: boolean;
			title?: string;
			preflush?: boolean;
		} = {},
	): Promise<void> {
		if (conflictRef.current !== null) return;
		// While a rewrite flow owns the editor, automatic writes stay
		// out — the flow's explicit preflush is the only save allowed
		// in, so the apply PATCH remains the sole writer.
		if (rewriteActiveRef.current && opts.preflush !== true) return;
		if (savingRef.current) {
			// Merge, never replace — a body-only re-arm must not drop a
			// queued title, and a newer title supersedes an older one.
			const queued = pendingRef.current;
			pendingRef.current = {
				keepalive: queued?.keepalive === true || opts.keepalive === true,
				...(queued?.force === true || opts.force === true ? { force: true } : {}),
				...(opts.title !== undefined
					? { title: opts.title }
					: queued?.title !== undefined
						? { title: queued.title }
						: {}),
				...(queued?.preflush === true || opts.preflush === true ? { preflush: true } : {}),
			};
			return;
		}
		const ed = editorRef.current;
		if (ed === null) return;
		const md = ed.action(getMarkdown());
		// A clean buffer short-circuits only a body save — a queued
		// title still has to reach the server.
		if (opts.force !== true && opts.title === undefined && md === baselineRef.current) {
			// Doc is clean — a stored draft of ours is stale too.
			captureDraft(md);
			markDirty(false);
			markStatus("saved");
			return;
		}
		// Synchronous capture at save entry covers anything the plugin
		// missed; the request snapshot is what the ack may later clear,
		// and only while the live body is still this one.
		const requestSnap = persistDraft(md, opts.force !== true);
		savingRef.current = true;
		hardFailRef.current = false;
		markStatus("saving");
		const flight = (async () => {
			try {
				const { data } = await patchNote(
					token,
					noteId,
					{
						body: md,
						...(opts.title !== undefined ? { title: opts.title } : {}),
					},
					{ ifMatch: expectedRev, keepalive: opts.keepalive === true },
				);
				baselineRef.current = md;
				// The ack's token decides whether its fields may move the
				// acknowledged markers — a write that landed before a
				// newer remote was observed must not roll title or
				// serverBody back over that remote.
				const freshest = data.stateRev >= stateRevRef.current;
				if (freshest) {
					serverBodyRef.current = data.body;
					titleAckRef.current = data.title;
				}
				// Never backwards — a flag response may race ahead.
				if (data.rev > revRef.current) revRef.current = data.rev;
				if (data.stateRev > stateRevRef.current) stateRevRef.current = data.stateRev;
				// A landed write resolves only a conflict at or below its
				// state token — a delayed response can't clear a newer
				// observed remote. The page still hears about the ack
				// (its forward guard drops the stale token); only the
				// label stays blocked.
				const c = conflictRef.current;
				if (c === null || data.stateRev >= c.stateRev) conflictRef.current = null;
				// The draft base advances only on a save that stands
				// clean — a late old ack under a newer observed conflict
				// must not rebase the stored draft onto that remote.
				if (conflictRef.current === null)
					draftBaseRef.current = { rev: revRef.current, body: serverBodyRef.current };
				// The ack retires the request snapshot only while the live
				// body is still the submitted one and no conflict stands —
				// under a newer remote, the local body (even this exact
				// one) is the conflict's local side and must stay
				// recoverable at the draft's ORIGINAL base. Edits that
				// landed mid-flight persist again at whatever base now
				// stands — the retained editor answers even after unmount.
				const liveEd = editorRef.current;
				const liveMd = liveEd !== null ? liveEd.action(getMarkdown()) : md;
				if (conflictRef.current === null && liveMd === md) {
					const snap = lastDraftRef.current;
					lastDraftRef.current = null;
					if (snap !== null) dropDraft(snap);
					if (requestSnap !== null && requestSnap !== snap) dropDraft(requestSnap);
				} else {
					persistDraft(liveMd, true);
				}
				if (!unmountedRef.current) {
					onSavedRef.current(data);
					if (conflictRef.current === null) markStatus("saved");
				}
			} catch (e) {
				if (e instanceof NoteConflictError) {
					// Block every automatic write until resolve() — kill the
					// armed debounce and any queued pending save.
					clearTimer();
					pendingRef.current = null;
					conflictRef.current = e.note;
					if (!unmountedRef.current) {
						markStatus("conflict");
						onConflictRef.current(e.note);
					}
				} else if (unmountedRef.current) {
					// A detached write that can't land — the drain must not
					// retry it forever.
					drainDeadRef.current = true;
				} else if (e instanceof TypeError || (e instanceof ApiError && e.status >= 500)) {
					// Transient (network/5xx) — the dirty buffer stays;
					// settle reschedules.
					markStatus("offline");
				} else {
					// Permanent refusal — surface it; retry only on a new
					// edit, not on a timer.
					hardFailRef.current = true;
					markStatus("error", e instanceof Error ? e.message : String(e));
				}
			} finally {
				savingRef.current = false;
				if (unmountedRef.current) {
					// The drain loop owns pendingRef now — it consumes and
					// dispatches the queued write itself, so a title
					// committed behind this in-flight PATCH still lands.
					return;
				}
				// Reconcile anything that landed mid-flight: compare the
				// live doc to the (possibly just-updated) baseline rather
				// than a dirty flag set before the PATCH resolved.
				const live = editorRef.current;
				const dirtyNow = live !== null && live.action(getMarkdown()) !== baselineRef.current;
				markDirty(dirtyNow);
				const pending = pendingRef.current;
				pendingRef.current = null;
				if (conflictRef.current === null && !hardFailRef.current) {
					if (pending !== null) {
						// A queued title dispatches even on a clean body —
						// clean-buffer early return applies to body writes.
						if (pending.force === true || pending.title !== undefined || dirtyNow) {
							void save(revRef.current, pending);
						}
					} else if (dirtyNow) {
						schedule();
					}
				}
			}
		})();
		inFlightRef.current = flight;
		await flight;
		if (inFlightRef.current === flight) inFlightRef.current = null;
	}

	function flush(keepalive = false): void {
		clearTimer();
		const ed = editorRef.current;
		if (ed === null || conflictRef.current !== null || rewriteActiveRef.current) return;
		// Synchronous check — the listener lags edits ~200ms, so a
		// typed-then-left window is still dirty even though dirtyRef
		// hasn't caught up.
		if (ed.action(getMarkdown()) === baselineRef.current) return;
		void save(revRef.current, { keepalive });
	}

	function blocked(): boolean {
		return (
			unmountedRef.current ||
			editorRef.current === null ||
			conflictRef.current !== null ||
			rewriteActiveRef.current
		);
	}

	async function flushAndWait(): Promise<boolean> {
		clearTimer();
		if (blocked() || !ready) return false;
		for (;;) {
			const flight = inFlightRef.current;
			if (flight === null) break;
			await flight;
			if (blocked()) return false;
		}
		const ed = editorRef.current;
		if (ed === null) return false;
		// Consume any queued drain here so its options (a forced title)
		// ride this flush instead of dispatching twice off the finally.
		const queued = pendingRef.current;
		pendingRef.current = null;
		if (
			ed.action(getMarkdown()) !== baselineRef.current ||
			queued?.title !== undefined ||
			queued?.force === true
		) {
			await save(revRef.current, queued ?? {});
		}
		for (;;) {
			const flight = inFlightRef.current;
			if (flight === null) break;
			await flight;
		}
		if (blocked() || savingRef.current) return false;
		return editorRef.current!.action(getMarkdown()) === baselineRef.current;
	}

	// The page's one title lane — rides the same save loop as body
	// autosaves so a title PATCH can never race a body PATCH onto the
	// same rev. Joins any in-flight save, then any queued drain; true
	// only when a response acked exactly this title.
	async function saveTitle(title: string): Promise<boolean> {
		if (blocked()) return false;
		clearTimer();
		void save(revRef.current, { title });
		for (;;) {
			const flight = inFlightRef.current;
			if (flight === null) break;
			await flight;
			if (blocked()) return false;
		}
		if (conflictRef.current !== null) return false;
		return titleAckRef.current === title;
	}

	// A server-side content change landed: adopt the note, rebase the
	// baseline to the serializer's own output (the listener's ~200ms-
	// debounced markdownUpdated for this replaceAll lands after this
	// and self-cancels against the new baseline), clear the conflict.
	// Adoption supersedes the stored draft — the local snapshot this
	// editor last wrote is cleared once the new body is in.
	function reload(note: AppNote): void {
		const ed = editorRef.current;
		if (ed === null) {
			// Editor.create is still resolving — the freshest queued
			// refresh wins and is applied before draft recovery (see the
			// startup reconcile in the mount effect).
			const queuedRev = startupRemoteRef.current?.stateRev ?? stateRevRef.current;
			if (!unmountedRef.current && note.stateRev > queuedRev) {
				startupRemoteRef.current = note;
			}
			return;
		}
		clearTimer();
		pendingRef.current = null;
		conflictRef.current = null;
		suppressDraftRef.current = true;
		try {
			ed.action(replaceAll(note.body));
			baselineRef.current = ed.action(getMarkdown());
		} finally {
			suppressDraftRef.current = false;
		}
		serverBodyRef.current = note.body;
		revRef.current = note.rev;
		stateRevRef.current = note.stateRev;
		titleAckRef.current = note.title;
		draftBaseRef.current = { rev: note.rev, body: note.body };
		const snap = lastDraftRef.current;
		lastDraftRef.current = null;
		if (snap !== null) dropDraft(snap);
		markDirty(false);
		markStatus("saved");
	}

	function setApplying(on: boolean): void {
		if (rewriteApplyingRef.current === on) return;
		rewriteApplyingRef.current = on;
		onRewriteApplyingRef.current?.(on);
	}

	// The editable lock rides one closure over rewriteActiveRef — the
	// flag flips it, setProps just installs the prop once.
	function lockEditing(lock: boolean): void {
		rewriteActiveRef.current = lock;
		const ed = editorRef.current;
		if (ed === null) return;
		ed.action((ctx) => {
			ctx.get(editorViewCtx).setProps({
				editable: () => !rewriteActiveRef.current,
			});
		});
	}

	function closeRewrite(): void {
		// Identity bump: an in-flight generation response — or a
		// still-draining preflush continuation — is stale the moment
		// the panel goes away.
		rewriteReqRef.current += 1;
		rewriteAbortRef.current?.abort();
		rewriteAbortRef.current = null;
		lockEditing(false);
		setRewrite(null);
		onRewriteBusyRef.current?.(false);
		setApplying(false);
		// A preflush that couldn't land (offline) still owes the edit
		// a retry — rearm now that automatic writes are allowed again.
		if (unmountedRef.current) return;
		const ed = editorRef.current;
		if (ed !== null && ed.action(getMarkdown()) !== baselineRef.current) {
			markDirty(true);
			schedule();
		}
	}

	function openRewrite(): void {
		const ed = editorRef.current;
		const sel = selRef.current;
		if (ed === null || sel.empty || conflictRef.current !== null) return;
		const flowId = ++rewriteReqRef.current;
		lockEditing(true);
		onRewriteBusyRef.current?.(true);
		clearTimer();
		// Capture before focus leaves the editor: the immutable doc,
		// the doc-position range, and the selection's own serialization.
		const capture = ed.action((ctx) => {
			const view = ctx.get(editorViewCtx);
			return {
				from: sel.from,
				to: sel.to,
				doc: view.state.doc,
				selection: getMarkdown({ from: sel.from, to: sel.to })(ctx),
			};
		});
		setRewrite({
			...capture,
			phase: "saving",
			instruction: "",
			replacement: null,
			error: null,
		});
		void preflush(flowId);
	}

	// Persist the operator's pending edits BEFORE generating — the
	// proposal and the apply PATCH both stand on that rev. A failure
	// or a conflict stops the flow; nothing generates on a body the
	// server never took. flowId guards every await: a canceled or
	// superseded flow's late continuation must never mutate or
	// close a newer flow's panel.
	async function preflush(flowId: number): Promise<void> {
		const alive = (): boolean =>
			!unmountedRef.current && flowId === rewriteReqRef.current && rewriteActiveRef.current;
		const block = (msg: string): void => {
			if (!alive()) return;
			setRewrite((cur) =>
				cur !== null && cur.phase === "saving" ? { ...cur, phase: "blocked", error: msg } : cur,
			);
		};
		try {
			while (alive()) {
				const flight = inFlightRef.current;
				if (flight === null) break;
				await flight;
			}
			if (!alive()) return;
			// A held autosave may have 409'd mid-drain — the conflict
			// bar owns the block, so the panel closes instead.
			if (conflictRef.current !== null) {
				closeRewrite();
				return;
			}
			const ed = editorRef.current;
			if (ed === null) {
				closeRewrite();
				return;
			}
			if (ed.action(getMarkdown()) !== baselineRef.current) {
				await save(revRef.current, { preflush: true });
			}
			if (!alive()) return;
			if (conflictRef.current !== null) {
				closeRewrite();
				return;
			}
			if (ed.action(getMarkdown()) !== baselineRef.current) {
				block("Couldn't save your pending edits — check the save status below.");
				return;
			}
			setRewrite((cur) =>
				cur !== null && cur.phase === "saving" ? { ...cur, phase: "input" } : cur,
			);
		} catch (e) {
			block(`Couldn't save pending edits: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	async function generateRewrite(): Promise<void> {
		const r = rewrite;
		if (r === null || r.phase !== "input" || r.instruction.trim() === "") return;
		const reqId = ++rewriteReqRef.current;
		const abort = new AbortController();
		rewriteAbortRef.current = abort;
		setRewrite({ ...r, phase: "generating", error: null });
		try {
			const res = await rewriteNote(
				token,
				noteId,
				{ selection: r.selection, instruction: r.instruction },
				{ signal: abort.signal },
			);
			if (unmountedRef.current || reqId !== rewriteReqRef.current || abort.signal.aborted) return;
			setRewrite((cur) =>
				cur !== null && cur.phase === "generating"
					? { ...cur, phase: "preview", replacement: res.replacement }
					: cur,
			);
		} catch (e) {
			if (unmountedRef.current || reqId !== rewriteReqRef.current || abort.signal.aborted) return;
			setRewrite((cur) =>
				cur !== null && cur.phase === "generating"
					? {
							...cur,
							phase: "input",
							error: `Couldn't generate: ${e instanceof Error ? e.message : String(e)}`,
						}
					: cur,
			);
		}
	}

	async function acceptRewrite(): Promise<void> {
		const r = rewrite;
		const ed = editorRef.current;
		if (r === null || r.phase !== "preview" || r.replacement === null) return;
		if (ed === null) return;
		if (conflictRef.current !== null) {
			setRewrite({ ...r, error: "Resolve the conflict above before applying." });
			return;
		}
		// The next body comes from a DETACHED transaction — the live
		// doc doesn't change until the server accepts the full result.
		let nextBody: string | null;
		try {
			nextBody = ed.action((ctx): string | null => {
				const view = ctx.get(editorViewCtx);
				// A reload or programmatic edit since capture means the
				// recorded offsets no longer describe this doc — refuse.
				if (!view.state.doc.eq(r.doc)) return null;
				const replacement = r.replacement;
				if (replacement === null) return null;
				const tr = view.state.tr.replaceRange(r.from, r.to, markdownToSlice(replacement)(ctx));
				return ctx.get(serializerCtx)(tr.doc);
			});
		} catch (e) {
			// A parse/replace/serialization failure keeps the preview —
			// discard or retry, nothing was sent.
			setRewrite({
				...r,
				error: `Couldn't prepare rewrite: ${e instanceof Error ? e.message : String(e)}`,
			});
			return;
		}
		if (nextBody === null) {
			setRewrite({
				...r,
				error: "The note changed since this rewrite — discard and try again.",
			});
			return;
		}
		setRewrite({ ...r, phase: "applying", error: null });
		setApplying(true);
		try {
			const { data } = await patchNote(
				token,
				noteId,
				{ body: nextBody, source: "rewrite" },
				{ ifMatch: revRef.current },
			);
			if (unmountedRef.current) return;
			setApplying(false);
			// Re-read after the await — the earlier null-check narrowed
			// the ref for TS, but a focus conflict can have landed.
			const c = conflictRef.current as AppNote | null;
			// Same delayed-success guard as the autosave path: a newer
			// conflict observed while the apply was held, or a state
			// token that moved past this PATCH, must not be adopted
			// over. The ack still reports — the page's forward guard
			// drops stale tokens — but the doc and the standing conflict
			// stay.
			if (data.stateRev < stateRevRef.current || (c !== null && c.stateRev > data.stateRev)) {
				onSavedRef.current(data);
				closeRewrite();
				return;
			}
			// A programmatic dispatch while the apply was held moved the
			// live doc off the capture — the write landed, but the local
			// buffer is somebody's unsaved work: keep it behind the
			// conflict bar instead of reloading over it.
			const edNow = editorRef.current;
			const docMoved =
				edNow !== null && !edNow.action((ctx) => ctx.get(editorViewCtx).state.doc.eq(r.doc));
			if (docMoved) {
				onSavedRef.current(data);
				if (c === null) {
					conflictRef.current = data;
					markStatus("conflict");
					onConflictRef.current(data);
				}
				closeRewrite();
				return;
			}
			// Adopt through the normal rebase so baseline/server body/rev
			// track the landed note — only now does the doc change.
			reload(data);
			closeRewrite();
			onSavedRef.current(data);
		} catch (e) {
			if (unmountedRef.current) return;
			setApplying(false);
			if (e instanceof NoteConflictError) {
				// Same block as an autosave 409 — the preview and the
				// local buffer stay; the bar resolves it.
				clearTimer();
				pendingRef.current = null;
				conflictRef.current = e.note;
				markStatus("conflict");
				onConflictRef.current(e.note);
				setRewrite((cur) =>
					cur !== null && cur.phase === "applying"
						? {
								...cur,
								phase: "preview",
								error: "A newer version arrived — resolve the conflict or discard.",
							}
						: cur,
				);
			} else {
				setRewrite((cur) =>
					cur !== null && cur.phase === "applying"
						? {
								...cur,
								phase: "preview",
								error: `Couldn't save: ${e instanceof Error ? e.message : String(e)}`,
							}
						: cur,
				);
			}
		}
	}

	useEffect(() => {
		const container = containerRef.current;
		if (container === null) return;
		let live = true;
		// Load before the editor exists — a broken record keeps the
		// normal server doc (never deleted), just with the failure shown.
		let recovered: { draft: NoteDraft; snapshot: string } | null = null;
		try {
			recovered = loadNoteDraft(noteId);
		} catch (err) {
			reportDraftError("loaded", err);
			// The unreadable record is held until the operator's
			// download or discard — persistDraft blocks while this
			// stands, so edits can't silently overwrite it.
			preservedRef.current = true;
			setPreserved(true);
		}
		const ed = Editor.make()
			.config((ctx) => {
				ctx.set(rootCtx, container);
				ctx.set(defaultValueCtx, initialNote.body);
				const mgr = ctx.get(listenerCtx);
				// The parser normalizes on load (e.g. `-` bullets become
				// `*`) — the baseline must be the serializer's own output
				// taken at mount, or the first real edit would compare
				// against un-normalized text and autosave a normalization
				// rewrite the operator never typed.
				mgr.mounted((c) => {
					baselineRef.current = getMarkdown()(c);
				});
				mgr.markdownUpdated((_c, md) => {
					if (unmountedRef.current) return;
					if (md === baselineRef.current) {
						clearTimer();
						markDirty(false);
						// Undoing back to the baseline doesn't resolve a
						// standing conflict.
						if (conflictRef.current === null) markStatus("saved");
						return;
					}
					markDirty(true);
					// A standing conflict keeps the label and blocks the
					// save — typing stays local until the operator resolves.
					schedule();
				});
				// The toolbar reads doc positions — a PM selection,
				// captured on every move (keyboard or mouse).
				mgr.selectionUpdated((_c, sel) => {
					selRef.current = {
						from: sel.from,
						to: sel.to,
						empty: sel.empty,
					};
					if (!unmountedRef.current) setSelEmpty(sel.empty);
				});
			})
			.use(commonmark)
			.use(gfm)
			.use(listener)
			.use(history)
			// The durable-draft capture: synchronous on EVERY document
			// change — the listener's debounce owns autosave timing, but
			// a typed-then-gone body can't wait for it.
			.use(
				$prose(
					(ctx) =>
						new Plugin({
							view: () => ({
								update: (view, prev) => {
									if (suppressDraftRef.current || view.state.doc.eq(prev.doc)) return;
									captureDraft(ctx.get(serializerCtx)(view.state.doc));
								},
							}),
						}),
				),
			)
			.create();
		const detachErr = (err: unknown) =>
			window.dispatchEvent(
				new ErrorEvent("error", {
					message: `note editor detach failed: ${err instanceof Error ? err.message : String(err)}`,
				}),
			);
		void ed.then(
			(e) => {
				if (live) {
					editorRef.current = e;
					// The freshest known server state — a reload/adoptRev
					// queued while creation pended, else the latest
					// initialNote prop. Applied under suppression BEFORE
					// the baseline and draft recovery run, so both judge
					// against what the server actually holds, not the
					// prop captured when the effect fired.
					const queued = startupRemoteRef.current;
					startupRemoteRef.current = null;
					// The freshest complete state we hold — a queued refresh,
					// the latest prop, or a pre-ready conflict's note (which
					// already moved stateRevRef; assigning below it would
					// roll the bookkeeping backwards).
					const fresh = [
						initialNoteRef.current,
						...(queued !== null ? [queued] : []),
						...(conflictRef.current !== null ? [conflictRef.current] : []),
					].reduce((a, b) => (b.stateRev > a.stateRev ? b : a));
					// The doc must end holding fresh's body — compare the
					// live serialization, never a captured prop, so a
					// delayed create or a differently-initialized
					// defaultValue can't leave stale text mounted.
					if (e.action(getMarkdown()) !== fresh.body) {
						e.action(replaceAll(fresh.body));
					}
					baselineRef.current = e.action(getMarkdown());
					serverBodyRef.current = fresh.body;
					revRef.current = fresh.rev;
					stateRevRef.current = fresh.stateRev;
					titleAckRef.current = fresh.title;
					// Draft judgment stands on the same freshest state — a
					// stale-base record restores behind the bar, a matching
					// one resumes the autosave.
					draftBaseRef.current = { rev: fresh.rev, body: fresh.body };
					// A stored draft is restored under suppression once the
					// normalized server baseline exists, then its recorded
					// base decides what it means:
					//  · serializes to the baseline — the draft already
					//    reached the server; retire that exact record.
					//  · base is this very note — the buffer is genuinely
					//    dirty; resume the guarded autosave.
					//  · base moved — the server has newer text; restore
					//    the buffer local-only behind the conflict bar,
					//    keeping the draft's ORIGINAL base so no later
					//    capture can rebase over the remote.
					if (recovered !== null) {
						e.action(replaceAll(recovered.draft.body));
						const restoredMd = e.action(getMarkdown());
						if (restoredMd === baselineRef.current) {
							dropDraft(recovered.snapshot);
						} else {
							lastDraftRef.current = recovered.snapshot;
							markDirty(true);
							if (
								recovered.draft.baseRev === fresh.rev &&
								recovered.draft.baseBody === fresh.body
							) {
								schedule();
							} else {
								draftBaseRef.current = {
									rev: recovered.draft.baseRev,
									body: recovered.draft.baseBody,
								};
								// An explicit pre-ready conflict stands — the
								// stale-base one only fills a vacant bar.
								if (conflictRef.current === null) {
									conflictRef.current = fresh;
									markStatus("conflict");
									onConflictRef.current(fresh);
								}
							}
						}
					}
					suppressDraftRef.current = false;
					setReady(true);
				} else {
					e.destroy().catch(detachErr);
				}
			},
			(err) => {
				if (live)
					markStatus(
						"error",
						`editor failed to start: ${err instanceof Error ? err.message : String(err)}`,
					);
			},
		);
		// Leaving must not lose the debounce window's work: persist the
		// buffer durably FIRST — it runs even under a conflict or open
		// rewrite — then the keepalive flush is the best-effort fast path.
		const onHide = () => {
			persistLive();
			flush(true);
		};
		const onVis = () => {
			if (document.visibilityState === "hidden") flush();
		};
		window.addEventListener("pagehide", onHide);
		document.addEventListener("visibilitychange", onVis);
		return () => {
			live = false;
			unmountedRef.current = true;
			window.removeEventListener("pagehide", onHide);
			document.removeEventListener("visibilitychange", onVis);
			clearTimer();
			// A rewrite outlives its panel: abort the generation, drop
			// the lock, release the page's controls.
			rewriteReqRef.current += 1;
			rewriteAbortRef.current?.abort();
			rewriteAbortRef.current = null;
			rewriteActiveRef.current = false;
			onRewriteBusyRef.current?.(false);
			setApplying(false);
			// Persist before the drain — a save that never lands still
			// leaves the body recoverable.
			persistLive();
			const e = editorRef.current;
			// Drain, then destroy: fire the pending write if the
			// serialized doc still differs from the baseline, wait for
			// the in-flight PATCH (whose response may re-dirty — the
			// loop sends the latest body at the new rev), then tear
			// down. A write queued behind the in-flight PATCH — a title
			// commit carries no body diff — is consumed and dispatched
			// too, or it would die with the editor. A blocked or dead
			// write stops the drain.
			void (async () => {
				while (e !== null && conflictRef.current === null && !drainDeadRef.current) {
					const flight = inFlightRef.current;
					if (flight !== null) {
						await flight;
						continue;
					}
					const queued = pendingRef.current;
					pendingRef.current = null;
					if (queued === null && e.action(getMarkdown()) === baselineRef.current) break;
					void save(revRef.current, queued ?? {});
				}
				if (e !== null) e.destroy().catch(detachErr);
				editorRef.current = null;
			})();
		};
		// The editor binds its initial content once; later server-side
		// changes arrive through handle.reload(), not remounts.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [noteId]);

	useImperativeHandle(ref, () => {
		return {
			dirty: () => {
				// An open rewrite flow is also unsafe to reload — the
				// apply PATCH doesn't ride savingRef.
				if (savingRef.current || rewriteActiveRef.current) return true;
				const ed = editorRef.current;
				return ed !== null && ed.action(getMarkdown()) !== baselineRef.current;
			},
			editor: () => editorRef.current,
			flush: () => flush(),
			flushAndWait,
			saveTitle,
			reload,
			adoptRev: (note: AppNote): void => {
				if (editorRef.current === null) {
					// Same startup queue as reload — a pre-create response
					// still lands once creation resolves.
					const queuedRev = startupRemoteRef.current?.stateRev ?? stateRevRef.current;
					if (!unmountedRef.current && note.stateRev > queuedRev) {
						startupRemoteRef.current = note;
					}
					return;
				}
				// Stale first: a delayed older response must never touch the
				// doc, the baseline, or the write rev. stateRev is the
				// order token — flag responses don't move rev.
				if (note.stateRev < stateRevRef.current) return;
				stateRevRef.current = note.stateRev;
				titleAckRef.current = note.title;
				if (note.body !== serverBodyRef.current) {
					// The server body moved under us — a clean editor takes
					// it; a dirty or in-flight one raises the bar instead of
					// rev-matching a write over somebody else's text.
					if (
						savingRef.current ||
						(editorRef.current?.action(getMarkdown()) ?? baselineRef.current) !==
							baselineRef.current
					) {
						conflictRef.current = note;
						markStatus("conflict");
						onConflictRef.current(note);
						return;
					}
					reload(note);
					return;
				}
				if (note.rev > revRef.current) {
					revRef.current = note.rev;
					// An unchanged-body response may advance the draft
					// base — never while a conflict stands — and a dirty
					// buffer is re-captured at that new base.
					if (conflictRef.current === null) {
						draftBaseRef.current = { rev: note.rev, body: note.body };
						const ed = editorRef.current;
						if (ed !== null) {
							const liveMd = ed.action(getMarkdown());
							if (liveMd !== baselineRef.current) persistDraft(liveMd, true);
						}
					}
				}
			},
			conflict: (note: AppNote): void => {
				clearTimer();
				pendingRef.current = null;
				conflictRef.current = note;
				if (note.stateRev > stateRevRef.current) stateRevRef.current = note.stateRev;
				markStatus("conflict");
				onConflictRef.current(note);
			},
			resolve(mode: "theirs" | "mine", theirs: AppNote, title?: string): void {
				// Never launch an ordinary save while the apply PATCH is
				// held — the page disables its buttons the same way; this
				// is the handle-side guard.
				if (rewriteRef.current?.phase === "applying") return;
				// An explicit resolution ends any open flow first — no
				// stale preview over freshly replaced content.
				if (rewriteActiveRef.current) closeRewrite();
				if (mode === "theirs") {
					reload(theirs);
					return;
				}
				// Clear the block only to submit the forced write — a
				// repeated 409 reblocks via the catch path. Keep mine
				// writes ON TOP of theirs, so the draft base advances to
				// it before the write leaves.
				conflictRef.current = null;
				revRef.current = theirs.rev;
				stateRevRef.current = theirs.stateRev;
				draftBaseRef.current = { rev: theirs.rev, body: theirs.body };
				markStatus("saving");
				void save(theirs.rev, {
					force: true,
					...(title !== undefined ? { title } : {}),
				});
			},
		};
	});

	const label =
		status === "saved"
			? "Saved"
			: status === "saving"
				? "Saving…"
				: status === "offline"
					? "Offline — retrying"
					: status === "error"
						? `Save failed: ${statusDetail ?? "unknown error"}`
						: "Conflict";
	return (
		<div className="note-editor">
			<div ref={containerRef} className="note-editor-body" />
			<div className="note-editor-bar">
				<button
					type="button"
					className="ghost-inline"
					disabled={!ready || selEmpty || status === "conflict" || rewrite !== null}
					onClick={openRewrite}
				>
					Rewrite selection
				</button>
			</div>
			{rewrite !== null && (
				<div className="note-rewrite">
					<pre className="note-rewrite-sel">{rewrite.selection}</pre>
					<label className="note-rewrite-field">
						Rewrite instruction
						<textarea
							rows={2}
							value={rewrite.instruction}
							disabled={rewrite.phase !== "input"}
							onChange={(e) => setRewrite({ ...rewrite, instruction: e.target.value })}
						/>
					</label>
					{rewrite.replacement !== null &&
						(rewrite.phase === "preview" || rewrite.phase === "applying") && (
							<pre className="note-rewrite-preview">{rewrite.replacement}</pre>
						)}
					{rewrite.error !== null && (
						<div className="note-rewrite-error" role="alert">
							{rewrite.error}
						</div>
					)}
					<div className="row note-rewrite-actions">
						{rewrite.phase === "saving" && <span className="hint">Saving edits…</span>}
						{rewrite.phase === "generating" && <span className="hint">Generating…</span>}
						{rewrite.phase === "applying" && <span className="hint">Applying…</span>}
						{rewrite.phase === "input" && (
							<button
								type="button"
								className="ghost"
								disabled={rewrite.instruction.trim() === ""}
								onClick={() => void generateRewrite()}
							>
								Generate rewrite
							</button>
						)}
						{rewrite.phase === "preview" && (
							<button type="button" className="ghost" onClick={() => void acceptRewrite()}>
								Apply rewrite
							</button>
						)}
						<button
							type="button"
							className="ghost-inline"
							disabled={rewrite.phase === "applying"}
							onClick={closeRewrite}
						>
							{rewrite.phase === "preview" || rewrite.phase === "blocked" ? "Discard" : "Cancel"}
						</button>
					</div>
				</div>
			)}
			{draftError !== null && (
				<div className="note-draft-error" role="alert">
					<span>{draftError}</span>
					{preserved && (
						<span className="row note-draft-actions">
							<button type="button" className="ghost-inline" onClick={downloadPreservedDraft}>
								Download draft
							</button>
							<button type="button" className="ghost-inline" onClick={discardPreservedDraft}>
								Discard draft
							</button>
						</span>
					)}
				</div>
			)}
			<div className={`note-save-status ${status}`}>{label}</div>
		</div>
	);
});

export default NoteEditor;
