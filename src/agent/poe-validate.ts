/**
 * Validate a Poe model id against Poe's `/v1/models` catalog at startup.
 *
 * - Unknown poe id: throws with up to 5 close-match suggestions.
 * - Poe unreachable / non-2xx: logs a warning and returns (don't brick on flakes).
 * - Non-poe model names: no-op.
 *
 * The endpoint is auth-free per Poe docs, but we send the key when present.
 */
import type { Config } from "../config.ts";

export async function validateModelAtStartup(
  cfg: Config,
  logger: { warn: (msg: string, ctx?: Record<string, unknown>) => void },
): Promise<void> {
  if (!cfg.modelName.startsWith("poe/")) return;
  const id = cfg.modelName.slice("poe/".length);

  let res: Response;
  try {
    res = await fetch("https://api.poe.com/v1/models", {
      headers: cfg.poeApiKey ? { Authorization: `Bearer ${cfg.poeApiKey}` } : {},
      signal: AbortSignal.timeout(5_000),
    });
  } catch (e) {
    logger.warn("could not reach Poe to validate model; skipping", {
      error: e instanceof Error ? e.message : String(e),
    });
    return;
  }
  if (!res.ok) {
    logger.warn("Poe model list returned non-2xx; skipping validation", { status: res.status });
    return;
  }

  const body = (await res.json()) as { data?: Array<{ id?: string }> };
  const ids = (body.data ?? []).map((m) => m.id).filter((x): x is string => typeof x === "string");
  if (ids.length === 0) {
    logger.warn("Poe model list was empty; skipping validation");
    return;
  }
  if (ids.includes(id)) return;

  const lower = id.toLowerCase();
  const suggestions = ids
    .filter((x) => x.toLowerCase().includes(lower) || lower.includes(x.toLowerCase()))
    .slice(0, 5);
  const hint =
    suggestions.length > 0
      ? ` Did you mean: ${suggestions.map((s) => `poe/${s}`).join(", ")}?`
      : ` See https://api.poe.com/v1/models for the full list.`;
  throw new Error(`Unknown Poe model "${id}" (MODEL_NAME=${cfg.modelName}).${hint}`);
}
