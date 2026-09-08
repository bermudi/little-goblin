import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSON5 from "json5";

interface PageVariant {
  id: string;
  label: string;
  contextTokens?: number;
  costSummary?: string;
  isNew: boolean;
  isBeta: boolean;
}

interface PageFamily {
  id: string;
  slug: string;
  label: string;
  aliases: string[];
  variants: PageVariant[];
}

interface PageCatalog {
  families: PageFamily[];
}

interface PageModule {
  renderSettingsPage(): string;
  escapeHtml(value: string): string;
  filterCatalogFamilies(catalog: PageCatalog, query: string): PageCatalog;
}

interface ServerOptions {
  goblinHome: string;
  botToken: string;
  allowedUserIds: readonly number[];
  allowedOrigins: readonly string[];
  discover?: (signal: AbortSignal) => Promise<PageCatalog>;
}

interface ServerHandle {
  url: string;
  close(): Promise<void>;
}

interface ServerModule {
  startSettingsServer(options: ServerOptions): ServerHandle | Promise<ServerHandle>;
}

// Dynamic loading lets the verifier-only commit typecheck before implementation.
const pagePath = "./page.ts";
const serverPath = "./server.ts";

async function loadPage(): Promise<PageModule> {
  const loaded: unknown = await import(pagePath);
  return loaded as PageModule;
}

async function startServer(options: ServerOptions): Promise<ServerHandle> {
  const loaded: unknown = await import(serverPath);
  return await (loaded as ServerModule).startSettingsServer(options);
}

const BOT_TOKEN = "test-bot-token-page-789";
const OPERATOR_ID = 123;
const ORIGIN = "https://app.example";

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "goblin-settings-page-"));
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
  return [...Object.entries(params), ["hash", hash] as [string, string]]
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

function validInitData(botToken = BOT_TOKEN, userId = OPERATOR_ID, authDate?: number): string {
  const auth_date = String(authDate ?? Math.floor(Date.now() / 1000));
  const user = JSON.stringify({ id: userId, first_name: "Op" });
  return signInitData({ auth_date, user }, botToken);
}

function testCatalog(): PageCatalog {
  return {
    families: [
      {
        id: "atlas-family",
        slug: "atlas",
        label: "Atlas family",
        aliases: ["atlas-alias"],
        variants: [
          { id: "atlas-exact-a", label: "Atlas A", contextTokens: 200000, costSummary: "$2/MTok", isNew: true, isBeta: false },
          { id: "atlas-exact-b", label: "Atlas B", isNew: false, isBeta: true },
        ],
      },
      {
        id: "boreal-family",
        slug: "boreal",
        label: "Boreal family",
        aliases: ["boreal-alias"],
        variants: [{ id: "boreal-exact", label: "Boreal One", isNew: false, isBeta: false }],
      },
    ],
  };
}

