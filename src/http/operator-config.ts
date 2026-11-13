import { createHash } from "node:crypto";
import { z } from "zod";
import { modelCatalogFor } from "../agent/models-dev.ts";
import { clampThinkingFor } from "../agent/thinking.ts";
import {
	authDefaults,
	type CapabilityName,
	type Config,
	ConfigValidationError,
	capabilityNames,
	type DelegationConfig,
	fetchKinds,
	loadConfig,
	parseConfig,
	providerKinds,
	type SubagentsConfig,
	searchKinds,
	thinkingLevels,
	transcriptionDefaults,
	transcriptionKinds,
	ttsCloudDefaults,
	writeConfig,
} from "../config.ts";
import { log } from "../log.ts";
import { capabilityDefaults, capabilityHints, providerPresets, serviceNames } from "../services.ts";
import type { OperatorRequest } from "./operator-deps.ts";
import { fail, json, methodNotAllowed, NO_STORE, readBody } from "./operator-http.ts";
import type {
	CapabilityState,
	ConfigPostBody,
	ConfigResponse,
	SecretStoreResponse,
	SubagentsWire,
} from "./operator-wire.ts";

// Settings: the config door, ChatGPT sign-in and auth records.
export async function configRoute(r: OperatorRequest): Promise<Response | null> {
	const { deps, actor, who, req, tail } = r;

	if (tail === "config") {
		if (req.method === "GET") {
			const config = loadConfig() ?? deps.configRef.current;
			const body: ConfigResponse = {
				config,
				providerKinds,
				searchKinds,
				fetchKinds,
				transcriptionKinds,
				transcriptionDefaults,
				ttsDefaults: ttsCloudDefaults,
				authDefaults,
				authNames: [...(deps.authNames?.() ?? [])].sort(),
				authCommandNames: (deps.authNames?.() ?? [])
					.filter((n) => deps.secrets?.isCommand(n) ?? false)
					.sort(),
				// Cached only: the settings door never waits on models.dev.
				modelCatalog: modelCatalogFor(config),
				capabilities: capabilityStates(config),
				subagents: subagentsWire(config),
				serviceNames,
				providerPresets,
			};
			return Response.json(body, {
				headers: { ...NO_STORE, etag: configTag(config) },
			});
		}
		if (req.method === "POST") {
			let body: unknown;
			try {
				body = await req.json();
			} catch {
				return fail("bad json", 400);
			}
			if (typeof body !== "object" || body === null || Array.isArray(body)) {
				return fail("expected a json object", 400);
			}
			const unknownKeys = unknownConfigKeys(body);
			if (unknownKeys.length > 0) {
				log.warn(`${actor.via} config save refused — unknown keys`, {
					...who,
					keys: unknownKeys,
				});
				return fail(`unknown config keys: ${unknownKeys.join(", ")}`, 400);
			}
			const attempt = configSaveQueue.then(() => saveConfig(r, body));
			configSaveQueue = attempt.catch((err: unknown) => {
				log.error("config save queue attempt failed", err, who);
			});
			return attempt;
		}
		return methodNotAllowed();
	}

	if (
		tail === "accounts/chatgpt" ||
		tail === "accounts/chatgpt/login" ||
		tail === "accounts/chatgpt/logout"
	) {
		const chatgpt = deps.chatgpt;
		if (chatgpt === undefined) return fail("chatgpt sign-in is not wired", 503);
		if (tail === "accounts/chatgpt") {
			if (req.method !== "GET") return methodNotAllowed();
			return json(chatgpt.status());
		}
		if (tail === "accounts/chatgpt/login") {
			if (req.method === "DELETE") return json(chatgpt.cancel());
			if (req.method !== "POST") return methodNotAllowed();
			if (chatgpt.status().pinned) {
				return fail(
					"a codex provider pins authFile in goblin.json5 — remove it to sign in from Settings",
					409,
				);
			}
			return json(await chatgpt.start());
		}
		if (req.method !== "POST") return methodNotAllowed();
		return json(chatgpt.signOut());
	}

	if (tail === "secrets") {
		if (req.method !== "POST") return methodNotAllowed();
		const secrets = deps.secrets;
		if (secrets === undefined) return fail("the auth store is not wired", 503);
		const parsed = await readBody(req, secretPostBody);
		if (parsed instanceof Response) return parsed;
		const { name, value } = parsed;
		if (value.startsWith("!")) {
			return fail(
				'values starting with "!" resolve as shell commands — command records stay hand-edited',
				422,
			);
		}
		if (secrets.isCommand(name)) {
			return fail(
				`"${name}" resolves through a command record — it stays hand-managed; pick another name`,
				409,
			);
		}
		const replaced = secrets.has(name);
		try {
			secrets.store(name, value);
		} catch (err) {
			log.error(`${actor.via} secret store failed`, err, { ...who, name });
			return fail("the secret could not be written — check the service log", 500);
		}
		log.info(`auth record stored via ${actor.via}`, { ...who, name, replaced });
		const stored: SecretStoreResponse = { ok: true, name, replaced };
		return json(stored);
	}

	return null;
}

