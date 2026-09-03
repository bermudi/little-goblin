/**
 * Model registry.
 *
 * Model IDs are prefixed with their provider namespace:
 *   or/<slug>       → OpenRouter (chat completions)
 *   openai/<id>     → Direct OpenAI API
 *   anthropic/<id>  → Direct Anthropic API
 *
 * Each entry picks the best pi-ai `api` dialect for that model family:
 *   - Claude models  → "anthropic-messages" (Messages API, prompt caching)
 *   - GPT/o-series   → "openai-responses" (reasoning summaries)
 *   - Everything else → "openai-completions" (universal fallback)
 *
 * Extend by adding entries. The registry is explicit — no runtime synthesis.
 */
import { type Api, type Model, clampThinkingLevel, type ThinkingLevelMap } from "@earendil-works/pi-ai";
import { getBuiltinModel, getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Config } from "../config.ts";

/**
 * Resolve maxTokens for a model id from pi-ai's built-in registry.
 *
 * Strategy: exact match → strip date suffix → prefix match → fallback.
 * This keeps goblin's custom provider routing (openrouter, direct) while
 * inheriting correct output limits from the upstream model database.
 */
function resolveMaxTokens(modelId: string, fallback = 8_192): number {
  const providers = getBuiltinProviders();

  // Exact match across all providers
  for (const p of providers) {
    const m = getBuiltinModel(p, modelId as never) as Model<Api> | undefined;
    if (m) return m.maxTokens;
  }

  // Strip trailing date suffix (e.g. "-20251022") and retry
  const stripped = modelId.replace(/-\d{8}$/, "");
  if (stripped !== modelId) {
    for (const p of providers) {
      const m = getBuiltinModel(p, stripped as never) as Model<Api> | undefined;
      if (m) return m.maxTokens;
    }
  }

  // Longest-prefix match — catches versioned ids that don't appear verbatim.
  // Avoids ambiguity when e.g. "gpt-5" and "gpt-5-pro" both exist.
  let best: Model<Api> | null = null;
  for (const p of providers) {
    for (const m of getBuiltinModels(p)) {
      if (m.id.startsWith(stripped) || stripped.startsWith(m.id)) {
        if (!best || m.id.length > best.id.length) best = m;
      }
    }
  }
  return best?.maxTokens ?? fallback;
}

export type ApiKeyEnv =
  | "OPENROUTER_API_KEY"
  | "OPENAI_API_KEY"
  | "ANTHROPIC_API_KEY"
  | "ZAI_API_KEY"
  | "OPENCODE_API_KEY";

export interface ModelEntry {
  model: Model<Api>;
  apiKeyEnv: ApiKeyEnv;
  /** Default thinking level for this model. Falls back to "medium" when absent. */
  thinkingLevel?: ThinkingLevel;
}

// Provider endpoints
const OPENROUTER = "https://openrouter.ai/api/v1";
const OPENAI = "https://api.openai.com/v1";
const ANTHROPIC = "https://api.anthropic.com";

// Cost fields are placeholders — actual billing varies by provider
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

// --- OpenRouter ---

function openrouter(id: string, name: string, ctx = 200_000): ModelEntry {
  return {
    apiKeyEnv: "OPENROUTER_API_KEY",
    thinkingLevel: "medium",
    model: {
      id,
      name,
      api: "openai-completions",
      provider: "openrouter",
      baseUrl: OPENROUTER,
      reasoning: false,
      input: ["text", "image"] as ("text" | "image")[],
      cost: ZERO_COST,
      contextWindow: ctx,
      maxTokens: resolveMaxTokens(id),
    } satisfies Model<"openai-completions">,
  };
}

// --- Direct providers ---

function directOpenAI(id: string, name: string, ctx = 128_000): ModelEntry {
  return {
    apiKeyEnv: "OPENAI_API_KEY",
    thinkingLevel: "medium",
    model: {
      id,
      name,
      api: "openai-responses",
      provider: "openai",
      baseUrl: OPENAI,
      reasoning: true,
      input: ["text", "image"] as ("text" | "image")[],
      cost: ZERO_COST,
      contextWindow: ctx,
      maxTokens: resolveMaxTokens(id),
    } satisfies Model<"openai-responses">,
  };
}

