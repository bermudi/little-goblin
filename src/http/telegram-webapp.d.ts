// Minimal ambient types for telegram-web-app.js — the script telegram.org
// serves to the settings page's webview. Only the surface app.js uses;
// widen here when the page grows rather than casting at call sites.
// Methods are optional because the SDK version varies by client — app.js
// feature-detects every call.
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