// Values never log; errors name the record only.
const secretPostBody = z
	.object({
		name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
		value: z.string().trim().min(1).max(4096),
	})
	.strict();

function configTag(config: Config): string {
	return `"${createHash("sha256").update(JSON.stringify(config)).digest("hex")}"`;
}

let configSaveQueue: Promise<unknown> = Promise.resolve();

const CONFIG_POST_KEYS = {
	providers: true,
	model: true,
	titleModel: true,
	favorites: true,
	pickerModels: true,
	customModels: true,
	modelFallbacks: true,
	thinking: true,
	tts: true,
	transcription: true,
	vision: true,
	image: true,
	search: true,
	fetch: true,
	operators: true,
	allowedUsers: true,
	delegation: true,
	subagents: true,
	telegram: true,
	publicUrl: true,
	http: true,
	memory: true,
	logLevel: true,
	capabilities: true,
} as const satisfies Record<keyof ConfigPostBody, true>;

const CONFIG_POST_TELEGRAM_KEYS = {
	enabled: true,
	apiRoot: true,
	dmGapMinutes: true,
	model: true,
	thinking: true,
	richReplies: true,
	showReasoning: true,
} as const satisfies Record<keyof ConfigPostBody["telegram"], true>;

const capabilitiesPostSchema = z.partialRecord(z.enum(capabilityNames), z.boolean());

const configPostBodySchema = z
	.object(
		Object.fromEntries(
			(Object.keys(CONFIG_POST_KEYS) as (keyof ConfigPostBody)[]).map((k) => [
				k,
				k === "capabilities"
					? capabilitiesPostSchema.optional()
					: k === "telegram"
						? z
								.object(
									Object.fromEntries(
										(
											Object.keys(CONFIG_POST_TELEGRAM_KEYS) as (keyof ConfigPostBody["telegram"])[]
										).map((tk) => [tk, z.unknown().optional()]),
									),
								)
								.strict()
								.optional()
						: z.unknown().optional(),
			]),
		),
	)
	.strict();

// The subagents wire arm — the settings editor's face of the block. The
// config schema stays the gate for urls and thinking rungs; this only
// pins the shape the merge reads.
const subagentModelPostSchema = z
	.object({
		auth: z.string().min(1),
		id: z.string().min(1),
		baseUrl: z.url(),
		thinking: z.enum(thinkingLevels),
	})
	.strict();
const subagentsPostSchema = z
	.object({
		worker: subagentModelPostSchema.nullable(),
		computer: subagentModelPostSchema.nullable(),
		desktopImage: z.string().min(1),
	})
	.strict();

