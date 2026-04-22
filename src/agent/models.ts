/**
 * Model registry.
 *
 * Keyed by the provider's own model id (what MODEL_NAME must equal).
 * Each entry picks the best pi-ai `api` dialect for that model family:
 *
 *   - Claude on Poe       → "anthropic"          (Messages API, prompt caching)
 *   - GPT/o-series on Poe → "openai-responses"   (reasoning summaries)
 *   - Everything else     → "openai-completions" (universal fallback)
 *
 * OpenRouter only speaks Chat Completions, so every OR entry is "openai-completions".
 *
 * Extend by adding entries. No pattern-matching magic — explicit is honest.
 */
import type { Api, Model } from "@mariozechner/pi-ai";
import type { Config } from "../config.ts";

export type ApiKeyEnv = "POE_API_KEY" | "OPENROUTER_API_KEY";

export interface ModelEntry {
  model: Model<Api>;
  apiKeyEnv: ApiKeyEnv;
}

// Poe endpoints. Anthropic-compatible lives at the root; OpenAI-compatible under /v1.
const POE_ANTHROPIC = "https://api.poe.com";
const POE_OPENAI = "https://api.poe.com/v1";
const OPENROUTER = "https://openrouter.ai/api/v1";

// Cost fields are placeholders — Poe bills in compute points, not tokens.
// Don't trust pi-ai's cost math against these values; we don't use it yet.
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

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
      input: ["text", "image"],
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
      input: ["text", "image"],
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
      input: ["text", "image"],
      cost: ZERO_COST,
      contextWindow: ctx,
      maxTokens: 8_192,
    } satisfies Model<"openai-completions">,
  };
}

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
      input: ["text", "image"],
      cost: ZERO_COST,
      contextWindow: ctx,
      maxTokens: 8_192,
    } satisfies Model<"openai-completions">,
  };
}

export const MODELS: Record<string, ModelEntry> = {
  // --- Poe: Claude family → Messages (cache_control, thinking blocks) ---
  "Claude-Sonnet-4.6": poeAnthropic("Claude-Sonnet-4.6", "Claude Sonnet 4.6 (Poe)"),
  "Claude-Haiku-4.5": poeAnthropic("Claude-Haiku-4.5", "Claude Haiku 4.5 (Poe)"),

  // --- Poe: OpenAI family → Responses (reasoning summaries) ---
  "GPT-5": poeResponses("GPT-5", "GPT-5 (Poe)"),
  "GPT-5-mini": poeResponses("GPT-5-mini", "GPT-5 mini (Poe)"),

  // --- Poe: everything else → Chat Completions ---
  "Gemini-2.5-Pro": poeCompletions("Gemini-2.5-Pro", "Gemini 2.5 Pro (Poe)", 1_000_000),

  // --- OpenRouter: slash-slugs, always chat completions ---
  "anthropic/claude-sonnet-4.5": openrouter("anthropic/claude-sonnet-4.5", "Claude Sonnet 4.5 (OR)"),
  "openai/gpt-5": openrouter("openai/gpt-5", "GPT-5 (OR)"),
};

export interface ResolvedModel {
  model: Model<Api>;
  apiKey: string;
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
  const apiKey = entry.apiKeyEnv === "POE_API_KEY" ? cfg.poeApiKey : cfg.openrouterApiKey;
  if (!apiKey) {
    throw new Error(`MODEL_NAME "${cfg.modelName}" requires ${entry.apiKeyEnv} to be set`);
  }
  return { model: entry.model, apiKey };
}