function directAnthropic(id: string, name: string, ctx = 200_000): ModelEntry {
  return {
    apiKeyEnv: "ANTHROPIC_API_KEY",
    thinkingLevel: "high",
    model: {
      id,
      name,
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: ANTHROPIC,
      reasoning: true,
      input: ["text", "image"] as ("text" | "image")[],
      cost: ZERO_COST,
      contextWindow: ctx,
      maxTokens: resolveMaxTokens(id),
    } satisfies Model<"anthropic-messages">,
  };
}

// --- Z.AI Coding Plan ---

const ZAI_CODING = "https://api.z.ai/api/coding/paas/v4";

/**
 * Lookup a model in pi-ai's built-in `zai` provider registry.
 * Returns null when no match is found.
 */
function lookupZaiModel(id: string): Model<"openai-completions"> | null {
  try {
    const m = getBuiltinModel("zai", id as never) as Model<Api>;
    if (m?.api === "openai-completions") return m as Model<"openai-completions">;
  } catch { /* not found */ }
  return null;
}

function zaiCoding(id: string): ModelEntry {
  // Prefer pi-ai's built-in entry (correct compat flags, thinking format, etc.)
  const upstream = lookupZaiModel(id);
  if (upstream) {
    return {
      apiKeyEnv: "ZAI_API_KEY",
      thinkingLevel: "medium",
      model: upstream,
    };
  }
  // Fallback: construct manually. pi-ai's detectCompat auto-fills most zai
  // flags from provider="zai" / api.z.ai baseUrl (thinkingFormat, etc.), but
  // `zaiToolStream` defaults to false — every zai entry in pi-ai's registry
  // sets it true so tool-call deltas stream incrementally. Pin it here so
  // models not yet upstream (e.g. glm-5.2) match registered ones.
  return {
    apiKeyEnv: "ZAI_API_KEY",
    thinkingLevel: "medium",
    model: {
      id,
      name: `${id} (Z.AI)`,
      api: "openai-completions",
      provider: "zai",
      baseUrl: ZAI_CODING,
      compat: { supportsDeveloperRole: false, thinkingFormat: "zai", zaiToolStream: true },
      reasoning: true,
      input: ["text"] as "text"[],
      cost: ZERO_COST,
      contextWindow: 200_000,
      maxTokens: resolveMaxTokens(id),
    } satisfies Model<"openai-completions">,
  };
}

export const MODELS: Record<string, ModelEntry> = {
  // --- OpenRouter: always chat completions ---
  "or/anthropic/claude-sonnet-4.5": openrouter("anthropic/claude-sonnet-4.5", "Claude Sonnet 4.5 (OR)"),
  "or/openai/gpt-5": openrouter("openai/gpt-5", "GPT-5 (OR)"),

  // --- Direct OpenAI ---
  "openai/gpt-5.4": directOpenAI("gpt-5.4", "GPT-5.4 (OpenAI)"),
  "openai/gpt-5.4-mini": directOpenAI("gpt-5.4-mini", "GPT-5.4 mini (OpenAI)"),
  "openai/o4": directOpenAI("o4", "o4 (OpenAI)"),

  // --- Direct Anthropic ---
  "anthropic/claude-opus-4": directAnthropic("claude-opus-4-20251001", "Claude Opus 4 (Anthropic)"),
  "anthropic/claude-sonnet-4.6": directAnthropic("claude-sonnet-4-6-20251022", "Claude Sonnet 4.6 (Anthropic)"),
};

/**
 * Resolve thinkingLevelMap for a model id from pi-ai's built-in registry.
 * Returns undefined when no upstream entry is found (goblin's Model stays as-is).
 *
 * This is a cross-provider lookup — e.g. an or/ model finds its map from the
 * openai provider's entry. This works because thinkingLevelMap is a property of
 * the model family, not the provider. If two providers ever disagree on the map
 * for the same model id, the longest-prefix match wins (same as resolveMaxTokens).
 */
