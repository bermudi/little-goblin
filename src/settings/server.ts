/**
 * Operator-authenticated Settings API — loopback HTTP listener in the Goblin process.
 *
 * Owner: Settings server (this module).
 * Lifetime: deployment process while the handle is open; each request owns its
 * discovery child and is cancelled by disconnect, timeout, or server close.
 * Authority: Telegram initData signature via `botToken` plus `allowedUserIds`
 * for identity, `allowedOrigins` for writes; durable state via the sole
 * Settings store (`readDeploymentConfig` / `saveConfigSection` in `store.ts`,
 * coordinated through `goblin-config-file.ts`), with the `mcp` section routed
 * exclusively through McpSelectionStore's mutations (decision 0042: the
 * Settings path never writes `mcp` keys directly). Responses carry `revision`
 * plus a startup-captured `bootRevision` (pending-restart derivation), and an
 * `allowedUsers` patch that would remove the verified requesting operator is
 * rejected before any write (self-lockout guard). No second durable copy, no
 * secret values in any response or log line, no auth material in logs.
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
import { McpSelectionStoreError, setMcpLimits, setMcpServerEnabled } from "../mcp/selection-store.ts";
import {
  readDeploymentConfig,
  saveConfigSection,
  SettingsStoreError,
  type SettingsStoreReason,
} from "./store.ts";
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

/**
 * HTTP mapping for every store failure reason. Store messages are crafted
 * to name fields without echoing values, so they are safe as client-facing
 * field errors; log lines carry only the short code.
 */
const STORE_ERROR_RESPONSES: Record<SettingsStoreReason, { status: number; code: string }> = {
  "invalid-selection": { status: 400, code: "invalid-selection" },
  "unknown-section": { status: 404, code: "unknown-section" },
  "unknown-field": { status: 400, code: "unknown-field" },
  "secret-field": { status: 400, code: "secret-field" },
  "invalid-patch": { status: 400, code: "invalid-patch" },
  "invalid-config": { status: 400, code: "invalid-config" },
  "stale-revision": { status: 409, code: "conflict" },
  conflict: { status: 409, code: "conflict" },
  "missing-config": { status: 404, code: "missing-config" },
};

function toSafeStoreResponse(error: unknown): { status: number; code: string; message?: string } {
  if (error instanceof McpSelectionStoreError) {
    // Invalid on-disk mcp section or out-of-range limits: actionable 400.
    return { status: 400, code: "invalid-config", message: error.message };
  }
  if (error instanceof SettingsStoreError) {
    return { ...STORE_ERROR_RESPONSES[error.reason], message: error.message };
  }
  if (error instanceof Error) {
    if (/stale revision|changed during update|Config is locked/.test(error.message)) {
      return { status: 409, code: "conflict" };
    }
    if (/Config file not found/.test(error.message)) return { status: 404, code: "missing-config" };
  }
  return { status: 500, code: "unavailable" };
}

/**
 * Self-lockout guard: an `allowedUsers` patch that drops the verified
 * requesting operator would lock them out of Settings on their next load.
 * Only `general` carries `allowedUsers`; non-array values are left to the
 * store's schema validation.
 */
function patchRemovesOperator(section: string, patch: Record<string, unknown>, operatorId: number): boolean {
  if (section !== "general") return false;
  const allowedUsers = patch.allowedUsers;
  return Array.isArray(allowedUsers) && !allowedUsers.includes(operatorId);
}

type McpPatchMutation =
  | { kind: "toggle"; server: string; enabled: boolean }
  | { kind: "limits"; limits: { defaultTimeoutMs?: number; maxResultChars?: number } };

/**
 * Validate an mcp section patch. Decision 0042 routes every mcp mutation
 * through McpSelectionStore, so patch shape is owned here: either one
 * allow/deny toggle (`server` + `enabled`) or a limits edit
 * (`defaultTimeoutMs` / `maxResultChars`). Mixing the two is rejected — each
 * MCP write is one atomic revision-CAS mutation through the store, never a
 * partial multi-write. Value ranges are the store's job (schema authority).
 * Returns a mutation, or an actionable `{error, message}` response payload.
 */
