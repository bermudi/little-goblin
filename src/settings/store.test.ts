import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSON5 from "json5";
import { setMcpServerEnabled } from "../mcp/selection-store.ts";
import { goblinConfigLockPath } from "../sessions/paths.ts";
import { ConfigFileSchema } from "../schema.ts";
import { SettingsStoreError } from "./store.ts";

interface DeploymentSettings {
  devinDefaultModel: string | null;
  revision: string;
}
interface SecretPresence {
  present: boolean;
}
interface DeploymentConfig {
  general: {
    model: string;
    logLevel: string;
    toolVisibility: string;
    voiceName: string;
    asrModel: string;
    favorites: string[];
    allowedUsers: number[];
  };
  embeddings: {
    baseUrl?: string;
    model?: string;
    provider?: string;
    cooldownSeconds?: number;
    apiKey: SecretPresence;
  };
  "external-agents": { backends: string[] };
  devin: { defaultModel: string | null };
  settings: {
    enabled: boolean;
    port: number;
    publicUrl?: string;
    allowedOrigins?: string[];
  };
  secrets: Record<string, SecretPresence>;
  revision: string;
}
interface StoreModule {
  readDeploymentSettings(goblinHome: string): DeploymentSettings;
  readDeploymentConfig(goblinHome: string): DeploymentConfig;
  saveConfigSection(
    goblinHome: string,
    section: string,
    patch: unknown,
    options?: { expectedRevision?: string },
  ): { revision: string };
}

// Dynamic loading lets the verifier-only commit typecheck before implementation.
const modulePath = "./store.ts";
async function load(): Promise<StoreModule> {
  const loaded: unknown = await import(modulePath);
  return loaded as StoreModule;
}

function makeHome(initial: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), "goblin-settings-store-"));
  writeFileSync(join(home, "goblin.json5"), JSON5.stringify(initial, { space: 2 }) + "\n", "utf-8");
  return home;
}

