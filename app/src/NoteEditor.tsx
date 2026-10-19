// Baseline = the markdown THIS serializer produces, never the raw
// server body — the parser normalizes syntax on load (`-` → `*`).
// Saves ride PATCH If-Match = baseline rev; a conflict (409 or
// handed in) blocks every automatic write until resolved.

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
	// A server-side content change landed (append, restore, another
	// writer's save): replaces the doc, rebases the baseline to the
	// serializer's own output, clears the conflict.
	reload(note: AppNote): void;
	// A non-content write's ack (title, pin, archive, move): advance
	// the If-Match rev only while the returned body still equals the
	// last server ack — a moved body means another writer landed
	// between: clean reloads it, dirty raises the conflict bar.
	adoptRev(note: AppNote): void;
	// Synchronous — an in-flight save also counts as unsafe to reload.
	dirty(): boolean;
	// Synchronous save — the listener lags edits ~200ms. Blocked
	// while a conflict stands.
	flush(): void;
	flushAndWait(): Promise<boolean>;
	// Queues into the SAME save loop as the body — a title PATCH
	// never races a body PATCH onto one rev, and the PATCH carries
	// the current serialized body so both land atomically. True only
	// when the server acked this exact title.
	saveTitle(title: string): Promise<boolean>;
	// External conflict (the page's focus refresh or a title 409):
	// blocks automatic writes.
	conflict(note: AppNote): void;
	// "theirs" reloads the live note; "mine" force-writes local
	// content (and title, when carried) on top of theirs.rev — a
	// repeated 409 reblocks.
	resolve(mode: "theirs" | "mine", theirs: AppNote, title?: string): void;
	// Drop pending body writes, including the unmount drain;
	// already-sent PATCHes can't be recalled; later edits re-arm.
	discard(): void;
	// Test seam for driving document changes.
	editor(): Editor | null;
}

export type SaveStatus = "saved" | "saving" | "offline" | "conflict" | "error";

// One open rewrite flow: the capture is immutable — taken while the
// selection still stood (the panel's input steals the DOM selection
// right after). "saving"/"blocked" are the pre-flush of pending
// edits — nothing generates on a body the server never took.
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
// fetch keepalive rejects request bodies past ~64KiB with a TypeError
// the unloading page can't surface — pagehide keeps it only under the
// cap, else the flush sends a plain PATCH. The cap counts serialized
// JSON — escaping inflates a control-char-heavy body ~6x — so save()
// measures the wire bytes, not the markdown.
const KEEPALIVE_BODY_MAX = 60_000;
const utf8 = new TextEncoder();

