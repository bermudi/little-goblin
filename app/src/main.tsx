import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { telegramDoor } from "./api.ts";
import "./styles.css";

// Telegram's SDK is never fetched: /t/ shares the PWA's origin — the
// app token sits in this origin's localStorage — so a live third-party
// script on either door rides the credential the other holds. Telegram's
// own webviews inject window.Telegram before page scripts run; a client
// that does not leaves initData empty and the door shows its notice —
// visible, not broken.
async function boot(): Promise<void> {
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
