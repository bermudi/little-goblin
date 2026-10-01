import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Served by the goblin process under /app/ — base keeps asset URLs
// relative to that mount. Dev server proxies the API to the local
// goblin http listener (config http.port).
export default defineConfig({
	base: "/app/",
	plugins: [react()],
	build: { outDir: "dist", emptyOutDir: true },
	server: {
		proxy: {
			"/api": process.env.GOBLIN_HTTP ?? "http://127.0.0.1:8787",
		},
	},
});