function resolveThinkingLevelMap(modelId: string): ThinkingLevelMap | undefined {
  const providers = getBuiltinProviders();

  for (const p of providers) {
    const m = getBuiltinModel(p, modelId as never) as Model<Api> | undefined;
    if (m?.thinkingLevelMap) return m.thinkingLevelMap;
  }

  const stripped = modelId.replace(/-\d{8}$/, "");
  if (stripped !== modelId) {
    for (const p of providers) {
      const m = getBuiltinModel(p, stripped as never) as Model<Api> | undefined;
      if (m?.thinkingLevelMap) return m.thinkingLevelMap;
    }
  }

  // Longest-prefix match — avoids ambiguity when e.g. "gpt-5" and "gpt-5-pro"
  // both exist with different maps.
  let best: Model<Api> | null = null;
  for (const p of providers) {
    for (const m of getBuiltinModels(p)) {
      if (m.id === stripped || m.id.startsWith(stripped) || stripped.startsWith(m.id)) {
        if (m.thinkingLevelMap && (!best || m.id.length > best.id.length)) best = m;
      }
    }
  }
  return best?.thinkingLevelMap ?? undefined;
}

export interface ResolvedModel {
  model: Model<Api>;
  apiKey: string;
  thinkingLevel: ThinkingLevel;
}

/** Dynamic fallback for `or/<slug>` — always OpenRouter chat completions. */
function openrouterPatternMatch(modelName: string): ModelEntry | null {
  if (!modelName.startsWith("or/")) return null;
  const id = modelName.slice("or/".length);
  if (!id) return null;
  return openrouter(id, `${id} (OR)`);
}

/** Dynamic fallback for `openai/<id>` — picks API dialect by model family. */
function directOpenAIPatternMatch(modelName: string): ModelEntry | null {
  if (!modelName.startsWith("openai/")) return null;
  const id = modelName.slice("openai/".length);
  if (!id) return null;
  // o-series and gpt get responses API; everything else falls to completions
  const fam = id.toLowerCase();
  if (fam.startsWith("gpt-") || /^o\d/.test(fam)) return directOpenAI(id, `${id} (OpenAI)`);
  return {
    apiKeyEnv: "OPENAI_API_KEY",
    model: {
      id,
      name: `${id} (OpenAI)`,
      api: "openai-completions",
      provider: "openai",
      baseUrl: OPENAI,
      reasoning: false,
      input: ["text", "image"] as ("text" | "image")[],
      cost: ZERO_COST,
      contextWindow: 128_000,
      maxTokens: resolveMaxTokens(id),
    } satisfies Model<"openai-completions">,
  };
}

/** Dynamic fallback for `anthropic/<id>` — always Anthropic Messages API. */
function directAnthropicPatternMatch(modelName: string): ModelEntry | null {
  if (!modelName.startsWith("anthropic/")) return null;
  const id = modelName.slice("anthropic/".length);
  if (!id) return null;
  return directAnthropic(id, `${id} (Anthropic)`);
}

/** Dynamic fallback for `zai/<id>` — Z.AI Coding Plan (Chat Completions). */
function zaiPatternMatch(modelName: string): ModelEntry | null {
  if (!modelName.startsWith("zai/")) return null;
  const id = modelName.slice("zai/".length);
  if (!id) return null;
  return zaiCoding(id);
}

// --- OpenCode Go subscription ---

/**
 * OpenCode Go: a curated bundle of open coding models at https://opencode.ai/zen/go.
 * pi-ai ships a built-in `opencode-go` provider with the canonical model list and
 * base URLs — openai-completions models live under `/zen/go/v1`, anthropic-messages
 * models under `/zen/go` (no /v1). We look up the upstream Model when available
 * so compat flags, baseUrl, and thinkingLevelMap inherit for free.
 */
const OPENCODE_GO_V1 = "https://opencode.ai/zen/go/v1";

/**
 * Lookup a model in pi-ai's built-in `opencode-go` provider registry.
 * Returns null when no match is found.
 */
function lookupOpencodeGoModel(id: string): Model<Api> | null {
  try {
    const m = getBuiltinModel("opencode-go", id as never) as Model<Api> | undefined;
    return m ?? null;
  } catch { /* not found */ }
  return null;
}

