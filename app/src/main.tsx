import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { telegramDoor } from "./api.ts";
import "./styles.css";

// Telegram's SDK is fetched only on the mini-app door: on /app/ it would
// execute a third-party script in the origin that holds the bearer token
// (supply-chain surface for nothing — the PWA never reads it). Telegram's
// own webviews inject the object before page scripts run, so the fetched
// copy is a fallback for clients that don't; a failure or timeout leaves
// initData empty and the door shows its notice — visible, not broken.
async function boot(): Promise<void> {
	if (telegramDoor() && window.Telegram === undefined) {
		await new Promise<void>((resolve) => {
			const script = document.createElement("script");
			script.src = "https://telegram.org/js/telegram-web-app.js";
			script.onload = () => resolve();
			script.onerror = () => resolve();
			setTimeout(resolve, 1500);
			document.head.appendChild(script);
		});
	}
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