// Active block, else the parked one — a parked block still prefills the
// editor and its restoration stash.
function subagentsWire(config: Config): SubagentsWire | null {
	const s = config.subagents ?? config.parked?.subagents;
	if (s === undefined) return null;
	const arm = (t: SubagentsConfig["worker"]): SubagentsWire["worker"] =>
		t === undefined
			? null
			: {
					auth: t.model.auth,
					id: t.model.id,
					baseUrl: t.model.baseUrl,
					thinking: t.model.thinking,
				};
	return {
		worker: arm(s.worker),
		computer: arm(s.computer),
		desktopImage: s.desktops.image,
	};
}

function capabilityState(config: Config, k: CapabilityName): CapabilityState {
	if (config[k] !== undefined) return { state: "on", hint: null };
	if (config.parked?.[k] !== undefined || capabilityDefaults[k] !== undefined)
		return { state: "off", hint: null };
	return { state: "needs-setup", hint: capabilityHints[k] };
}

function capabilityStates(config: Config): Record<CapabilityName, CapabilityState> {
	return Object.fromEntries(capabilityNames.map((k) => [k, capabilityState(config, k)])) as Record<
		CapabilityName,
		CapabilityState
	>;
}

function unknownConfigKeys(body: object): string[] {
	const parsed = configPostBodySchema.safeParse(body);
	if (parsed.success) return [];
	const unknown: string[] = [];
	for (const issue of parsed.error.issues) {
		if (issue.code !== "unrecognized_keys" || !("keys" in issue)) continue;
		const prefix = issue.path.length > 0 ? `${issue.path.join(".")}.` : "";
		for (const k of issue.keys) unknown.push(`${prefix}${k}`);
	}
	return unknown;
}

const isCapability = (k: string): k is CapabilityName =>
	(capabilityNames as readonly string[]).includes(k);

