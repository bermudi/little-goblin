import { z } from "zod";

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
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  toolVisibility: z.enum(["none", "minimal", "standard", "verbose", "debug"]).default("standard"),
  favorites: z.array(z.string()).optional(),
});

export type ConfigFile = z.infer<typeof ConfigFileSchema>;
