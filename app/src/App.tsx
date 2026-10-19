import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { UIMessage } from "ai";
import {
	ApiError,
	clearToken,
	createConversation,
	deleteConversation,
	listConversations,
	listProjects,
	loadToken,
	patchConversation,
	saveToken,
	searchConversations,
	telegramDoor,
} from "./api.ts";
import { ChatView, Composer, type StagedNote, type StagedUpload } from "./ChatView.tsx";
import { SettingsView } from "./SettingsView.tsx";
import { MemoryView } from "./MemoryView.tsx";
import { ThreadSourcesSheet } from "./ThreadSourcesSheet.tsx";
import { DelegationsView, ProgramsView, StatusView } from "./OperatorViews.tsx";
import { FilesView, SkillsView } from "./StateViews.tsx";
import { LogView } from "./LogView.tsx";
import { NewProjectDialog, ProjectsIndex, ProjectView } from "./ProjectView.tsx";
import { NotesIndex, NoteView } from "./NoteView.tsx";
import type {
	AppConversationList,
	AppNote,
	AppProject,
	AppSearchHit,
} from "../../src/http/app-wire.ts";

// The operator pages ride the same shell as chat — deep links like
// /app/settings are served the app bundle and land here. `project` is
// /app/p/<id> and `note` /app/n/<id> — their ids live outside the union.
type Page =
	| "chat"
	| "settings"
	| "memory"
	| "delegations"
	| "programs"
	| "status"
	| "skills"
	| "files"
	| "log"
	| "projects"
	| "project"
	| "notes"
	| "note";

const PAGES: { key: Exclude<Page, "chat" | "notes" | "note">; label: string }[] = [
	{ key: "settings", label: "Settings" },
	{ key: "memory", label: "Memories" },
	{ key: "delegations", label: "Delegations" },
	{ key: "programs", label: "Programs" },
	{ key: "status", label: "Status" },
	{ key: "skills", label: "Skills" },
	{ key: "files", label: "Files" },
	{ key: "log", label: "Log" },
];

function pageFromPath(pathname: string): Page | null {
	// /app/ is the PWA door, /t/ the Telegram mini app's — both serve this
	// bundle and both parse the same page vocabulary; each door clamps the
	// result to its own page scope.
	const m =
		/^\/(?:app|t)\/(settings|memory|delegations|programs|status|skills|files|log|projects|notes)\/?$/.exec(
			pathname,
		);
	return m === null ? null : (m[1] as Page);
}

// /app/p/<projectId> — project ids are server-minted randomUUIDs, the
// same url-safe shape the /app/c/ link checks (design/projects.md).
export function projectFromPath(pathname: string): string | null {
	const m = /^\/app\/p\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/?$/.exec(pathname);
	return m === null ? null : m[1]!;
}

// /app/n/<noteId> — same id shape as projects.
function noteFromPath(pathname: string): string | null {
	const m = /^\/app\/n\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/?$/.exec(pathname);
	return m === null ? null : m[1]!;
}

function historyPosition(state: unknown): { index: number; segment: string } | null {
	if (
		typeof state !== "object" ||
		state === null ||
		!("goblinIndex" in state) ||
		typeof state.goblinIndex !== "number" ||
		!Number.isSafeInteger(state.goblinIndex) ||
		!("goblinSegment" in state) ||
		typeof state.goblinSegment !== "string"
	)
		return null;
	return { index: state.goblinIndex, segment: state.goblinSegment };
}

const newHistorySegment = () => crypto.getRandomValues(new Uint32Array(2)).join("-");

interface BrowserNavigation {
	readonly currentEntry: { readonly key: string };
	traverseTo(key: string): { committed: Promise<unknown>; finished: Promise<unknown> };
}

// Native keys also identify entries created before we started tagging history.
// The DOM typings don't yet expose Window.navigation.
function browserNavigation(): BrowserNavigation | null {
	const value: unknown = Reflect.get(window, "navigation");
	if (
		typeof value !== "object" ||
		value === null ||
		!("traverseTo" in value) ||
		typeof value.traverseTo !== "function" ||
		!("currentEntry" in value) ||
		typeof value.currentEntry !== "object" ||
		value.currentEntry === null ||
		!("key" in value.currentEntry) ||
		typeof value.currentEntry.key !== "string"
	)
		return null;
	return value as BrowserNavigation;
}

// Sidebar timestamps are relative: "now", minutes, hours, days, then a
// short date — the format Open WebUI's chat list uses.
function relTime(iso: string): string {
	const ts = Date.parse(iso);
	if (Number.isNaN(ts)) return "";
	const diffSec = Math.floor((Date.now() - ts) / 1000);
	if (diffSec < 60) return "now";
	const diffMin = Math.floor(diffSec / 60);
	if (diffMin < 60) return `${diffMin}m`;
	const diffHr = Math.floor(diffMin / 60);
	if (diffHr < 24) return `${diffHr}h`;
	const diffDay = Math.floor(diffHr / 24);
	if (diffDay < 7) return `${diffDay}d`;
	return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Sidebar rows are single-line labels, so markdown furniture comes off
// the stored title at display time: fences and their language tag,
// inline-code backticks, link syntax (text survives), paired emphasis,
// and line-lead markers. Mirrors conversation.ts's flatLine — the client
// does its own pass because a running server may predate the store-side
// flattening and still hand over a fenced title.
export function flatLine(text: string): string {
	return text
		.replace(/```+[ \t]*[^\s`\n]*/g, " ")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
		.replace(/(\*|_)([^\s*_][^*_]*?[^\s*]|[^\s*_])\1/g, "$2")
		.replace(/^[ \t]*(?:#{1,6}|>|[-*+]|\d+\.)[ \t]+/gm, "")
		.replace(/\s+/g, " ")
		.trim();
}

// A title reduced to nothing falls through to the preview, same as the
// server's `flatLine(r.title) || null` projection.
function flatTitle(title: string | null): string | null {
	if (title === null) return null;
	return flatLine(title) || null;
}

// The spin-off deep link (design/app.md → Spin-off → Links):
// /app/c/<appId> opens one conversation — the id matches the server's
// appIdSchema and the conversation id is "app/<appId>".
export function deepLinkConv(pathname: string): string | null {
	const m = /^\/app\/c\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})$/.exec(pathname);
	return m === null ? null : `app/${m[1]}`;
}

