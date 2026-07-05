import { z } from "zod";
import { DEFAULT_VOICE_NAME } from "./voice.ts";

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
});

export type ConfigFile = z.infer<typeof ConfigFileSchema>;
