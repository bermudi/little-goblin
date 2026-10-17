import { z } from "zod";
import { prepareAppSettingsForConfig, type ModelSettings } from "../conversation.ts";
import { thinkingLevelsFor } from "../agent/providers.ts";
import {
	loadConfig,
	parseConfig,
	ConfigValidationError,
	splitModelRef,
	thinkingLevels,
	writeConfig,
	type Config,
} from "../config.ts";
import { log } from "../log.ts";
import type { AppConfigView } from "./app-wire.ts";

import { NO_STORE } from "./app-shared.ts";
import { jsonBodyRefusal } from "./app-auth.ts";

import type { AppChannelDeps } from "./app-channel.ts";
import { conversationFromSegment } from "./app-shared.ts";

// The composer's two knobs. A patch with neither is a client bug —
// refuse rather than write a no-op through the file.
const configPatchBody = z
	.object({
		model: z.string().min(1).optional(),
		thinking: z.enum(thinkingLevels).optional(),
	})
	.refine((p) => p.model !== undefined || p.thinking !== undefined, {
		message: "nothing to write",
	});

// The composer's readout: the live model ref and thinking rung, the
// favorites list to switch between, and the rungs the active model can
// actually express (thinkingLevelsFor — same table the mini app reads).
function configView(cfg: Config, settings: ModelSettings = cfg): AppConfigView {
	const { provider, modelId } = splitModelRef(settings.model);
	const p = cfg.providers[provider];
	return {
		model: settings.model,
		thinking: settings.thinking,
		favorites: cfg.favorites,
		thinkingLevels:
			p === undefined
				? [...thinkingLevels]
				: [...thinkingLevelsFor(p.kind, modelId, "baseUrl" in p ? p.baseUrl : undefined)],
	};
}

export async function handleAppConfigRoute(
	req: Request,
	url: URL,
	deps: AppChannelDeps,
): Promise<Response | null> {
	const path = url.pathname;
	const { store } = deps;
	// Per-conversation settings live in SQLite, not goblin.json5. A
	// patch does not bump the epoch or interrupt the admitted turn.
	const configMatch = path.match(/^\/api\/app\/conversations\/([^/]+)\/config$/);
	if (configMatch) {
		const convId = conversationFromSegment(configMatch[1]!);
		if (convId instanceof Response) return convId;
		if (store.get(convId.id) === null) {
			return Response.json({ error: "no such conversation" }, { status: 404, headers: NO_STORE });
		}
		if (req.method !== "GET" && req.method !== "PATCH") {
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		}
		if (req.method === "PATCH") {
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
			// Body reads yield: recheck the row and live registry now.
			if (store.get(convId.id) === null) {
				return Response.json({ error: "no such conversation" }, { status: 404, headers: NO_STORE });
			}
			const cfg = deps.configRef.current;
			try {
				// Same provider-ref validation as global config; validate
				// before initialization so a bad patch writes nothing.
				parseConfig({ ...cfg, ...parsed.data });
			} catch (err) {
				if (err instanceof ConfigValidationError) {
					return Response.json({ error: err.message }, { status: 422, headers: NO_STORE });
				}
				if (!(err instanceof z.ZodError)) throw err;
				return Response.json({ error: z.prettifyError(err) }, { status: 422, headers: NO_STORE });
			}
			store.initializeAppSettings(convId.id, cfg);
			store.setMeta(convId.id, {
				...(parsed.data.model !== undefined ? { model: parsed.data.model } : {}),
				...(parsed.data.thinking !== undefined ? { thinking: parsed.data.thinking } : {}),
			});
			log.info("app conversation settings changed", {
				conversation: convId.id,
				...parsed.data,
				applies: "next turn",
			});
		}
		const cfg = deps.configRef.current;
		const settings = store.initializeAppSettings(convId.id, cfg);
		return Response.json(configView(cfg, settings), { headers: NO_STORE });
	}

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