// The token is the operator-pasted credential (the value behind the
// auth.jsonl record config.appToken names), kept in sessionStorage — it
// dies with the tab, so a new browser session re-asks for it. When
// the server runs trust mode (appToken unset) no credential exists —
// App probes unauthenticated first so the gate never shows.

function TokenGate({ hint, onToken }: { hint: string | null; onToken: (token: string) => void }) {
	const [draft, setDraft] = useState("");
	const [error, setError] = useState<string | null>(hint);
	const [busy, setBusy] = useState(false);
	const submit = async () => {
		const token = draft.trim();
		if (token === "") return;
		setBusy(true);
		setError(null);
		try {
			// Prove the token before storing it — a bad paste should fail here.
			await listConversations(token);
			saveToken(token);
			onToken(token);
		} catch (err) {
			setError(
				err instanceof ApiError && err.status === 503
					? "The app channel isn't configured on this goblin."
					: "That token wasn't accepted.",
			);
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="gate">
			<h1>goblin</h1>
			<p className="gate-hint">Paste the app token to open the channel.</p>
			<form
				onSubmit={(e) => {
					e.preventDefault();
					void submit();
				}}
			>
				<input
					type="password"
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					placeholder="app token"
					aria-label="App token"
					autoFocus
					autoComplete="off"
				/>
				<button type="submit" disabled={busy || draft.trim() === ""}>
					Open
				</button>
			</form>
			{error !== null && <p className="error">{error}</p>}
		</div>
	);
}

// A small pushpin, shown persistently on pinned rows — the marker
// explaining why the row floats above the activity stream.
function PinGlyph() {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			width="10"
			height="10"
			className="conv-pin"
			aria-hidden="true"
		>
			<path d="M9 3h6l2 8H7l2-8z" />
			<line x1="12" y1="11" x2="12" y2="21" />
		</svg>
	);
}

// Stroke icons for the row's hover actions — the same 24-grid, 2px-stroke
// style as PinGlyph. Icon-only buttons must carry aria-label + title; the
// tests assert on the accessible name, not on visible text.
function ActionGlyph({ children }: { children: ReactNode }) {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			width="12"
			height="12"
			aria-hidden="true"
		>
			{children}
		</svg>
	);
}
const PinActionGlyph = () => (
	<ActionGlyph>
		<path d="M9 3h6l2 8H7l2-8z" />
		<line x1="12" y1="11" x2="12" y2="21" />
	</ActionGlyph>
);
const UnpinGlyph = () => (
	<ActionGlyph>
		<path d="M9 3h6l2 8H7l2-8z" />
		<line x1="12" y1="11" x2="12" y2="21" />
		<line x1="5" y1="5" x2="19" y2="19" />
	</ActionGlyph>
);
const PencilGlyph = () => (
	<ActionGlyph>
		<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
	</ActionGlyph>
);
const ArchiveGlyph = () => (
	<ActionGlyph>
		<rect x="2" y="3" width="20" height="5" rx="1" />
		<path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
		<path d="M10 12h4" />
	</ActionGlyph>
);
const UnarchiveGlyph = () => (
	<ActionGlyph>
		<rect x="2" y="3" width="20" height="5" rx="1" />
		<path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
		<path d="m9 15 3-3 3 3" />
		<path d="M12 12v7" />
	</ActionGlyph>
);
const TrashGlyph = () => (
	<ActionGlyph>
		<path d="M3 6h18" />
		<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
		<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
	</ActionGlyph>
);

// One rail row: the conversation button plus its three icon actions —
// pin floats the row above the rail's activity order, rename turns the
// title into an input, archive shelves the row (no confirm — it's
// reversible). The actions overlay the preview line on hover so the
// title never trades width for them. Archived rows swap pin/archive for
// unarchive and delete, delete keeping the confirm as the one
// destructive action.
function ConversationRow({
	conv,
	current,
	onOpen,
	onRenamed,
	onToggleArchived,
	onTogglePinned,
	onDeleted,
	onError,
	token,
}: {
	conv: AppConversationList["conversations"][number];
	current: string | null;
	onOpen: (id: string) => void;
	onRenamed: () => void;
	onToggleArchived: (id: string, archived: boolean) => void;
	onTogglePinned: (id: string, pinned: boolean) => void;
	onDeleted: (id: string) => void;
	onError: (message: string) => void;
	token: string | null;
}) {
	const title = flatTitle(conv.title);
	const preview = flatLine(conv.preview);
	const archived = conv.archivedAt !== null;
	const pinned = conv.pinnedAt !== null;
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");
	const editRef = useRef<HTMLInputElement>(null);
	// Enter commits and unmounts the input — its blur then fires
	// commitRename a second time, a duplicate PATCH with the same title.
	const committed = useRef(false);
	useEffect(() => {
		if (editing) {
			committed.current = false;
			editRef.current?.focus();
			editRef.current?.select();
		}
	}, [editing]);

	// A dropped rejection leaves the operator staring at a row that did
	// nothing — every mutation failure surfaces in the rail.
	const failed = (verb: string) => (err: unknown) =>
		onError(
			`Couldn't ${verb} "${title ?? (preview === "" ? "this conversation" : preview)}": ` +
				(err instanceof Error ? err.message : String(err)),
		);
	const commitRename = () => {
		if (committed.current) return;
		committed.current = true;
		const t = draft.trim();
		setEditing(false);
		if (t === "" || t === title) return;
		void patchConversation(token, conv.id, { title: t }).then(onRenamed, failed("rename"));
	};
	const toggleArchived = () => {
		void patchConversation(token, conv.id, { archived: !archived }).then(
			() => onToggleArchived(conv.id, !archived),
			failed(archived ? "unarchive" : "archive"),
		);
	};
	const togglePinned = () => {
		void patchConversation(token, conv.id, { pinned: !pinned }).then(
			() => onTogglePinned(conv.id, !pinned),
			failed(pinned ? "unpin" : "pin"),
		);
	};
	const startRename = () => {
		setDraft(title ?? "");
		setEditing(true);
	};
	const remove = () => {
		if (!window.confirm(`Delete "${title ?? preview ?? "this conversation"}"?`)) return;
		void deleteConversation(token, conv.id).then(() => onDeleted(conv.id), failed("delete"));
	};

	if (editing) {
		return (
			<div className="conv editing">
				<input
					ref={editRef}
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onBlur={commitRename}
					onKeyDown={(e) => {
						if (e.key === "Enter") commitRename();
						// Escape is a cancel: mark committed so the
						// unmount's blur doesn't PATCH the half-typed draft.
						if (e.key === "Escape") {
							committed.current = true;
							setEditing(false);
						}
					}}
				/>
			</div>
		);
	}
	// Without a preview line the row is one line tall, so the hover icons
	// need the head line's text out of their way (see styles.css).
	const hasPreviewLine = title !== null && preview !== "";
	const rowClass = ["conv", conv.id === current ? "current" : null, hasPreviewLine ? null : "bare"]
		.filter((c): c is string => c !== null)
		.join(" ");
	return (
		<div className={rowClass}>
			<a
				className="conv-main"
				href={`/app/c/${conv.id.slice("app/".length)}`}
				onClick={(e) => {
					if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
					e.preventDefault();
					onOpen(conv.id);
				}}
			>
				<span className="conv-head">
					{pinned && <PinGlyph />}
					<span className="conv-title">
						{title ?? (preview === "" ? "new conversation" : preview)}
					</span>
					<span className="conv-time">{relTime(conv.updatedAt)}</span>
				</span>
				{hasPreviewLine && <span className="conv-preview">{preview}</span>}
			</a>
			<span className="conv-actions">
				{archived ? (
					<>
						<button type="button" onClick={startRename} title="Rename" aria-label="Rename">
							<PencilGlyph />
						</button>
						<button type="button" onClick={toggleArchived} title="Unarchive" aria-label="Unarchive">
							<UnarchiveGlyph />
						</button>
						<button type="button" onClick={remove} title="Delete" aria-label="Delete">
							<TrashGlyph />
						</button>
					</>
				) : (
					<>
						<button
							type="button"
							onClick={togglePinned}
							title={pinned ? "Unpin" : "Pin"}
							aria-label={pinned ? "Unpin" : "Pin"}
						>
							{pinned ? <UnpinGlyph /> : <PinActionGlyph />}
						</button>
						<button type="button" onClick={startRename} title="Rename" aria-label="Rename">
							<PencilGlyph />
						</button>
						<button type="button" onClick={toggleArchived} title="Archive" aria-label="Archive">
							<ArchiveGlyph />
						</button>
					</>
				)}
			</span>
		</div>
	);
}