function opencodeGo(id: string): ModelEntry {
  // Prefer pi-ai's built-in entry (correct baseUrl, compat flags, thinkingLevelMap).
  const upstream = lookupOpencodeGoModel(id);
  if (upstream) {
    return {
      apiKeyEnv: "OPENCODE_API_KEY",
      thinkingLevel: "medium",
      model: upstream,
    };
  }
  // Fallback: construct manually. pi-ai's built-in provider is the source of
  // truth for which api dialect + baseUrl each model uses; without an entry
  // we default to chat completions at the v1 endpoint (matches the majority
  // of the catalog — GLM, Kimi, DeepSeek, MiMo) and let /model surface the
  // mismatch if it ever happens.
  return {
    apiKeyEnv: "OPENCODE_API_KEY",
    thinkingLevel: "medium",
    model: {
      id,
      name: `${id} (OpenCode Go)`,
      api: "openai-completions",
      provider: "opencode-go",
      baseUrl: OPENCODE_GO_V1,
      compat: { supportsDeveloperRole: false },
      reasoning: true,
      input: ["text"] as "text"[],
      cost: ZERO_COST,
      contextWindow: 200_000,
      maxTokens: resolveMaxTokens(id),
    } satisfies Model<"openai-completions">,
  };
}

/** Dynamic fallback for `opencode-go/<id>` — OpenCode Go subscription. */
function opencodeGoPatternMatch(modelName: string): ModelEntry | null {
  if (!modelName.startsWith("opencode-go/")) return null;
  const id = modelName.slice("opencode-go/".length);
  if (!id) return null;
  return opencodeGo(id);
}

const KEY_FIELD: Record<ApiKeyEnv, keyof Config> = {
  OPENROUTER_API_KEY: "openrouterApiKey",
  OPENAI_API_KEY: "openaiApiKey",
  ANTHROPIC_API_KEY: "anthropicApiKey",
  ZAI_API_KEY: "zaiApiKey",
  OPENCODE_API_KEY: "opencodeApiKey",
};

function getApiKey(cfg: Config, env: ApiKeyEnv): string | undefined {
  return cfg[KEY_FIELD[env]] as string | undefined;
}

/**
 * Look up MODEL_NAME in the registry and pair it with the matching API key
 * from config. Throws a clear error if the model is unknown or the required
 * key is missing.
 */
export function resolveModel(cfg: Config): ResolvedModel {
  const entry =
    MODELS[cfg.modelName] ??
    openrouterPatternMatch(cfg.modelName) ??
    directOpenAIPatternMatch(cfg.modelName) ??
    directAnthropicPatternMatch(cfg.modelName) ??
    zaiPatternMatch(cfg.modelName) ??
    opencodeGoPatternMatch(cfg.modelName);
  if (!entry) {
    if (cfg.modelName.startsWith("poe/")) {
      throw new Error(
        `MODEL_NAME "${cfg.modelName}" uses the retired Poe namespace. Update the configured model and persisted Surface preferences to use anthropic/<model> with ANTHROPIC_API_KEY, openai/<model> with OPENAI_API_KEY, or OpenRouter or/<provider>/<model> with OPENROUTER_API_KEY.`,
      );
    }
    const known = Object.keys(MODELS).sort().join(", ");
    throw new Error(
      `Unknown MODEL_NAME "${cfg.modelName}". Known: ${known}.`,
    );
  }
  const apiKey = getApiKey(cfg, entry.apiKeyEnv);
  if (!apiKey) {
    throw new Error(`MODEL_NAME "${cfg.modelName}" requires ${entry.apiKeyEnv} to be set`);
  }
  // Inherit thinkingLevelMap from pi-ai's upstream registry so that
  // levels like "xhigh" are clamped correctly for each model family.
  const upstreamMap = resolveThinkingLevelMap(entry.model.id);
  const model = upstreamMap ? { ...entry.model, thinkingLevelMap: upstreamMap } : entry.model;

  // The default level is clamped to the model's supported set so the reported
  // default always matches what a request will actually run at (pi clamps again
  // at request time; the display and runtime plan must agree with it).
  const thinkingLevel = clampThinkingLevel(model, entry.thinkingLevel ?? "medium");

  return { model, apiKey, thinkingLevel };
}

