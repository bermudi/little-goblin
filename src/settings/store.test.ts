import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSON5 from "json5";
import { setMcpServerEnabled } from "../mcp/selection-store.ts";
import { goblinConfigLockPath } from "../sessions/paths.ts";

interface CatalogVariant {
  id: string;
  label: string;
  isNew: boolean;
  isBeta: boolean;
}
interface Catalog {
  families: {
    id: string;
    slug: string;
    label: string;
    aliases: string[];
    variants: CatalogVariant[];
  }[];
}
interface DeploymentSettings {
  devinDefaultModel: string | null;
  revision: string;
}
interface StoreModule {
  readDeploymentSettings(goblinHome: string): DeploymentSettings;
  saveDeploymentModel(
    goblinHome: string,
    modelId: string,
    options?: { expectedRevision?: string; catalog?: Catalog },
  ): DeploymentSettings;
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

function catalogWith(modelId: string): Catalog {
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

describe("Durable deployment model selection", () => {
  it("selected model survives settings owner reconstruction", async () => {
    const { readDeploymentSettings, saveDeploymentModel } = await load();
    const home = makeHome({ botToken: "x", allowedUsers: [1], model: "m" });
    try {
      expect(readDeploymentSettings(home).devinDefaultModel).toBeNull();
      const catalog = catalogWith("test-model");
      const saved = saveDeploymentModel(home, "test-model", { catalog });
      expect(saved.devinDefaultModel).toBe("test-model");
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
    const { readDeploymentSettings, saveDeploymentModel } = await load();
    const home = makeHome({ botToken: "x", allowedUsers: [1], model: "m" });
    try {
      const catalog = catalogWith("test-model");
      const committed = saveDeploymentModel(home, "test-model", { catalog });
      const otherCatalog = catalogWith("other-model");
      // Stale revision is rejected.
      const staleError: unknown = await Promise.resolve()
        .then(() => saveDeploymentModel(home, "other-model", { catalog: otherCatalog, expectedRevision: "stale" }))
        .catch((error: unknown) => error);
      expect(staleError).toBeInstanceOf(Error);
      // Invalid selections are rejected: empty, padded, and unknown ids.
      for (const bad of ["", " test-model", "test-model ", "unknown-model"]) {
        const error: unknown = await Promise.resolve()
          .then(() => saveDeploymentModel(home, bad, { catalog }))
          .catch((error: unknown) => error);
        expect(error).toBeInstanceOf(Error);
      }
      expect(readDeploymentSettings(home)).toEqual(committed);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("MCP and settings writes share conflict protection", async () => {
    const { readDeploymentSettings, saveDeploymentModel } = await load();
    const home = makeHome({ botToken: "x", allowedUsers: [1], model: "m", mcp: {} });
    try {
      const before = readDeploymentSettings(home);
      setMcpServerEnabled(home, "tavily", false);
      // A settings save based on the pre-MCP revision must not clobber it.
      const conflict: unknown = await Promise.resolve()
        .then(() =>
          saveDeploymentModel(home, "test-model", {
            catalog: catalogWith("test-model"),
            expectedRevision: before.revision,
          }),
        )
        .catch((error: unknown) => error);
      expect(conflict).toBeInstanceOf(Error);
      const raw = JSON5.parse(readFileSync(join(home, "goblin.json5"), "utf-8")) as {
        mcp?: { disabledServers?: string[] };
      };
      expect(raw.mcp?.disabledServers).toEqual(["tavily"]);
      // A fresh settings save preserves the MCP section.
      const saved = saveDeploymentModel(home, "test-model", {
        catalog: catalogWith("test-model"),
        expectedRevision: readDeploymentSettings(home).revision,
      });
      expect(saved.devinDefaultModel).toBe("test-model");
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
    const { readDeploymentSettings, saveDeploymentModel } = await load();
    const home = makeHome({ botToken: "x", allowedUsers: [1], model: "m" });
    try {
      const committed = saveDeploymentModel(home, "test-model", { catalog: catalogWith("test-model") });
      // A live lock forces the coordinated write to fail without publishing.
      const lockPath = goblinConfigLockPath(home);
      writeFileSync(lockPath, `${process.pid}\n`, "utf-8");
      try {
        const error: unknown = await Promise.resolve()
          .then(() =>
            saveDeploymentModel(home, "other-model", {
              catalog: catalogWith("other-model"),
              expectedRevision: committed.revision,
            }),
          )
          .catch((error: unknown) => error);
        expect(error).toBeInstanceOf(Error);
      } finally {
        rmSync(lockPath, { force: true });
      }
      expect(readDeploymentSettings(home)).toEqual(committed);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 10_000);

  it("non-secret projection preserves private config and file mode", async () => {
    const { readDeploymentSettings, saveDeploymentModel } = await load();
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
      const saved = saveDeploymentModel(home, "test-model", { catalog: catalogWith("test-model") });
      expect(saved.devinDefaultModel).toBe("test-model");
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
