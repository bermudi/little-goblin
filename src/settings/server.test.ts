import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSON5 from "json5";
import { log } from "../log.ts";

interface TestCatalog {
  families: {
    id: string;
    slug: string;
    label: string;
    aliases: string[];
    variants: { id: string; label: string; isNew: boolean; isBeta: boolean }[];
  }[];
}

interface ServerOptions {
  goblinHome: string;
  botToken: string;
  allowedUserIds: readonly number[];
  allowedOrigins: readonly string[];
  maxBodyBytes?: number;
  requestTimeoutMs?: number;
  authMaxAgeSec?: number;
  discover?: (signal: AbortSignal) => Promise<TestCatalog>;
}

interface ServerHandle {
  url: string;
  close(): Promise<void>;
}

interface ServerModule {
  startSettingsServer(options: ServerOptions): ServerHandle | Promise<ServerHandle>;
}

// Dynamic loading lets the verifier-only commit typecheck before implementation.
const modulePath = "./server.ts";
async function startServer(options: ServerOptions): Promise<ServerHandle> {
  const loaded: unknown = await import(modulePath);
  return await (loaded as ServerModule).startSettingsServer(options);
}

const BOT_TOKEN = "test-bot-token-abc123";
const OPERATOR_ID = 123;
const ORIGIN = "https://app.example";

function makeHomeWith(initial: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), "goblin-settings-server-"));
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

function catalogWith(modelId: string): TestCatalog {
  return {
    families: [
      {
        id: "test-family",
        slug: "test-family",
        label: "Test family",
        aliases: ["test-alias"],
        variants: [{ id: modelId, label: "Test variant", isNew: false, isBeta: false }],
      },
    ],
  };
}

interface ConfigBody {
  general: { model: string; allowedUsers: number[] };
  embeddings: { baseUrl?: string; apiKey: { present: boolean } };
  devin: { defaultModel: string | null };
  settings: { enabled: boolean; port: number };
  secrets: Record<string, { present: boolean }>;
  revision: string;
  bootRevision: string;
}

async function getConfig(handle: ServerHandle, auth: string): Promise<Response> {
  return await fetch(`${handle.url}/api/config`, { headers: { authorization: `tma ${auth}` } });
}

async function putSection(
  handle: ServerHandle,
  auth: string,
  section: string,
  body: Record<string, unknown>,
  origin: string | null = ORIGIN,
): Promise<Response> {
  const headers: Record<string, string> = { authorization: `tma ${auth}`, "content-type": "application/json" };
  if (origin !== null) headers["origin"] = origin;
  return await fetch(`${handle.url}/api/config/${section}`, { method: "PUT", headers, body: JSON.stringify(body) });
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
  return calls.map((args) => args.map((part) => String(part)).join(" ")).join("\n");
}

