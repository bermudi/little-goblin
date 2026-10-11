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
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { history } from "@milkdown/kit/plugin/history";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { getMarkdown, markdownToSlice, replaceAll } from "@milkdown/kit/utils";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { ApiError, NoteConflictError, patchNote, rewriteNote } from "./api.ts";
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
		initialBody: string;
		initialRev: number;
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
		initialBody,
		initialRev,
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
	const baselineRef = useRef(initialBody);
	// The raw body the server last acknowledged (initial load, reload,
	// successful PATCH) — adoptRev compares responses against it.
	const serverBodyRef = useRef(initialBody);
	const revRef = useRef(initialRev);
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
			pendingRef.current = {
				keepalive: opts.keepalive === true,
				...(opts.force === true ? { force: true } : {}),
				...(opts.title !== undefined ? { title: opts.title } : {}),
				...(opts.preflush === true ? { preflush: true } : {}),
			};
			return;
		}
		const ed = editorRef.current;
		if (ed === null) return;
		const md = ed.action(getMarkdown());
		if (opts.force !== true && md === baselineRef.current) {
			markDirty(false);
			markStatus("saved");
			return;
		}
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
				serverBodyRef.current = data.body;
				// Never backwards — a flag response may race ahead.
				if (data.rev > revRef.current) revRef.current = data.rev;
				// A landed write resolves only a conflict at or below its
				// rev — a delayed response can't clear a newer observed
				// remote. The page still hears about the ack (its forward
				// guard drops the stale rev); only the label stays blocked.
				const c = conflictRef.current;
				if (c === null || data.rev >= c.rev) conflictRef.current = null;
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
					// The drain loop re-serializes and decides for itself.
					pendingRef.current = null;
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
						if (pending.force === true || dirtyNow) void save(revRef.current, pending);
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

	// A server-side content change landed: adopt the note, rebase the
	// baseline to the serializer's own output (the listener's ~200ms-
	// debounced markdownUpdated for this replaceAll lands after this
	// and self-cancels against the new baseline), clear the conflict.
	function reload(note: AppNote): void {
		const ed = editorRef.current;
		if (ed === null) return;
		clearTimer();
		pendingRef.current = null;
		conflictRef.current = null;
		ed.action(replaceAll(note.body));
		baselineRef.current = ed.action(getMarkdown());
		serverBodyRef.current = note.body;
		revRef.current = note.rev;
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
			// conflict observed while the apply was held, or a write rev
			// that moved past this PATCH, must not be adopted over. The
			// ack still reports — the page's forward guard drops stale
			// revs — but the doc and the standing conflict stay.
			if (data.rev < revRef.current || (c !== null && c.rev > data.rev)) {
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
		const ed = Editor.make()
			.config((ctx) => {
				ctx.set(rootCtx, container);
				ctx.set(defaultValueCtx, initialBody);
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
					baselineRef.current = e.action(getMarkdown());
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
		// Leaving must not lose the debounce window's work: pagehide
		// flushes the pending save through fetch keepalive so it
		// survives the unload itself.
		const onHide = () => flush(true);
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
			const e = editorRef.current;
			// Drain, then destroy: fire the pending write if the
			// serialized doc still differs from the baseline, wait for
			// the in-flight PATCH (whose response may re-dirty — the
			// loop sends the latest body at the new rev), then tear
			// down. A blocked or dead write stops the drain.
			void (async () => {
				while (e !== null && conflictRef.current === null && !drainDeadRef.current) {
					const flight = inFlightRef.current;
					if (flight !== null) {
						await flight;
						continue;
					}
					if (e.action(getMarkdown()) === baselineRef.current) break;
					void save(revRef.current);
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
			reload,
			adoptRev: (note: AppNote): void => {
				// Stale first: a delayed older response must never touch the
				// doc, the baseline, or the write rev.
				if (note.rev < revRef.current) return;
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
				if (note.rev > revRef.current) revRef.current = note.rev;
			},
			conflict: (note: AppNote): void => {
				clearTimer();
				conflictRef.current = note;
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
				// repeated 409 reblocks via the catch path.
				conflictRef.current = null;
				revRef.current = theirs.rev;
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
			<div className={`note-save-status ${status}`}>{label}</div>
		</div>
	);
});

export default NoteEditor;
