/**
 * Model registry.
 *
 * Model IDs are prefixed with their provider namespace:
 *   poe/<id>        → Poe API (choose best endpoint per model family)
 *   or/<slug>       → OpenRouter (chat completions)
 *   openai/<id>     → Direct OpenAI API
 *   anthropic/<id>  → Direct Anthropic API
 *
 * Each entry picks the best pi-ai `api` dialect for that model family:
 *   - Claude models  → "anthropic" (Messages API, prompt caching)
 *   - GPT/o-series   → "openai-responses" (reasoning summaries)
 *   - Everything else → "openai-completions" (universal fallback)
 *
 * Extend by adding entries. The registry is explicit — no runtime synthesis.
 */
import type { Api, Model } from "@mariozechner/pi-ai";
import type { Config } from "../config.ts";

export type ApiKeyEnv =
  | "POE_API_KEY"
  | "OPENROUTER_API_KEY"
  | "OPENAI_API_KEY"
  | "ANTHROPIC_API_KEY";

export interface ModelEntry {
  model: Model<Api>;
  apiKeyEnv: ApiKeyEnv;
}

// Provider endpoints
const POE_ANTHROPIC = "https://api.poe.com";
const POE_OPENAI = "https://api.poe.com/v1";
const OPENROUTER = "https://openrouter.ai/api/v1";
const OPENAI = "https://api.openai.com/v1";
const ANTHROPIC = "https://api.anthropic.com";

// Cost fields are placeholders — actual billing varies by provider
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

// --- Poe ---

function poeAnthropic(id: string, name: string, ctx = 200_000): ModelEntry {
  return {
    apiKeyEnv: "POE_API_KEY",
    model: {
      id,
      name,
      api: "anthropic",
      provider: "poe",
      baseUrl: POE_ANTHROPIC,
      reasoning: true,
      input: ["text", "image"] as ("text" | "image")[],
      cost: ZERO_COST,
      contextWindow: ctx,
      maxTokens: 8_192,
    } satisfies Model<"anthropic">,
  };
}

function poeResponses(id: string, name: string, ctx = 200_000): ModelEntry {
  return {
    apiKeyEnv: "POE_API_KEY",
    model: {
      id,
      name,
      api: "openai-responses",
      provider: "poe",
      baseUrl: POE_OPENAI,
      reasoning: true,
      input: ["text", "image"] as ("text" | "image")[],
      cost: ZERO_COST,
      contextWindow: ctx,
      maxTokens: 8_192,
    } satisfies Model<"openai-responses">,
  };
}

function poeCompletions(id: string, name: string, ctx = 128_000): ModelEntry {
  return {
    apiKeyEnv: "POE_API_KEY",
    model: {
      id,
      name,
      api: "openai-completions",
      provider: "poe",
      baseUrl: POE_OPENAI,
      reasoning: false,
      input: ["text", "image"] as ("text" | "image")[],
      cost: ZERO_COST,
      contextWindow: ctx,
      maxTokens: 8_192,
    } satisfies Model<"openai-completions">,
  };
}

// --- OpenRouter ---

function openrouter(id: string, name: string, ctx = 200_000): ModelEntry {
  return {
    apiKeyEnv: "OPENROUTER_API_KEY",
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
      maxTokens: 8_192,
    } satisfies Model<"openai-completions">,
  };
}

// --- Direct providers ---

function directOpenAI(id: string, name: string, ctx = 128_000): ModelEntry {
  return {
    apiKeyEnv: "OPENAI_API_KEY",
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
      maxTokens: 8_192,
    } satisfies Model<"openai-responses">,
  };
}

function directAnthropic(id: string, name: string, ctx = 200_000): ModelEntry {
  return {
    apiKeyEnv: "ANTHROPIC_API_KEY",
    model: {
      id,
      name,
      api: "anthropic",
      provider: "anthropic",
      baseUrl: ANTHROPIC,
      reasoning: true,
      input: ["text", "image"] as ("text" | "image")[],
      cost: ZERO_COST,
      contextWindow: ctx,
      maxTokens: 8_192,
    } satisfies Model<"anthropic">,
  };
}

export const MODELS: Record<string, ModelEntry> = {
  // --- Poe: Claude family → Messages (cache_control, thinking blocks) ---
  "poe/Claude-Sonnet-4.6": poeAnthropic("Claude-Sonnet-4.6", "Claude Sonnet 4.6 (Poe)"),
  "poe/Claude-Haiku-4.5": poeAnthropic("Claude-Haiku-4.5", "Claude Haiku 4.5 (Poe)"),

  // --- Poe: OpenAI family → Responses (reasoning summaries) ---
  "poe/GPT-5": poeResponses("GPT-5", "GPT-5 (Poe)"),
  "poe/GPT-5-mini": poeResponses("GPT-5-mini", "GPT-5 mini (Poe)"),

  // --- Poe: everything else → Chat Completions ---
  "poe/Gemini-2.5-Pro": poeCompletions("Gemini-2.5-Pro", "Gemini 2.5 Pro (Poe)", 1_000_000),

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

export interface ResolvedModel {
  model: Model<Api>;
  apiKey: string;
}

function getApiKey(cfg: Config, env: ApiKeyEnv): string | undefined {
  switch (env) {
    case "POE_API_KEY":
      return cfg.poeApiKey;
    case "OPENROUTER_API_KEY":
      return cfg.openrouterApiKey;
    case "OPENAI_API_KEY":
      return cfg.openaiApiKey;
    case "ANTHROPIC_API_KEY":
      return cfg.anthropicApiKey;
    default:
      return undefined;
  }
}

/**
 * Look up MODEL_NAME in the registry and pair it with the matching API key
 * from config. Throws a clear error if the model is unknown or the required
 * key is missing.
 */
export function resolveModel(cfg: Config): ResolvedModel {
  const entry = MODELS[cfg.modelName];
  if (!entry) {
    const known = Object.keys(MODELS).sort().join(", ");
    throw new Error(`Unknown MODEL_NAME "${cfg.modelName}". Known: ${known}`);
  }
  const apiKey = getApiKey(cfg, entry.apiKeyEnv);
  if (!apiKey) {
    throw new Error(`MODEL_NAME "${cfg.modelName}" requires ${entry.apiKeyEnv} to be set`);
  }
  return { model: entry.model, apiKey };
}
