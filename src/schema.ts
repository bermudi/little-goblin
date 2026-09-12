import { z } from "zod";
import { DEFAULT_VOICE_NAME } from "./voice.ts";

const EXTERNAL_AGENT_BACKENDS = ["claude", "devin"] as const;

export const ExternalAgentsConfigSchema = z.object({
  backends: z.array(z.enum(EXTERNAL_AGENT_BACKENDS)).default([]),
  /**
   * Operator-owned Settings deployment default for Devin (decision 0049),
   * bootstrapped to `glm-5.2`. Resolved at admission and captured with each
   * admitted run; the AI never selects or overrides it.
   */
  devinModel: z.string().min(1).default("glm-5.2"),
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
  /** Degraded-state cooldown after a failed embeddings call. Any finite non-negative number of seconds; mirrors the runtime boundary. */
  cooldownSeconds: z.number().min(0).optional(),
});

export type EmbeddingsConfig = z.infer<typeof EmbeddingsConfigSchema>;

export const McpConfigSchema = z.object({
  /** Positive allow-list. Undefined = every server in the mcporter config is exposed. */
  enabled: z.array(z.string()).optional(),
  /** Negative deny-list applied after `enabled`. Deny wins over the allow-list. */
  disabledServers: z.array(z.string()).optional(),
  configPath: z.string().optional(),
  defaultTimeoutMs: z.number().int().min(5000).max(1800000).default(120000),
  maxResultChars: z.number().int().min(1000).max(100000).default(16000),
});

export type McpConfig = z.infer<typeof McpConfigSchema>;

export const DevinConfigSchema = z.object({
  /** Exact deployment-default Devin model id (explicit selection only). */
  defaultModel: z.string().min(1),
});

export type DevinConfig = z.infer<typeof DevinConfigSchema>;

export const SettingsConfigSchema = z
  .object({
    /** Master switch for the optional loopback Settings API. Disabled by default. */
    enabled: z.boolean().default(false),
    /**
     * Deployment-owned stable loopback port (decision 0049). The listener
     * always binds 127.0.0.1; this port is the stable Tailscale Serve target.
     * Ephemeral port 0 is reserved for tests via `SettingsServerOptions.port`.
     */
    port: z.number().int().min(1).max(65535).default(3423),
    /**
     * Operator-managed private HTTPS URL (Tailscale Serve) that serves the
     * loopback listener to Telegram. Required for the web_app launch entry;
     * when absent the API still listens locally but Telegram has no entry.
     */
    publicUrl: z.string().optional(),
    /**
     * Allowed write origins for settings write requests (PUT /api/config/:section).
     * Defaults to the `publicUrl` origin when absent. Loopback and tests pass
     * explicit values.
     */
    allowedOrigins: z.array(z.string()).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.publicUrl !== undefined) {
      try {
        const parsed = new URL(val.publicUrl);
        if (parsed.protocol !== "https:") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "settings.publicUrl must be an https URL",
            path: ["publicUrl"],
          });
        }
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "settings.publicUrl must be a valid URL",
          path: ["publicUrl"],
        });
      }
    }
    if (val.allowedOrigins !== undefined) {
      for (const origin of val.allowedOrigins) {
        try {
          const parsed = new URL(origin);
          if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "settings.allowedOrigins entries must be valid http(s) origins",
              path: ["allowedOrigins"],
            });
            break;
          }
        } catch {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "settings.allowedOrigins entries must be valid URLs",
            path: ["allowedOrigins"],
          });
          break;
        }
      }
    }
  });

export type SettingsConfig = z.infer<typeof SettingsConfigSchema>;

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
    devin: DevinConfigSchema.optional(),
    /**
     * Optional loopback Settings Mini App API (decision 0049). Disabled by
     * default; when enabled the deployment owns a stable loopback port and
     * an operator-managed Tailscale Serve HTTPS URL. See SettingsConfigSchema.
     */
    settings: SettingsConfigSchema.optional(),
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