function errorReason(error: unknown): string {
  if (error instanceof Error) {
    const reason = (error as { reason?: unknown }).reason;
    return typeof reason === "string" ? reason : "";
  }
  return "";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

async function catchOf(thunk: () => unknown): Promise<unknown> {
  return await Promise.resolve()
    .then(thunk)
    .catch((error: unknown) => error);
}

describe("Durable deployment config writes", () => {
  it("saved devin default survives settings owner reconstruction", async () => {
    const { readDeploymentSettings, saveConfigSection } = await load();
    const home = makeHome({ botToken: "x", allowedUsers: [1], model: "m" });
    try {
      expect(readDeploymentSettings(home).devinDefaultModel).toBeNull();
      const saved = saveConfigSection(home, "devin", { defaultModel: "test-model" });
      expect(typeof saved.revision).toBe("string");
      // Owner reconstruction is a fresh read of the same deployment file.
      const reread = readDeploymentSettings(home);
      expect(reread.devinDefaultModel).toBe("test-model");
      expect(reread.revision).toBe(saved.revision);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("stale and invalid saves cannot overwrite committed settings", async () => {
    const { readDeploymentSettings, saveConfigSection } = await load();
    const home = makeHome({ botToken: "x", allowedUsers: [1], model: "m" });
    try {
      const committed = saveConfigSection(home, "devin", { defaultModel: "test-model" });
      // Stale revision is rejected.
      const staleError: unknown = await Promise.resolve()
        .then(() => saveConfigSection(home, "devin", { defaultModel: "other-model" }, { expectedRevision: "stale" }))
        .catch((error: unknown) => error);
      expect(errorReason(staleError)).toBe("stale-revision");
      // Invalid model values are rejected before any write. (Padded ids pass
      // the file schema; exactness is owned by the catalog save flow.)
      for (const bad of ["", 5, null, true]) {
        const error: unknown = await Promise.resolve()
          .then(() => saveConfigSection(home, "devin", { defaultModel: bad }))
          .catch((err: unknown) => err);
        expect(errorReason(error)).toBe("invalid-config");
      }
      const afterFailures = readDeploymentSettings(home);
      expect(afterFailures.devinDefaultModel).toBe("test-model");
      expect(afterFailures.revision).toBe(committed.revision);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("MCP and settings writes share conflict protection", async () => {
    const { readDeploymentSettings, saveConfigSection } = await load();
    const home = makeHome({ botToken: "x", allowedUsers: [1], model: "m", mcp: {} });
    try {
      const before = readDeploymentSettings(home);
      setMcpServerEnabled(home, "tavily", false);
      // A settings save based on the pre-MCP revision must not clobber it.
      const conflict: unknown = await Promise.resolve()
        .then(() =>
          saveConfigSection(home, "devin", { defaultModel: "test-model" }, { expectedRevision: before.revision }),
        )
        .catch((error: unknown) => error);
      expect(errorReason(conflict)).toBe("stale-revision");
      const raw = JSON5.parse(readFileSync(join(home, "goblin.json5"), "utf-8")) as {
        mcp?: { disabledServers?: string[] };
      };
      expect(raw.mcp?.disabledServers).toEqual(["tavily"]);
      // A fresh settings save preserves the MCP section.
      saveConfigSection(home, "devin", { defaultModel: "test-model" }, {
        expectedRevision: readDeploymentSettings(home).revision,
      });
      expect(readDeploymentSettings(home).devinDefaultModel).toBe("test-model");
      const merged = JSON5.parse(readFileSync(join(home, "goblin.json5"), "utf-8")) as {
        mcp?: { disabledServers?: string[] };
        devin?: { defaultModel?: string };
      };
      expect(merged.mcp?.disabledServers).toEqual(["tavily"]);
      expect(merged.devin?.defaultModel).toBe("test-model");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("failed durable writes do not publish new values", async () => {
    const { readDeploymentSettings, saveConfigSection } = await load();
    const home = makeHome({ botToken: "x", allowedUsers: [1], model: "m" });
    try {
      const committed = saveConfigSection(home, "devin", { defaultModel: "test-model" });
      // A live lock forces the coordinated write to fail without publishing.
      const lockPath = goblinConfigLockPath(home);
      writeFileSync(lockPath, `${process.pid}\n`, "utf-8");
      try {
        const error: unknown = await Promise.resolve()
          .then(() =>
            saveConfigSection(home, "devin", { defaultModel: "other-model" }, { expectedRevision: committed.revision }),
          )
          .catch((err: unknown) => err);
        expect(error).toBeInstanceOf(Error);
      } finally {
        rmSync(lockPath, { force: true });
      }
      const afterFailure = readDeploymentSettings(home);
      expect(afterFailure.devinDefaultModel).toBe("test-model");
      expect(afterFailure.revision).toBe(committed.revision);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 10_000);

  it("non-secret projection preserves private config and file mode", async () => {
    const { readDeploymentSettings, saveConfigSection } = await load();
    const home = makeHome({
      botToken: "secret-token",
      allowedUsers: [1],
      model: "m",
      openrouterApiKey: "secret-key",
      mcp: { disabledServers: ["a"] },
    });
    try {
      const target = join(home, "goblin.json5");
      chmodSync(target, 0o600);
      saveConfigSection(home, "devin", { defaultModel: "test-model" });
      expect(readDeploymentSettings(home).devinDefaultModel).toBe("test-model");
      expect(statSync(target).mode & 0o777).toBe(0o600);
      const raw = JSON5.parse(readFileSync(target, "utf-8")) as Record<string, unknown>;
      expect(raw.botToken).toBe("secret-token");
      expect(raw.openrouterApiKey).toBe("secret-key");
      const projected = JSON.stringify(readDeploymentSettings(home));
      expect(projected).not.toContain("secret-token");
      expect(projected).not.toContain("secret-key");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("Deployment config store", () => {
  it("readDeploymentConfig returns whitelisted fields, secret presence flags, and revision", async () => {
    const { readDeploymentConfig } = await load();
    const home = makeHome({
      botToken: "secret-token",
      allowedUsers: [1, 2],
      model: "main-model",
      logLevel: "debug",
      toolVisibility: "minimal",
      favorites: ["fav-one"],
      voiceName: "en-US-AriaNeural",
      asrModel: "whisper-large-v3",
      openrouterApiKey: "secret-openrouter",
      openaiApiKey: "secret-openai",
      anthropicApiKey: "secret-anthropic",
      zaiApiKey: "secret-zai",
      opencodeApiKey: "secret-opencode",
      groqApiKey: "secret-groq",
      embeddings: {
        apiKey: "secret-embeddings",
        baseUrl: "https://embeddings.example",
        model: "emb-model",
        provider: "openai",
        cooldownSeconds: 30,
      },
      externalAgents: { backends: ["devin"], devinModel: "legacy-snapshot-model" },
      devin: { defaultModel: "devin-default-model" },
      settings: {
        enabled: true,
        port: 4242,
        publicUrl: "https://goblin.example.ts.net",
        allowedOrigins: ["https://goblin.example.ts.net"],
      },
    });
    try {
      const config = readDeploymentConfig(home);
      expect(config.general).toEqual({
        model: "main-model",
        logLevel: "debug",
        toolVisibility: "minimal",
        voiceName: "en-US-AriaNeural",
        asrModel: "whisper-large-v3",
        favorites: ["fav-one"],
        allowedUsers: [1, 2],
      });
      expect(config.embeddings).toEqual({
        baseUrl: "https://embeddings.example",
        model: "emb-model",
        provider: "openai",
        cooldownSeconds: 30,
        apiKey: { present: true },
      });
      expect(config["external-agents"]).toEqual({ backends: ["devin"] });
      expect(config.devin).toEqual({ defaultModel: "devin-default-model" });
      expect(config.settings).toEqual({
        enabled: true,
        port: 4242,
        publicUrl: "https://goblin.example.ts.net",
        allowedOrigins: ["https://goblin.example.ts.net"],
      });
      expect(config.secrets).toEqual({
        botToken: { present: true },
        openrouterApiKey: { present: true },
        openaiApiKey: { present: true },
        anthropicApiKey: { present: true },
        zaiApiKey: { present: true },
        opencodeApiKey: { present: true },
        groqApiKey: { present: true },
      });
      expect(config.revision).toMatch(/^[0-9a-f]{64}$/);
      // Secret values never leave the store in any form.
      const projected = JSON.stringify(config);
      for (const secret of [
        "secret-token",
        "secret-openrouter",
        "secret-openai",
        "secret-anthropic",
        "secret-zai",
        "secret-opencode",
        "secret-groq",
        "secret-embeddings",
      ]) {
        expect(projected).not.toContain(secret);
      }
      // The legacy startup snapshot is never surfaced (decision 0049).
      expect(projected).not.toContain("devinModel");
      expect(projected).not.toContain("legacy-snapshot-model");

      // Minimal file: schema defaults fill the projection; absent secrets are
      // presence flags only.
      const minimal = makeHome({ botToken: "t", allowedUsers: [1], model: "m" });
      try {
        const bare = readDeploymentConfig(minimal);
        expect(bare.general.logLevel).toBe("info");
        expect(bare.general.toolVisibility).toBe("standard");
        expect(bare.general.voiceName.length).toBeGreaterThan(0);
        expect(bare.general.asrModel).toBe("whisper-large-v3-turbo");
        expect(bare.general.favorites).toEqual([]);
        expect(bare.embeddings.apiKey).toEqual({ present: false });
        expect(bare["external-agents"]).toEqual({ backends: [] });
        expect(bare.devin).toEqual({ defaultModel: null });
        expect(bare.settings.enabled).toBe(false);
        expect(bare.settings.port).toBe(3423);
        expect(bare.secrets.botToken).toEqual({ present: true });
        expect(bare.secrets.groqApiKey).toEqual({ present: false });
      } finally {
        rmSync(minimal, { recursive: true, force: true });
      }

      // Missing config file is the one expected error (ENOENT); everything
      // else fails loud.
      const empty = mkdtempSync(join(tmpdir(), "goblin-settings-store-"));
      try {
        let caught: unknown;
        try {
          readDeploymentConfig(empty);
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(SettingsStoreError);
        expect(caught instanceof SettingsStoreError && caught.reason === "missing-config").toBe(true);
      } finally {
        rmSync(empty, { recursive: true, force: true });
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("saveConfigSection writes only the target section and returns the new revision", async () => {
    const { readDeploymentConfig, saveConfigSection } = await load();
    const home = makeHome({
      botToken: "t",
      allowedUsers: [1],
      model: "main-model",
      mcp: { disabledServers: ["tavily"] },
      devin: { defaultModel: "kept-model" },
    });
    try {
      const before = readDeploymentConfig(home);
      const saved = saveConfigSection(home, "settings", { enabled: true, port: 5050 });
      expect(typeof saved.revision).toBe("string");
      expect(saved.revision).not.toBe(before.revision);
      const after = readDeploymentConfig(home);
      expect(after.revision).toBe(saved.revision);
      expect(after.settings).toMatchObject({ enabled: true, port: 5050 });
      expect(after.general.model).toBe("main-model");
      expect(after.devin).toEqual({ defaultModel: "kept-model" });

      // `general` holds the top-level whitelisted fields; only its keys move.
      saveConfigSection(home, "general", { logLevel: "debug", favorites: ["fav-one"] }, {
        expectedRevision: saved.revision,
      });
      const raw = JSON5.parse(readFileSync(join(home, "goblin.json5"), "utf-8")) as Record<string, unknown>;
      expect(raw.logLevel).toBe("debug");
      expect(raw.favorites).toEqual(["fav-one"]);
      expect(raw.botToken).toBe("t");
      expect(raw.model).toBe("main-model");
      expect(raw.mcp).toEqual({ disabledServers: ["tavily"] });
      // The in-file result still parses as a valid ConfigFile.
      expect(ConfigFileSchema.safeParse(raw).success).toBe(true);
      const reread = readDeploymentConfig(home);
      expect(reread.general).toMatchObject({ logLevel: "debug", favorites: ["fav-one"] });

      // Unknown sections are rejected before any filesystem effect; `mcp`
      // stays owned by McpSelectionStore (decision 0042).
      const beforeUnknown = readFileSync(join(home, "goblin.json5"), "utf-8");
      const unknownSection = await catchOf(() => saveConfigSection(home, "mcp", { enabled: [] }));
      expect(unknownSection).toBeInstanceOf(Error);
      expect(errorReason(unknownSection)).toBe("unknown-section");
      expect(errorText(unknownSection)).toContain("McpSelectionStore");
      expect(readFileSync(join(home, "goblin.json5"), "utf-8")).toBe(beforeUnknown);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("saveConfigSection preserves unrelated keys and file mode", async () => {
    const { readDeploymentConfig, saveConfigSection } = await load();
    const home = makeHome({
      botToken: "t",
      allowedUsers: [1],
      model: "m",
      embeddings: {
        apiKey: "secret-embeddings",
        baseUrl: "https://embeddings.example",
        model: "emb-model",
        provider: "openai",
        cooldownSeconds: 1,
      },
      externalAgents: { backends: ["claude"], devinModel: "legacy-snapshot-model" },
    });
    const target = join(home, "goblin.json5");
    chmodSync(target, 0o600);
    try {
      saveConfigSection(home, "embeddings", { cooldownSeconds: 45 });
      expect(statSync(target).mode & 0o777).toBe(0o600);
      const raw = JSON5.parse(readFileSync(target, "utf-8")) as Record<string, unknown>;
      const embeddings = raw.embeddings as Record<string, unknown>;
      expect(embeddings.cooldownSeconds).toBe(45);
      expect(embeddings.apiKey).toBe("secret-embeddings");
      expect(embeddings.baseUrl).toBe("https://embeddings.example");
      expect(embeddings.model).toBe("emb-model");
      expect(embeddings.provider).toBe("openai");

      saveConfigSection(home, "external-agents", { backends: ["claude", "devin"] });
      const rawAfter = JSON5.parse(readFileSync(target, "utf-8")) as Record<string, unknown>;
      const externalAgents = rawAfter.externalAgents as Record<string, unknown>;
      expect(externalAgents.backends).toEqual(["claude", "devin"]);
      // The legacy snapshot key round-trips untouched: operator-owned, never
      // written through the store (decision 0049).
      expect(externalAgents.devinModel).toBe("legacy-snapshot-model");
      const projected = JSON.stringify(readDeploymentConfig(home));
      expect(projected).not.toContain("legacy-snapshot-model");
      expect(projected).not.toContain("secret-embeddings");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("saveConfigSection rejects secret field targets with actionable error", async () => {
    const { readDeploymentConfig, saveConfigSection } = await load();
    const home = makeHome({ botToken: "t", allowedUsers: [1], model: "m" });
    try {
      const beforeText = readFileSync(join(home, "goblin.json5"), "utf-8");
      const beforeRevision = readDeploymentConfig(home).revision;
      const secretTargets: [string, Record<string, unknown>][] = [
        ["general", { botToken: "leaked-token-value" }],
        ["general", { openrouterApiKey: "leaked-openrouter-value" }],
        ["general", { openaiApiKey: "leaked-openai-value" }],
        ["general", { anthropicApiKey: "leaked-anthropic-value" }],
        ["general", { zaiApiKey: "leaked-zai-value" }],
        ["general", { opencodeApiKey: "leaked-opencode-value" }],
        ["general", { groqApiKey: "leaked-groq-value" }],
        ["embeddings", { apiKey: "leaked-embeddings-value" }],
      ];
      for (const [section, patch] of secretTargets) {
        const error = await catchOf(() => saveConfigSection(home, section, patch));
        expect(error).toBeInstanceOf(Error);
        expect(errorReason(error)).toBe("secret-field");
        const text = errorText(error);
        // Actionable: names the field, never echoes the attempted value.
        expect(text).toMatch(/never writable/);
        for (const [field, value] of Object.entries(patch)) {
          expect(text).toContain(field);
          expect(text).not.toContain(String(value));
        }
      }
      expect(readFileSync(join(home, "goblin.json5"), "utf-8")).toBe(beforeText);
      expect(readDeploymentConfig(home).revision).toBe(beforeRevision);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("saveConfigSection rejects schema-invalid patches before any write", async () => {
    const { saveConfigSection } = await load();
    const home = makeHome({ botToken: "t", allowedUsers: [1], model: "m" });
    try {
      const beforeText = readFileSync(join(home, "goblin.json5"), "utf-8");
      const cases: [string, Record<string, unknown>][] = [
        ["general", { allowedUsers: [] }],
        ["general", { logLevel: "bogus" }],
        ["general", { asrModel: "bogus" }],
        ["settings", { port: 99999 }],
        ["settings", { publicUrl: "http://insecure.example" }],
        ["embeddings", { cooldownSeconds: -5 }],
        ["devin", { defaultModel: "" }],
      ];
      for (const [section, patch] of cases) {
        const error = await catchOf(() => saveConfigSection(home, section, patch));
        expect(error).toBeInstanceOf(Error);
        expect(errorReason(error)).toBe("invalid-config");
      }
      // Unknown patch keys for a known section are rejected too.
      const unknownField = await catchOf(() => saveConfigSection(home, "settings", { botToken: "x" }));
      expect(errorReason(unknownField)).toBe("unknown-field");
      // The legacy Devin snapshot is never a write target (decision 0049).
      const devinModel = await catchOf(() => saveConfigSection(home, "external-agents", { devinModel: "new-model" }));
      expect(errorReason(devinModel)).toBe("unknown-field");
      expect(errorText(devinModel)).toContain("devin.defaultModel");
      expect(readFileSync(join(home, "goblin.json5"), "utf-8")).toBe(beforeText);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("saveConfigSection rejects stale revision", async () => {
    const { readDeploymentConfig, saveConfigSection } = await load();
    const home = makeHome({ botToken: "t", allowedUsers: [1], model: "m", devin: { defaultModel: "kept" } });
    try {
      const before = readDeploymentConfig(home);
      const committed = saveConfigSection(home, "general", { model: "next-model" });
      expect(committed.revision).not.toBe(before.revision);
      // A write based on the pre-commit revision must not clobber it.
      const stale = await catchOf(() =>
        saveConfigSection(home, "devin", { defaultModel: "stale-model" }, { expectedRevision: before.revision })
      );
      expect(errorReason(stale)).toBe("stale-revision");
      let raw = JSON5.parse(readFileSync(join(home, "goblin.json5"), "utf-8")) as Record<string, unknown>;
      expect(raw.model).toBe("next-model");
      expect(raw.devin).toEqual({ defaultModel: "kept" });
      // The fresh revision succeeds.
      const fresh = saveConfigSection(home, "devin", { defaultModel: "fresh-model" }, {
        expectedRevision: committed.revision,
      });
      expect(readDeploymentConfig(home).devin).toEqual({ defaultModel: "fresh-model" });
      // Concurrent writers (McpSelectionStore) participate in the same CAS.
      const reread = readDeploymentConfig(home);
      expect(reread.revision).toBe(fresh.revision);
      setMcpServerEnabled(home, "tavily", false);
      const clobber = await catchOf(() =>
        saveConfigSection(home, "general", { favorites: ["f"] }, { expectedRevision: reread.revision })
      );
      expect(errorReason(clobber)).toBe("stale-revision");
      raw = JSON5.parse(readFileSync(join(home, "goblin.json5"), "utf-8")) as Record<string, unknown>;
      expect((raw.mcp as Record<string, unknown>).disabledServers).toEqual(["tavily"]);
      expect(raw.favorites).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
