import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Served by the goblin process under /app/ — base keeps asset URLs
// relative to that mount. `bun run app:dev` runs the dev server: HMR
// for the client, /api proxied to the local goblin http listener
// (config http.port); GOBLIN_HTTP overrides the target.
export default defineConfig({
	base: "/app/",
	plugins: [react()],
	build: { outDir: "dist", emptyOutDir: true },
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
					proxy.on("proxyReq", (proxyReq) => {
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
