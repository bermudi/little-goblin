import { z } from "zod";
import { clampThinkingFor } from "../agent/thinking.ts";
import {
	ConfigValidationError,
	loadConfig,
	parseConfig,
	splitModelRef,
	writeConfig,
} from "../config.ts";
import { prepareAppSettingsForConfig } from "../conversation.ts";
import { log } from "../log.ts";
import {
	type AppChannelDeps,
	configPatchBody,
	configView,
	jsonBodyRefusal,
	NO_STORE,
} from "./app-shared.ts";

const favoriteToggleBody = z
	.object({
		ref: z.string().min(1),
		on: z.boolean(),
	})
	.strict();

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
				// A stored level the model can't express is a lie — write the
				// rung the wire clamp would land on, on both channels.
				merged.thinking = clampThinkingFor(
					merged.providers,
					merged.model,
					parsed.data.thinking ?? base.thinking,
				);
				// A disabled channel's saved pin is dormant state — leave
				// model and thinking untouched until it is re-enabled.
				if (merged.telegram.enabled) {
					merged.telegram.thinking = clampThinkingFor(
						merged.providers,
						merged.telegram.model ?? merged.model,
						merged.telegram.thinking ?? merged.thinking,
					);
				}
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

	// One favorite at a time — the composer's star and the picker's.
	// Deliberately not on configPatchBody: the per-conversation config
	// route shares that schema, and favorites are global.
	if (path === "/api/app/favorites") {
		if (req.method !== "POST") {
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		}
		const refusedJson = jsonBodyRefusal(req);
		if (refusedJson !== null) return refusedJson;
		let json: unknown;
		try {
			json = await req.json();
		} catch {
			return Response.json({ error: "bad json" }, { status: 400, headers: NO_STORE });
		}
		const parsed = favoriteToggleBody.safeParse(json);
		if (!parsed.success) {
			return Response.json(
				{ error: z.prettifyError(parsed.error) },
				{ status: 422, headers: NO_STORE },
			);
		}
		const { ref, on } = parsed.data;
		// Adding names a real model — a typo'd ref or a provider that
		// isn't configured would favorite a dead entry. Removing accepts
		// anything, so a stale or malformed entry can always leave.
		let provider = "";
		if (on) {
			try {
				provider = splitModelRef(ref).provider;
			} catch {
				return Response.json(
					{ error: `invalid model ref "${ref}" — expected "<provider>/<model-id>"` },
					{ status: 422, headers: NO_STORE },
				);
			}
		}
		try {
			const base = loadConfig() ?? parseConfig(deps.configRef.current);
			if (on && base.providers[provider] === undefined) {
				return Response.json(
					{ error: `unknown provider "${provider}" — configure it in Settings first` },
					{ status: 422, headers: NO_STORE },
				);
			}
			const favorites = on
				? base.favorites.includes(ref)
					? base.favorites
					: [...base.favorites, ref]
				: base.favorites.filter((f) => f !== ref);
			const merged = parseConfig({ ...base, favorites });
			writeConfig(merged);
			const fresh = loadConfig();
			if (fresh !== null) deps.configRef.current = fresh;
			deps.onConfigWritten();
			log.info("favorite toggled", { ref, on, count: merged.favorites.length });
			return Response.json({ favorites: merged.favorites }, { headers: NO_STORE });
		} catch (err) {
			if (err instanceof ConfigValidationError) {
				return Response.json({ error: err.message }, { status: 422, headers: NO_STORE });
			}
			if (err instanceof z.ZodError) {
				return Response.json({ error: z.prettifyError(err) }, { status: 422, headers: NO_STORE });
			}
			log.error("app favorites write failed", err);
			return Response.json({ error: "favorites write failed" }, { status: 500, headers: NO_STORE });
		}
	}

	return null;
}