const NoteEditor = forwardRef<
	NoteEditorHandle,
	{
		token: string | null;
		noteId: string;
		// The whole note, not just body/rev — a stale draft restores
		// behind the conflict bar, which needs the genuine server
		// record, not invented metadata or a refetch.
		initialNote: AppNote;
		// Reports the acked note so the page tracks the live rev for
		// flag writes and titles.
		onSaved: (note: AppNote) => void;
		// A save hit a rev that isn't ours.
		onConflict: (theirs: AppNote) => void;
		onDirty?: (dirty: boolean) => void;
		// The page locks its own actions (title, flags, archive,
		// restore, chat) for the same window — nothing races the
		// pending apply.
		onRewriteBusy?: (busy: boolean) => void;
		// Held while the apply PATCH is in flight — conflict
		// resolution must not launch an ordinary save against it.
		onRewriteApplying?: (applying: boolean) => void;
		// Test seam — the product's debounce is a second.
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
	// The raw body the server last acknowledged — adoptRev compares
	// responses against it.
	const serverBodyRef = useRef(initialNote.body);
	const revRef = useRef(initialNote.rev);
	// rev orders only content writes; stateRev is the monotonic token
	// stale-response guards run on — flag responses advance it too.
	const stateRevRef = useRef(initialNote.stateRev);
	// The title the server last acked — saveTitle() resolves true
	// only once a response carries exactly it.
	const titleAckRef = useRef(initialNote.title);
	// A reload()/adoptRev() landing before Editor.create resolves —
	// or a newer initialNote prop — queues here; the create
	// continuation applies the freshest before draft recovery.
	const startupRemoteRef = useRef<AppNote | null>(null);
	const initialNoteRef = useRef(initialNote);
	initialNoteRef.current = initialNote;
	// The server state the stored draft stands on. While a conflict
	// stands it keeps the draft's ORIGINAL base — rebasing onto the
	// newer remote would make a revisit autosave stale local text
	// over it.
	const draftBaseRef = useRef({ rev: initialNote.rev, body: initialNote.body });
	// Suppresses draft capture during mount/recovery and programmatic
	// reloads — a restore is not an edit, and the mount-time parse
	// normalization must never write or autosave.
	const suppressDraftRef = useRef(true);
	// The exact record this editor last stored — compare-delete, so
	// a late ack clears only its own write.
	const lastDraftRef = useRef<string | null>(null);
	// An unreadable stored record stays on the key verbatim until
	// the operator handles it — persistDraft refuses while it stands.
	const preservedRef = useRef(false);
	const [preserved, setPreserved] = useState(false);
	const dirtyRef = useRef(false);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const savingRef = useRef(false);
	// A save requested while one is in flight — runs on settle with
	// merged options (a forced resolve keeps force + title).
	const pendingRef = useRef<{
		keepalive: boolean;
		force?: boolean;
		title?: string;
		preflush?: boolean;
	} | null>(null);
	// A standing conflict blocks every automatic write until resolve().
	const conflictRef = useRef<AppNote | null>(null);
	// Set at unmount: callbacks and scheduling stop; the cleanup
	// drain flushes the pending write, then destroys the editor —
	// drainDead breaks the loop on a write that can't land detached.
	const unmountedRef = useRef(false);
	const drainDeadRef = useRef(false);
	// A permanent write failure (4xx, deleted note) — the buffer stays
	// dirty but nothing auto-reschedules; the next edit retries.
	const hardFailRef = useRef(false);
	// A late save acknowledgement must not re-dirty a discarded buffer.
	const discardedBodyRef = useRef<string | null>(null);
	const inFlightRef = useRef<Promise<void> | null>(null);
	// Live PM doc-position selection for the toolbar — not the DOM
	// selection the panel steals.
	const selRef = useRef<{ from: number; to: number; empty: boolean }>({
		from: 0,
		to: 0,
		empty: true,
	});
	const rewriteActiveRef = useRef(false);
	const rewriteAbortRef = useRef<AbortController | null>(null);
	// One applying window — the page's resolution buttons disable on
	// its edges.
	const rewriteApplyingRef = useRef(false);
	// Flow/request identity — bumped per flow; a stale generation
	// response or late continuation of a closed flow is dropped.
	const rewriteReqRef = useRef(0);
	const [rewrite, setRewrite] = useState<RewriteFlow | null>(null);
	// Mirror for the handle — resolve() refuses an ordinary save
	// while an apply PATCH is held.
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

	// Storage failures stay visible: ErrorEvent diagnostic + alert,
	// so a broken draft never masquerades as recovery. No note body
	// or token ever enters either.
	function reportDraftError(verb: "preserved" | "loaded" | "cleared", e: unknown): void {
		// A raw SyntaxError message can quote its input (V8) — stored
		// bytes are note content, never shown.
		const msg =
			e instanceof SyntaxError
				? "stored record is malformed"
				: e instanceof Error
					? e.message
					: String(e);
		window.dispatchEvent(new ErrorEvent("error", { message: `note draft ${verb} failed: ${msg}` }));
		if (!unmountedRef.current) setDraftError(`Local draft could not be ${verb}: ${msg}`);
	}

	// Store the live body as the durable draft on draftBaseRef's base;
	// returns the stored snapshot, or null when storage refused. After
	// unmount a newer editor owns the record — a late drain/ack write
	// may only overwrite its own snapshot.
	function persistDraft(md: string, ownedOnly = false): string | null {
		// The preserved record owns the key — overwriting unreadable
		// bytes would destroy the unsaved work they hold.
		if (preservedRef.current || md === discardedBodyRef.current) return null;
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

	// Baseline-equal clears only THIS editor's last snapshot, and only
	// while no conflict stands — under one, baseline-equal local text
	// IS the conflict's local side and stays recoverable.
	function captureDraft(md: string): void {
		if (md === discardedBodyRef.current) return;
		// Expire the discard synchronously, before the listener's
		// debounce can coalesce an edit-and-revert back to discarded text.
		discardedBodyRef.current = null;
		if (md === baselineRef.current && conflictRef.current === null) {
			const snap = lastDraftRef.current;
			lastDraftRef.current = null;
			if (snap !== null) dropDraft(snap);
			return;
		}
		persistDraft(md);
	}

	// Download hands back the raw bytes; Discard frees the key so the
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
		// The freed key lets the live buffer become the draft again.
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
		// Only the flow's explicit preflush saves while a rewrite owns
		// the editor — the apply PATCH stays the sole writer.
		if (rewriteActiveRef.current && opts.preflush !== true) return;
		if (savingRef.current) {
			// Merge, never replace — a body-only re-arm must not drop a
			// queued title.
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
		if (
			opts.force !== true &&
			opts.title === undefined &&
			(md === baselineRef.current || md === discardedBodyRef.current)
		) {
			if (md !== discardedBodyRef.current) captureDraft(md);
			markDirty(false);
			markStatus("saved");
			return;
		}
		// Capture at save entry covers anything the plugin missed —
		// the ack may clear only this snapshot, and only while the
		// live body is still this one.
		const requestSnap = persistDraft(md, opts.force !== true);
		savingRef.current = true;
		hardFailRef.current = false;
		markStatus("saving");
		const flight = (async () => {
			try {
				const patch = {
					body: md,
					...(opts.title !== undefined ? { title: opts.title } : {}),
				};
				const { data } = await patchNote(token, noteId, patch, {
					ifMatch: expectedRev,
					keepalive:
						opts.keepalive === true &&
						utf8.encode(JSON.stringify(patch)).length <= KEEPALIVE_BODY_MAX,
				});
				baselineRef.current = md;
				// A write that landed before a newer remote was observed
				// must not roll title or serverBody back over it.
				const freshest = data.stateRev >= stateRevRef.current;
				if (freshest) {
					serverBodyRef.current = data.body;
					titleAckRef.current = data.title;
				}
				// Never backwards — a flag response may race ahead.
				if (data.rev > revRef.current) revRef.current = data.rev;
				if (data.stateRev > stateRevRef.current) stateRevRef.current = data.stateRev;
				// A landed write resolves only a conflict at or below its
				// state token — a delayed ack can't clear a newer observed
				// remote (the page's forward guard drops it; only the
				// label stays blocked).
				const c = conflictRef.current;
				if (c === null || data.stateRev >= c.stateRev) conflictRef.current = null;
				// The draft base advances only on a save that stands
				// clean — a late old ack under a newer observed conflict
				// must not rebase the stored draft onto that remote.
				if (conflictRef.current === null)
					draftBaseRef.current = { rev: revRef.current, body: serverBodyRef.current };
				// Retire the request snapshot only while the live body is
				// still the submitted one and no conflict stands — under a
				// newer remote the local body is the conflict's local side
				// and stays recoverable at its ORIGINAL base; mid-flight
				// edits persist again at whatever base now stands.
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
					// Transient (network/5xx) — settle reschedules.
					markStatus("offline");
				} else {
					// Permanent refusal — retry only on a new edit, not a timer.
					hardFailRef.current = true;
					markStatus("error", e instanceof Error ? e.message : String(e));
				}
			} finally {
				savingRef.current = false;
				if (unmountedRef.current) {
					// The drain loop owns pendingRef now — it dispatches the
					// queued write itself, so a title committed behind this
					// PATCH still lands.
					return;
				}
				// Reconcile against the live doc, not a dirty flag set
				// before the PATCH resolved — a disclaimed buffer isn't
				// dirty just because the landed write moved the baseline.
				const live = editorRef.current;
				const liveMd = live === null ? null : live.action(getMarkdown());
				const dirtyNow =
					liveMd !== null && liveMd !== baselineRef.current && liveMd !== discardedBodyRef.current;
				markDirty(dirtyNow);
				const pending = pendingRef.current;
				pendingRef.current = null;
				if (conflictRef.current === null && !hardFailRef.current) {
					if (pending !== null) {
						// A queued title dispatches even on a clean body.
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
		// Serialize synchronously — the listener lags ~200ms, so a
		// typed-then-left window is dirty before dirtyRef knows.
		const md = ed.action(getMarkdown());
		if (md === baselineRef.current || md === discardedBodyRef.current) return;
		// save() measures the wire body against the keepalive cap.
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
		// Consume the queued drain so its options (a forced title) ride
		// this flush instead of dispatching twice off the finally.
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

	// Rides the same save loop as body autosaves — a title PATCH
	// never races a body PATCH onto the same rev. True only once a
	// response acks exactly this title.
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

	function discard(): void {
		const ed = editorRef.current;
		if (ed === null) return;
		clearTimer();
		pendingRef.current = null;
		discardedBodyRef.current = ed.action(getMarkdown());
		const snap = lastDraftRef.current;
		lastDraftRef.current = null;
		if (snap !== null) dropDraft(snap);
		markDirty(false);
	}

	// Adopt the note: rebase the baseline to the serializer's own
	// output — the debounced markdownUpdated for this replaceAll
	// self-cancels against it — clear the conflict, and retire the
	// stored draft this editor last wrote.
	function reload(note: AppNote): void {
		const ed = editorRef.current;
		if (ed === null) {
			// Editor.create still resolving — the freshest queued
			// refresh wins, applied before draft recovery.
			const queuedRev = startupRemoteRef.current?.stateRev ?? stateRevRef.current;
			if (!unmountedRef.current && note.stateRev > queuedRev) {
				startupRemoteRef.current = note;
			}
			return;
		}
		clearTimer();
		pendingRef.current = null;
		conflictRef.current = null;
		discardedBodyRef.current = null;
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

	// editable reads the flag through one closure — setProps installs
	// it once; flipping the ref is the lock.
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
		// Identity bump — an in-flight generation response or a
		// still-draining preflush continuation is stale the moment
		// the panel goes away.
		rewriteReqRef.current += 1;
		rewriteAbortRef.current?.abort();
		rewriteAbortRef.current = null;
		lockEditing(false);
		setRewrite(null);
		onRewriteBusyRef.current?.(false);
		setApplying(false);
		// A preflush that couldn't land still owes the edit a retry —
		// rearm now that automatic writes are allowed again.
		if (unmountedRef.current) return;
		const ed = editorRef.current;
		const md = ed?.action(getMarkdown());
		if (md !== undefined && md !== baselineRef.current && md !== discardedBodyRef.current) {
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
		// Capture before focus leaves the editor — the panel's input
		// steals the DOM selection right after.
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

	// Persist pending edits BEFORE generating — the proposal and the
	// apply PATCH both stand on that rev; nothing generates on a
	// body the server never took. flowId guards every await: a
	// canceled or superseded flow's late continuation must never
	// touch a newer flow's panel.
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
			// bar owns the block, so the panel closes.
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
		// doc doesn't change until the server accepts it.
		let nextBody: string | null;
		try {
			nextBody = ed.action((ctx): string | null => {
				const view = ctx.get(editorViewCtx);
				// A reload or programmatic edit since capture means the
				// offsets no longer describe this doc — refuse.
				if (!view.state.doc.eq(r.doc)) return null;
				const replacement = r.replacement;
				if (replacement === null) return null;
				const tr = view.state.tr.replaceRange(r.from, r.to, markdownToSlice(replacement)(ctx));
				return ctx.get(serializerCtx)(tr.doc);
			});
		} catch (e) {
			// Parse/replace/serialization failure — nothing was sent.
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
			// Re-read after the await — a focus conflict can have landed.
			const c = conflictRef.current as AppNote | null;
			// Same delayed-success guard as autosave: a newer conflict
			// observed while the apply was held, or a token that moved
			// past this PATCH, must not be adopted over. The ack still
			// reports (the page's forward guard drops stale tokens) —
			// but doc and standing conflict stay.
			if (data.stateRev < stateRevRef.current || (c !== null && c.stateRev > data.stateRev)) {
				onSavedRef.current(data);
				closeRewrite();
				return;
			}
			// A programmatic dispatch while the apply was held moved the
			// live doc off the capture — the write landed, but the
			// buffer is unsaved work: keep it behind the conflict bar
			// instead of reloading over it.
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
			// Adopt through the normal rebase — only now does the doc change.
			reload(data);
			closeRewrite();
			onSavedRef.current(data);
		} catch (e) {
			if (unmountedRef.current) return;
			setApplying(false);
			if (e instanceof NoteConflictError) {
				// Same block as an autosave 409 — the preview and the
				// buffer stay; the bar resolves it.
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
		// A broken record keeps the normal server doc (never deleted),
		// just with the failure shown.
		let recovered: { draft: NoteDraft; snapshot: string } | null = null;
		try {
			recovered = loadNoteDraft(noteId);
		} catch (err) {
			reportDraftError("loaded", err);
			// Held until the operator's download or discard —
			// persistDraft blocks while this stands.
			preservedRef.current = true;
			setPreserved(true);
		}
		const ed = Editor.make()
			.config((ctx) => {
				ctx.set(rootCtx, container);
				ctx.set(defaultValueCtx, initialNote.body);
				const mgr = ctx.get(listenerCtx);
				// The parser normalizes on load (`-` → `*`) — the
				// baseline must be the serializer's own output taken at
				// mount, or the first real edit autosaves a
				// normalization rewrite the operator never typed.
				mgr.mounted((c) => {
					baselineRef.current = getMarkdown()(c);
				});
				mgr.markdownUpdated((_c, md) => {
					if (unmountedRef.current) return;
					if (md !== discardedBodyRef.current) discardedBodyRef.current = null;
					if (md === baselineRef.current || md === discardedBodyRef.current) {
						clearTimer();
						markDirty(false);
						// Undoing back to the baseline doesn't resolve a
						// standing conflict.
						if (conflictRef.current === null) markStatus("saved");
						return;
					}
					markDirty(true);
					schedule();
				});
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
			// Draft capture runs synchronously on EVERY doc change —
			// the listener's debounce owns autosave timing, but a
			// typed-then-gone body can't wait for it.
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
					const queued = startupRemoteRef.current;
					startupRemoteRef.current = null;
					// The freshest state we hold — queued refresh, latest
					// prop, or a pre-ready conflict's note (which already
					// moved stateRevRef; assigning below it would roll
					// the token backwards) — applied under suppression
					// BEFORE baseline and draft recovery judge.
					const fresh = [
						initialNoteRef.current,
						...(queued !== null ? [queued] : []),
						...(conflictRef.current !== null ? [conflictRef.current] : []),
					].reduce((a, b) => (b.stateRev > a.stateRev ? b : a));
					// Compare the live serialization, never a captured
					// prop — a delayed create or a differently-initialized
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
					// A stored draft restores under suppression, then its
					// recorded base decides: serializes to baseline — it
					// already landed, retire it. Base matches — genuinely
					// dirty, resume the guarded autosave. Base moved —
					// restore local-only behind the conflict bar, keeping
					// the ORIGINAL base so no later capture rebases over
					// the remote.
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
		// Persist the buffer durably FIRST — it runs even under a
		// conflict or open rewrite — then the keepalive flush is the
		// best-effort fast path.
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
			// Drain, then destroy: flush the pending write, wait out the
			// in-flight PATCH (whose response may re-dirty — the loop
			// sends the latest body at the new rev). A write queued
			// behind it — a title commit carries no body diff — is
			// dispatched too, or it dies with the editor. A blocked or
			// dead write or a confirmed discard stops the drain.
			void (async () => {
				while (e !== null && conflictRef.current === null && !drainDeadRef.current) {
					const flight = inFlightRef.current;
					if (flight !== null) {
						await flight;
						continue;
					}
					const queued = pendingRef.current;
					pendingRef.current = null;
					const drainMd = e.action(getMarkdown());
					if (drainMd === discardedBodyRef.current) break;
					if (queued === null && drainMd === baselineRef.current) break;
					void save(revRef.current, queued ?? {});
				}
				if (e !== null) e.destroy().catch(detachErr);
				editorRef.current = null;
			})();
		};
		// Initial content binds once per noteId; later server changes
		// arrive via handle.reload(), not remounts.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [noteId]);

	useImperativeHandle(ref, () => {
		return {
			dirty: () => {
				// An open rewrite flow is also unsafe to reload — the
				// apply PATCH doesn't ride savingRef.
				if (savingRef.current || rewriteActiveRef.current) return true;
				const ed = editorRef.current;
				if (ed === null) return false;
				const md = ed.action(getMarkdown());
				return md !== baselineRef.current && md !== discardedBodyRef.current;
			},
			editor: () => editorRef.current,
			flush: () => flush(),
			flushAndWait,
			saveTitle,
			discard,
			reload,
			adoptRev: (note: AppNote): void => {
				if (editorRef.current === null) {
					// Same startup queue as reload.
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
				// held — the handle-side guard for the page's disabled
				// buttons.
				if (rewriteRef.current?.phase === "applying") return;
				// An explicit resolution ends any open flow first — no
				// stale preview over freshly replaced content.
				if (rewriteActiveRef.current) closeRewrite();
				if (mode === "theirs") {
					reload(theirs);
					return;
				}
				// Clear the block only for the forced write — a repeated
				// 409 reblocks via the catch path. Keep mine writes ON
				// TOP of theirs, so the draft base advances to it first.
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