// The Telegram mini app door (design/telegram.md → Mini Apps, ruling
// 2026-10-10): the deep-linked page renders settings or memories over
// initData — the app channel's gate, rail, and conversations never
// mount here. In-door switching is component state with no history
// entries, so the webview's back gesture closes the mini app natively.
const TELEGRAM_PAGES = PAGES.filter((p) => p.key === "settings" || p.key === "memory");

function TelegramDoor() {
	const [page, setPage] = useState<Page>(() => {
		const p = pageFromPath(window.location.pathname);
		return p !== null && TELEGRAM_PAGES.some((t) => t.key === p) ? p : "settings";
	});
	const [navOpen, setNavOpen] = useState(false);
	const settingsDirty = useRef(false);
	// initData empty means the page was not opened by Telegram — every
	// request would 401. Say so instead of rendering a form that cannot
	// save; window.Telegram is settled before first render — injected by
	// the webview, or the local fallback installed in main.tsx.
	const [authed] = useState(() => (window.Telegram?.WebApp.initData ?? "") !== "");
	// One callback owns the draft bit and the webview's native close
	// guard — the in-door confirm and the SDK confirmation protect the
	// same draft. The SDK call mirrors the transition only: the editor
	// reports its state on every mount too, and re-arming an armed
	// guard is pointless. Both methods are optional in older clients.
	const setSettingsDirty = useCallback((dirty: boolean) => {
		if (settingsDirty.current === dirty) return;
		settingsDirty.current = dirty;
		const webApp = window.Telegram?.WebApp;
		if (dirty) webApp?.enableClosingConfirmation?.();
		else webApp?.disableClosingConfirmation?.();
	}, []);
	useEffect(() => {
		window.Telegram?.WebApp.ready?.();
		window.Telegram?.WebApp.expand?.();
		// Mount clean, unmount clean: the guard must never outlive the
		// draft it was armed for.
		window.Telegram?.WebApp.disableClosingConfirmation?.();
		return () => window.Telegram?.WebApp.disableClosingConfirmation?.();
	}, []);
	const openPage = (p: Exclude<Page, "chat">) => {
		if (p === page) return;
		if (
			page === "settings" &&
			settingsDirty.current &&
			!window.confirm("Discard unsaved settings changes?")
		)
			return;
		// Approved navigation throws the draft away — disarm the guard.
		setSettingsDirty(false);
		setPage(p);
	};
	return (
		<div className="shell">
			<nav className={navOpen ? "rail open" : "rail"}>
				<div className="rail-ops">
					{TELEGRAM_PAGES.map((p) => (
						<button
							key={p.key}
							type="button"
							className={page === p.key ? "rail-op on" : "rail-op"}
							onClick={() => {
								openPage(p.key);
								setNavOpen(false);
							}}
						>
							{p.label}
						</button>
					))}
				</div>
			</nav>
			<div className={navOpen ? "scrim open" : "scrim"} onClick={() => setNavOpen(false)} />
			<main>
				<header>
					<button
						type="button"
						className="nav-toggle"
						aria-label="Pages"
						onClick={() => setNavOpen((v) => !v)}
					>
						<svg
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.75"
							strokeLinecap="round"
							width="18"
							height="18"
						>
							<rect x="3" y="4" width="18" height="16" rx="3" />
							<line x1="9.5" y1="4" x2="9.5" y2="20" />
						</svg>
					</button>
					<h1>goblin</h1>
					<span className="header-title">{PAGES.find((p) => p.key === page)?.label}</span>
				</header>
				{!authed && (
					<p className="error" role="alert">
						Open this page from Telegram — the settings door authenticates with Telegram's signed
						payload, and a plain browser has none.
					</p>
				)}
				{authed && page === "settings" && (
					<SettingsView token={null} onDirtyChange={setSettingsDirty} />
				)}
				{authed && page === "memory" && <MemoryView token={null} />}
			</main>
		</div>
	);
}

