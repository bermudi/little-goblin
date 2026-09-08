/**
 * Operator-authenticated Settings API — loopback HTTP listener in the Goblin process.
 *
 * Owner: Settings server (this module).
 * Lifetime: deployment process while the handle is open; each request owns its
 * discovery child and is cancelled by disconnect, timeout, or server close.
 * Authority: Telegram initData signature via `botToken` plus `allowedUserIds`
 * for identity, `allowedOrigins` for writes; durable state via the sole
 * Settings store (`readDeploymentSettings` / `saveDeploymentModel` in
 * `store.ts`, coordinated through `goblin-config-file.ts`). No second durable
 * copy, no secret/config dump routes, no auth material in logs.
 * Persistence: `$GOBLIN_HOME/goblin.json5` through the Settings store only.
 * Network: binds 127.0.0.1 only (never 0.0.0.0); ephemeral port 0 for tests,
 * deployment-owned stable `settings.port` (default 3423) in production so
 * operator-managed Tailscale Serve has a stable local target and supplies
 * private HTTPS. Tests use loopback only and perform no live
 * network setup.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { discoverDevinCatalog, type DevinModelCatalog } from "./devin-catalog.ts";
import { renderSettingsPage } from "./page.ts";
import { readDeploymentSettings, saveDeploymentModel, SettingsStoreError } from "./store.ts";
import { log } from "../log.ts";

const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_AUTH_MAX_AGE_SEC = 3600;
const CLOCK_SKEW_SEC = 60;

export interface SettingsServerOptions {
  goblinHome: string;
  botToken: string;
  allowedUserIds: readonly number[];
  allowedOrigins: readonly string[];
  /**
   * Deployment-owned stable loopback port. Defaults to ephemeral 0 for tests;
   * production passes the configured `settings.port` (default 3423) so
   * operator-managed Tailscale Serve has a stable local target. The listener
   * always binds 127.0.0.1 and never 0.0.0.0.
   */
  port?: number;
  maxBodyBytes?: number;
  requestTimeoutMs?: number;
  authMaxAgeSec?: number;
  discover?: (signal: AbortSignal) => Promise<DevinModelCatalog>;
}

export interface SettingsServerHandle {
  url: string;
  close(): Promise<void>;
}

type AuthFailure = { status: 401; code: "unauthorized" | "expired" };

function authFail(code: AuthFailure["code"]): AuthFailure {
  return { status: 401, code };
}

function parseInitData(initData: string): { params: Map<string, string> } | null {
  if (initData.length === 0) return null;
  const params = new Map<string, string>();
  for (const part of initData.split("&")) {
    if (part.length === 0) return null;
    const eq = part.indexOf("=");
    if (eq < 0) return null;
    let key: string;
    let value: string;
    try {
      key = decodeURIComponent(part.slice(0, eq));
      value = decodeURIComponent(part.slice(eq + 1));
    } catch {
      return null;
    }
    if (key.length === 0 || params.has(key)) return null;
    params.set(key, value);
  }
  return { params };
}

/**
 * Verify Telegram Mini App initData server-side: integrity (HMAC), freshness
 * (auth_date), and operator identity (user.id in the allowlist). Never trusts
 * initDataUnsafe or a browser-supplied user id. Returns the verified user id.
 */
function verifyInitData(
  initData: string,
  botToken: string,
  allowedUserIds: readonly number[],
  maxAgeSec: number,
): number | AuthFailure {
  const parsed = parseInitData(initData);
  if (parsed === null) return authFail("unauthorized");
  const { params } = parsed;
  const hash = params.get("hash");
  const authDateRaw = params.get("auth_date");
  const userRaw = params.get("user");
  if (hash === undefined || authDateRaw === undefined || userRaw === undefined) return authFail("unauthorized");
  if (!/^[0-9a-f]{64}$/.test(hash)) return authFail("unauthorized");

  const check = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(check).digest("hex");
  let match = false;
  try {
    match = timingSafeEqual(Buffer.from(hash, "utf8"), Buffer.from(expected, "utf8"));
  } catch {
    match = false;
  }
  if (!match) return authFail("unauthorized");

  if (!/^-?\d+$/.test(authDateRaw)) return authFail("unauthorized");
  const authDate = Number(authDateRaw);
  const nowSec = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(authDate)) return authFail("unauthorized");
  if (authDate > nowSec + CLOCK_SKEW_SEC) return authFail("expired");
  if (nowSec - authDate > maxAgeSec) return authFail("expired");

  let userId: unknown;
  try {
    userId = (JSON.parse(userRaw) as { id?: unknown }).id;
  } catch {
    return authFail("unauthorized");
  }
  if (typeof userId !== "number" || !Number.isInteger(userId)) return authFail("unauthorized");
  if (!allowedUserIds.includes(userId)) return authFail("unauthorized");
  return userId;
}

