// Milkdown editor for /app/n/<id> — lazy-imported from NoteView so the
// editor stack stays out of the main chunk. Owns the autosave loop:
// a baseline (the markdown last produced by THIS serializer — never
// the raw server body, whose syntax the parser normalizes) and a
// debounce; saves ride PATCH with If-Match = baseline rev, so
// concurrent writers conflict instead of clobbering. A conflict —
// from a 409 or handed in by the page — blocks every automatic write
// until the operator explicitly resolves it.

import { Editor, defaultValueCtx, rootCtx } from "@milkdown/kit/core";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { history } from "@milkdown/kit/plugin/history";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { getMarkdown, replaceAll } from "@milkdown/kit/utils";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { ApiError, NoteConflictError, patchNote } from "./api.ts";
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
		// Tests shorten the debounce; the product keeps a second.
		saveDelayMs?: number;
	}
>(function NoteEditor(
	{ token, noteId, initialBody, initialRev, onSaved, onConflict, onDirty, saveDelayMs },
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
	const pendingRef = useRef<{ keepalive: boolean; force?: boolean; title?: string } | null>(null);
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
	const [status, setStatus] = useState<SaveStatus>("saved");
	const [statusDetail, setStatusDetail] = useState<string | null>(null);
	const onSavedRef = useRef(onSaved);
	const onConflictRef = useRef(onConflict);
	const onDirtyRef = useRef(onDirty);
	onSavedRef.current = onSaved;
	onConflictRef.current = onConflict;
	onDirtyRef.current = onDirty;

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
		if (unmountedRef.current || conflictRef.current !== null) return;
		clearTimer();
		timerRef.current = setTimeout(
			() => void save(revRef.current),
			saveDelayMs ?? DEBOUNCE_MS,
		);
	}

	async function save(
		expectedRev: number,
		opts: { keepalive?: boolean; force?: boolean; title?: string } = {},
	): Promise<void> {
		if (conflictRef.current !== null) return;
		if (savingRef.current) {
			pendingRef.current = {
				keepalive: opts.keepalive === true,
				...(opts.force === true ? { force: true } : {}),
				...(opts.title !== undefined ? { title: opts.title } : {}),
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
				} else if (
					e instanceof TypeError ||
					(e instanceof ApiError && e.status >= 500)
				) {
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
				const dirtyNow =
					live !== null &&
					live.action(getMarkdown()) !== baselineRef.current;
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
		if (ed === null || conflictRef.current !== null) return;
		// Synchronous check — the listener lags edits ~200ms, so a
		// typed-then-left window is still dirty even though dirtyRef
		// hasn't caught up.
		if (ed.action(getMarkdown()) === baselineRef.current) return;
		void save(revRef.current, { keepalive });
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
			const e = editorRef.current;
			// Drain, then destroy: fire the pending write if the
			// serialized doc still differs from the baseline, wait for
			// the in-flight PATCH (whose response may re-dirty — the
			// loop sends the latest body at the new rev), then tear
			// down. A blocked or dead write stops the drain.
			void (async () => {
				while (
					e !== null &&
					conflictRef.current === null &&
					!drainDeadRef.current
				) {
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
		const reload = (note: AppNote): void => {
			const ed = editorRef.current;
			if (ed === null) return;
			clearTimer();
			pendingRef.current = null;
			conflictRef.current = null;
			ed.action(replaceAll(note.body));
			// Rebase on the serialized form (normalized), not the raw
			// body: the listener's ~200ms-debounced markdownUpdated for
			// this replaceAll lands after this and self-cancels against
			// the new baseline.
			baselineRef.current = ed.action(getMarkdown());
			serverBodyRef.current = note.body;
			revRef.current = note.rev;
			markDirty(false);
			markStatus("saved");
		};
		return {
			dirty: () => {
				if (savingRef.current) return true;
				const ed = editorRef.current;
				return (
					ed !== null && ed.action(getMarkdown()) !== baselineRef.current
				);
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
					if (savingRef.current || (editorRef.current?.action(getMarkdown()) ?? baselineRef.current) !== baselineRef.current) {
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
			<div className={`note-save-status ${status}`}>{label}</div>
		</div>
	);
});

export default NoteEditor;
