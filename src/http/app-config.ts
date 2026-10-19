import { z } from "zod";
import { ConfigValidationError, loadConfig, parseConfig, writeConfig } from "../config.ts";
import { prepareAppSettingsForConfig } from "../conversation.ts";
import { log } from "../log.ts";
import {
	type AppChannelDeps,
	configPatchBody,
	configView,
	jsonBodyRefusal,
	NO_STORE,
} from "./app-shared.ts";

export async function handleConfigRoute(
	req: Request,
	url: URL,
	deps: AppChannelDeps,
): Promise<Response | null> {
	const path = url.pathname;
	const { store } = deps;

	if (path === "/api/app/config") {
		if (req.method === "GET") {
			return Response.json(configView(deps.configRef.current), { headers: NO_STORE });
		}
		if (req.method === "PATCH" || req.method === "POST") {
			const refusedJson = jsonBodyRefusal(req);
			if (refusedJson !== null) return refusedJson;
			let json: unknown;
			try {
				json = await req.json();
			} catch {
				return Response.json({ error: "bad json" }, { status: 400, headers: NO_STORE });
			}
			const parsed = configPatchBody.safeParse(json);
			if (!parsed.success) {
				return Response.json(
					{ error: z.prettifyError(parsed.error) },
					{ status: 422, headers: NO_STORE },
				);
			}
			try {
				const base = loadConfig() ?? parseConfig(deps.configRef.current);
				const merged = parseConfig({ ...base, ...parsed.data });
				prepareAppSettingsForConfig(store, base, merged);
				writeConfig(merged);
				const fresh = loadConfig();
				if (fresh !== null) deps.configRef.current = fresh;
				deps.onConfigWritten();
				log.info("config written via app channel", {
					model: parsed.data.model,
					thinking: parsed.data.thinking,
				});
				return Response.json(configView(fresh ?? merged), { headers: NO_STORE });
			} catch (err) {
				if (err instanceof ConfigValidationError) {
					return Response.json({ error: err.message }, { status: 422, headers: NO_STORE });
				}
				if (err instanceof z.ZodError) {
					return Response.json({ error: z.prettifyError(err) }, { status: 422, headers: NO_STORE });
				}
				log.error("app config write failed", err);
				return Response.json({ error: "config write failed" }, { status: 500, headers: NO_STORE });
			}
		}
		return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
	}

	return null;
}
