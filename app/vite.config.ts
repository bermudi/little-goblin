import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Served by the goblin process under /app/ — base keeps asset URLs
// relative to that mount. `bun run app:dev` runs the dev server: HMR
// for the client, /api proxied to the local goblin http listener
// (config http.port); GOBLIN_HTTP overrides the target.
export default defineConfig({
	base: "/app/",
	plugins: [react()],
	// Builds only stage: publish is the atomic dist-symlink swap in
	// scripts/publish-app.sh, so a build alone never changes what is served.
	build: { outDir: "dist.next", emptyOutDir: true },
	server: {
		proxy: {
			"/api": {
				target: process.env.GOBLIN_HTTP ?? "http://127.0.0.1:8787",
				// Trust mode's browser-origin gate refuses mutations whose
				// Origin isn't the configured publicUrl (design/app.md, the
				// #75 line) — a dev page's localhost origin can never match.
				// Stripping the browser markers makes the proxied request a
				// non-browser client, whose whole check is reachability.
				// Dev-only; bearer mode never reads these headers.
				configure: (proxy) => {
					proxy.on("proxyReq", (proxyReq, req) => {
						// Only the dev page's own requests get laundered —
						// its Origin names this dev server (host === the
						// request's Host). A cross-origin or `Origin: null`
						// request keeps its headers so the backend gate still
						// refuses it; stripping unconditionally would reopen
						// the no-cors CSRF hole the gate exists to close.
						const origin = req.headers.origin;
						const own =
							typeof origin === "string" &&
							URL.canParse(origin) &&
							new URL(origin).host === req.headers.host;
						if (origin !== undefined && !own) return;
						for (const header of [
							"origin",
							"sec-fetch-site",
							"sec-fetch-mode",
							"sec-fetch-dest",
							"sec-fetch-user",
						]) {
							proxyReq.removeHeader(header);
						}
					});
				},
			},
		},
	},
});