function parseMcpPatch(patch: Record<string, unknown>): McpPatchMutation | { error: string; message: string } {
  const allowed = ["server", "enabled", "defaultTimeoutMs", "maxResultChars"];
  for (const key of Object.keys(patch)) {
    if (!allowed.includes(key)) {
      return {
        error: "unknown-field",
        message: `Unknown field "${key}" for section "mcp"; mcp patches accept one toggle (server + enabled) or limits (defaultTimeoutMs, maxResultChars).`,
      };
    }
  }
  const hasToggle = patch.server !== undefined || patch.enabled !== undefined;
  const hasLimits = patch.defaultTimeoutMs !== undefined || patch.maxResultChars !== undefined;
  if (hasToggle && hasLimits) {
    return {
      error: "invalid-patch",
      message:
        'A "mcp" patch accepts either one server toggle (server + enabled) or a limits edit (defaultTimeoutMs/maxResultChars), not both; send them as separate writes so each is one atomic revision-CAS mutation.',
    };
  }
  if (hasToggle) {
    const server = patch.server;
    const enabled = patch.enabled;
    if (typeof server !== "string" || server.length === 0 || server.trim() !== server) {
      return { error: "invalid-patch", message: '"mcp" toggle patch field "server" must be a non-empty, unpadded server name.' };
    }
    if (typeof enabled !== "boolean") {
      return { error: "invalid-patch", message: '"mcp" toggle patch field "enabled" must be a boolean.' };
    }
    return { kind: "toggle", server, enabled };
  }
  if (hasLimits) {
    const limits: { defaultTimeoutMs?: number; maxResultChars?: number } = {};
    for (const key of ["defaultTimeoutMs", "maxResultChars"] as const) {
      const value = patch[key];
      if (value === undefined) continue;
      if (typeof value !== "number" || !Number.isInteger(value)) {
        return { error: "invalid-patch", message: `"mcp" limits patch field "${key}" must be an integer.` };
      }
      limits[key] = value;
    }
    return { kind: "limits", limits };
  }
  return {
    error: "invalid-patch",
    message:
      '"mcp" patch is empty; it must contain one server toggle (server + enabled) or a limits edit (defaultTimeoutMs/maxResultChars).',
  };
}

/** Start the optional loopback Settings API. Call `close()` to reject new work and settle accepted requests. */
export function startSettingsServer(options: SettingsServerOptions): SettingsServerHandle {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const authMaxAgeSec = options.authMaxAgeSec ?? DEFAULT_AUTH_MAX_AGE_SEC;
  const discover = options.discover ?? ((signal: AbortSignal) => discoverDevinCatalog({ signal }));
  const port = options.port ?? 0;
  // Content revision captured once at server start so clients can derive a
  // pending-restart flag (`revision !== bootRevision` after a config edit).
  // Fails loud when the deployment config is missing or invalid: the process
  // is already running on a loaded config, so this means the file vanished or
  // was corrupted mid-boot.
  const bootRevision = readDeploymentConfig(options.goblinHome).revision;

  let closing = false;
  let closed = false;
  const inFlight = new Set<Promise<void>>();
  const requestControllers = new Set<AbortController>();

  const fail = (route: string, status: number, code: string, message?: string): Response => {
    log.warn("Settings API request failed", { route, status, error: code });
    return jsonResponse(status, message === undefined ? { error: code } : { error: code, message });
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
          if (req.method === "GET" && route === "/api/config") {
            try {
              const config = readDeploymentConfig(options.goblinHome);
              return jsonResponse(200, { ...config, bootRevision });
            } catch (error: unknown) {
              const mapped = toSafeStoreResponse(error);
              return fail(route, mapped.status, mapped.code, mapped.message);
            }
          }
          if (req.method === "PUT" && route.startsWith("/api/config/")) {
            const section = route.slice("/api/config/".length);
            // Writes enforce the configured origin server-side, same as every
            // other mutating route.
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
            const { patch, expectedRevision } = body as { patch?: unknown; expectedRevision?: unknown };
            if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
              return fail(route, 400, "bad-request");
            }
            if (expectedRevision !== undefined && typeof expectedRevision !== "string") {
              return fail(route, 400, "bad-request");
            }
            const fields = patch as Record<string, unknown>;
            if (patchRemovesOperator(section, fields, identity)) {
              return fail(
                route,
                400,
                "operator-lockout",
                "This change would remove the requesting operator from allowedUsers and lock them out of Settings; the new allowedUsers list must include the verified operator.",
              );
            }
            if (section === "mcp") {
              // Decision 0042: McpSelectionStore is the sole writer of the
              // mcp section. The route validates patch shape, then the
              // mutation (toggle or limits) goes through the store with the
              // same revision CAS as every other section — never a direct
              // write to goblin.json5's mcp keys from this path.
              const mutation = parseMcpPatch(fields);
              if ("error" in mutation) {
                return fail(route, 400, mutation.error, mutation.message);
              }
              try {
                const result =
                  mutation.kind === "toggle"
                    ? setMcpServerEnabled(options.goblinHome, mutation.server, mutation.enabled, { expectedRevision })
                    : setMcpLimits(options.goblinHome, mutation.limits, { expectedRevision });
                return jsonResponse(200, { revision: result.revision });
              } catch (error: unknown) {
                const mapped = toSafeStoreResponse(error);
                return fail(route, mapped.status, mapped.code, mapped.message);
              }
            }
            try {
              // The store owns the section whitelist, secret-field rejection,
              // schema validation, CAS, and the durable write.
              const saved = saveConfigSection(options.goblinHome, section, patch, { expectedRevision });
              return jsonResponse(200, { revision: saved.revision });
            } catch (error: unknown) {
              const mapped = toSafeStoreResponse(error);
              return fail(route, mapped.status, mapped.code, mapped.message);
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
