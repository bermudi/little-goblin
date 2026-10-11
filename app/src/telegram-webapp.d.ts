// Minimal ambient types for telegram-web-app.js — the script telegram.org
// serves to the mini app's webview (the built client's index.html
// includes it directly). Only the surface the client uses; widen here
// when the door grows rather than casting at call sites. Methods are
// optional because the SDK version varies by client — callers
// feature-detect every call.
//
// CLIENT PROGRAM ONLY (tsconfig.client.json includes it by path;
// tsconfig.json excludes it): declaring `Window` here would give
// linkedom's `parseHTML(): Window & typeof globalThis` a real meaning in
// the server program, where no DOM lib exists and the property `document`
// would stop resolving.

interface TelegramWebApp {
	initData: string;
	initDataUnsafe: { user?: { id?: number } };
	expand?(): void;
	ready?(): void;
	setHeaderColor?(color: string): void;
	setBackgroundColor?(color: string): void;
	showConfirm?(message: string, callback: (ok: boolean) => void): void;
	enableClosingConfirmation?(): void;
	disableClosingConfirmation?(): void;
	HapticFeedback?: {
		selectionChanged(): void;
		notificationOccurred(type: "error" | "success" | "warning" | "impact"): void;
	};
	BackButton?: {
		show(): void;
		hide(): void;
		onClick(callback: () => void): void;
	};
}

declare global {
	interface Window {
		Telegram?: { WebApp: TelegramWebApp };
	}
}

export {};