describe("Search and save inside Telegram", () => {
  it("searchable model selection saves and survives reopening the page", async () => {
    const { renderSettingsPage, filterCatalogFamilies } = await loadPage();
    const home = makeHome();
    const handle = await startServer({
      goblinHome: home,
      botToken: BOT_TOKEN,
      allowedUserIds: [OPERATOR_ID],
      allowedOrigins: [ORIGIN],
      discover: async () => testCatalog(),
    });
    try {
      // The real page is a searchable Telegram-themed shell, not a model-button wall.
      const pageRes = await fetch(`${handle.url}/`);
      expect(pageRes.status).toBe(200);
      expect(pageRes.headers.get("content-type")).toContain("text/html");
      const page = await pageRes.text();
      expect(page).toContain('type="search"');
      expect(page).toContain("telegram-web-app.js");
      expect(page).toContain("/api/catalog");
      expect(page).toContain("/api/settings");
      expect(page).toContain("Telegram.WebApp.initData");
      expect(page).not.toContain(BOT_TOKEN);

      // Search matches family labels, aliases, and exact variant identities.
      const catalog = testCatalog();
      expect(filterCatalogFamilies(catalog, "").families).toHaveLength(2);
      expect(filterCatalogFamilies(catalog, "atlas-alias").families.map((f) => f.id)).toEqual(["atlas-family"]);
      expect(filterCatalogFamilies(catalog, "Boreal").families.map((f) => f.id)).toEqual(["boreal-family"]);
      const variantHit = filterCatalogFamilies(catalog, "boreal-exact");
      expect(variantHit.families.map((f) => f.id)).toEqual(["boreal-family"]);
      expect(variantHit.families[0]?.variants.map((v) => v.id)).toEqual(["boreal-exact"]);
      const subset = filterCatalogFamilies(catalog, "atlas-exact-b");
      expect(subset.families.map((f) => f.id)).toEqual(["atlas-family"]);
      expect(subset.families[0]?.variants.map((v) => v.id)).toEqual(["atlas-exact-b"]);
      expect(filterCatalogFamilies(catalog, "no-such-model").families).toHaveLength(0);

      // Save an exact model through the same API the page uses, then reopen.
      const auth = validInitData();
      const before = (await (
        await fetch(`${handle.url}/api/settings`, { headers: { authorization: `tma ${auth}` } })
      ).json()) as { devinDefaultModel: string | null; revision: string };
      expect(before.devinDefaultModel).toBeNull();
      const saveRes = await fetch(`${handle.url}/api/settings`, {
        method: "POST",
        headers: { authorization: `tma ${auth}`, origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ modelId: "atlas-exact-a", expectedRevision: before.revision }),
      });
      expect(saveRes.status).toBe(200);

      const reopened = await fetch(`${handle.url}/`);
      expect(reopened.status).toBe(200);
      const persisted = (await (
        await fetch(`${handle.url}/api/settings`, { headers: { authorization: `tma ${auth}` } })
      ).json()) as { devinDefaultModel: string | null };
      expect(persisted.devinDefaultModel).toBe("atlas-exact-a");
      expect(renderSettingsPage()).toBe(page);
    } finally {
      await handle.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("expired and conflicting saves remain visibly unsaved", async () => {
    const { renderSettingsPage } = await loadPage();
    const home = makeHome();
    const handle = await startServer({
      goblinHome: home,
      botToken: BOT_TOKEN,
      allowedUserIds: [OPERATOR_ID],
      allowedOrigins: [ORIGIN],
      discover: async () => testCatalog(),
    });
    try {
      const auth = validInitData();
      const before = (await (
        await fetch(`${handle.url}/api/settings`, { headers: { authorization: `tma ${auth}` } })
      ).json()) as { devinDefaultModel: string | null; revision: string };
      const first = await fetch(`${handle.url}/api/settings`, {
        method: "POST",
        headers: { authorization: `tma ${auth}`, origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ modelId: "atlas-exact-a", expectedRevision: before.revision }),
      });
      expect(first.status).toBe(200);

      // Expired authentication cannot save.
      const expired = validInitData(BOT_TOKEN, OPERATOR_ID, Math.floor(Date.now() / 1000) - 4000);
      const expiredRes = await fetch(`${handle.url}/api/settings`, {
        method: "POST",
        headers: { authorization: `tma ${expired}`, origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ modelId: "boreal-exact" }),
      });
      expect(expiredRes.status).toBe(401);

      // A stale revision cannot overwrite the committed selection.
      const staleRes = await fetch(`${handle.url}/api/settings`, {
        method: "POST",
        headers: { authorization: `tma ${auth}`, origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ modelId: "boreal-exact", expectedRevision: before.revision }),
      });
      expect(staleRes.status).toBe(409);

      const current = (await (
        await fetch(`${handle.url}/api/settings`, { headers: { authorization: `tma ${auth}` } })
      ).json()) as { devinDefaultModel: string | null };
      expect(current.devinDefaultModel).toBe("atlas-exact-a");

      // The page keeps expired sessions, stale conflicts, and success visibly distinct.
      const page = renderSettingsPage();
      expect(page).toContain("status-loading");
      expect(page).toContain("status-saved");
      expect(page).toContain("expired");
      expect(page).toContain("conflict");
    } finally {
      await handle.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("provider labels are inert and discovery errors remain visible", async () => {
    const { escapeHtml, renderSettingsPage } = await loadPage();
    const hostile = `<script>alert(1)</script><img src=x onerror=alert(2)>`;
    const escaped = escapeHtml(hostile);
    expect(escaped).not.toContain("<script>");
    expect(escaped).not.toContain("<img");
    expect(escaped).toContain("&lt;script&gt;");

    // The delivered page renders provider text as text, never HTML.
    const page = renderSettingsPage();
    expect(page).toContain("textContent");
    expect(page).not.toContain("innerHTML");

    // Classified discovery failures surface visibly without raw output.
    const sentinel = "RAW_OUTPUT_SENTINEL";
    const home = makeHome();
    const handle = await startServer({
      goblinHome: home,
      botToken: BOT_TOKEN,
      allowedUserIds: [OPERATOR_ID],
      allowedOrigins: [ORIGIN],
      discover: async () => {
        throw Object.assign(new Error(`exploded: ${sentinel}`), { reason: "process-failed" });
      },
    });
    try {
      const catalogRes = await fetch(`${handle.url}/api/catalog`, {
        headers: { authorization: `tma ${validInitData()}` },
      });
      expect(catalogRes.status).toBe(502);
      const body = await catalogRes.text();
      expect(body).not.toContain(sentinel);
      expect(body).toContain("process-failed");
      expect(page).toContain("catalog-error");
      expect(readFileSync(join(home, "goblin.json5"), "utf-8")).not.toContain(sentinel);
    } finally {
      await handle.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("Search and save inside Telegram production wiring", () => {
  it("deployment owns a stable listener and URL configuration", async () => {
    const schemaPath = "../schema.ts";
    const loaded: unknown = await import(schemaPath);
    const mod = loaded as Record<string, unknown>;
    const SettingsConfigSchema = mod.SettingsConfigSchema as
      | { parse: (value: unknown) => { enabled: boolean; port: number } }
      | undefined;
    expect(SettingsConfigSchema).toBeDefined();
    const parsed = SettingsConfigSchema!.parse({});
    expect(parsed.enabled).toBe(false);
    expect(parsed.port).toBe(3423);
    expect(parsed.port).not.toBe(0);
    const fileMod = loaded as {
      ConfigFileSchema?: { shape?: Record<string, unknown> };
    };
    expect(fileMod.ConfigFileSchema?.shape?.settings).toBeDefined();
  });

  it("settings server binds the configured stable loopback port", async () => {
    const serverPath = "./server.ts";
    const loaded: unknown = await import(serverPath);
    const starter = (
      loaded as {
        startSettingsServer: (
          options: ServerOptions & { port?: number },
        ) => ServerHandle | Promise<ServerHandle>;
      }
    ).startSettingsServer;
    expect(typeof starter).toBe("function");
    const home = makeHome();
    try {
      const ephemeral = await starter({
        goblinHome: home,
        botToken: BOT_TOKEN,
        allowedUserIds: [OPERATOR_ID],
        allowedOrigins: [ORIGIN],
        discover: async () => testCatalog(),
      });
      const freePort = Number(new URL(ephemeral.url).port);
      expect(ephemeral.url).toContain("127.0.0.1");
      await ephemeral.close();
      const stable = await starter({
        goblinHome: home,
        botToken: BOT_TOKEN,
        allowedUserIds: [OPERATOR_ID],
        allowedOrigins: [ORIGIN],
        port: freePort,
        discover: async () => testCatalog(),
      });
      try {
        expect(new URL(stable.url).hostname).toBe("127.0.0.1");
        expect(Number(new URL(stable.url).port)).toBe(freePort);
      } finally {
        await stable.close();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("telegram launch entry exposes a web_app URL without secrets", async () => {
    const telegramPath = "./telegram.ts";
    const loaded: unknown = await import(telegramPath);
    const mod = loaded as {
      buildSettingsEntryReply: (cfg: unknown) => {
        text: string;
        webAppUrl: string | null;
        replyMarkup: {
          inline_keyboard: { text: string; web_app?: { url: string } }[][];
        } | null;
      };
      syncSettingsMenuButton: (
        api: unknown,
        cfg: unknown,
        warn: (message: string, context?: Record<string, unknown>) => void,
      ) => Promise<void>;
    };
    expect(typeof mod.buildSettingsEntryReply).toBe("function");
    expect(typeof mod.syncSettingsMenuButton).toBe("function");
    const enabledCfg = {
      botToken: BOT_TOKEN,
      allowedTgUserIds: new Set([OPERATOR_ID]),
      goblinHome: "/tmp/goblin-settings-wiring",
      modelName: "m",
      logLevel: "info" as const,
      toolVisibility: "standard" as const,
      favorites: [],
      voiceName: "v",
      settings: {
        enabled: true,
        port: 3423,
        publicUrl: "https://settings.example",
        allowedOrigins: undefined,
      },
    };
    const entry = mod.buildSettingsEntryReply(enabledCfg);
    expect(entry.webAppUrl).toBe("https://settings.example/");
    expect(entry.text).toContain("https://settings.example/");
    expect(entry.text).not.toContain(BOT_TOKEN);
    expect(JSON.stringify(entry.replyMarkup)).toContain("web_app");
    expect(JSON.stringify(entry.replyMarkup)).toContain("https://settings.example/");
    expect(JSON.stringify(entry.replyMarkup)).not.toContain(BOT_TOKEN);
    const disabledCfg = {
      ...enabledCfg,
      settings: { enabled: false, port: 3423 },
    };
    const disabled = mod.buildSettingsEntryReply(disabledCfg);
    expect(disabled.webAppUrl).toBeNull();
    expect(disabled.replyMarkup).toBeNull();
    expect(disabled.text).not.toContain(BOT_TOKEN);
    const registryPath = "../commands/registry.ts";
    const registryLoaded: unknown = await import(registryPath);
    const registry = registryLoaded as {
      COMMAND_REGISTRY: { name: string }[];
      telegramBotCommands: () => { command: string }[];
      helpReply: () => string;
    };
    expect(registry.COMMAND_REGISTRY.some((def) => def.name === "settings")).toBe(true);
    expect(registry.telegramBotCommands().some((cmd) => cmd.command === "settings")).toBe(true);
    expect(registry.helpReply()).toContain("/settings");
    let menuPayload: unknown = null;
    const api = {
      setChatMenuButton: async (payload: unknown) => {
        menuPayload = payload;
      },
    };
    await mod.syncSettingsMenuButton(api, enabledCfg, () => {});
    expect(JSON.stringify(menuPayload)).toContain("web_app");
    expect(JSON.stringify(menuPayload)).toContain("https://settings.example/");
    expect(JSON.stringify(menuPayload)).not.toContain(BOT_TOKEN);
    let called = false;
    await mod.syncSettingsMenuButton(
      {
        setChatMenuButton: async () => {
          called = true;
        },
      },
      disabledCfg,
      () => {},
    );
    expect(called).toBe(false);
  });

  it("composition owns startup and shutdown wiring", async () => {
    const compositionPath = "./composition.ts";
    const loaded: unknown = await import(compositionPath);
    const mod = loaded as {
      SETTINGS_DEFAULT_PORT: unknown;
      resolveDeploymentSettingsServerConfig: (cfg: unknown) => {
        enabled: boolean;
        port: number;
        publicUrl: string | null;
        allowedOrigins: readonly string[];
      } | null;
      settingsWebAppUrl: (cfg: unknown) => string | null;
      startDeploymentSettingsServer: (cfg: unknown) => {
        url: string;
        close: () => Promise<void>;
      } | null;
    };
    expect(mod.SETTINGS_DEFAULT_PORT).toBe(3423);
    expect(typeof mod.resolveDeploymentSettingsServerConfig).toBe("function");
    expect(typeof mod.settingsWebAppUrl).toBe("function");
    expect(typeof mod.startDeploymentSettingsServer).toBe("function");
    const disabledCfg = {
      botToken: BOT_TOKEN,
      allowedTgUserIds: new Set([OPERATOR_ID]),
      goblinHome: "/tmp/goblin-settings-wiring",
      modelName: "m",
      logLevel: "info" as const,
      toolVisibility: "standard" as const,
      favorites: [],
      voiceName: "v",
      settings: { enabled: false, port: 3423 },
    };
    expect(mod.resolveDeploymentSettingsServerConfig(disabledCfg)).toBeNull();
    expect(mod.settingsWebAppUrl(disabledCfg)).toBeNull();
    expect(mod.startDeploymentSettingsServer(disabledCfg)).toBeNull();
    const enabledCfg = {
      botToken: BOT_TOKEN,
      allowedTgUserIds: new Set([OPERATOR_ID]),
      goblinHome: "/tmp/goblin-settings-wiring",
      modelName: "m",
      logLevel: "info" as const,
      toolVisibility: "standard" as const,
      favorites: [],
      voiceName: "v",
      settings: {
        enabled: true,
        port: 3423,
        publicUrl: "https://settings.example",
        allowedOrigins: undefined,
      },
    };
    const resolved = mod.resolveDeploymentSettingsServerConfig(enabledCfg);
    expect(resolved?.enabled).toBe(true);
    expect(resolved?.port).toBe(3423);
    expect(resolved?.publicUrl).toBe("https://settings.example/");
    expect(resolved?.allowedOrigins).toEqual(["https://settings.example"]);
    expect(mod.settingsWebAppUrl(enabledCfg)).toBe("https://settings.example/");
    const indexText = readFileSync(join(import.meta.dir, "..", "index.ts"), "utf-8");
    expect(indexText).toContain("startDeploymentSettingsServer");
    expect(indexText).toContain("syncSettingsMenuButton");
    expect(indexText).not.toContain("0.0.0.0");
  });
});
