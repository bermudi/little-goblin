import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { telegramDoor } from "./api.ts";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) throw new Error("no #root");
createRoot(root).render(<App />);

// Installability only — the worker caches nothing (see public/sw.js).
// The PWA registers it; the telegram door never does — its pages sit
// outside the /app/ scope, so the registration could only fail.
if (!telegramDoor() && "serviceWorker" in navigator) {
	void navigator.serviceWorker.register("/app/sw.js", { scope: "/app/" });
}
