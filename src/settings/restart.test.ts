/**
 * Verifier for issue #66 unit 4 — Self-restart: verified endpoint with
 * graceful drain. Covers both halves of the contract: the restart exit
 * policy (`createRestartTrigger`: bounded drain, single exit, always code 0)
 * through injectable `exit`/`runShutdown` hooks so the test runner is never
 * killed, and the `POST /api/restart` route (verified operator, origin
 * enforcement, 503 `shutting-down` latch, boot-loop guard refusal) through
 * an injected `requestRestart` recorder.
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSON5 from "json5";
import { log } from "../log.ts";

interface RestartTriggerHooks {
  runShutdown: () => Promise<void>;
  exit: (code: number) => void;
  deadlineMs?: number;
}

interface RestartModule {
  RESTART_DRAIN_DEADLINE_MS: number;
  createRestartTrigger(hooks: RestartTriggerHooks): () => void;
}

interface ServerOptions {
  goblinHome: string;
  botToken: string;
  allowedUserIds: readonly number[];
  allowedOrigins: readonly string[];
  requestRestart?: () => void;
}

interface ServerHandle {
  url: string;
  close(): Promise<void>;
}

interface ServerModule {
  startSettingsServer(options: ServerOptions): ServerHandle;
}

// Dynamic loading lets the verifier-only commit typecheck before implementation.
const restartModulePath = "./restart.ts";
async function loadRestart(): Promise<RestartModule> {
  const loaded: unknown = await import(restartModulePath);
  return loaded as RestartModule;
}

const serverModulePath = "./server.ts";
async function startServer(options: ServerOptions): Promise<ServerHandle> {
  const loaded: unknown = await import(serverModulePath);
  return (loaded as ServerModule).startSettingsServer(options);
}

const BOT_TOKEN = "test-bot-token-abc123";
const OPERATOR_ID = 123;
const ORIGIN = "https://app.example";

function makeHomeWith(initial: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), "goblin-settings-restart-"));
  writeFileSync(join(home, "goblin.json5"), JSON5.stringify(initial) + "\n", "utf-8");
  return home;
}

function makeHome(): string {
  return makeHomeWith({ botToken: "x", allowedUsers: [OPERATOR_ID], model: "m" });
}

function signInitData(params: Record<string, string>, botToken: string): string {
  const check = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  const query = [...Object.entries(params), ["hash", hash] as [string, string]]
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  return query;
}

function validInitData(botToken = BOT_TOKEN, userId = OPERATOR_ID, authDate?: number): string {
  const auth_date = String(authDate ?? Math.floor(Date.now() / 1000));
  const user = JSON.stringify({ id: userId, first_name: "Op" });
  return signInitData({ auth_date, user }, botToken);
}

interface RestartRecorder {
  calls: number;
  hook(): void;
}

function makeRestartRecorder(): RestartRecorder {
  const rec: RestartRecorder = { calls: 0, hook: () => { rec.calls += 1; } };
  return rec;
}

async function postRestart(
  handle: ServerHandle,
  auth: string | null,
  origin: string | null = ORIGIN,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (auth !== null) headers["authorization"] = `tma ${auth}`;
  if (origin !== null) headers["origin"] = origin;
  return await fetch(`${handle.url}/api/restart`, { method: "POST", headers });
}

async function getConfig(handle: ServerHandle, auth: string): Promise<Response> {
  return await fetch(`${handle.url}/api/config`, { headers: { authorization: `tma ${auth}` } });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met before timeout");
    await Bun.sleep(5);
  }
}

let info = spyOn(log, "info");
let warn = spyOn(log, "warn");
let errorLog = spyOn(log, "error");
afterEach(() => {
  info.mockRestore();
  warn.mockRestore();
  errorLog.mockRestore();
  info = spyOn(log, "info");
  warn = spyOn(log, "warn");
  errorLog = spyOn(log, "error");
});

function loggedText(): string {
  const calls: unknown[][] = [...info.mock.calls, ...warn.mock.calls, ...errorLog.mock.calls];
  return calls
    .map((args) => args.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join(" "))
    .join("\n");
}

describe("Restart exit policy (createRestartTrigger)", () => {
  it("exits 0 exactly once after shutdown phases complete; repeat triggers are no-ops", async () => {
    const { createRestartTrigger } = await loadRestart();
    const exits: number[] = [];
    let phases = 0;
    const trigger = createRestartTrigger({
      runShutdown: async () => {
        phases += 1;
      },
      exit: (code) => {
        exits.push(code);
      },
      deadlineMs: 5_000,
    });
    trigger();
    // A second trigger during shutdown must not create a double-exit path.
    trigger();
    await waitFor(() => exits.length > 0);
    await Bun.sleep(20);
    expect(exits).toEqual([0]);
    expect(phases).toBe(1);
  });

  it("exits 0 when a shutdown phase fails; the failure is logged loudly", async () => {
    const { createRestartTrigger } = await loadRestart();
    const exits: number[] = [];
    const trigger = createRestartTrigger({
      runShutdown: async () => {
        throw new Error("phase exploded");
      },
      exit: (code) => {
        exits.push(code);
      },
      deadlineMs: 5_000,
    });
    trigger();
    await waitFor(() => exits.length > 0);
    await Bun.sleep(20);
    // Revival depends on a success exit (systemd Restart=on-success), so a
    // drain-phase failure is logged, never fatal to the exit code.
    expect(exits).toEqual([0]);
    expect(loggedText()).toContain("phase exploded");
  });

  it("fails closed at the bounded deadline when phases hang", async () => {
    const { createRestartTrigger } = await loadRestart();
    const exits: number[] = [];
    const trigger = createRestartTrigger({
      runShutdown: () => new Promise<void>(() => {}),
      exit: (code) => {
        exits.push(code);
      },
      deadlineMs: 50,
    });
    trigger();
    await waitFor(() => exits.length > 0);
    expect(exits).toEqual([0]);
  });
});

describe("POST /api/restart", () => {
  it("verified operator gets 200 then shutdown triggers; unverified or cross-origin never triggers", async () => {
    const home = makeHome();
    const rec = makeRestartRecorder();
    const handle = await startServer({
      goblinHome: home,
      botToken: BOT_TOKEN,
      allowedUserIds: [OPERATOR_ID],
      allowedOrigins: [ORIGIN],
      requestRestart: rec.hook,
    });
    try {
      const auth = validInitData();
      // Negative cases first: the accepted restart closes the server below.
      const noAuth = await postRestart(handle, null);
      expect(noAuth.status).toBe(401);
      const garbage = await postRestart(handle, "malformed");
      expect(garbage.status).toBe(401);
      const foreignUser = await postRestart(handle, validInitData(BOT_TOKEN, 999));
      expect(foreignUser.status).toBe(401);
      // Mutating route: same-origin enforcement.
      const wrongOrigin = await postRestart(handle, auth, "https://evil.example");
      expect(wrongOrigin.status).toBe(403);
      const noOrigin = await postRestart(handle, auth, null);
      expect(noOrigin.status).toBe(403);
      await Bun.sleep(20);
      expect(rec.calls).toBe(0);

      const ok = await postRestart(handle, auth);
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as { status: string };
      expect(body.status).toBe("restarting");
      // Shutdown begins only after the 200 is dispatched.
      await waitFor(() => rec.calls === 1);
      expect(rec.calls).toBe(1);
    } finally {
      await handle.close().catch(() => {});
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("requests during shutdown get 503 shutting-down and a second restart never re-triggers", async () => {
    const home = makeHome();
    const rec = makeRestartRecorder();
    const handle = await startServer({
      goblinHome: home,
      botToken: BOT_TOKEN,
      allowedUserIds: [OPERATOR_ID],
      allowedOrigins: [ORIGIN],
      requestRestart: rec.hook,
    });
    try {
      const ok = await postRestart(handle, validInitData());
      expect(ok.status).toBe(200);
      await waitFor(() => rec.calls === 1);

      // New API work is rejected by the existing shutting-down mechanism.
      const during = await getConfig(handle, validInitData());
      expect(during.status).toBe(503);
      expect(((await during.json()) as { error: string }).error).toBe("shutting-down");

      // A second restart request during shutdown is idempotent: 503, and
      // exactly one shutdown trigger exists.
      const second = await postRestart(handle, validInitData());
      expect(second.status).toBe(503);
      expect(((await second.json()) as { error: string }).error).toBe("shutting-down");
      await Bun.sleep(20);
      expect(rec.calls).toBe(1);
    } finally {
      await handle.close().catch(() => {});
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("restart refused when on-disk config is invalid or missing; server keeps serving", async () => {
    const home = makeHome();
    const rec = makeRestartRecorder();
    const handle = await startServer({
      goblinHome: home,
      botToken: BOT_TOKEN,
      allowedUserIds: [OPERATOR_ID],
      allowedOrigins: [ORIGIN],
      requestRestart: rec.hook,
    });
    const envNames = ["GPT4TURBO", "ALICE"];
    const savedEnv = envNames.map((name) => [name, process.env[name]] as const);
    for (const name of envNames) delete process.env[name];
    try {
      const auth = validInitData();
      // Boot-loop guard: an externally corrupted config (out-of-range port)
      // must never be restarted into.
      writeFileSync(
        join(home, "goblin.json5"),
        JSON5.stringify({
          botToken: "x",
          allowedUsers: [OPERATOR_ID],
          model: "m",
          settings: { port: 999999 },
        }) + "\n",
        "utf-8",
      );
      const invalid = await postRestart(handle, auth);
      expect(invalid.status).toBe(400);
      const invalidBody = (await invalid.json()) as { error: string; message?: string };
      expect(invalidBody.error).toBe("invalid-config");
      expect(invalidBody.message).toContain("port");
      expect(rec.calls).toBe(0);

      // Raw-valid but unbootable configs are refused too: env-style literals
      // resolve to undefined at boot (the review probe {model:"GPT4TURBO",
      // favorites:["ALICE"]} parses raw but never boots), so restarting into
      // one would crash-loop the service.
      writeFileSync(
        join(home, "goblin.json5"),
        JSON5.stringify({
          botToken: "x",
          allowedUsers: [OPERATOR_ID],
          model: "GPT4TURBO",
          favorites: ["ALICE"],
        }) + "\n",
        "utf-8",
      );
      const unbootable = await postRestart(handle, auth);
      expect(unbootable.status).toBe(400);
      const unbootableBody = (await unbootable.json()) as { error: string; message?: string };
      expect(unbootableBody.error).toBe("invalid-config");
      expect(unbootableBody.message).toContain("model");
      expect(unbootableBody.message).toContain("favorites");
      expect(rec.calls).toBe(0);

      // The server keeps serving while the config stays invalid: reads get
      // the store's actionable invalid-config response (unit 2 behavior),
      // not a shutting-down 503 and not a dead listener.
      const read = await getConfig(handle, auth);
      expect(read.status).toBe(400);
      expect(((await read.json()) as { error: string }).error).toBe("invalid-config");

      // A missing config file is refused too, with an actionable error.
      unlinkSync(join(home, "goblin.json5"));
      const missing = await postRestart(handle, auth);
      expect(missing.status).toBe(404);
      expect(((await missing.json()) as { error: string }).error).toBe("missing-config");
      expect(rec.calls).toBe(0);

      // Repairing the file lets the restart through.
      writeFileSync(
        join(home, "goblin.json5"),
        JSON5.stringify({ botToken: "x", allowedUsers: [OPERATOR_ID], model: "m" }) + "\n",
        "utf-8",
      );
      const repaired = await postRestart(handle, auth);
      expect(repaired.status).toBe(200);
      await waitFor(() => rec.calls === 1);
      expect(rec.calls).toBe(1);
    } finally {
      for (const [name, value] of savedEnv) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await handle.close().catch(() => {});
      rmSync(home, { recursive: true, force: true });
    }
  });
});