// One bundle, two doors: /t/ is the Telegram mini app, everything else
// the PWA's app channel.
export function App() {
	return telegramDoor() ? <TelegramDoor /> : <AppShell />;
}

function AppShell() {
	const [token, setToken] = useState<string | null>(loadToken);
	// The gate is conditional: the server may be in trust mode (appToken
	// unset — the tailnet is the only lock), where a bare request just
	// works and the token screen must never show. A stored token answers
	// the question itself through refresh(); with none stored, probe
	// unauthenticated first — 200 means trust mode, 401 shows the gate.
	const [gate, setGate] = useState<"probing" | "shown" | "passed">(
		token === null ? "probing" : "passed",
	);
	const [probeHint, setProbeHint] = useState<string | null>(null);
	const [conversations, setConversations] = useState<AppConversationList["conversations"] | null>(
		null,
	);
	// The rail's second pool (design/projects.md) — every project,
	// archived included; the rail shows only the active ones.
	const [projects, setProjects] = useState<AppProject[] | null>(null);
	const [current, setCurrent] = useState<string | null>(null);
	// The chat header's thread-sources sheet belongs to the chat page.
	const [sourcesOpen, setSourcesOpen] = useState(false);
	const [listError, setListError] = useState<string | null>(null);
	// Row-action failures — cleared by the next successful action or
	// refresh, like listError but per-action and named.
	const [rowError, setRowError] = useState<string | null>(null);
	const [navOpen, setNavOpen] = useState(false);
	// Rail search: debounced against the app-pool FTS endpoint. A non-
	// empty query swaps the conversation list for the hit list. A failed
	// search says so — it must not read as "no matches".
	const [query, setQuery] = useState("");
	const [hits, setHits] = useState<AppSearchHit[] | null>(null);
	const [searchError, setSearchError] = useState<string | null>(null);
	const searchSeq = useRef(0);
	// The empty state has the composer too — its send creates the
	// conversation, then ChatView delivers the parked message as `seed`.
	const [seed, setSeed] = useState<{ id: string; parts: UIMessage["parts"] } | null>(null);
	// Staged uploads are owned here, above any composer: the first send
	// swaps the empty state's composer for the new conversation's, and
	// uploads still in flight (or failed chips) must carry across that
	// unmount — their resolution writes this state, whichever composer
	// is mounted (#118).
	const [staged, setStaged] = useState<StagedUpload[]>([]);
	// Note chips ride beside the upload chips for the same reason —
	// they must survive the empty-state → conversation composer swap.
	const [stagedNotes, setStagedNotes] = useState<StagedNote[]>([]);
	// Bump on "New conversation" — the composer focuses itself, mounted
	// or not (a remount sees the non-zero signal on first effect).
	const [composerFocus, setComposerFocus] = useState(0);
	const [starting, setStarting] = useState(false);
	const [startFailed, setStartFailed] = useState(false);
	// A cancelled send belongs only to the composer that dispatched it.
	const [draftRestores, setDraftRestores] = useState<Record<string, { parts: UIMessage["parts"] }>>(
		{},
	);
	const consumeRestore = (scope: string) =>
		setDraftRestores((prev) => {
			const next = { ...prev };
			delete next[scope];
			return next;
		});
	// Navigation (or a newer start) fences off a stale failure — the
	// alert belongs to the page that saw the failed send, nowhere else.
	const startSeq = useRef(0);
	// Guard before the sequence bump: a duplicate start must not fence
	// the first continuation or mint an empty conversation.
	const startBusyRef = useRef(false);
	const clearStartFailure = () => {
		startSeq.current += 1;
		setStartFailed(false);
	};
	// The rail's second pool: archived rows sit in a collapsed section
	// under the active list (design/app.md → Archiving).
	const [archivedOpen, setArchivedOpen] = useState(false);
	const listSeq = useRef(0);
	// The deep link applies once — after the first list load — so an
	// operator's own navigation is never overridden later.
	const deepApplied = useRef(false);
	const [page, setPage] = useState<Page>(
		() =>
			pageFromPath(window.location.pathname) ??
			(projectFromPath(window.location.pathname) !== null
				? "project"
				: noteFromPath(window.location.pathname) !== null
					? "note"
					: "chat"),
	);
	useEffect(() => setSourcesOpen(false), [current, page]);
	// /app/p/<id> — set whenever the path names a project page.
	const [projectId, setProjectId] = useState<string | null>(() =>
		projectFromPath(window.location.pathname),
	);
	// /app/n/<id> — same deal for a note page.
	const [noteId, setNoteId] = useState<string | null>(() => noteFromPath(window.location.pathname));
	const [createProjectOpen, setCreateProjectOpen] = useState(false);
	// The settings editor reports its dirty bit here so navigating away
	// can ask before discarding unsaved edits.
	const settingsDirty = useRef(false);
	// Stale async completions — a held create's onCreated/onOpen firing
	// after the operator already navigated — run the navigation guards
	// from the render that issued them. The guard must ask which page
	// is mounted now (a declined traversal deliberately leaves the old
	// editor mounted), not which page rendered the callback.
	const pageRef = useRef(page);
	pageRef.current = page;
	// The note editor reports here too — unsaved body/title edits or a
	// standing 409 conflict bar. Its draft lives only in that
	// component; an unguarded navigation destroys it silently.
	const noteDirty = useRef(false);
	// Confirmed discards must reach the editor before its unmount drain.
	const noteDiscard = useRef<(() => void) | null>(null);
	const [navigationError, setNavigationError] = useState<string | null>(null);
	const navigation = browserNavigation();
	const position = historyPosition(window.history.state);
	const route = useRef({
		index: position?.index ?? 0,
		segment: position?.segment ?? newHistorySegment(),
		key: navigation?.currentEntry.key ?? null,
	});
	// Leaving a dirty page asks once, with the page's own wording.
	const leaveDirty = () => {
		if (pageRef.current === "settings" && settingsDirty.current)
			return window.confirm("Discard unsaved settings changes?");
		if (pageRef.current === "note" && noteDirty.current) {
			if (!window.confirm("Discard unsaved note edits and any conflict?")) return false;
			noteDiscard.current?.();
			return true;
		}
		return true;
	};
	const pushRoute = (path: string) => {
		const actual = historyPosition(window.history.state);
		// A declined legacy traversal can leave the browser at a different
		// entry while the editor stays open. Never extend its saved indices.
		const base =
			actual?.segment === route.current.segment && actual.index === route.current.index
				? actual
				: { index: 0, segment: newHistorySegment() };
		window.history.pushState(
			{ goblinIndex: base.index + 1, goblinSegment: base.segment },
			"",
			path,
		);
		route.current = {
			index: base.index + 1,
			segment: base.segment,
			key: navigation?.currentEntry.key ?? null,
		};
		setNavigationError(null);
	};

	useEffect(() => {
		if (navigation !== null) return;
		const state: unknown = window.history.state;
		window.history.replaceState(
			{
				...(typeof state === "object" && state !== null ? state : {}),
				goblinIndex: route.current.index,
				goblinSegment: route.current.segment,
			},
			"",
		);
	}, []);

	useEffect(() => {
		if (gate !== "probing") return;
		let live = true;
		listConversations(null).then(
			() => live && setGate("passed"),
			(err) => {
				if (!live) return;
				if (!(err instanceof ApiError) || err.status !== 401) {
					setProbeHint(
						err instanceof ApiError
							? `The app channel answered ${err.status} — check goblin's log.`
							: "Couldn't reach goblin — check the tailnet.",
					);
				}
				setGate("shown");
			},
		);
		return () => {
			live = false;
		};
	}, [gate]);

	const refresh = useCallback(async () => {
		const seq = ++listSeq.current;
		try {
			const [list, plist] = await Promise.all([listConversations(token), listProjects(token)]);
			if (seq !== listSeq.current) return;
			setConversations(list.conversations);
			setProjects(plist.projects);
			setListError(null);
			setRowError(null);
		} catch (err) {
			// Same fence as the success path — a stale failure arriving
			// after a newer refresh settled must not paint over its state.
			if (seq !== listSeq.current) return;
			setListError(err instanceof ApiError && err.status === 401 ? "unauthorized" : "list failed");
		}
	}, [token]);

	useEffect(() => {
		if (gate === "passed") void refresh();
	}, [gate, refresh]);

	// A /app/c/<id> load selects that conversation once the list
	// arrives — an unknown id just shows the list.
	useEffect(() => {
		if (conversations === null || deepApplied.current) return;
		deepApplied.current = true;
		const id = deepLinkConv(window.location.pathname);
		if (id === null) return;
		if (conversations.some((c) => c.id === id)) {
			setCurrent(id);
		} else {
			// A dead link must not masquerade — normalize to the root.
			window.history.replaceState(window.history.state, "", "/app/");
		}
	}, [conversations]);

	// Back/forward between operator pages and conversations.
	useEffect(() => {
		const onPop = () => {
			const p = pageFromPath(window.location.pathname);
			const nextPosition = historyPosition(window.history.state);
			// Only a pop that actually leaves the dirty page asks — the
			// guard's own restoration below lands right back on it, and a
			// second ask there would double every decline.
			const stillHome =
				(page === "settings" && p === "settings") ||
				(page === "note" && noteFromPath(window.location.pathname) === noteId);
			if (!stillHome && !leaveDirty()) {
				// popstate arrives after traversal. Undo it rather than push a
				// replacement entry, which would erase the forward history.
				if (navigation !== null && route.current.key !== null) {
					const failed = (err: unknown) =>
						setNavigationError(
							`Couldn't restore history: ${err instanceof Error ? err.message : String(err)}`,
						);
					try {
						const { committed, finished } = navigation.traverseTo(route.current.key);
						void Promise.all([committed, finished]).catch(failed);
					} catch (err) {
						failed(err);
					}
				} else if (
					nextPosition !== null &&
					nextPosition.segment === route.current.segment &&
					nextPosition.index !== route.current.index
				) {
					window.history.go(route.current.index - nextPosition.index);
				} else {
					setNavigationError(
						"Your unsaved edits are still here. This browser cannot restore an older history entry; save or discard your changes before navigating again.",
					);
				}
				return;
			}
			route.current = {
				// A legacy gap breaks index continuity. New entries get a new
				// segment so we never compute a distance across that gap.
				index: nextPosition?.index ?? 0,
				segment: nextPosition?.segment ?? newHistorySegment(),
				key: navigation?.currentEntry.key ?? null,
			};
			setNavigationError(null);
			clearStartFailure();
			if (p !== null) {
				setPage(p);
				setProjectId(null);
				setNoteId(null);
				return;
			}
			const pid = projectFromPath(window.location.pathname);
			if (pid !== null) {
				setPage("project");
				setProjectId(pid);
				setNoteId(null);
				return;
			}
			const nid = noteFromPath(window.location.pathname);
			if (nid !== null) {
				setPage("note");
				setProjectId(null);
				setNoteId(nid);
				return;
			}
			const id = deepLinkConv(window.location.pathname);
			setPage("chat");
			setProjectId(null);
			setNoteId(null);
			setCurrent(id);
		};
		window.addEventListener("popstate", onPop);
		return () => window.removeEventListener("popstate", onPop);
	}, [page, noteId]);

	useEffect(() => {
		const onUnload = (event: BeforeUnloadEvent) => {
			const dirty =
				page === "settings" ? settingsDirty.current : page === "note" && noteDirty.current;
			if (!dirty) return;
			event.preventDefault();
			event.returnValue = "Unsaved edits";
		};
		window.addEventListener("beforeunload", onUnload);
		return () => window.removeEventListener("beforeunload", onUnload);
	}, [page]);

	// Debounced app-pool search — an empty box clears back to the list.
	// The sequence bumps on every invocation, including the clear, so a
	// reply dispatched before the box emptied can never reappear after.
	// A stale error clears on empty (and on the next settled reply),
	// never on a fresh query — clearing there would flash "No matches.".
	useEffect(() => {
		const seq = ++searchSeq.current;
		const q = query.trim();
		if (q === "") {
			setHits(null);
			setSearchError(null);
			return;
		}
		const t = setTimeout(() => {
			void searchConversations(token, q).then(
				(r) => {
					if (seq !== searchSeq.current) return;
					setHits(r.hits);
					setSearchError(null);
				},
				(err) => {
					if (seq !== searchSeq.current) return;
					setHits([]);
					setSearchError(err instanceof Error ? err.message : "search failed");
				},
			);
		}, 250);
		return () => clearTimeout(t);
	}, [query, token]);

	// A dead token means 401s forever — offer a way back to the gate.
	if (listError === "unauthorized") {
		return (
			<div className="gate">
				<h1>goblin</h1>
				<p className="error">The stored token stopped working.</p>
				<button
					type="button"
					onClick={() => {
						clearToken();
						setToken(null);
						setListError(null);
						setProbeHint(null);
						setGate("shown");
					}}
				>
					Paste a new token
				</button>
			</div>
		);
	}

	if (gate === "probing") {
		return (
			<div className="gate">
				<h1>goblin</h1>
				<p className="gate-hint">Connecting…</p>
			</div>
		);
	}

	if (gate === "shown") {
		return (
			<TokenGate
				hint={probeHint}
				onToken={(t) => {
					setToken(t);
					setGate("passed");
				}}
			/>
		);
	}

	// Selection owns the URL — /app/c/<id> for a conversation, /app/
	// for the list/empty state, matching the deep link the pings carry.
	const select = (id: string | null, opts?: { skipDirtyGuard?: boolean }) => {
		if (opts?.skipDirtyGuard !== true && !leaveDirty()) return;
		clearStartFailure();
		setPage("chat");
		setProjectId(null);
		setNoteId(null);
		setCurrent(id);
		const path = id === null ? "/app/" : `/app/c/${id.slice("app/".length)}`;
		if (path !== window.location.pathname) pushRoute(path);
	};

	const openProject = (id: string) => {
		if (!leaveDirty()) return;
		clearStartFailure();
		setPage("project");
		setProjectId(id);
		setNoteId(null);
		setNavOpen(false);
		pushRoute(`/app/p/${id}`);
	};

	const openProjectsIndex = () => {
		if (!leaveDirty()) return;
		clearStartFailure();
		setPage("projects");
		setProjectId(null);
		setNoteId(null);
		setNavOpen(false);
		pushRoute("/app/projects");
	};

	const openNotesIndex = () => {
		if (!leaveDirty()) return;
		clearStartFailure();
		setPage("notes");
		setProjectId(null);
		setNoteId(null);
		setNavOpen(false);
		pushRoute("/app/notes");
	};

	const openNote = (id: string) => {
		if (page === "note" && noteId === id) {
			setNavOpen(false);
			return;
		}
		if (!leaveDirty()) return;
		clearStartFailure();
		setPage("note");
		setProjectId(null);
		setNoteId(id);
		setNavOpen(false);
		pushRoute(`/app/n/${id}`);
	};

	const rowRemoved = (id: string) => {
		if (id !== current) return;
		if (page === "chat") select(null);
		else setCurrent(null);
	};

	const openPage = (p: Exclude<Page, "chat" | "notes" | "note">) => {
		if (page === p) {
			setNavOpen(false);
			return;
		}
		if (!leaveDirty()) return;
		clearStartFailure();
		setPage(p);
		setNavOpen(false);
		pushRoute(`/app/${p}`);
	};

	// "New conversation" opens the empty state; the conversation itself is
	// created lazily, on the first send — an untouched composer never
	// leaves an empty row in the store.
	const newConversation = () => {
		setNavOpen(false);
		setComposerFocus((t) => t + 1);
		select(null);
	};

	const openConversation = (id: string) => {
		select(id);
		setNavOpen(false);
	};

	// One start path for every composer — the empty state passes null,
	// a project page its id, and both ride the same create → seed →
	// select flow (design/projects.md: binding is fixed at creation).
	const startChat = async (
		projectId: string | null,
		parts: UIMessage["parts"],
		composerScope?: string,
	): Promise<boolean> => {
		if (!leaveDirty()) return false;
		if (startBusyRef.current) {
			// Refuse loudly — a silent no-op reads as success to awaited
			// callers (the note page's chat surfaces this rejection as an
			// opError; fire-and-forget composer sends catch it at the
			// call site). A composer-scoped send parks its parts back in
			// the draft first, the same shape as the fenced path —
			// note-originated starts carry no scope and restore nothing.
			if (composerScope !== undefined) {
				setDraftRestores((prev) => ({ ...prev, [composerScope]: { parts } }));
			}
			throw new Error("a conversation is still starting — resend once it finishes");
		}
		startBusyRef.current = true;
		const seq = ++startSeq.current;
		setStarting(true);
		setStartFailed(false);
		try {
			const created = await createConversation(
				token,
				projectId === null ? undefined : { projectId },
			);
			// A navigation while the create was in flight bumped the
			// sequence — this continuation closes over the old page, so
			// its select would skip the dirty-settings guard entirely.
			if (seq !== startSeq.current) {
				if (composerScope !== undefined) {
					setDraftRestores((prev) => ({ ...prev, [composerScope]: { parts } }));
				}
				try {
					await deleteConversation(token, created.id);
					await refresh();
				} catch (err) {
					setRowError(
						`Couldn't remove the cancelled conversation: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
				return false;
			}
			setSeed({ id: created.id, parts });
			// The guard above already asked — select's own check would
			// confirm the still-dirty page a second time.
			select(created.id, { skipDirtyGuard: true });
			await refresh();
			return true;
		} catch {
			if (seq === startSeq.current) setStartFailed(true);
			return false;
		} finally {
			startBusyRef.current = false;
			setStarting(false);
		}
	};

	const startConversation = (parts: UIMessage["parts"]) => startChat(null, parts, "chat");

	// Composer sends are fire-and-forget — the only rejection startChat
	// produces is the deliberate busy refusal, so it surfaces on the
	// rail rather than dying as an unhandled rejection.
	const reportStartRefusal = (err: unknown) =>
		setRowError(err instanceof Error ? err.message : String(err));

	const currentTitle = conversations?.find((c) => c.id === current)?.title ?? null;

	// One payload, three pools: pinned rows float above the rail's
	// activity order (the server sorts within each group, the client
	// only partitions), archived ones wait behind the section toggle
	// (design/app.md → Archiving, Pinning). Project-bound chats leave
	// the main rail entirely — they live on their project's page
	// (design/projects.md); `?? null` keeps pre-projects fixtures
	// (field absent) on the rail.
	const all = conversations ?? [];
	const unbound = all.filter((c) => (c.projectId ?? null) === null);
	const active = unbound.filter((c) => c.archivedAt === null);
	const rail = [
		...active.filter((c) => c.pinnedAt !== null),
		...active.filter((c) => c.pinnedAt === null),
	];
	const archived = unbound
		.filter((c) => c.archivedAt !== null)
		.sort((a, b) => Date.parse(b.archivedAt!) - Date.parse(a.archivedAt!));

	const projectList = projects ?? [];
	const activeProjects = projectList
		.filter((p) => p.archivedAt === null)
		.sort((a, b) => a.name.localeCompare(b.name));
	const currentProject =
		projectId === null ? undefined : projectList.find((p) => p.id === projectId);
	// The breadcrumb above a selected project chat — the name rides the
	// same pool the rail lists.
	const currentConv = all.find((c) => c.id === current);
	const currentConvProject =
		currentConv?.projectId != null
			? projectList.find((p) => p.id === currentConv.projectId)
			: undefined;

	const renderRow = (c: AppConversationList["conversations"][number]) => (
		<li key={c.id}>
			<ConversationRow
				conv={c}
				current={current}
				token={token}
				onOpen={openConversation}
				onRenamed={() => {
					setRowError(null);
					void refresh();
				}}
				onToggleArchived={(id, isArchived) => {
					setRowError(null);
					if (isArchived) rowRemoved(id);
					void refresh();
				}}
				onTogglePinned={() => {
					setRowError(null);
					void refresh();
				}}
				onDeleted={(id) => {
					setRowError(null);
					rowRemoved(id);
					void refresh();
				}}
				onError={setRowError}
			/>
		</li>
	);

	return (
		<div className="shell">
			<nav className={navOpen ? "rail open" : "rail"}>
				<button type="button" className="new" onClick={newConversation}>
					New conversation
				</button>
				<input
					className="rail-search"
					type="search"
					placeholder="Search history"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Escape") setQuery("");
					}}
				/>
				{hits !== null ? (
					<>
						<ul className="search-results">
							{hits.map((h) => (
								<li key={`${h.conversationId}:${h.seq}`}>
									<button
										type="button"
										className="hit"
										onClick={() => {
											openConversation(h.conversationId);
											setQuery("");
										}}
									>
										<span className="hit-role">{h.role === "user" ? "you" : "goblin"}</span>
										<span className="hit-text">{flatLine(h.text)}</span>
										<span className="hit-conv">
											{flatTitle(h.title) ?? h.conversationId.slice(4)}
											{" · "}
											{relTime(h.createdAt)}
										</span>
									</button>
								</li>
							))}
						</ul>
						{searchError !== null && (
							<p className="error" role="alert">
								Search failed: {searchError}
							</p>
						)}
						{searchError === null && hits.length === 0 && <p className="empty">No matches.</p>}
					</>
				) : (
					<>
						{/* The conversation list sits directly below New +
							search — its own labeled group, so the action and
							its rows read as one. Projects and Notes wait
							below it, never wedged between. */}
						<div className="rail-convs">
							<div className="rail-label">Conversations</div>
							<ul>{rail.map(renderRow)}</ul>
							{archived.length > 0 && (
								<>
									<button
										type="button"
										className="rail-archived"
										aria-expanded={archivedOpen}
										onClick={() => setArchivedOpen((v) => !v)}
									>
										Archived ({archived.length})
									</button>
									{archivedOpen && <ul>{archived.map(renderRow)}</ul>}
								</>
							)}
						</div>
						{/* The Projects section sits below the chat list — header
							links to the /app/projects index. */}
						{projects !== null && (
							<div className="rail-projects">
								<button type="button" className="rail-section" onClick={openProjectsIndex}>
									Projects
								</button>
								<ul>
									{activeProjects.map((p) => (
										<li key={p.id}>
											<button
												type="button"
												className={page === "project" && projectId === p.id ? "proj on" : "proj"}
												onClick={() => openProject(p.id)}
											>
												{p.name}
											</button>
										</li>
									))}
								</ul>
								<button type="button" className="new" onClick={() => setCreateProjectOpen(true)}>
									New project
								</button>
								<button
									type="button"
									className={
										page === "notes" || page === "note" ? "rail-section on" : "rail-section"
									}
									onClick={openNotesIndex}
								>
									Notes
								</button>
							</div>
						)}
					</>
				)}
				{hits === null &&
					conversations !== null &&
					unbound.length === 0 &&
					activeProjects.length === 0 && (
						<p className="empty">Nothing here yet — start a conversation.</p>
					)}
				{listError !== null && <p className="error">Couldn't refresh the list.</p>}
				{rowError !== null && (
					<p className="error" role="alert">
						{rowError}
					</p>
				)}
				<div className="rail-ops">
					{PAGES.map((p) => (
						<button
							key={p.key}
							type="button"
							className={page === p.key ? "rail-op on" : "rail-op"}
							onClick={() => openPage(p.key)}
						>
							{p.label}
						</button>
					))}
				</div>
			</nav>
			<div className={navOpen ? "scrim open" : "scrim"} onClick={() => setNavOpen(false)} />
			<main>
				<header>
					<button
						type="button"
						className="nav-toggle"
						aria-label="Conversations"
						title="Conversations"
						onClick={() => setNavOpen((v) => !v)}
					>
						<svg
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.75"
							strokeLinecap="round"
							width="18"
							height="18"
						>
							<rect x="3" y="4" width="18" height="16" rx="3" />
							<line x1="9.5" y1="4" x2="9.5" y2="20" />
						</svg>
					</button>
					<h1>goblin</h1>
					{page === "chat" && current !== null && (
						<span className="header-title">{flatTitle(currentTitle)}</span>
					)}
					{page === "projects" && <span className="header-title">Projects</span>}
					{page === "chat" && current !== null && (
						<button
							type="button"
							className="header-action"
							title="From this thread"
							aria-label="From this thread — memories and skills generated here"
							onClick={() => setSourcesOpen(true)}
						>
							<svg
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.75"
								strokeLinecap="round"
								strokeLinejoin="round"
								width="18"
								height="18"
							>
								<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" />
								<path d="M12 12l8-4.5" />
								<path d="M12 12v9" />
								<path d="M12 12L4 7.5" />
							</svg>
						</button>
					)}
					{page === "project" && <span className="header-title">{currentProject?.name}</span>}
					{page === "notes" && <span className="header-title">Notes</span>}
					{page === "note" && <span className="header-title">Note</span>}
					{PAGES.some((p) => p.key === page) && (
						<span className="header-title">{PAGES.find((p) => p.key === page)?.label}</span>
					)}
				</header>
				{navigationError !== null && (
					<p className="error" role="alert">
						{navigationError}
					</p>
				)}
				{page === "settings" && (
					<SettingsView
						token={token}
						onDirtyChange={(d) => {
							settingsDirty.current = d;
						}}
					/>
				)}
				{page === "memory" && <MemoryView token={token} />}
				{page === "delegations" && <DelegationsView token={token} />}
				{page === "programs" && <ProgramsView token={token} />}
				{page === "status" && <StatusView token={token} />}
				{page === "skills" && <SkillsView token={token} />}
				{page === "files" && <FilesView token={token} />}
				{page === "log" && <LogView token={token} />}
				{page === "projects" && (
					<ProjectsIndex
						token={token}
						projects={projectList}
						onOpen={openProject}
						onNew={() => setCreateProjectOpen(true)}
					/>
				)}
				{page === "notes" && <NotesIndex token={token} projects={projectList} onOpen={openNote} />}
				{page === "note" && (
					<div className="chat">
						{noteId === null ? (
							<p className="empty">No such note.</p>
						) : (
							<>
								<NoteView
									key={noteId}
									token={token}
									noteId={noteId}
									projects={projectList}
									discardRef={noteDiscard}
									onChat={(note: AppNote) =>
										startChat(note.projectId, [
											{
												type: "data-note",
												data: { id: note.id, title: note.title },
											} as UIMessage["parts"][number],
										])
									}
									// A deleted note has no draft left to guard — clear
									// the bit before the index navigation runs the check.
									onDeleted={() => {
										noteDirty.current = false;
										openNotesIndex();
									}}
									onDirtyChange={(d) => {
										noteDirty.current = d;
									}}
								/>
								{startFailed && (
									<p className="error" role="alert">
										Couldn't start a conversation — check the tailnet, then resend.
									</p>
								)}
							</>
						)}
					</div>
				)}
				{page === "project" && (
					<div className="chat">
						{currentProject === undefined ? (
							<p className="empty">{projects === null ? "Loading…" : "No such project."}</p>
						) : (
							<>
								<ProjectView
									key={currentProject.id}
									token={token}
									project={currentProject}
									conversations={all}
									renderRow={renderRow}
									onChanged={() => void refresh()}
									onOpenNote={openNote}
								/>
								{startFailed && (
									<p className="error">
										Couldn't start a conversation — check the tailnet, then resend.
									</p>
								)}
								{currentProject.archivedAt === null ? (
									<Composer
										key={`composer:${currentProject.id}`}
										token={token}
										busy={starting}
										staged={staged}
										setStaged={setStaged}
										stagedNotes={stagedNotes}
										setStagedNotes={setStagedNotes}
										draftRestore={draftRestores[currentProject.id] ?? null}
										onDraftRestored={() => consumeRestore(currentProject.id)}
										onSend={(parts) =>
											startChat(currentProject.id, parts, currentProject.id).catch(
												(err: unknown) => {
													reportStartRefusal(err);
													return false;
												},
											)
										}
									/>
								) : (
									<p className="empty">
										This project is archived — unarchive it to start new chats here.
									</p>
								)}
							</>
						)}
					</div>
				)}
				{page === "chat" &&
					(current === null ? (
						<div className="chat">
							<div className="transcript">
								<div className="transcript-inner">
									<p className="empty">
										Pick a conversation, or say something — a new one starts here.
									</p>
									{startFailed && (
										<p className="error">
											Couldn't start a conversation — check the tailnet, then resend.
										</p>
									)}
								</div>
							</div>
							<Composer
								token={token}
								busy={starting}
								staged={staged}
								setStaged={setStaged}
								stagedNotes={stagedNotes}
								setStagedNotes={setStagedNotes}
								focusSignal={composerFocus}
								draftRestore={draftRestores.chat ?? null}
								onDraftRestored={() => consumeRestore("chat")}
								onSend={(parts) =>
									startConversation(parts).catch((err: unknown) => {
										reportStartRefusal(err);
										return false;
									})
								}
							/>
						</div>
					) : (
						<>
							{/* A bound chat names its project — the link lands on the
								project page (design/projects.md). */}
							{currentConvProject !== undefined && (
								<button
									type="button"
									className="crumb"
									onClick={() => openProject(currentConvProject.id)}
								>
									{currentConvProject.name}
								</button>
							)}
							<ChatView
								key={current}
								token={token}
								conversationId={current}
								title={flatTitle(currentTitle)}
								seed={seed !== null && seed.id === current ? seed.parts : null}
								staged={staged}
								setStaged={setStaged}
								stagedNotes={stagedNotes}
								setStagedNotes={setStagedNotes}
								noteProjectId={currentConv?.projectId ?? null}
								onSeeded={() => setSeed(null)}
								onTurnDone={() => void refresh()}
								onOpenNote={openNote}
							/>
						</>
					))}
			</main>
			{page === "chat" && sourcesOpen && current !== null && (
				<ThreadSourcesSheet
					token={token}
					conversationId={current}
					title={currentTitle}
					onClose={() => setSourcesOpen(false)}
				/>
			)}
			{createProjectOpen && (
				<NewProjectDialog
					token={token}
					onClose={() => setCreateProjectOpen(false)}
					onCreated={(p) => {
						setCreateProjectOpen(false);
						void refresh();
						openProject(p.id);
					}}
				/>
			)}
		</div>
	);
}
