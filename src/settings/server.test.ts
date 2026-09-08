import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "goblin-settings-server-"));
  writeFileSync(
    join(home, "goblin.json5"),
    JSON5.stringify({ botToken: "x", allowedUsers: [OPERATOR_ID], model: "m" }) + "\n",
    "utf-8",
  );
  return home;
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
  it("verified operator can read and save settings over loopback HTTP", async () => {
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
      const before = await fetch(`${handle.url}/api/settings`, {
        headers: { authorization: `tma ${auth}` },
      });
      expect(before.status).toBe(200);
      const beforeBody = (await before.json()) as { devinDefaultModel: string | null; revision: string };
      expect(beforeBody.devinDefaultModel).toBeNull();
      expect(typeof beforeBody.revision).toBe("string");

      const catalogRes = await fetch(`${handle.url}/api/catalog`, {
        headers: { authorization: `tma ${auth}` },
      });
      expect(catalogRes.status).toBe(200);
      const catalog = (await catalogRes.json()) as TestCatalog;
      expect(catalog.families[0]?.variants.map((v) => v.id)).toEqual(["test-model"]);

      const saveRes = await fetch(`${handle.url}/api/settings`, {
        method: "POST",
        headers: {
          authorization: `tma ${auth}`,
          origin: ORIGIN,
          "content-type": "application/json",
        },
        body: JSON.stringify({ modelId: "test-model", expectedRevision: beforeBody.revision }),
      });
      expect(saveRes.status).toBe(200);
      const saved = (await saveRes.json()) as { devinDefaultModel: string; revision: string };
      expect(saved.devinDefaultModel).toBe("test-model");

      const after = await fetch(`${handle.url}/api/settings`, {
        headers: { authorization: `tma ${auth}` },
      });
      const afterBody = (await after.json()) as { devinDefaultModel: string | null };
      expect(afterBody.devinDefaultModel).toBe("test-model");
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
        const readRes = await fetch(`${handle.url}/api/settings`, {
          headers: { authorization: `tma ${bad}` },
        });
        expect(readRes.status).toBe(401);
        const catalogRes = await fetch(`${handle.url}/api/catalog`, {
          headers: { authorization: `tma ${bad}` },
        });
        expect(catalogRes.status).toBe(401);
        const writeRes = await fetch(`${handle.url}/api/settings`, {
          method: "POST",
          headers: { authorization: `tma ${bad}`, origin: ORIGIN, "content-type": "application/json" },
          body: JSON.stringify({ modelId: "test-model" }),
        });
        expect([401, 403]).toContain(writeRes.status);
      }
      // Missing credentials are rejected without side effects.
      const missing = await fetch(`${handle.url}/api/settings`);
      expect(missing.status).toBe(401);

      // Foreign-origin write with valid identity is rejected without mutation.
      const revision = (
        (await (
          await fetch(`${handle.url}/api/settings`, { headers: { authorization: `tma ${good}` } })
        ).json()) as { revision: string }
      ).revision;
      const crossOrigin = await fetch(`${handle.url}/api/settings`, {
        method: "POST",
        headers: { authorization: `tma ${good}`, origin: "https://evil.example", "content-type": "application/json" },
        body: JSON.stringify({ modelId: "test-model", expectedRevision: revision }),
      });
      expect(crossOrigin.status).toBe(403);

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
      const rejected: unknown = await fetch(`${handle.url}/api/settings`, {
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
      const oversized = await fetch(`${handle.url}/api/settings`, {
        method: "POST",
        headers: { authorization: `tma ${validInitData()}`, origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ modelId: "x".repeat(4096) }),
      });
      expect(oversized.status).toBe(413);

      const expired = validInitData(BOT_TOKEN, OPERATOR_ID, Math.floor(Date.now() / 1000) - 3600);
      const expiredRes = await fetch(`${handle.url}/api/settings`, {
        headers: { authorization: `tma ${expired}` },
      });
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
      const badAuth = await fetch(`${handle.url}/api/settings`, {
        headers: { authorization: "tma malformed" },
      });
      bodies.push(await badAuth.text());
      const badSave = await fetch(`${handle.url}/api/settings`, {
        method: "POST",
        headers: { authorization: `tma ${auth}`, origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ modelId: "" }),
      });
      bodies.push(await badSave.text());
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
      expect(joined).not.toContain("secret-token");
      const logs = loggedText();
      expect(logs).not.toContain(BOT_TOKEN);
      expect(logs).not.toContain(auth);
      expect(logs).not.toContain(rawSentinel);
    } finally {
      await handle.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
