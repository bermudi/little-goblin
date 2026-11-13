import { useCallback, useEffect, useRef, useState } from "react";
import { type ChatWidth, loadChatWidth } from "./chatWidth.ts";
import { useConfirm } from "./confirm.tsx";
import { MemoryView } from "./MemoryView.tsx";
import { type Page, PAGES, pageFromPath } from "./routing.ts";
import { SettingsView } from "./SettingsView.tsx";

// The Telegram mini app door: the deep-linked page renders settings or
// memories over initData — the app channel's gate, rail, and
// conversations never mount here. In-door switching is component state
// with no history entries, so the webview's back gesture closes the mini
// app natively.
const TELEGRAM_PAGES = PAGES.filter((p) => p.key === "settings" || p.key === "memory");

export function TelegramDoor() {
	const [page, setPage] = useState<Page>(() => {
		const p = pageFromPath(window.location.pathname);
		return p !== null && TELEGRAM_PAGES.some((t) => t.key === p) ? p : "settings";
	});
	const [navOpen, setNavOpen] = useState(false);
	// The mini app honors the PWA's width preference read-only — no
	// selector here, but Telegram Desktop's viewport is desktop-wide.
	const [chatWidth] = useState<ChatWidth>(loadChatWidth);
	const settingsDirty = useRef(false);
	const confirm = useConfirm();
	// Empty initData = not opened by Telegram — every request would 401,
	// so say so rather than render a form that cannot save.
	// window.Telegram is settled before first render — injected by the
	// webview, or the local fallback installed in main.tsx.
	const [authed] = useState(() => (window.Telegram?.WebApp.initData ?? "") !== "");
	// Mirrors the draft bit onto the webview's native close guard — the
	// in-door confirm and the SDK confirmation protect the same draft;
	// the editor reports its state on every mount, so re-arming is
	// pointless. Both SDK methods are optional in older clients.
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
	const openPage = async (p: Exclude<Page, "chat">) => {
		if (p === page) return;
		if (
			page === "settings" &&
			settingsDirty.current &&
			!(await confirm.ask({
				message: "Discard unsaved settings changes?",
				confirmLabel: "Discard",
				danger: true,
			}))
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
								void openPage(p.key);
								setNavOpen(false);
							}}
						>
							{p.label}
						</button>
					))}
				</div>
			</nav>
			<div className={navOpen ? "scrim open" : "scrim"} onClick={() => setNavOpen(false)} />
			<main className={chatWidth === "wide" ? "chat-wide" : undefined}>
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
			{confirm.view}
		</div>
	);
}
