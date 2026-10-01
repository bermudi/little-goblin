import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) throw new Error("no #root");
createRoot(root).render(<App />);

// Installability only — the worker caches nothing (see public/sw.js).
if ("serviceWorker" in navigator) {
	void navigator.serviceWorker.register("/app/sw.js", { scope: "/app/" });
}
