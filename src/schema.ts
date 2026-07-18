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
export const ConfigFileSchema = z.object({
  botToken: z.string(),
  allowedUsers: z.array(z.number().int().positive()).min(1),
  model: z.string(),
  poeApiKey: z.string().optional(),
  openrouterApiKey: z.string().optional(),
  openaiApiKey: z.string().optional(),
  anthropicApiKey: z.string().optional(),
  zaiApiKey: z.string().optional(),
  opencodeApiKey: z.string().optional(),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  toolVisibility: z.enum(["none", "minimal", "standard", "verbose", "debug"]).default("standard"),
  skillSources: z.enum(["goblin-only", "user"]).default("goblin-only"),
  favorites: z.array(z.string()).optional(),
  /** Microsoft Edge TTS voice for /voice and text_to_speech. */
  voiceName: z.string().default(DEFAULT_VOICE_NAME),
  /** Groq API key for voice-note ASR. Optional resolved string. */
  groqApiKey: z.string().optional(),
  /** Groq Whisper model for voice-note ASR. */
  asrModel: z.enum(["whisper-large-v3-turbo", "whisper-large-v3"]).default("whisper-large-v3-turbo"),
  externalAgents: ExternalAgentsConfigSchema.optional(),
  mcp: McpConfigSchema.optional(),
});

export type ConfigFile = z.infer<typeof ConfigFileSchema>;