async function saveConfig(
	{ deps, actor, who, req }: OperatorRequest,
	body: object,
): Promise<Response> {
	let wrote = false;
	try {
		const base = loadConfig() ?? deps.configRef.current;
		const expected = req.headers.get("if-match");
		if (!expected) {
			log.warn(`${actor.via} config save refused — missing version`, who);
			return fail("load settings before saving", 428);
		}
		if (expected !== configTag(base)) {
			log.warn(`${actor.via} config save refused — stale version`, who);
			return fail("settings changed since this page loaded — reopen settings before saving", 409);
		}
		const normalized = parseConfig(base);
		// Capability flips apply to the normalized disk config BEFORE the
		// body merge — a body block for the same key then still wins.
		const parked: Partial<Record<CapabilityName, unknown>> = {
			...(normalized.parked ?? {}),
		};
		const candidate: Record<string, unknown> = { ...normalized };
		const caps = capabilitiesPostSchema.parse(
			(body as { capabilities?: unknown }).capabilities ?? {},
		);
		for (const [k, on] of Object.entries(caps) as [CapabilityName, boolean][]) {
			if (!on) {
				if (candidate[k] !== undefined) {
					parked[k] = candidate[k];
					delete candidate[k];
				}
				continue;
			}
			if (candidate[k] !== undefined) continue;
			// First-time setup may arrive with the enable switch. The body
			// merge below wins over parked/default blocks; validate that
			// supplied value with the WHOLE resulting config before writing
			// (it may also introduce the model's provider).
			const supplied = (body as Record<string, unknown>)[k];
			if (supplied !== undefined && supplied !== "") continue;
			if (parked[k] !== undefined) {
				candidate[k] = parked[k];
				delete parked[k];
				continue;
			}
			const dflt = capabilityDefaults[k];
			if (dflt !== undefined) {
				candidate[k] = dflt;
				continue;
			}
			log.warn(`${actor.via} config save refused — capability needs setup`, {
				...who,
				capability: k,
			});
			return fail(`cannot enable ${k}: ${capabilityHints[k]}`, 422);
		}
		for (const [k, v] of Object.entries(body)) {
			if (k === "capabilities") continue;
			const isBlock = typeof v === "object" && v !== null && !Array.isArray(v);
			if (k === "telegram" && isBlock) {
				candidate.telegram = { ...normalized.telegram, ...v };
				continue;
			}
			// Machine targets are host-bound and file-only — the settings
			// editor sends harnesses/defaults, and this merge keeps the
			// file's own copy: the active block's, else the parked one a
			// re-enable leaves behind.
			if (k === "delegation" && isBlock) {
				const machines =
					normalized.delegation?.machines ??
					(parked.delegation as DelegationConfig | undefined)?.machines;
				candidate.delegation = {
					...(machines === undefined ? {} : { machines }),
					...v,
				};
				// An edited block supersedes a parked copy — leaving it
				// would resurrect the old value on the next off/on flip.
				delete parked.delegation;
				continue;
			}
			// maxRuns and the desktop pool limits are file-only — the
			// editor sends models and the image; this merge keeps the
			// file's own tuning: the active block's, else the parked one.
			if (k === "subagents" && isBlock) {
				const w = subagentsPostSchema.parse(v);
				if (w.worker === null && w.computer === null) {
					log.warn(`${actor.via} config save refused — subagents with no model type`, who);
					return fail("pick a model for the worker or computer use", 422);
				}
				const prev = normalized.subagents ?? (parked.subagents as SubagentsConfig | undefined);
				const model = (m: NonNullable<(typeof w)["worker"]>) => ({
					model: { ...m, api: "openai-completions" as const },
				});
				candidate.subagents = {
					...(prev === undefined ? {} : { maxRuns: prev.maxRuns }),
					...(w.worker === null ? {} : { worker: model(w.worker) }),
					...(w.computer === null ? {} : { computer: model(w.computer) }),
					desktops:
						prev === undefined
							? { image: w.desktopImage }
							: { ...prev.desktops, image: w.desktopImage },
				};
				// Like delegation: an edited block supersedes a parked copy.
				delete parked.subagents;
				continue;
			}
			// "" on a parkable block keeps its contents — off, not deleted.
			if (v === "" && isCapability(k)) {
				if (candidate[k] !== undefined) parked[k] = candidate[k];
				delete candidate[k];
				continue;
			}
			candidate[k] = v;
			if (isCapability(k)) delete parked[k];
		}
		candidate.parked = Object.keys(parked).length > 0 ? parked : undefined;
		const merged = parseConfig(candidate);
		// A stored level the model can't express is a lie — write the
		// rung the wire clamp would land on, on both channels.
		merged.thinking = clampThinkingFor(merged.providers, merged.model, merged.thinking);
		// A disabled channel's saved pin is dormant state — leave model and
		// thinking untouched until it is re-enabled.
		if (merged.telegram.enabled) {
			merged.telegram.thinking = clampThinkingFor(
				merged.providers,
				merged.telegram.model ?? merged.model,
				merged.telegram.thinking ?? merged.thinking,
			);
		}
		if (actor.via === "mini-app" && !merged.operators.includes(actor.userId)) {
			return fail(`config would remove your own telegram user id (${actor.userId})`, 422);
		}
		deps.beforeConfigWritten?.(normalized, merged);
		writeConfig(merged);
		wrote = true;
		const fresh = loadConfig();
		if (fresh) deps.configRef.current = fresh;
		deps.onConfigWritten();
		log.info(`config written via ${actor.via}`, {
			...who,
			appModel: merged.model,
			appThinking: merged.thinking,
			telegramModel: merged.telegram.model,
			telegramThinking: merged.telegram.thinking,
		});
		return Response.json(
			{ ok: true },
			{ headers: { ...NO_STORE, etag: configTag(fresh ?? merged) } },
		);
	} catch (err) {
		if (err instanceof ConfigValidationError) return fail(err.message, 422);
		if (err instanceof z.ZodError) return fail(z.prettifyError(err), 422);
		log.error(`${actor.via} config save failed`, err, { ...who, wrote });
		return fail(
			wrote
				? "settings were saved but could not be applied — check the service log"
				: "settings could not be written — check the service log",
			500,
		);
	}
}
