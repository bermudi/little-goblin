// Minimal ambient types for the Telegram WebApp surface — the native
// object the client webview injects, or app/src/telegram.ts's local
// stand-in when it doesn't (Telegram Desktop). Only the surface the
// client uses; widen here when the door grows rather than casting at
// call sites. Methods are optional because the SDK version varies by
// client — callers feature-detect every call.
//
// APP PROGRAM ONLY (it lives under app/src, which the server's
// tsconfig never includes): declaring `Window` here would give
// linkedom's `parseHTML(): Window & typeof globalThis` a real meaning in
// the server program, where no DOM lib exists and the property `document`
// would stop resolving. Keep it out of src/.

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
		// Telegram Desktop's Qt bridge — the first postEvent target in
		// the official script's dispatch order.
		TelegramWebviewProxy?: { postEvent(eventType: string, eventData: string): void };
	}
}

export {};
