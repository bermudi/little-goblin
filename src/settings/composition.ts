/**
 * Settings deployment composition — stable listener/URL resolution and
 * process-owned startup for the optional loopback Settings API.
 *
 * Owner: Settings composition (this module resolves; `index.ts` owns the
 * handle lifetime).
 * Lifetime: deployment process while the returned handle is open. The resolved
 * config is a snapshot of `goblin.json5` `settings` at startup; changing it
 * requires a restart. Each request owns its discovery child (see `server.ts`).
 * Authority: `goblin.json5` `settings` section (`enabled`, stable `port`,
 * operator-managed `publicUrl`, `allowedOrigins`). No second durable copy.
 * Persistence: none in this module (canonical state stays in `goblin.json5`).
 * Network: loopback only via `startSettingsServer` (127.0.0.1); Tailscale
 * Serve is operator-managed and never configured here. No secrets are
 * projected or logged.
 */

import type { Config } from "../config.ts";
import { startSettingsServer, type SettingsServerHandle } from "./server.ts";

/** Deployment-owned stable default for the loopback Settings listener. */
export const SETTINGS_DEFAULT_PORT = 3423;

export interface DeploymentSettingsServerConfig {
  enabled: boolean;
  /** Stable loopback port (never 0 in production). */
  port: number;
  /** Normalized public web_app URL with trailing slash, or null when unset. */
  publicUrl: string | null;
  /** Effective write origins: explicit list or the publicUrl origin. */
  allowedOrigins: readonly string[];
}

function normalizePublicUrl(publicUrl: string | undefined): string | null {
  if (publicUrl === undefined) return null;
  const trimmed = publicUrl.trim();
  if (trimmed.length === 0) return null;
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Resolve the deployment-owned Settings server config. Returns null when the
 * Mini App API is disabled or unconfigured; otherwise returns the stable port,
 * normalized public URL, and effective write origins. Never throws for a
 * missing section — absence means disabled.
 */
export function resolveDeploymentSettingsServerConfig(
  cfg: Config,
): DeploymentSettingsServerConfig | null {
  const settings = cfg.settings;
  if (settings === undefined || settings.enabled !== true) return null;
  const port = settings.port ?? SETTINGS_DEFAULT_PORT;
  const publicUrl = normalizePublicUrl(settings.publicUrl);
  let allowedOrigins: readonly string[];
  if (settings.allowedOrigins !== undefined) {
    allowedOrigins = settings.allowedOrigins;
  } else if (publicUrl !== null) {
    const origin = originOf(publicUrl);
    allowedOrigins = origin === null ? [] : [origin];
  } else {
    allowedOrigins = [];
  }
  return { enabled: true, port, publicUrl, allowedOrigins };
}

/**
 * Resolve the Telegram web_app URL for the Settings Mini App. Returns null
 * when the API is disabled or no operator-managed public URL is configured.
 * The URL is safe to embed in Telegram buttons and messages (no secrets).
 */
export function settingsWebAppUrl(cfg: Config): string | null {
  return resolveDeploymentSettingsServerConfig(cfg)?.publicUrl ?? null;
}

/**
 * Start the optional deployment Settings server. Returns null when disabled;
 * otherwise binds 127.0.0.1 on the deployment-owned stable port. The caller
 * (`index.ts`) owns the handle and must close it during shutdown. Passes only
 * non-secret routing identity (botToken for initData verification is required
 * by the server to authenticate, but is never logged or projected).
 */
export function startDeploymentSettingsServer(cfg: Config): SettingsServerHandle | null {
  const resolved = resolveDeploymentSettingsServerConfig(cfg);
  if (resolved === null) return null;
  return startSettingsServer({
    goblinHome: cfg.goblinHome,
    botToken: cfg.botToken,
    allowedUserIds: [...cfg.allowedTgUserIds],
    allowedOrigins: [...resolved.allowedOrigins],
    port: resolved.port,
  });
}