function extractInitData(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (header === null) return null;
  const prefix = "tma ";
  if (!header.toLowerCase().startsWith(prefix)) return null;
  return header.slice(prefix.length).trim();
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function safeDiscoveryStatus(reason: string): number {
  if (reason === "timeout") return 504;
  if (reason === "cancelled") return 499;
  return 502;
}

function toSafeDiscoveryReason(error: unknown): string {
  if (typeof error === "object" && error !== null && "reason" in error) {
    const reason = (error as { reason?: unknown }).reason;
    if (
      reason === "invalid-options" ||
      reason === "unavailable" ||
      reason === "process-failed" ||
      reason === "output-limit" ||
      reason === "timeout" ||
      reason === "cancelled" ||
      reason === "invalid-catalog"
    ) {
      return reason;
    }
  }
  return "process-failed";
}

function toSafeStoreResponse(error: unknown): { status: number; code: string } {
  if (error instanceof SettingsStoreError) {
    if (error.reason === "invalid-selection") return { status: 400, code: "invalid-selection" };
    if (error.reason === "stale-revision" || error.reason === "conflict") return { status: 409, code: "conflict" };
    return { status: 500, code: "unavailable" };
  }
  if (error instanceof Error) {
    if (/stale revision|changed during update|Config is locked/.test(error.message)) {
      return { status: 409, code: "conflict" };
    }
    if (/Config file not found/.test(error.message)) return { status: 500, code: "unavailable" };
  }
  return { status: 500, code: "unavailable" };
}

/** Start the optional loopback Settings API. Call `close()` to reject new work and settle accepted requests. */
export function startSettingsServer(options: SettingsServerOptions): SettingsServerHandle {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const authMaxAgeSec = options.authMaxAgeSec ?? DEFAULT_AUTH_MAX_AGE_SEC;
  const discover = options.discover ?? ((signal: AbortSignal) => discoverDevinCatalog({ signal }));
  const port = options.port ?? 0;

  let closing = false;
  let closed = false;
  const inFlight = new Set<Promise<void>>();
  const requestControllers = new Set<AbortController>();

  const fail = (route: string, status: number, code: string): Response => {
    log.warn("Settings API request failed", { route, status, error: code });
    return jsonResponse(status, { error: code });
  };

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const route = url.pathname;
      if (closing) return fail(route, 503, "shutting-down");

      // Static Mini App shell: no secrets, no config I/O, no discovery.
      // Every settings/catalog call the page makes is authenticated below.
      if (req.method === "GET" && route === "/") {
        return new Response(renderSettingsPage(), {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      }

      // Authenticate before any subprocess discovery or configuration I/O.
      const initData = extractInitData(req);
      if (initData === null) return fail(route, 401, "unauthorized");
      const identity = verifyInitData(initData, options.botToken, options.allowedUserIds, authMaxAgeSec);
      if (typeof identity !== "number") return fail(route, identity.status, identity.code);

      const requestController = new AbortController();
      requestControllers.add(requestController);
      const onClientAbort = (): void => requestController.abort();
      req.signal.addEventListener("abort", onClientAbort, { once: true });
      const timer = setTimeout(() => {
        (requestController as AbortController & { timedOut?: boolean }).timedOut = true;
        requestController.abort();
      }, requestTimeoutMs);
      const done = (): void => {
        clearTimeout(timer);
        req.signal.removeEventListener("abort", onClientAbort);
        requestControllers.delete(requestController);
      };

      const task = (async (): Promise<Response> => {
        try {
          if (req.method === "GET" && route === "/api/settings") {
            try {
              const settings = readDeploymentSettings(options.goblinHome);
              return jsonResponse(200, {
                devinDefaultModel: settings.devinDefaultModel,
                revision: settings.revision,
              });
            } catch (error: unknown) {
              const mapped = toSafeStoreResponse(error);
              return fail(route, mapped.status, mapped.code);
            }
          }
          if (req.method === "GET" && route === "/api/catalog") {
            try {
              const catalog = await discover(requestController.signal);
              return jsonResponse(200, catalog as unknown as Record<string, unknown>);
            } catch (error: unknown) {
              if (requestController.signal.aborted) {
                const timedOut = (requestController as AbortController & { timedOut?: boolean }).timedOut === true;
                return fail(route, timedOut ? 504 : 499, timedOut ? "timeout" : "cancelled");
              }
              const reason = toSafeDiscoveryReason(error);
              return fail(route, safeDiscoveryStatus(reason), reason);
            }
          }
          if (req.method === "POST" && route === "/api/settings") {
            // Writes also enforce the configured origin server-side.
            const origin = req.headers.get("origin");
            if (origin === null || !options.allowedOrigins.includes(origin)) {
              return fail(route, 403, "forbidden");
            }
            const contentLength = req.headers.get("content-length");
            if (contentLength !== null && Number(contentLength) > maxBodyBytes) {
              return fail(route, 413, "payload-too-large");
            }
            let text: string;
            try {
              text = await req.text();
            } catch {
              return fail(route, 400, "bad-request");
            }
            if (Buffer.byteLength(text, "utf8") > maxBodyBytes) {
              return fail(route, 413, "payload-too-large");
            }
            let body: unknown;
            try {
              body = JSON.parse(text) as unknown;
            } catch {
              return fail(route, 400, "bad-request");
            }
            if (typeof body !== "object" || body === null || Array.isArray(body)) {
              return fail(route, 400, "bad-request");
            }
            const { modelId, expectedRevision } = body as { modelId?: unknown; expectedRevision?: unknown };
            if (typeof modelId !== "string") return fail(route, 400, "bad-request");
            if (expectedRevision !== undefined && typeof expectedRevision !== "string") {
              return fail(route, 400, "bad-request");
            }
            try {
              const saved = saveDeploymentModel(options.goblinHome, modelId, { expectedRevision });
              return jsonResponse(200, {
                devinDefaultModel: saved.devinDefaultModel,
                revision: saved.revision,
              });
            } catch (error: unknown) {
              const mapped = toSafeStoreResponse(error);
              return fail(route, mapped.status, mapped.code);
            }
          }
          return fail(route, 404, "not-found");
        } finally {
          done();
        }
      })();

      const tracked: Promise<void> = task.then(() => undefined, () => undefined);
      inFlight.add(tracked);
      try {
        return await task;
      } finally {
        inFlight.delete(tracked);
      }
    },
  });

  log.info("Settings API listening", { port: server.port });

  return {
    url: `http://127.0.0.1:${server.port}`,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      closing = true;
      for (const controller of requestControllers) controller.abort();
      await Promise.allSettled([...inFlight]);
      server.stop(true);
    },
  };
}
