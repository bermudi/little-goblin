import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { telegramDoor } from "./api.ts";
import { installTelegramFallback } from "./telegram.ts";
import "./styles.css";

// Telegram's SDK is never fetched: /t/ shares the PWA's origin — the
// app token sits in this origin's localStorage — so no third-party
// script, fetched or pinned, runs here. Webviews that inject
// window.Telegram use their own copy; Telegram Desktop doesn't inject,
// so the telegram door installs a local stand-in reading initData from
// the URL hash — the transport every client delivers. A plain browser
// keeps initData empty and the door shows its notice — visible, not
// broken.
async function boot(): Promise<void> {
	// Synchronous, before first render: the door reads initData in a
	// useState initializer.
	if (telegramDoor()) installTelegramFallback();
	const root = document.getElementById("root");
	if (root === null) throw new Error("no #root");
	createRoot(root).render(<App />);

	// Installability only — the worker caches nothing (see public/sw.js).
	// The PWA registers it; the telegram door never does — its pages sit
	// outside the /app/ scope, so the registration could only fail.
	if (!telegramDoor() && "serviceWorker" in navigator) {
		void navigator.serviceWorker.register("/app/sw.js", { scope: "/app/" });
	}
}

void boot();