describe("Operator-authenticated Settings API", () => {
  it("GET /api/config returns sections, revision, bootRevision; 401 without initData", async () => {
    const home = makeHome();
    const handle = await startServer({
      goblinHome: home,
      botToken: BOT_TOKEN,
      allowedUserIds: [OPERATOR_ID],
      allowedOrigins: [ORIGIN],
    });
    try {
      const auth = validInitData();
      const res = await getConfig(handle, auth);
      expect(res.status).toBe(200);
      const body = (await res.json()) as ConfigBody;
      expect(body.general.model).toBe("m");
      expect(body.general.allowedUsers).toEqual([OPERATOR_ID]);
      // Schema defaults fill sections absent from the file.
      expect(body.settings.port).toBe(3423);
      expect(body.settings.enabled).toBe(false);
      expect(body.devin.defaultModel).toBeNull();
      expect(body.embeddings.apiKey).toEqual({ present: false });
      expect(body.secrets.botToken).toEqual({ present: true });
      expect(body.revision).toMatch(/^[0-9a-f]{64}$/);
      expect(body.bootRevision).toMatch(/^[0-9a-f]{64}$/);

      // bootRevision is captured once at start and survives later file edits;
      // revision tracks the file, so the pair derives a pending-restart flag.
      writeFileSync(
        join(home, "goblin.json5"),
        JSON5.stringify({ botToken: "x", allowedUsers: [OPERATOR_ID], model: "m2" }) + "\n",
        "utf-8",
      );
      const after = (await (await getConfig(handle, auth)).json()) as ConfigBody;
      expect(after.revision).not.toBe(body.revision);
      expect(after.bootRevision).toBe(body.bootRevision);

      const missing = await fetch(`${handle.url}/api/config`);
      expect(missing.status).toBe(401);
      const garbage = await fetch(`${handle.url}/api/config`, {
        headers: { authorization: "tma malformed" },
      });
      expect(garbage.status).toBe(401);
    } finally {
      await handle.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("PUT /api/config/general saves and returns new revision", async () => {
    const home = makeHome();
    const handle = await startServer({
      goblinHome: home,
      botToken: BOT_TOKEN,
      allowedUserIds: [OPERATOR_ID],
      allowedOrigins: [ORIGIN],
    });
    try {
      const auth = validInitData();
      const before = (await (await getConfig(handle, auth)).json()) as ConfigBody;
      const res = await putSection(handle, auth, "general", {
        patch: { model: "edited-model", logLevel: "debug" },
        expectedRevision: before.revision,
      });
      expect(res.status).toBe(200);
      const saved = (await res.json()) as { revision: string };
      expect(saved.revision).toMatch(/^[0-9a-f]{64}$/);
      expect(saved.revision).not.toBe(before.revision);

      // Only the patch keys changed; unrelated keys are preserved in the file.
      const raw = readFileSync(join(home, "goblin.json5"), "utf-8");
      const parsed = JSON5.parse(raw) as Record<string, unknown>;
      expect(parsed["model"]).toBe("edited-model");
      expect(parsed["logLevel"]).toBe("debug");
      expect(parsed["botToken"]).toBe("x");
      expect(parsed["allowedUsers"]).toEqual([OPERATOR_ID]);

      // The saved revision is the one the next read reports (CAS coherence).
      const after = (await (await getConfig(handle, auth)).json()) as ConfigBody;
      expect(after.revision).toBe(saved.revision);
      expect(after.general.model).toBe("edited-model");
    } finally {
      await handle.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("PUT with invalid payload returns 400 field errors; stale revision returns 409", async () => {
    const home = makeHome();
    const handle = await startServer({
      goblinHome: home,
      botToken: BOT_TOKEN,
      allowedUserIds: [OPERATOR_ID],
      allowedOrigins: [ORIGIN],
    });
    try {
      const auth = validInitData();
      const beforeRaw = readFileSync(join(home, "goblin.json5"), "utf-8");
      const before = (await (await getConfig(handle, auth)).json()) as ConfigBody;

      // Schema-invalid field value → 400 with a field-level error message.
      const badPort = await putSection(handle, auth, "settings", {
        patch: { port: "nope" },
        expectedRevision: before.revision,
      });
      expect(badPort.status).toBe(400);
      const badPortBody = (await badPort.json()) as { error: string; message?: string };
      expect(badPortBody.error).toBe("invalid-config");
      expect(badPortBody.message).toContain("port");

      const outOfRange = await putSection(handle, auth, "settings", {
        patch: { port: 999_999 },
        expectedRevision: before.revision,
      });
      expect(outOfRange.status).toBe(400);

      // Unknown field → 400 naming the field and the writable set.
      const unknownField = await putSection(handle, auth, "general", {
        patch: { nope: 1 },
        expectedRevision: before.revision,
      });
      expect(unknownField.status).toBe(400);
      const unknownBody = (await unknownField.json()) as { error: string; message?: string };
      expect(unknownBody.error).toBe("unknown-field");
      expect(unknownBody.message).toContain("nope");

      // Empty Devin default fails config validation → 400, nothing written.
      const emptyModel = await putSection(handle, auth, "devin", {
        patch: { defaultModel: "" },
        expectedRevision: before.revision,
      });
      expect(emptyModel.status).toBe(400);

      // Malformed request shapes → 400.
      const badPatch = await putSection(handle, auth, "general", { patch: 5 });
      expect(badPatch.status).toBe(400);
      const notJson = await fetch(`${handle.url}/api/config/general`, {
        method: "PUT",
        headers: { authorization: `tma ${auth}`, origin: ORIGIN, "content-type": "application/json" },
        body: "{not json",
      });
      expect(notJson.status).toBe(400);

      // Stale revision → 409 conflict, no write.
      const stale = await putSection(handle, auth, "general", {
        patch: { model: "should-not-land" },
        expectedRevision: "0".repeat(64),
      });
      expect(stale.status).toBe(409);
      const staleBody = (await stale.json()) as { error: string };
      expect(staleBody.error).toBe("conflict");

      // Only whitelisted sections are accepted; unknown sections → 404.
      const mcp = await putSection(handle, auth, "mcp", { patch: {} });
      expect(mcp.status).toBe(404);
      const mcpBody = (await mcp.json()) as { error: string };
      expect(mcpBody.error).toBe("unknown-section");
      const unknownSection = await putSection(handle, auth, "unknown-thing", { patch: {} });
      expect(unknownSection.status).toBe(404);

      expect(readFileSync(join(home, "goblin.json5"), "utf-8")).toBe(beforeRaw);
    } finally {
      await handle.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("allowedUsers patch removing requester rejected 400, file unchanged", async () => {
    const home = makeHomeWith({ botToken: "x", allowedUsers: [OPERATOR_ID, 555], model: "m" });
    const handle = await startServer({
      goblinHome: home,
      botToken: BOT_TOKEN,
      allowedUserIds: [OPERATOR_ID],
      allowedOrigins: [ORIGIN],
    });
    try {
      const auth = validInitData();
      const beforeRaw = readFileSync(join(home, "goblin.json5"), "utf-8");
      const before = (await (await getConfig(handle, auth)).json()) as ConfigBody;

      const lockout = await putSection(handle, auth, "general", {
        patch: { allowedUsers: [555] },
        expectedRevision: before.revision,
      });
      expect(lockout.status).toBe(400);
      const lockoutBody = (await lockout.json()) as { error: string };
      expect(lockoutBody.error).toBe("operator-lockout");
      expect(readFileSync(join(home, "goblin.json5"), "utf-8")).toBe(beforeRaw);

      // Keeping the requesting operator is allowed.
      const keep = await putSection(handle, auth, "general", {
        patch: { allowedUsers: [OPERATOR_ID, 777] },
        expectedRevision: before.revision,
      });
      expect(keep.status).toBe(200);
      const raw = readFileSync(join(home, "goblin.json5"), "utf-8");
      expect(raw).toContain("777");
      expect(raw).toContain(String(OPERATOR_ID));
    } finally {
      await handle.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("GET /api/settings returns 404", async () => {
    const home = makeHome();
    const handle = await startServer({
      goblinHome: home,
      botToken: BOT_TOKEN,
      allowedUserIds: [OPERATOR_ID],
      allowedOrigins: [ORIGIN],
    });
    try {
      const auth = validInitData();
      const read = await fetch(`${handle.url}/api/settings`, {
        headers: { authorization: `tma ${auth}` },
      });
      expect(read.status).toBe(404);
      const write = await fetch(`${handle.url}/api/settings`, {
        method: "POST",
        headers: { authorization: `tma ${auth}`, origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ modelId: "test-model" }),
      });
      expect(write.status).toBe(404);
    } finally {
      await handle.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("GET /api/config response contains presence flags only", async () => {
    const home = makeHomeWith({
      botToken: "bot-token-value-secret",
      allowedUsers: [OPERATOR_ID],
      model: "m",
      openrouterApiKey: "sk-oracle-secret-value",
      embeddings: { apiKey: "sk-embed-secret-value", baseUrl: "https://emb.example" },
    });
    const handle = await startServer({
      goblinHome: home,
      botToken: BOT_TOKEN,
      allowedUserIds: [OPERATOR_ID],
      allowedOrigins: [ORIGIN],
    });
    try {
      const res = await getConfig(handle, validInitData());
      expect(res.status).toBe(200);
      const text = await res.text();
      // Presence flags appear; secret values never do.
      expect(text).toContain('"present":true');
      expect(text).toContain('"botToken":{"present":true}');
      expect(text).toContain('"apiKey":{"present":true}');
      expect(text).toContain('"openrouterApiKey":{"present":true}');
      // Non-secret values pass through.
      expect(text).toContain("https://emb.example");
      // Secret values never leave the server.
      expect(text).not.toContain("bot-token-value-secret");
      expect(text).not.toContain("sk-oracle-secret-value");
      expect(text).not.toContain("sk-embed-secret-value");
      // Nothing sensitive in the log stream either.
      const logs = loggedText();
      expect(logs).not.toContain("bot-token-value-secret");
      expect(logs).not.toContain("sk-oracle-secret-value");
      expect(logs).not.toContain("sk-embed-secret-value");
    } finally {
      await handle.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("missing config file is an actionable 404 on read and write", async () => {
    const home = makeHome();
    const handle = await startServer({
      goblinHome: home,
      botToken: BOT_TOKEN,
      allowedUserIds: [OPERATOR_ID],
      allowedOrigins: [ORIGIN],
    });
    try {
      unlinkSync(join(home, "goblin.json5"));
      const auth = validInitData();
      const read = await getConfig(handle, auth);
      expect(read.status).toBe(404);
      const readBody = (await read.json()) as { error: string; message?: string };
      expect(readBody.error).toBe("missing-config");
      expect(readBody.message).toContain("Config file not found");
      const write = await putSection(handle, auth, "general", { patch: { model: "n" } });
      expect(write.status).toBe(404);
      const writeBody = (await write.json()) as { error: string };
      expect(writeBody.error).toBe("missing-config");
      // The store never creates the file as a side effect.
      expect(existsSync(join(home, "goblin.json5"))).toBe(false);
    } finally {
      await handle.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("verified operator reads the config and saves the Devin default over loopback HTTP", async () => {
    const home = makeHome();
    const handle = await startServer({
      goblinHome: home,
      botToken: BOT_TOKEN,
      allowedUserIds: [OPERATOR_ID],
      allowedOrigins: [ORIGIN],
      discover: async () => catalogWith("test-model"),
    });
    try {
      const auth = validInitData();
      const before = (await (await getConfig(handle, auth)).json()) as ConfigBody;
      expect(before.devin.defaultModel).toBeNull();

      const catalogRes = await fetch(`${handle.url}/api/catalog`, {
        headers: { authorization: `tma ${auth}` },
      });
      expect(catalogRes.status).toBe(200);
      const catalog = (await catalogRes.json()) as TestCatalog;
      expect(catalog.families[0]?.variants.map((v) => v.id)).toEqual(["test-model"]);

      const saveRes = await putSection(handle, auth, "devin", {
        patch: { defaultModel: "test-model" },
        expectedRevision: before.revision,
      });
      expect(saveRes.status).toBe(200);
      const saved = (await saveRes.json()) as { revision: string };
      expect(saved.revision).toMatch(/^[0-9a-f]{64}$/);

      const after = (await (await getConfig(handle, auth)).json()) as ConfigBody;
      expect(after.devin.defaultModel).toBe("test-model");
      const raw = readFileSync(join(home, "goblin.json5"), "utf-8");
      expect(raw).toContain("test-model");
    } finally {
      await handle.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("invalid identity and cross-origin writes produce no effects", async () => {
    const home = makeHome();
    let discoveries = 0;
    const handle = await startServer({
      goblinHome: home,
      botToken: BOT_TOKEN,
      allowedUserIds: [OPERATOR_ID],
      allowedOrigins: [ORIGIN],
      discover: async () => {
        discoveries += 1;
        return catalogWith("test-model");
      },
    });
    try {
      const good = validInitData();
      const tampered = good.slice(0, -1) + (good.endsWith("0") ? "1" : "0");
      const foreignUser = validInitData(BOT_TOKEN, 999);
      const wrongToken = validInitData("other-token", OPERATOR_ID);
      const hashPart = good.split("hash=")[1] ?? "missing";
      const duplicate = `${good}&hash=${hashPart}`;
      const beforeRaw = readFileSync(join(home, "goblin.json5"), "utf-8");

      for (const bad of [tampered, foreignUser, wrongToken, duplicate]) {
        const readRes = await fetch(`${handle.url}/api/config`, {
          headers: { authorization: `tma ${bad}` },
        });
        expect(readRes.status).toBe(401);
        const catalogRes = await fetch(`${handle.url}/api/catalog`, {
          headers: { authorization: `tma ${bad}` },
        });
        expect(catalogRes.status).toBe(401);
        const writeRes = await putSection(handle, bad, "general", { patch: { model: "evil" } });
        expect(writeRes.status).toBe(401);
      }
      // Missing credentials are rejected without side effects.
      const missing = await fetch(`${handle.url}/api/config`);
      expect(missing.status).toBe(401);

      // Foreign-origin (and missing-origin) writes with valid identity are
      // rejected without mutation.
      const revision = ((await (await getConfig(handle, good)).json()) as ConfigBody).revision;
      const crossOrigin = await putSection(handle, good, "general", { patch: { model: "evil" }, expectedRevision: revision }, "https://evil.example");
      expect(crossOrigin.status).toBe(403);
      const noOrigin = await putSection(handle, good, "general", { patch: { model: "evil" }, expectedRevision: revision }, null);
      expect(noOrigin.status).toBe(403);

      expect(discoveries).toBe(0);
      expect(readFileSync(join(home, "goblin.json5"), "utf-8")).toBe(beforeRaw);
    } finally {
      await handle.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("disconnect and shutdown settle active requests", async () => {
    const home = makeHome();
    const signals: AbortSignal[] = [];
    const handle = await startServer({
      goblinHome: home,
      botToken: BOT_TOKEN,
      allowedUserIds: [OPERATOR_ID],
      allowedOrigins: [ORIGIN],
      requestTimeoutMs: 5_000,
      discover: (signal) => {
        signals.push(signal);
        return new Promise<TestCatalog>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { reason: "cancelled" })), {
            once: true,
          });
        });
      },
    });
    try {
      // Client disconnect cancels its own request-owned discovery.
      const controller = new AbortController();
      const pending = fetch(`${handle.url}/api/catalog`, {
        headers: { authorization: `tma ${validInitData()}` },
        signal: controller.signal,
      });
      await Bun.sleep(50);
      controller.abort();
      await expect(pending).rejects.toThrow();
      await Bun.sleep(50);
      expect(signals.length).toBeGreaterThanOrEqual(1);
      expect(signals[0]?.aborted).toBe(true);

      // Server shutdown cancels accepted work and rejects new work.
      const inFlight = fetch(`${handle.url}/api/catalog`, {
        headers: { authorization: `tma ${validInitData()}` },
      });
      await Bun.sleep(50);
      await handle.close();
      const settled = await Promise.allSettled([inFlight]);
      expect(settled.length).toBe(1);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      const rejected: unknown = await fetch(`${handle.url}/api/config`, {
        headers: { authorization: `tma ${validInitData()}` },
      }).then(
        (res) => res.status,
        (err: unknown) => err,
      );
      expect(typeof rejected === "number" ? [503, 500].includes(rejected) : rejected instanceof Error).toBe(true);
    } finally {
      await handle.close().catch(() => {});
      rmSync(home, { recursive: true, force: true });
    }
  }, 10_000);

  it("oversized and expired requests fail within bounds", async () => {
    const home = makeHome();
    const handle = await startServer({
      goblinHome: home,
      botToken: BOT_TOKEN,
      allowedUserIds: [OPERATOR_ID],
      allowedOrigins: [ORIGIN],
      maxBodyBytes: 256,
      authMaxAgeSec: 60,
      discover: async () => catalogWith("test-model"),
    });
    try {
      const beforeRaw = readFileSync(join(home, "goblin.json5"), "utf-8");
      const oversized = await putSection(handle, validInitData(), "general", {
        patch: { model: "x".repeat(4096) },
      });
      expect(oversized.status).toBe(413);

      const expired = validInitData(BOT_TOKEN, OPERATOR_ID, Math.floor(Date.now() / 1000) - 3600);
      const expiredRes = await getConfig(handle, expired);
      expect(expiredRes.status).toBe(401);
      const expiredBody = (await expiredRes.json()) as { error: string };
      expect(typeof expiredBody.error).toBe("string");

      expect(readFileSync(join(home, "goblin.json5"), "utf-8")).toBe(beforeRaw);
    } finally {
      await handle.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("API errors and logs contain no credentials", async () => {
    const home = makeHome();
    const rawSentinel = "RAW_OUTPUT_SENTINEL";
    const handle = await startServer({
      goblinHome: home,
      botToken: BOT_TOKEN,
      allowedUserIds: [OPERATOR_ID],
      allowedOrigins: [ORIGIN],
      discover: async () => {
        const failure = new Error(`discovery exploded: ${rawSentinel}`) as Error & { reason: string; exitCode?: number };
        failure.reason = "process-failed";
        throw failure;
      },
    });
    try {
      const auth = validInitData();
      const bodies: string[] = [];
      const badAuth = await fetch(`${handle.url}/api/config`, {
        headers: { authorization: "tma malformed" },
      });
      bodies.push(await badAuth.text());
      const secretTarget = await putSection(handle, auth, "general", {
        patch: { botToken: "hushed-secret-value" },
      });
      bodies.push(await secretTarget.text());
      const badCatalog = await fetch(`${handle.url}/api/catalog`, {
        headers: { authorization: `tma ${auth}` },
      });
      bodies.push(await badCatalog.text());
      const notFound = await fetch(`${handle.url}/api/nope`, {
        headers: { authorization: `tma ${auth}` },
      });
      bodies.push(await notFound.text());
      const joined = bodies.join("\n");
      expect(joined).not.toContain(BOT_TOKEN);
      expect(joined).not.toContain(auth);
      expect(joined).not.toContain(rawSentinel);
      expect(joined).not.toContain("hushed-secret-value");
      const logs = loggedText();
      expect(logs).not.toContain(BOT_TOKEN);
      expect(logs).not.toContain(auth);
      expect(logs).not.toContain(rawSentinel);
      expect(logs).not.toContain("hushed-secret-value");
    } finally {
      await handle.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
