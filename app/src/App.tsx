import type { UIMessage } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Drawer, DrawerBackdrop, DrawerContent, DrawerTitle } from "@ui-sdk/react/drawer";
import {
	Menu,
	MenuContent,
	MenuItem,
	MenuCheckboxItem,
	MenuSub,
	MenuSubContent,
	MenuSubTrigger,
	MenuTrigger,
} from "@ui-sdk/react/menu";
import type { AppPageKey } from "../../src/http/app-routes.ts";
import type {
	AppConversationList,
	AppChatResponse,
	AppModelSettings,
	AppNote,
	AppNoteSummary,
	AppProject,
	AppAttentionTarget,
} from "../../src/http/app-wire.ts";
import { ArchiveView } from "./ArchiveView.tsx";
import { ActivityView } from "./ActivityView.tsx";
import { AttentionView } from "./AttentionView.tsx";
import {
	ApiError,
	clearToken,
	createConversation,
	deleteConversation,
	listConversations,
	loadToken,
	patchConversation,
	rollRollingChat,
	telegramDoor,
} from "./api.ts";
import { moveComposerDraft } from "./composerDraft.ts";
import { LiveStore } from "./live.ts";
import { LiveProvider, useLive, useLiveStatus, useLiveStore } from "./useLive.tsx";
import { ChatView } from "./ChatView.tsx";
import { GoblinAvatar } from "./GoblinAvatar.tsx";
import { GoblinPanel, GoblinProfileHeader, loadPanelOpen, savePanelOpen } from "./GoblinPanel.tsx";
import { useGoblinActivity } from "./useGoblinActivity.ts";
import { Composer } from "./chat/Composer.tsx";
import { ConversationTitleEditor } from "./ConversationTitleEditor.tsx";
import { conversationActions } from "./conversationActions.ts";
import { type ChatWidth, loadChatWidth, saveChatWidth } from "./chatWidth.ts";
import { loadProjectsOpen, loadSideChatsOpen, saveProjectsOpen, saveSideChatsOpen } from "./railFolders.ts";
import { ConversationRow, relTime } from "./ConversationList.tsx";
import { HomeList, type RenderRow, useHomeList } from "./HomeList.tsx";
import { useMarkRead } from "./useMarkRead.ts";
import { useFlip } from "./useFlip.ts";
import { GoblinFace } from "./GoblinFace.tsx";
import { flatLine, flatTitle } from "./flatText.ts";
import { DelegationsView } from "./DelegationsView.tsx";
import {
	ChevronDownGlyph,
} from "./glyphs.tsx";
import { LogView } from "./LogView.tsx";
import { MemoryView } from "./MemoryView.tsx";
import { NoteView } from "./NoteView.tsx";
import { NotesIndex } from "./NotesIndex.tsx";
import { ProgramsView } from "./ProgramsView.tsx";
import { NewProjectDialog, ProjectsIndex, ProjectView } from "./ProjectView.tsx";
import {
	type Page,
	PAGES,
	browserNavigation,
	historyPosition,
	newHistorySegment,
	openingRoute,
	pathOfRoute,
	routeFromPath,
	sameRoute,
	type Route,
} from "./routing.ts";
import { SettingsView } from "./SettingsView.tsx";
import { SkillsView } from "./SkillsView.tsx";
import { FilesView } from "./StateViews.tsx";
import { StatusView } from "./StatusView.tsx";
import { TelegramDoor } from "./TelegramDoor.tsx";
import { ThreadSourcesSheet } from "./ThreadSourcesSheet.tsx";
import { TokenGate } from "./TokenGate.tsx";
import { useUndoToast } from "./undoToast.tsx";
import { useConfirm } from "./confirm.tsx";
import { type LeaveAnswer, useLeaveAsk } from "./leaveAsk.ts";
import { usePhoneWidth } from "./usePhoneWidth.ts";
import { useConversationSearch } from "./useConversationSearch.ts";
import { WindowView } from "./WindowView.tsx";
// One bundle, two doors: /t/ the Telegram mini app, everything else the
// PWA's app channel.
export function App() {
	return telegramDoor() ? <TelegramDoor /> : <AppShell />;
}

const CRAMPED_COLUMN_PX = 400;

function observeColumnWidth(column: HTMLElement | null, setCramped: (value: boolean) => void) {
	if (column === null || typeof window.ResizeObserver !== "function") return;
	const observer = new window.ResizeObserver((entries) => {
		const width = entries[0]?.contentRect.width;
		if (width !== undefined) {
			const cramped = width < CRAMPED_COLUMN_PX;
			column.toggleAttribute("data-cramped", cramped);
			setCramped(cramped);
		}
	});
	observer.observe(column);
	return () => observer.disconnect();
}

function AppShell() {
	const [token, setToken] = useState<string | null>(loadToken);
	// Trust mode (appToken unset — the tailnet is the only lock) means a
	// bare request just works and the gate must never show. With no
	// stored token, probe unauthenticated: 200 = trust mode, 401 = the
	// gate.
	const [gate, setGate] = useState<"probing" | "shown" | "passed">(
		token === null ? "probing" : "passed",
	);
	const [probeHint, setProbeHint] = useState<string | null>(null);
	const store = useMemo(() => new LiveStore(token), [token]);
	useEffect(() => {
		if (gate !== "passed") return;
		return store.start();
	}, [store, gate]);
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
							? err.status === 0
								? err.message
								: `The app channel answered ${err.status} — check goblin's log.`
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

	return (
		<LiveProvider store={store}>
			<AppBody
				token={token}
				onDeadToken={() => {
					clearToken();
					setToken(null);
					setProbeHint(null);
					setGate("shown");
				}}
			/>
		</LiveProvider>
	);
}

const EMPTY_CHAIN: AppConversationList["rolling"]["chain"] = [];

function LiveLost() {
	const status = useLiveStatus();
	if (status !== "lost") return null;
	return (
		<p className="live-lost" role="status">
			Reconnecting. Marks may be old.
		</p>
	);
}

