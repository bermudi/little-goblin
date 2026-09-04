import { z } from "zod";
import { DEFAULT_VOICE_NAME } from "./voice.ts";

const EXTERNAL_AGENT_BACKENDS = ["codex", "claude", "devin"] as const;
const EXTERNAL_AGENT_PERMISSION_PROFILES = ["read-only", "workspace-write"] as const;

export const ExternalAgentsConfigSchema = z.object({
  backends: z.array(z.enum(EXTERNAL_AGENT_BACKENDS)).default([]),
  permissionProfile: z.enum(EXTERNAL_AGENT_PERMISSION_PROFILES).default("read-only"),
  maxConcurrent: z.number().int().min(1).max(8).default(2),
  timeoutMs: z.number().int().min(60000).max(7200000).default(1800000),
  ptyFallback: z.boolean().default(false),
}).superRefine((val, ctx) => {
  if (new Set(val.backends).size !== val.backends.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "externalAgents.backends must not contain duplicate values",
      path: ["backends"],
    });
  }
});

export type ExternalAgentsConfig = z.infer<typeof ExternalAgentsConfigSchema>;

export const EmbeddingsConfigSchema = z.object({
  /** API key for the embeddings endpoint. Falls back to GOBLIN_MEMORY_EMBEDDING_API_KEY, then OPENAI_API_KEY. */
  apiKey: z.string().optional(),
  /** Base URL without /v1 (the client appends /v1/embeddings). Falls back to GOBLIN_MEMORY_EMBEDDING_BASE_URL, then OPENAI_BASE_URL. */
  baseUrl: z.string().optional(),
  /** Embedding model id. Falls back to GOBLIN_MEMORY_EMBEDDING_MODEL, then text-embedding-3-small. */
  model: z.string().optional(),
  /** Provider label stored in memory_embeddings; changing it (or the model) triggers a full reindex. */
  provider: z.string().optional(),
  /** Degraded-state cooldown after a failed embeddings call. */
  cooldownSeconds: z.number().int().min(0).max(3600).optional(),
});

export type EmbeddingsConfig = z.infer<typeof EmbeddingsConfigSchema>;

export const McpConfigSchema = z.object({
  enabled: z.array(z.string()).optional(),
  configPath: z.string().optional(),
  defaultTimeoutMs: z.number().int().min(5000).max(1800000).default(120000),
  maxResultChars: z.number().int().min(1000).max(100000).default(16000),
});

export type McpConfig = z.infer<typeof McpConfigSchema>;

/**
 * Zod schema for the JSON5 config file (goblin.json5).
 * Values are resolved via resolveConfigValue() before validation.
 */
export const ConfigFileSchema = z
  .object({
    botToken: z.string(),
    allowedUsers: z.array(z.number().int().positive()).min(1),
    model: z.string(),
    openrouterApiKey: z.string().optional(),
    openaiApiKey: z.string().optional(),
    anthropicApiKey: z.string().optional(),
    zaiApiKey: z.string().optional(),
    opencodeApiKey: z.string().optional(),
    logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
    toolVisibility: z.enum(["none", "minimal", "standard", "verbose", "debug"]).default("standard"),
    favorites: z.array(z.string()).optional(),
    /** Microsoft Edge TTS voice for /voice and text_to_speech. */
    voiceName: z.string().default(DEFAULT_VOICE_NAME),
    /** Groq API key for voice-note ASR. Optional resolved string. */
    groqApiKey: z.string().optional(),
    /** Groq Whisper model for voice-note ASR. */
    asrModel: z.enum(["whisper-large-v3-turbo", "whisper-large-v3"]).default("whisper-large-v3-turbo"),
    /** Memory embeddings endpoint configuration. Optional; env fallbacks apply per key. */
    embeddings: EmbeddingsConfigSchema.optional(),
    externalAgents: ExternalAgentsConfigSchema.optional(),
    mcp: McpConfigSchema.optional(),
    /**
     * Legacy field removed by decision 0034. Retained as `z.unknown()` so an
     * existing key fails validation with actionable guidance via the
     * superRefine below, rather than being silently stripped.
     */
    skillSources: z.unknown().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.skillSources !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "skillSources has been removed (decision 0034). Remove this key from goblin.json5; skill selection is now per-Surface via /skills policy.",
        path: ["skillSources"],
      });
    }
  });

export type ConfigFile = z.infer<typeof ConfigFileSchema>;
