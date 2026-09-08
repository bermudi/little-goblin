/**
 * Settings Telegram launch entry — explicit web_app URL and menu button.
 *
 * Owner: Settings Telegram entry (this module builds payloads; `index.ts`
 * performs the Telegram API calls, `/settings` dispatches the text).
 * Lifetime: stateless pure builders plus one best-effort menu-button sync;
 * no persisted state, no listener, no discovery child.
 * Authority: deployment `settings.publicUrl` via `composition.ts`
 * (`settingsWebAppUrl`). Telegram remains the UI; this module never opens
 * network connections itself and never configures Tailscale.
 * Persistence: none.
 * Secrets: never includes botToken, initData, or configuration dumps in text,
 * markup, or logs.
 */

import type { Config } from "../config.ts";
import { settingsWebAppUrl } from "./composition.ts";

export interface SettingsEntryReply {
  text: string;
  /** Normalized public web_app URL, or null when Telegram has no entry. */
  webAppUrl: string | null;
  /** Inline keyboard with a web_app button, or null when no entry. */
  replyMarkup: {
    inline_keyboard: { text: string; web_app?: { url: string }; url?: string }[][];
  } | null;
}

/**
 * Build the `/settings` reply and its web_app markup. When the deployment
 * exposes a public URL, the reply contains the URL as text plus a web_app
 * button opening it inside Telegram. Otherwise the reply explains the
 * operator setup (enable `settings`, set the Tailscale Serve HTTPS
 * `publicUrl`) without secrets. Provider catalog text is rendered by the
 * Mini App page itself, never here.
 */
export function buildSettingsEntryReply(cfg: Config): SettingsEntryReply {
  const webAppUrl = settingsWebAppUrl(cfg);
  if (webAppUrl === null) {
    const enabled = cfg.settings?.enabled === true;
    const text = enabled
      ? "Settings API is enabled locally but no public URL is configured. Set `settings.publicUrl` to your Tailscale Serve HTTPS URL (serving the loopback Settings port), restart Goblin, then reopen /settings."
      : "Settings Mini App is disabled. Enable it with `settings: { enabled: true, publicUrl: \"https://<tailnet-name>/settings/\" }` in goblin.json5 (Tailscale Serve maps that HTTPS URL to the loopback Settings port), restart Goblin, then reopen /settings from Telegram.";
    return { text, webAppUrl: null, replyMarkup: null };
  }
  const text =
    `Open Goblin Settings to search Devin models and save the deployment default.\n` +
    `${webAppUrl}\n` +
    `It applies to the next run.`;
  return {
    text,
    webAppUrl,
    replyMarkup: {
      inline_keyboard: [[{ text: "Open Settings", web_app: { url: webAppUrl } }]],
    },
  };
}

/**
 * Sync Telegram's chat menu button to open Settings as a Mini App.
 * Best-effort: no-op when no public URL is configured or the API lacks
 * `setChatMenuButton`; failures call `warn` and resolve so startup continues.
 * Never includes secrets in the payload or logs.
 */
export async function syncSettingsMenuButton(
  api: unknown,
  cfg: Config,
  warn: (message: string, context?: Record<string, unknown>) => void,
): Promise<void> {
  const webAppUrl = settingsWebAppUrl(cfg);
  if (webAppUrl === null) return;
  if (typeof api !== "object" || api === null) return;
  const candidate = (api as Record<string, unknown>).setChatMenuButton;
  if (typeof candidate !== "function") return;
  try {
    await (candidate as (payload: Record<string, unknown>) => Promise<unknown>).call(api, {
      menu_button: { type: "web_app", text: "Settings", web_app: { url: webAppUrl } },
    });
  } catch (err) {
    warn("setChatMenuButton failed; Settings menu button may be stale", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