function AppBody({ token, onDeadToken }: { token: string | null; onDeadToken: () => void }) {
	const phone = usePhoneWidth();
	const [columnCramped, setColumnCramped] = useState(false);
	const observeMain = useCallback(
		(column: HTMLElement | null) => observeColumnWidth(column, setColumnCramped),
		[],
	);
	const live = useLiveStore();
	const liveStatus = useLiveStatus();
	const goblin = useGoblinActivity();
	const [panelOpen, setPanelOpen] = useState(loadPanelOpen);
	const conversationsLive = useLive("conversations");
	const projectsLive = useLive("projects");
	const notesLive = useLive("notes");
	const conversations = conversationsLive.data?.conversations ?? null;
	const rollingChain = conversationsLive.data?.rolling.chain ?? EMPTY_CHAIN;
	const projects = projectsLive.data?.projects ?? null;
	const notes = notesLive.data?.notes ?? null;
	const notesError = notesLive.error !== null;
	const convError = conversationsLive.error;
	const listError =
		convError instanceof ApiError && convError.status === 401
			? "unauthorized"
			: convError !== null || projectsLive.error !== null
				? "list failed"
				: null;
	const [rollingViewing, setRollingViewing] = useState<string | null>(null);
	const [rollingRouted, setRollingRouted] = useState<string | null>(null);
	const [rollingFollow, setRollingFollow] = useState<{
		conversationId: string;
		messageId: string;
	} | null>(null);
	const [rollFocus, setRollFocus] = useState(0);
	const [sourcesOpen, setSourcesOpen] = useState(false);
	// Chat column width — a header selector on the chat page, persisted
	// per device (chatWidth.ts).
	const [chatWidth, setChatWidthState] = useState<ChatWidth>(loadChatWidth);
	const [projectsOpen, setProjectsOpenState] = useState(loadProjectsOpen);
	const [sideChatsOpen, setSideChatsOpenState] = useState(loadSideChatsOpen);
	const setProjectsOpen = (open: boolean) => {
		setProjectsOpenState(open);
		saveProjectsOpen(open);
	};
	const setSideChatsOpen = (open: boolean) => {
		setSideChatsOpenState(open);
		saveSideChatsOpen(open);
	};
	const setChatWidth = (width: ChatWidth) => {
		setChatWidthState(width);
		saveChatWidth(width);
	};
	const [rowError, setRowError] = useState<string | null>(null);
	const acted = (...topics: Parameters<typeof live.refresh>) => {
		setRowError(null);
		return live.refresh(...topics);
	};
	const [headerRenaming, setHeaderRenaming] = useState(false);
	const [railHidden, setRailHidden] = useState(false);
	// A pending rail create may navigate only while its original route
	// still owns the screen, even if the operator later returns there.
	const navigationSeq = useRef(0);
	const [goblinSheetOpen, setGoblinSheetOpen] = useState(false);
	const { query, setQuery, hits, searchError } = useConversationSearch(token);
	// The empty state has the composer too — its send creates the
	// conversation, then ChatView delivers the parked message as `seed`.
	const [seed, setSeed] = useState<{
		id: string;
		parts: UIMessage["parts"];
	} | null>(null);
	// The pre-creation memory choice — the conversation doesn't exist to
	// PATCH until the first send creates it, so the exclusion stages
	// here and rides into createConversation. Sticky like the staged
	// chips: an operator who excludes a chat shouldn't be re-asked per
	// start. Memory-off projects force it at their own composer.
	const [stagedMemoryExcluded, setStagedMemoryExcluded] = useState(false);
	// Bump on "New conversation" — the composer focuses itself, mounted
	// or not (a remount sees the non-zero signal on first effect).
	const [composerFocus, setComposerFocus] = useState(0);
	const [starting, setStarting] = useState(false);
	const [startFailed, setStartFailed] = useState(false);
	// A cancelled send belongs only to the composer that dispatched it.
	const [draftRestores, setDraftRestores] = useState<
		Record<string, { messages: UIMessage["parts"][] }>
	>({});
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
	const undoToast = useUndoToast();
	const confirm = useConfirm();
	// Deleted rows stay out of the lists while their DELETE is held back
	// for the undo window.
	const [heldDeletes, setHeldDeletes] = useState<ReadonlySet<string>>(new Set());
	const rowRemovedLatest = useRef<(id: string) => void>(() => {});
	// The deep link applies once — after the first list load — so an
	// operator's own navigation is never overridden later.
	const deepApplied = useRef(false);
	const [route, setRoute] = useState<Route>(() =>
		openingRoute(window.location.pathname, window.history.state)
	);
	// Async completions and dirty guards must read the mounted route, not
	// the route where their callback was created.
	const routeRef = useRef(route);
	routeRef.current = route;
	const current = route.kind === "conversation" ? route.id : null;
	const rollingCurrent = rollingChain[0] ?? null;
	const rollingId = rollingViewing ?? rollingRouted ?? rollingCurrent?.id ?? null;
	useEffect(() => {
		if (!(route.kind === "page" && route.page === "rolling")) {
			setRollingViewing(null);
			setRollingRouted(null);
			setRollingFollow(null);
		}
	}, [route]);
	useEffect(() => setHeaderRenaming(false), [current]);
	const projectId = route.kind === "project" ? route.id : null;
	const currentFolderId =
		(route.kind === "conversation"
			? conversations?.find((conversation) => conversation.id === route.id)?.projectId
			: null) ?? (route.kind === "project" ? route.id : null);
	useEffect(() => {
		if (currentFolderId === null) return;
		setProjectsOpenState(true);
		saveProjectsOpen(true);
	}, [currentFolderId]);
	const noteId = route.kind === "note" ? route.id : null;
	const windowConv = route.kind === "window" ? route.id : null;
	const composeStaged = route.kind === "home" && route.composing;
	const railCurrent = route.kind === "conversation" || route.kind === "window" ? route.id : null;
	const openRoll = route.kind === "page" && route.page === "rolling" ? rollingId : null;
	const seen = useMarkRead(token, current ?? openRoll);
	const page: Page = route.kind === "home" || route.kind === "conversation"
		? "chat"
		: route.kind === "page" ? route.page : route.kind;
	useEffect(() => setSourcesOpen(false), [route]);
	const [createProjectOpen, setCreateProjectOpen] = useState(false);
	const [createProjectMoveFor, setCreateProjectMoveFor] = useState<string | null>(null);
	const [createProjectMoveOrigin, setCreateProjectMoveOrigin] = useState<"list" | "chat" | "rolling">("chat");
	const [moveError, setMoveError] = useState<string | null>(null);
	useEffect(() => setMoveError(null), [current, rollingId]);
	// The settings editor's dirty bit — navigation asks before
	// discarding unsaved edits.
	const settingsDirty = useRef(false);
	// Tells the settings editor a leave ask is open and how it was
	// answered, so its autosave can't write under the sheet.
	const settingsLeave = useRef<((answer: LeaveAnswer) => void) | null>(null);
	// The note editor's unsaved body/title edits or standing 409 conflict
	// are also guarded; its draft lives only in that component.
	const noteDirty = useRef(false);
	// Confirmed discards must reach the editor before its unmount drain.
	const noteDiscard = useRef<(() => void) | null>(null);
	const [navigationError, setNavigationError] = useState<string | null>(null);
	const navigation = browserNavigation();
	const position = historyPosition(window.history.state);
	const historyRoute = useRef({
		index: position?.index ?? 0,
		segment: position?.segment ?? newHistorySegment(),
		key: navigation?.currentEntry.key ?? null,
	});
	// The traversal a pop already performed, parked while the leave-guard
	// ask is open — its answer replays or reverts this entry. A second
	// pop re-parks: the newest target is the only one that can land.
	const pendingPop = useRef<{
		p: Route;
		position: { index: number; segment: string } | null;
	} | null>(null);
	const popAskOpen = useRef(false);
	const askLeave = useLeaveAsk(confirm.ask);
	// Leaving a dirty page asks once, with the page's own wording. The
	// ask is a sheet now, not a blocking window.confirm, so the guard
	// splits in two: what to ask (dirtyGuard) and the answer's await.
	// The page hears "asking" when the sheet opens and the answer when
	// it closes. popstate uses the same pair — a traversal can't be
	// vetoed, so it restores-or-applies around the answer instead.
	const dirtyGuard = (): { message: string; answer: (a: LeaveAnswer) => void } | null => {
		if (routeRef.current.kind === "page" && routeRef.current.page === "settings" && settingsDirty.current)
			return {
				message: "Discard unsaved settings changes?",
				answer: (a) => {
					if (a === "discard") settingsDirty.current = false;
					settingsLeave.current?.(a);
				},
			};
		if (routeRef.current.kind === "note" && noteDirty.current)
			return {
				message: "Discard unsaved note edits and any conflict?",
				answer: (a) => {
					if (a === "discard") noteDiscard.current?.();
				},
			};
		return null;
	};
	const leaveDirty = async (): Promise<boolean> => {
		const guard = dirtyGuard();
		if (guard === null) return true;
		return (await askLeave(guard.message, guard.answer)) === true;
	};
	const pushRoute = (path: string) => {
		navigationSeq.current += 1;
		const actual = historyPosition(window.history.state);
		// A declined legacy traversal can leave the browser at a different
		// entry while the editor stays open. Never extend its saved indices.
		const base =
			actual?.segment === historyRoute.current.segment && actual.index === historyRoute.current.index
				? actual
				: { index: 0, segment: newHistorySegment() };
		window.history.pushState(
			{ goblinIndex: base.index + 1, goblinSegment: base.segment },
			"",
			path,
		);
		historyRoute.current = {
			index: base.index + 1,
			segment: base.segment,
			key: navigation?.currentEntry.key ?? null,
		};
		setNavigationError(null);
	};
	const navigate = async (next: Route, opts?: { skipDirtyGuard?: boolean }) => {
		if (sameRoute(routeRef.current, next)) return;
		if (opts?.skipDirtyGuard !== true && !(await leaveDirty())) return;
		clearStartFailure();
		const path = pathOfRoute(next);
		const mountedPath = pathOfRoute(routeRef.current);
		routeRef.current = next;
		setRoute(next);
		if (path !== mountedPath) pushRoute(path);
	};

	useEffect(() => {
		if (
			routeRef.current.kind === "page" &&
			routeFromPath(window.location.pathname).kind === "home"
		)
			window.history.replaceState(window.history.state, "", pathOfRoute(routeRef.current));
	}, []);

	useEffect(() => {
		if (navigation !== null) return;
		const state: unknown = window.history.state;
		window.history.replaceState(
			{
				...(typeof state === "object" && state !== null ? state : {}),
				goblinIndex: historyRoute.current.index,
				goblinSegment: historyRoute.current.segment,
			},
			"",
		);
	}, [navigation]);

	useEffect(() => {
		if (rollingRouted !== null && rollingChain[0]?.id === rollingRouted) {
			setRollingRouted(null);
		}
	}, [rollingRouted, rollingChain]);
	useEffect(() => {
		if (rollFocus !== 0) setRollFocus(0);
	}, [rollingId, rollFocus]);

	// A /app/c/<id> load selects that conversation once the list
	// arrives.
	useEffect(() => {
		if (conversations === null || deepApplied.current) return;
		deepApplied.current = true;
		const initial = routeFromPath(window.location.pathname);
		if (initial.kind !== "conversation") return;
		if (conversations.some((c) => c.id === initial.id)) {
			routeRef.current = initial;
			setRoute(initial);
		} else if (rollingChain.some((c) => c.id === initial.id)) {
			const next: Route = { kind: "page", page: "rolling" };
			routeRef.current = next;
			setRoute(next);
			setRollingViewing(rollingChain[0]?.id === initial.id ? null : initial.id);
			window.history.replaceState(window.history.state, "", "/app/rolling");
		} else {
			// A dead link must not masquerade — normalize to the root.
			window.history.replaceState(window.history.state, "", "/app/");
		}
	}, [conversations, rollingChain]);

	useEffect(() => {
		const applyPop = (next: Route, nextPosition: { index: number; segment: string } | null) => {
			navigationSeq.current += 1;
			historyRoute.current = {
				// A legacy gap breaks index continuity. New entries get a new
				// segment so we never compute a distance across that gap.
				index: nextPosition?.index ?? 0,
				segment: nextPosition?.segment ?? newHistorySegment(),
				key: navigation?.currentEntry.key ?? null,
			};
			setNavigationError(null);
			clearStartFailure();
			routeRef.current = next;
			setRoute(next);
		};
		// popstate arrives after traversal. Undo it rather than push a
		// replacement entry, which would erase the forward history.
		const restoreEntry = (nextPosition: { index: number; segment: string } | null) => {
			if (navigation !== null && historyRoute.current.key !== null) {
				const failed = (err: unknown) =>
					setNavigationError(
						`Couldn't restore history: ${err instanceof Error ? err.message : String(err)}`,
					);
				try {
					const { committed, finished } = navigation.traverseTo(historyRoute.current.key);
					void Promise.all([committed, finished]).catch(failed);
				} catch (err) {
					failed(err);
				}
			} else if (
				nextPosition !== null &&
				nextPosition.segment === historyRoute.current.segment &&
				nextPosition.index !== historyRoute.current.index
			) {
				window.history.go(historyRoute.current.index - nextPosition.index);
			} else {
				setNavigationError(
					"Your unsaved edits are still here. This browser cannot restore an older history entry; save or discard your changes before navigating again.",
				);
			}
		};
		const onPop = () => {
			const next = routeFromPath(window.location.pathname);
			const nextPosition = historyPosition(window.history.state);
			// Only a pop that actually leaves the dirty page asks — the
			// restore lands right back on it, and an ask there would double
			// every decline.
			const stillHome =
				(route.kind === "page" && route.page === "settings" && next.kind === "page" && next.page === "settings") ||
				(route.kind === "note" && next.kind === "note" && next.id === route.id);
			const guard = stillHome ? null : dirtyGuard();
			if (guard === null) {
				// A pending ask's target dies here: this pop applied under
				// the open sheet, so the page it guarded no longer stands —
				// the late answer must neither restore nor replay.
				pendingPop.current = null;
				applyPop(next, nextPosition);
				return;
			}
			// The traversal already happened and can't be vetoed — park it
			// and ask. A decline undoes the traversal; an approval applies
			// it as if the guard had passed. A second pop re-parks: the
			// newest target is the only one that can land.
			pendingPop.current = { p: next, position: nextPosition };
			if (popAskOpen.current) return;
			popAskOpen.current = true;
			void askLeave(guard.message, guard.answer, () => pendingPop.current !== null).then((ok) => {
				popAskOpen.current = false;
				const target = pendingPop.current;
				pendingPop.current = null;
				if (target === null) return;
				if (ok === true) {
					applyPop(target.p, target.position);
				} else {
					restoreEntry(target.position);
				}
			});
		};
		window.addEventListener("popstate", onPop);
		return () => window.removeEventListener("popstate", onPop);
	}, [route, askLeave, confirm, navigation, navigation?.currentEntry.key]);

	useEffect(() => {
		const onUnload = (event: BeforeUnloadEvent) => {
			const dirty =
				(route.kind === "page" && route.page === "settings" && settingsDirty.current) ||
				(route.kind === "note" && noteDirty.current);
			if (!dirty) return;
			event.preventDefault();
			event.returnValue = "Unsaved edits";
		};
		window.addEventListener("beforeunload", onUnload);
		return () => window.removeEventListener("beforeunload", onUnload);
	}, [route]);

	const all = (conversations ?? []).filter((c) => !heldDeletes.has(c.id));
	const unbound = all.filter((c) => (c.projectId ?? null) === null);
	const projectList = projects ?? [];
	const activeProjects = projectList
		.filter((p) => p.archivedAt === null)
		.sort((a, b) => a.name.localeCompare(b.name));
	const home = useHomeList({
		conversations: all,
		chain: rollingChain,
		projects: projectList.map(({ id, name, archivedAt }) => ({ id, name, archivedAt })),
		attention: goblin.attention ?? [],
		delegations: (goblin.delegations ?? []).map(({ appConversation, status }) => ({ appConversation, status })),
		open: railCurrent,
		seen,
		sideChatsOpen,
	}, activeProjects, projectsOpen);
	const inGoblin = page === "rolling" || home.list.openInGoblin;
	const inProject = currentFolderId !== null;
	useEffect(() => {
		if (!inGoblin && !inProject) return;
		setSideChatsOpenState(inGoblin);
		saveSideChatsOpen(inGoblin);
	}, [inGoblin, inProject, railCurrent, currentFolderId]);
	const desktopFlipRef = useFlip(home.orderSignature);
	const phoneFlipRef = useFlip(home.orderSignature);

	// A dead token means 401s forever — offer a way back to the gate.
	if (listError === "unauthorized") {
		return (
			<div className="gate">
				<h1>goblin</h1>
				<p className="error">The stored token stopped working.</p>
				<button type="button" onClick={onDeadToken}>
					Paste a new token
				</button>
			</div>
		);
	}

	// Selection owns the URL — /app/c/<id> for a conversation, /app/
	// for the list/empty state, matching the deep link the pings carry.
	const select = async (id: string | null, opts?: { skipDirtyGuard?: boolean }) => {
		await navigate(
			id === null ? { kind: "home", composing: false }
				: { kind: "conversation", id },
			opts,
		);
	};

	const openProject = (id: string) => navigate({ kind: "project", id });
	const openProjectsIndex = () => navigate({ kind: "page", page: "projects" });
	const openArchive = () => navigate({ kind: "page", page: "archive" });
	const openNotesIndex = () => navigate({ kind: "page", page: "notes" });
	const openNote = (id: string) => navigate({ kind: "note", id });

	// The context-window view of one conversation — read-only, so the
	// dirty guard has nothing to protect here.
	const openWindow = (id: string) => {
		void navigate({ kind: "window", id }, { skipDirtyGuard: true });
	};

	const rowRemoved = (id: string) => {
		if (routeRef.current.kind === "conversation" && routeRef.current.id === id)
			void navigate({ kind: "home", composing: false });
	};

	const rowLabel = (c: AppConversationList["conversations"][number]) => {
		const title = flatTitle(c.title);
		const preview = flatLine(c.preview);
		return title ?? (preview === "" ? "new conversation" : preview);
	};
	const unarchive = (c: AppConversationList["conversations"][number]) => {
		void patchConversation(token, c.id, { archived: false }).then(
			() => {
				void acted("conversations");
			},
			(err: unknown) =>
				setRowError(
					`Couldn't unarchive "${rowLabel(c)}": ` +
						(err instanceof Error ? err.message : String(err)),
				),
		);
	};
	const archivedWithUndo = (c: AppConversationList["conversations"][number]) => {
		undoToast.show({
			message: `Archived "${rowLabel(c)}"`,
			undo: () => unarchive(c),
		});
	};
	// The settle callback runs seconds later: it must see the selection and
	// page of that moment, not of the click.
	rowRemovedLatest.current = rowRemoved;
	// The server delete is irreversible: it keeps its confirm, then waits
	// out the undo window. The row hides now, the DELETE fires when the
	// toast settles, and Undo just un-hides it. Closing the page inside the
	// window cancels it.
	const deleteConversationHeld = async (c: AppConversationList["conversations"][number]) => {
		if (
			!(await confirm.ask({
				message: `Delete "${rowLabel(c)}"?`,
				confirmLabel: "Delete",
				danger: true,
			}))
		)
			return;
		const release = () =>
			setHeldDeletes((prev) => {
				const next = new Set(prev);
				next.delete(c.id);
				return next;
			});
		setRowError(null);
		setHeldDeletes((prev) => new Set(prev).add(c.id));
		rowRemoved(c.id);
		undoToast.show({
			message: `Deleted "${rowLabel(c)}"`,
			undo: release,
			settle: () => {
				void deleteConversation(token, c.id).then(
					() => {
						// Drop the row before releasing the hold, so it can't
						// reappear while (or if) the refresh is pending or fails.
						live.update("conversations", (d) =>
							d === null
								? d
								: { ...d, conversations: d.conversations.filter((x) => x.id !== c.id) },
						);
						release();
						// It may have been reopened (search, history) during the window.
						rowRemovedLatest.current(c.id);
						void acted("conversations");
					},
					(err: unknown) => {
						release();
						setRowError(
							`Couldn't delete "${rowLabel(c)}": ` +
								(err instanceof Error ? err.message : String(err)),
						);
					},
				);
			},
		});
	};

	const openPage = (p: AppPageKey) => navigate({ kind: "page", page: p });

	// "New conversation" opens the empty state; the conversation itself is
	// created lazily, on the first send — an untouched composer never
	// leaves an empty row in the store. On phone widths "+" is tapped from
	// the chats list, so staging the composer is the mobile bit.
	const newConversation = () => {
		setComposerFocus((t) => t + 1);
		void navigate({ kind: "home", composing: true });
	};

	const openConversation = (id: string) => {
		void select(id);
	};
	const openAttentionTarget = (target: AppAttentionTarget) => {
		if (target.kind === "page") void openPage(target.page);
		else openConversation(target.conversationId);
	};

	const startChat = async (
		projectId: string | null,
		parts: UIMessage["parts"],
		composerScope?: string,
		initialModelSettings?: AppModelSettings,
	): Promise<boolean> => {
		if (!(await leaveDirty())) return false;
		if (startBusyRef.current) {
			// Refuse loudly — a silent no-op reads as success to awaited
			// callers. A composer-scoped send parks its parts back in the
			// draft first, the same shape as the fenced path —
			// note-originated starts carry no scope and restore nothing.
			if (composerScope !== undefined) {
				setDraftRestores((prev) => ({ ...prev, [composerScope]: { messages: [parts] } }));
			}
			throw new Error("a conversation is still starting — resend once it finishes");
		}
		startBusyRef.current = true;
		const seq = ++startSeq.current;
		setStarting(true);
		setStartFailed(false);
		try {
			const created = await createConversation(token, {
				...(projectId === null ? {} : { projectId }),
				// Only a composer start carries the staged memory toggle —
				// note-originated chats have no visible toggle and must not
				// inherit a sticky exclusion.
				...(composerScope === undefined ? {} : { memoryExcluded: stagedMemoryExcluded }),
				...(initialModelSettings === undefined ? {} : { initialModelSettings }),
			});
			// A navigation while the create was in flight bumped the
			// sequence — this continuation closes over the old page, so
			// its select would skip the dirty-settings guard entirely.
			if (seq !== startSeq.current) {
				if (composerScope !== undefined) {
					setDraftRestores((prev) => ({ ...prev, [composerScope]: { messages: [parts] } }));
				}
				try {
					await deleteConversation(token, created.id);
					await acted("conversations");
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
			void select(created.id, { skipDirtyGuard: true });
			await acted("conversations");
			return true;
		} catch {
			if (seq === startSeq.current) setStartFailed(true);
			return false;
		} finally {
			startBusyRef.current = false;
			setStarting(false);
		}
	};

	// Composer sends are fire-and-forget — the only rejection startChat
	// produces is the deliberate busy refusal, so it surfaces on the
	// rail rather than dying as an unhandled rejection.
	const reportStartRefusal = (err: unknown) =>
		setRowError(err instanceof Error ? err.message : String(err));

	const currentTitle = conversations?.find((c) => c.id === current)?.title ?? null;

	const archived = unbound
		.filter((c) => c.archivedAt !== null && c.parentId == null)
		.sort((a, b) => Date.parse(b.archivedAt!) - Date.parse(a.archivedAt!));

	const currentProject =
		projectId === null ? undefined : projectList.find((p) => p.id === projectId);
	// The crumb's name rides the same pool the rail lists.
	const currentConv = all.find((c) => c.id === current);
	const rowActionCallbacks = (c: AppConversationList["conversations"][number]) => ({
		onToggleArchived: (id: string, isArchived: boolean) => {
			if (isArchived) {
				rowRemoved(id);
				archivedWithUndo(c);
			}
			void acted("conversations");
		},
		onTogglePinned: () => {
			void acted("conversations");
		},
		onDelete: deleteConversationHeld,
		onError: setRowError,
	});
	const headerActions =
		currentConv === undefined
			? null
			: conversationActions(currentConv, {
					token,
					...rowActionCallbacks(currentConv),
				});
	const parentConv =
		currentConv?.parentId == null ? undefined : all.find((c) => c.id === currentConv.parentId);
	const currentConvProject =
		currentConv?.projectId != null
			? projectList.find((p) => p.id === currentConv.projectId)
			: undefined;
	const moveChatToProject = async (
		conversationId: string,
		targetProjectId: string,
		origin: "list" | "chat" | "rolling",
	) => {
		if (origin === "list") setRowError(null);
		else setMoveError(null);
		try {
			await patchConversation(token, conversationId, { projectId: targetProjectId });
			setProjectsOpen(true);
			await acted("conversations");
			if (origin === "rolling") openConversation(conversationId);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (origin === "list") setRowError(message);
			else setMoveError(message);
		}
	};

	const chatListMode = phone && page === "chat" && current === null && !composeStaged;

	const renderRow: RenderRow = (conv, options) => {
		const callbacks = rowActionCallbacks(conv);
		return (
			<ConversationRow
				conv={conv}
				{...options}
				current={railCurrent}
				token={token}
				moveTargets={activeProjects.map(({ id, name }) => ({ id, name }))}
				onMove={(conversationId, targetProjectId) =>
					void moveChatToProject(conversationId, targetProjectId, "list")
				}
				onMoveToNewProject={(conversationId) => {
					setRowError(null);
					setCreateProjectMoveFor(conversationId);
					setCreateProjectMoveOrigin("list");
					setCreateProjectOpen(true);
				}}
				onOpen={openConversation}
				onRenamed={() => {
					void acted("conversations");
				}}
				{...callbacks}
			/>
		);
	};
	const openRollingFromList = () => {
		const { sideTarget, target } = home.list.rolling;
		if (sideTarget !== null) {
			openConversation(sideTarget);
			return;
		}
		setRollingViewing(target === rollingChain[0]?.id ? null : target);
		setRollingRouted(null);
		void openPage("rolling");
	};
	const rollChat = async (): Promise<string | null> => {
		const from = rollingId;
		const routeAt = routeRef.current;
		try {
			const result = await rollRollingChat(token);
			if (from !== null && from !== result.conversationId)
				moveComposerDraft(from, result.conversationId);
			if (routeRef.current === routeAt && routeAt.kind === "page" && routeAt.page === "rolling") {
				setRollingViewing(null);
				setRollingRouted(result.conversationId);
				setRollingFollow(null);
				setRollFocus((n) => n + 1);
			}
			await acted("conversations");
			return null;
		} catch (err) {
			return err instanceof Error ? err.message : String(err);
		}
	};
	const renderHomeList = (navRef: (node: HTMLElement | null) => void) => (
		<HomeList
			home={home}
			projects={activeProjects}
			projectsOpen={projectsOpen}
			currentFolderId={currentFolderId}
			rollingCurrent={page === "rolling"}
			sideChatsOpen={sideChatsOpen}
			onToggleProjects={() => setProjectsOpen(!projectsOpen)}
			onToggleSideChats={() => setSideChatsOpen(!sideChatsOpen)}
			onNewSideChat={newConversation}
			onNewProject={() => setCreateProjectOpen(true)}
			onOpenProject={(id) => void openProject(id)}
			onOpenTarget={openAttentionTarget}
			onOpenRolling={openRollingFromList}
			renderRow={renderRow}
			navRef={navRef}
		/>
	);
	const renderGoblinFace = (destination: "panel" | "sheet") => (
		<GoblinFace
			working={goblin.working}
			needs={goblin.attention?.length ?? null}
			failed={goblin.attentionError}
			{...(destination === "panel" ? { expanded: panelOpen } : {})}
			onClick={() => {
				if (destination === "sheet") {
					setGoblinSheetOpen(true);
					return;
				}
				setPanelOpen(!panelOpen);
				savePanelOpen(!panelOpen);
			}}
		/>
	);

	// The search hits and the archived disclosure serve two hosts — the
	// desktop rail and the mobile chats screen render the same rows off
	// the same state.
	const searchBody = hits !== null && (
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
	);
	// The archive is a page, not a rail section — the rail only links to
	// it, so a long archive never crowds the list.
	const archivedRows = archived.length > 0 && (
		<button
			type="button"
			className="rail-archived"
			aria-current={page === "archive" ? "page" : undefined}
			onClick={openArchive}
		>
			Archived <span className="count">{archived.length}</span>
			<svg
				className="chev"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.75"
				strokeLinecap="round"
				strokeLinejoin="round"
				width="12"
				height="12"
				aria-hidden="true"
			>
				<path d="M9 6l6 6-6 6" />
			</svg>
		</button>
	);

	const backFromWindow = () => {
		if (windowConv === null) return;
		void leaveDirty().then((ok) => {
			if (!ok) return;
			void select(windowConv);
		});
	};
	const youMenu = (
		<Menu
			onAction={(value) => {
				if (value === "settings") void openPage("settings");
				if (value === "projects") void openProjectsIndex();
				if (value === "archive") void openArchive();
			}}
		>
			<MenuTrigger className="rail-you" aria-label="You">You</MenuTrigger>
			<MenuContent className="title-menu">
				<MenuItem value="settings">Settings</MenuItem>
				<MenuItem value="projects">Projects</MenuItem>
				<MenuItem value="archive">Archive</MenuItem>
			</MenuContent>
		</Menu>
	);

	return (
		<div className="shell" data-live={liveStatus === "lost" ? "lost" : undefined}>
			{!railHidden && (
				<nav className="rail app-rail" aria-label="Sidebar">
					<div className="rail-top">
						<input
							className="rail-search"
							type="search"
							placeholder="Search history"
							aria-label="Search history"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Escape") setQuery("");
							}}
						/>
						<button type="button" aria-label="New side chat" onClick={newConversation}>
							<svg
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.75"
								strokeLinecap="round"
								width="18"
								height="18"
								aria-hidden="true"
							>
								<path d="M12 5v14M5 12h14" />
							</svg>
						</button>
					</div>
					<LiveLost />
					<div className="rail-body">
						{query.trim() !== "" ? (
							searchBody
						) : (
							<>
								{renderHomeList(desktopFlipRef)}
								{archivedRows}
							</>
						)}
					</div>
					{listError !== null && <p className="error">Couldn't refresh the list.</p>}
					{rowError !== null && <p className="error" role="alert">{rowError}</p>}
					{youMenu}
				</nav>
			)}
			<main
				ref={observeMain}
				className={
					[chatWidth === "wide" ? "chat-wide" : "", chatListMode ? "list-mode" : ""]
						.filter(Boolean)
						.join(" ") || undefined
				}
			>
				<header>
					{!phone && (
						<button
							type="button"
							className="nav-toggle rail-toggle"
							aria-label="Sidebar"
							aria-expanded={!railHidden}
							title="Sidebar"
							onClick={() => setRailHidden((v) => !v)}
						>
							<svg
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.75"
								strokeLinecap="round"
								width="18"
								height="18"
								aria-hidden="true"
							>
								<rect x="3" y="4" width="18" height="16" rx="3" />
								<line x1="9.5" y1="4" x2="9.5" y2="20" />
							</svg>
						</button>
					)}
					{phone && !chatListMode && (
						<button
							type="button"
							className="mobile-back"
							aria-label={
								page === "project"
									? "Back to projects"
									: page === "note"
										? "Back to notes"
										: page === "window"
											? "Back to conversation"
											: "Back to chats"
							}
							onClick={() => {
								if (page === "project") void openProjectsIndex();
								else if (page === "note") void openNotesIndex();
								else if (page === "window") backFromWindow();
								else void navigate({ kind: "home", composing: false });
							}}
						>
							<svg
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.75"
								strokeLinecap="round"
								strokeLinejoin="round"
								width="19"
								height="19"
								aria-hidden="true"
							>
								<path d="M14.5 5 7.5 12l7 7" />
							</svg>
						</button>
					)}
					<h1 className={page === "chat" || page === "rolling" ? "sr-only" : undefined}>goblin</h1>
					{page === "chat" && current !== null && (
						headerRenaming && currentConv !== undefined ? (
							<div className="header-title-editor">
								<ConversationTitleEditor
									conv={currentConv}
									token={token}
									onRenamed={() => {
										void acted("conversations");
									}}
									onError={setRowError}
									onClose={() => setHeaderRenaming(false)}
								/>
							</div>
						) : currentConv === undefined || headerActions === null ? (
							<span className={`header-title${page === "chat" ? " main-title" : ""}`}>{flatTitle(currentTitle)}</span>
						) : (
							<Menu
								onAction={(value) => {
									if (value === "pin") void headerActions.togglePinned();
									else if (value === "rename") setHeaderRenaming(true);
									else if (value === "archive" || value === "unarchive")
										void headerActions.toggleArchived();
									else if (value === "delete") headerActions.remove();
									else if (value === "new-project") {
										setMoveError(null);
										setCreateProjectMoveFor(currentConv.id);
										setCreateProjectMoveOrigin("chat");
										setCreateProjectOpen(true);
									} else if (value.startsWith("project:")) {
										void moveChatToProject(
											currentConv.id,
											value.slice("project:".length),
											"chat",
										);
									}
								}}
							>
								<MenuTrigger className={`header-title title-trigger${page === "chat" ? " main-title" : ""}`}>
									{rowLabel(currentConv)}
									<ChevronDownGlyph />
								</MenuTrigger>
								<MenuContent className="title-menu">
									{currentConv.archivedAt === null ? (
										<>
											<MenuItem value="pin">
												{currentConv.pinnedAt === null ? "Pin" : "Unpin"}
											</MenuItem>
											<MenuItem value="rename">Rename</MenuItem>
											{currentConv.projectId === null && currentConv.parentId === null && (
												<MenuSub>
													<MenuSubTrigger>Move to project</MenuSubTrigger>
													<MenuSubContent className="move-menu">
														{activeProjects.map((project) => (
														<MenuItem key={project.id} value={`project:${project.id}`}>
															{project.name}
														</MenuItem>
														))}
														<MenuItem value="new-project">New project…</MenuItem>
													</MenuSubContent>
												</MenuSub>
											)}
											<MenuItem value="archive">Archive</MenuItem>
										</>
									) : (
										<>
											<MenuItem value="rename">Rename</MenuItem>
											<MenuItem value="unarchive">Unarchive</MenuItem>
											<MenuItem value="delete">Delete</MenuItem>
										</>
									)}
								</MenuContent>
							</Menu>
						)
					)}
					{page === "chat" && parentConv !== undefined && (
						<a
							className="header-parent"
							href={`/app/c/${parentConv.id.slice("app/".length)}`}
							onClick={(event) => {
								if (
									event.metaKey ||
									event.ctrlKey ||
									event.shiftKey ||
									event.altKey ||
									event.button !== 0
								)
									return;
								event.preventDefault();
								openConversation(parentConv.id);
							}}
						>
							↑ {flatTitle(parentConv.title) ?? "parent conversation"}
						</a>
					)}
					{page === "window" && <span className="header-title">Context window</span>}
					{page === "projects" && <span className="header-title">Projects</span>}
					{page === "archive" && <span className="header-title">Archive</span>}
					{page === "rolling" &&
						(rollingCurrent !== null && rollingId === rollingCurrent.id ? (
							<Menu
								onAction={(value) => {
									if (value === "new-project") {
										setMoveError(null);
										setCreateProjectMoveFor(rollingCurrent.id);
										setCreateProjectMoveOrigin("rolling");
										setCreateProjectOpen(true);
									} else if (value.startsWith("project:")) {
										void moveChatToProject(
											rollingCurrent.id,
											value.slice("project:".length),
											"rolling",
										);
									}
								}}
							>
								<MenuTrigger className="header-title title-trigger main-title">
									Little Goblin
									<ChevronDownGlyph />
								</MenuTrigger>
								<MenuContent className="title-menu">
									<MenuSub>
										<MenuSubTrigger>Move to project</MenuSubTrigger>
										<MenuSubContent className="move-menu">
											{activeProjects.map((project) => (
												<MenuItem key={project.id} value={`project:${project.id}`}>
													{project.name}
												</MenuItem>
											))}
											<MenuItem value="new-project">New project…</MenuItem>
										</MenuSubContent>
									</MenuSub>
								</MenuContent>
							</Menu>
						) : (
							<span className="header-title">Little Goblin</span>
						))}
					{page === "project" && <span className="header-title">{currentProject?.name}</span>}
					{page === "notes" && <span className="header-title">Notes</span>}
					{page === "note" && <span className="header-title">Note</span>}
					{PAGES.some((p) => p.key === page) && (
						<span className="header-title">{PAGES.find((p) => p.key === page)?.label}</span>
					)}
					<div className="header-tools">
					{page === "chat" && current !== null && (
						<Menu onAction={(value) => {
							if (value === "context") openWindow(current);
							else if (value === "sources") setSourcesOpen(true);
						}}>
							<MenuTrigger className="header-action" aria-label="Chat tools" title="Chat tools"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg></MenuTrigger>
							<MenuContent className="title-menu">
								<MenuItem value="context">Context window</MenuItem>
								<MenuItem value="sources">From this thread</MenuItem>
								{!phone && !columnCramped && <MenuCheckboxItem value="wide" checked={chatWidth === "wide"} onCheckedChange={(checked) => setChatWidth(checked ? "wide" : "narrow")}>Wide column</MenuCheckboxItem>}
							</MenuContent>
						</Menu>
					)}
					{!phone && (page === "chat" || page === "rolling") && (
						<>
						{page === "chat" && <span className="header-tools-divider" aria-hidden="true" />}
						{renderGoblinFace("panel")}
						</>
					)}
					{phone && !chatListMode && (page === "chat" || page === "rolling") && (
						<>
						{page === "chat" && <span className="header-tools-divider" aria-hidden="true" />}
						{renderGoblinFace("sheet")}
						</>
					)}
					</div>
				</header>
				{/* Mobile (M): the chats surface is a screen. Desktop never sees
					it — the rail is the list there; CSS shows this on phone
					widths only, hiding the header and the empty-state composer
					beneath it. */}
				{chatListMode && (
					<div className="chatlist-screen">
						<div className="chatlist-bar">
							<h1>Chats</h1>
							<button
								type="button"
								className="header-action"
								title="New side chat"
								aria-label="New side chat"
								onClick={newConversation}
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
									<path d="M12 5v14M5 12h14" />
								</svg>
							</button>
							{renderGoblinFace("sheet")}
						</div>
						<input
							className="rail-search chatlist-search"
							type="search"
							placeholder="Search history"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Escape") setQuery("");
							}}
						/>
						<LiveLost />
						{searchBody}
						{hits === null && (
							<>
								{renderHomeList(phoneFlipRef)}
								{archivedRows}
								{conversations !== null && home.list.active.length === 0 && home.list.side.length === 0 && archived.length === 0 && activeProjects.length === 0 && (
									<p className="empty">Nothing here yet — start a conversation.</p>
								)}
								{listError !== null && <p className="error">Couldn't refresh the list.</p>}
								{rowError !== null && (
									<p className="error" role="alert">
										{rowError}
									</p>
								)}
							</>
						)}
						{youMenu}
					</div>
				)}
				{navigationError !== null && (
					<p className="error" role="alert">
						{navigationError}
					</p>
				)}
				{page === "attention" && (
					<AttentionView token={token} onPage={openPage} onConversation={openConversation} />
				)}
				{page === "activity" && (
					<ActivityView
						token={token}
						data={goblin}
						conversations={[...all, ...rollingChain]}
						rollingConversationIds={rollingChain.map((conversation) => conversation.id)}
						onOpenConversation={openConversation}
						onOpenPage={(p) => void openPage(p)}
					/>
				)}
				{page === "settings" && (
					<SettingsView
						token={token}
						onDirtyChange={(d) => {
							settingsDirty.current = d;
						}}
						leaveRef={settingsLeave}
						onOpenNotes={() => void openNotesIndex()}
					/>
				)}
				{(page === "status" || page === "memory" || page === "skills" || page === "log") && (
					<GoblinProfileHeader page={page} working={goblin.working} onPage={openPage} />
				)}
				{page === "memory" && <MemoryView token={token} onConversation={openConversation} />}
				{page === "delegations" && (
					<DelegationsView token={token} onOpenConversation={openConversation} />
				)}
				{page === "programs" && <ProgramsView token={token} />}
				{page === "status" && <StatusView token={token} onPage={openPage} />}
				{page === "skills" && <SkillsView token={token} />}
				{page === "files" && <FilesView token={token} />}
				{page === "log" && <LogView token={token} />}
				{page === "window" && windowConv !== null && (
					<WindowView
						key={windowConv}
						token={token}
						conversationId={windowConv}
						title={flatTitle(conversations?.find((c) => c.id === windowConv)?.title ?? null)}
						onBack={backFromWindow}
					/>
				)}
				{page === "projects" && (
					<ProjectsIndex
						projects={projectList}
						onOpen={openProject}
						onNew={() => setCreateProjectOpen(true)}
					/>
				)}
				{page === "archive" && (
					<ArchiveView
						rows={archived.map((c) => ({
							id: c.id,
							label: rowLabel(c),
							preview:
								flatTitle(c.title) !== null && flatLine(c.preview) !== ""
									? flatLine(c.preview)
									: null,
							archivedAt: c.archivedAt!,
							updatedAt: c.updatedAt,
						}))}
						error={rowError}
						onOpen={openConversation}
						onUnarchive={(id) => {
							const c = archived.find((x) => x.id === id);
							if (c !== undefined) unarchive(c);
						}}
						onDelete={(id) => {
							const c = archived.find((x) => x.id === id);
							if (c !== undefined) void deleteConversationHeld(c);
						}}
					/>
				)}
				{page === "notes" && (
					<NotesIndex
						token={token}
						projects={projectList}
						onOpen={openNote}
						onSettings={() => void openPage("settings")}
						onChanged={() => void acted("notes")}
					/>
				)}
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
									onChanged={() => void acted("notes")}
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
										void openNotesIndex();
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
									renderRow={(conversation) => renderRow(conversation)}
									onChanged={() => void acted("projects", "conversations", "notes")}
									onOpenNote={openNote}
									onConversation={openConversation}
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
										draftScope={currentProject.id}
										busy={starting}
										stagedMemory={{
											excluded: currentProject.memory === "off" || stagedMemoryExcluded,
											locked: currentProject.memory === "off",
										}}
										onStagedMemoryToggle={setStagedMemoryExcluded}
										draftRestore={draftRestores[currentProject.id] ?? null}
										onDraftRestored={() => consumeRestore(currentProject.id)}
										onSend={(parts, _whenBusy, initialModelSettings) =>
											startChat(
												currentProject.id,
												parts,
												currentProject.id,
												initialModelSettings,
											).catch(
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
								key={`home-composer:${composerFocus}`}
								token={token}
								draftScope="new"
								busy={starting}
								stagedMemory={{ excluded: stagedMemoryExcluded, locked: false }}
								onStagedMemoryToggle={setStagedMemoryExcluded}
								focusSignal={composerFocus}
								draftRestore={draftRestores.chat ?? null}
								onDraftRestored={() => consumeRestore("chat")}
								onSend={(parts, _whenBusy, initialModelSettings) =>
									startChat(null, parts, "chat", initialModelSettings).catch((err: unknown) => {
										reportStartRefusal(err);
										return false;
									})
								}
							/>
						</div>
					) : (
						<>
							{currentConvProject !== undefined && (
								<button
									type="button"
									className="crumb"
									onClick={() => openProject(currentConvProject.id)}
								>
									{currentConvProject.name}
								</button>
							)}
							{moveError !== null && (
								<p className="error" role="alert">
									{moveError}
								</p>
							)}
							<ChatView
								key={current}
								token={token}
								conversationId={current}
								title={flatTitle(currentTitle)}
								seed={seed !== null && seed.id === current ? seed.parts : null}
								noteProjectId={currentConv?.projectId ?? null}
								onSeeded={() => setSeed(null)}
								onSendAccepted={() => void acted("conversations")}
								onOpenNote={openNote}
								onBranched={(id) => {
									void acted("conversations");
									openConversation(id);
								}}
							/>
						</>
					))}
				{page === "rolling" &&
					(rollingId === null ? (
						<div className="chat">
							<div className="transcript">
								<div className="transcript-inner">
									<p className="empty">Send a message — your chat with Little Goblin starts here.</p>
									{startFailed && <p className="error">Couldn't send — check the tailnet, then resend.</p>}
								</div>
							</div>
							<Composer
								token={token}
								draftScope="rolling"
								busy={starting}
								stagedMemory={{ excluded: false, locked: true }}
								onStagedMemoryToggle={() => {}}
								onSend={async (parts, _whenBusy, initialModelSettings) => {
									setStarting(true);
									setStartFailed(false);
									try {
										const message = { id: crypto.randomUUID(), role: "user", parts };
										const response = await fetch("/api/app/chat", {
											method: "POST",
											headers: {
												"content-type": "application/json",
												...(token === null ? {} : { authorization: `Bearer ${token}` }),
											},
											body: JSON.stringify({
												rolling: true,
												message,
												...(initialModelSettings === undefined ? {} : { initialModelSettings }),
											}),
										});
										if (response.status !== 202) throw new Error(`send failed (${response.status})`);
										const result = (await response.json()) as AppChatResponse;
										if (!("conversationId" in result))
											throw new Error("rolling send returned no conversation id");
										setRollingViewing(null);
										setRollingRouted(result.conversationId);
										setRollingFollow({
											conversationId: result.conversationId,
											messageId: message.id,
										});
										await acted("conversations");
										return true;
									} catch {
										setStartFailed(true);
										return false;
									} finally {
										setStarting(false);
									}
								}}
							/>
						</div>
					) : (
						<ChatView
							key={`rolling:${rollingId}`}
							token={token}
							conversationId={rollingId}
							title="Little Goblin"
							seed={null}
							noteProjectId={null}
							rolling
							onRoll={rollChat}
							focusSignal={rollFocus}
							rollDisabled={rollingCurrent?.busy === true}
							onSeeded={() => {}}
							onSendAccepted={() => void acted("conversations")}
							onRollingAccepted={(id, _rolled, messageId) => {
								if (id === rollingId) return;
								setRollingViewing(null);
								setRollingRouted(id);
								setRollingFollow({ conversationId: id, messageId });
							}}
							followAfter={
								rollingFollow?.conversationId === rollingId
									? rollingFollow.messageId
									: undefined
							}
							onFollowStarted={() =>
								setRollingFollow((current) =>
									current?.conversationId === rollingId ? null : current,
								)
							}
							header={
								<>
									{moveError !== null && (
										<p className="error" role="alert">
											{moveError}
										</p>
									)}
									<div className="rolling-history-bar">
										{rollingViewing !== null && (
										<>
											<span>Earlier conversation</span>
											<button
												type="button"
												onClick={() => {
													setRollingViewing(null);
													setRollingRouted(null);
												}}
											>
												Back to latest
											</button>
										</>
									)}
									{(() => {
										const index = rollingChain.findIndex((roll) => roll.id === rollingId);
										const previous = index >= 0 ? rollingChain[index + 1] : undefined;
										return previous ? (
											<>
												<span>— new conversation —</span>
												<button
													type="button"
													onClick={() => {
														setRollingRouted(null);
														setRollingViewing(previous.id);
													}}
												>
													↑ Previous conversation
												</button>
											</>
										) : null;
									})()}
									</div>
								</>
							}
						/>
					))}
			</main>
			{!phone && (page === "chat" || page === "rolling") && panelOpen && (
				<aside className="goblin-column" aria-label="Little Goblin">
					<GoblinPanel
						variant="column"
						data={goblin}
						conversations={[...all, ...rollingChain]}
						openConversationId={railCurrent ?? openRoll}
						rollingConversationIds={rollingChain.map((conversation) => conversation.id)}
						notes={notes}
						notesError={notesError}
						onOpenTarget={openAttentionTarget}
						onOpenConversation={openConversation}
						onOpenPage={openPage}
						onOpenNote={openNote}
						onOpenProfile={() => openPage("status")}
					/>
				</aside>
			)}
			{phone && goblinSheetOpen && (
				<Drawer
					open={goblinSheetOpen}
					onOpenChange={setGoblinSheetOpen}
					modal
					side="bottom"
				>
					<DrawerBackdrop className="row-sheet-backdrop" />
					<DrawerContent className="goblin-sheet">
						<DrawerTitle className="goblin-sheet-title">Little Goblin</DrawerTitle>
						<GoblinPanel
							variant="sheet"
							data={goblin}
							conversations={[...all, ...rollingChain]}
							openConversationId={railCurrent ?? openRoll}
							rollingConversationIds={rollingChain.map((conversation) => conversation.id)}
							notes={notes}
							notesError={notesError}
							onOpenTarget={(target) => {
								setGoblinSheetOpen(false);
								openAttentionTarget(target);
							}}
							onOpenConversation={(id) => {
								setGoblinSheetOpen(false);
								openConversation(id);
							}}
							onOpenPage={(target) => {
								setGoblinSheetOpen(false);
								void openPage(target);
							}}
							onOpenNote={(id) => {
								setGoblinSheetOpen(false);
								void openNote(id);
							}}
							onOpenProfile={() => {
								setGoblinSheetOpen(false);
								void openPage("status");
							}}
						/>
					</DrawerContent>
				</Drawer>
			)}
			{page === "chat" && sourcesOpen && current !== null && (
				<ThreadSourcesSheet
					token={token}
					conversationId={current}
					title={currentTitle}
					onClose={() => setSourcesOpen(false)}
				/>
			)}
			{undoToast.view}
			{confirm.view}
			{createProjectOpen && (
				<NewProjectDialog
					token={token}
					onClose={() => {
						setCreateProjectOpen(false);
						setCreateProjectMoveFor(null);
						setCreateProjectMoveOrigin("chat");
					}}
					onCreated={(p) => {
						setCreateProjectOpen(false);
						const moveFor = createProjectMoveFor;
						const moveOrigin = createProjectMoveOrigin;
						setCreateProjectMoveFor(null);
						if (moveFor !== null) {
							void acted("projects");
							void moveChatToProject(moveFor, p.id, moveOrigin);
						} else {
							void acted("projects");
							void openProject(p.id);
						}
					}}
				/>
			)}
		</div>
	);
}
