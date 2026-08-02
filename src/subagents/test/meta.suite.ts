import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SubagentRunner } from "../mod.ts";
import { FakeSubagentHost } from "./fake-host.ts";
import {
  loadSubagentMeta,
  parseSubagentMeta,
  SubagentMetadataAmbiguityError,
  writeMetaAtomic,
} from "../meta.ts";
import {
  genericSubagentDir,
  genericSubagentMetaPath,
  listNamedAgents,
  namedAgentAgentsMdPath,
  namedAgentDir,
  namedAgentInstanceDir,
  namedAgentInstanceMetaPath,
  namedAgentsRoot,
} from "../paths.ts";
import {
  createTestHome,
  DEFAULT_AUTHORITY,
  DEFAULT_PARENT_CAPTURE,
  EMPTY_GENERIC_SUBAGENT_INHERITANCE,
  flush,
  makeConfig,
} from "./support.ts";

function validMeta(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    role: "generic",
    name: null,
    spawnedBy: null,
    activeScope: DEFAULT_PARENT_CAPTURE.authority.activeScope,
    depth: 1,
    createdAt: new Date().toISOString(),
    status: "completed",
    ...overrides,
  };
}

function writeMeta(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value));
}

function writeSession(path: string): void {
  writeFileSync(path, "");
}

describe("Subagent metadata boundary", () => {
  let tmp: string;
  let runner: SubagentRunner;
  let host: FakeSubagentHost;

  beforeEach(() => {
    tmp = createTestHome("goblin-subagent-meta-boundary-");
    host = new FakeSubagentHost();
    runner = new SubagentRunner(makeConfig(tmp), undefined, undefined, host);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("rejects malformed instance IDs before filesystem lookup", async () => {
    for (const id of ["", "../escape", "nested/id", "..\\escape"]) {
      await expect(
        runner.revive(DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, id, "go"),
      ).rejects.toThrow(/safe path segment/);
    }

    expect(existsSync(join(tmp, "scratch"))).toBe(false);
  });

  it("normalizes the historical object-or-null namedAgent field and writes current scope", () => {
    const currentScope = { chatId: -100123, topicScope: "general" } as const;
    for (const [index, namedAgent] of [
      { name: "legacy-agent" },
      null,
    ].entries()) {
      const id = `legacy-scope-${index}`;
      const dir = genericSubagentDir(tmp, id);
      mkdirSync(dir, { recursive: true });
      const path = genericSubagentMetaPath(tmp, id);
      const parsed = parseSubagentMeta(
        validMeta(id, {
          activeScope: { ...currentScope, namedAgent },
        }),
        path,
      );

      expect(parsed.activeScope).toEqual(currentScope);
      writeMetaAtomic(path, parsed);
      expect(JSON.parse(readFileSync(path, "utf-8")).activeScope).toEqual(currentScope);
    }

    expect(() =>
      parseSubagentMeta(
        validMeta("legacy-string", {
          activeScope: { ...currentScope, namedAgent: "legacy-agent" },
        }),
        genericSubagentMetaPath(tmp, "legacy-string"),
      ),
    ).toThrow();
  });

  it("rejects a generic record whose id disagrees with its path", async () => {
    const id = "requested-id";
    const dir = genericSubagentDir(tmp, id);
    mkdirSync(dir, { recursive: true });
    writeMeta(genericSubagentMetaPath(tmp, id), validMeta("different-id"));
    writeSession(join(dir, "2026-01-01T00-00-00.jsonl"));

    await expect(
      runner.revive(DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, id, "go"),
    ).rejects.toThrow(/record id does not match/);
  });

  it("rejects a named record whose name disagrees with its directory", async () => {
    const id = "named-id";
    mkdirSync(namedAgentDir(tmp, "researcher"), { recursive: true });
    writeFileSync(namedAgentAgentsMdPath(tmp, "researcher"), "# Researcher");
    const dir = namedAgentInstanceDir(tmp, "researcher", id);
    mkdirSync(dir, { recursive: true });
    writeMeta(
      namedAgentInstanceMetaPath(tmp, "researcher", id),
      validMeta(id, { role: "named", name: "writer" }),
    );
    writeSession(join(dir, "2026-01-01T00-00-00.jsonl"));

    await expect(
      runner.revive(DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, id, "go"),
    ).rejects.toThrow(/record name does not match/);
  });

  it("does not fall through a corrupt generic record into a named tree", async () => {
    const id = "same-id";
    const genericDir = genericSubagentDir(tmp, id);
    mkdirSync(genericDir, { recursive: true });
    writeFileSync(genericSubagentMetaPath(tmp, id), "not-json");

    mkdirSync(namedAgentDir(tmp, "researcher"), { recursive: true });
    writeFileSync(namedAgentAgentsMdPath(tmp, "researcher"), "# Researcher");
    const namedDir = namedAgentInstanceDir(tmp, "researcher", id);
    mkdirSync(namedDir, { recursive: true });
    writeMeta(
      namedAgentInstanceMetaPath(tmp, "researcher", id),
      validMeta(id, { role: "named", name: "researcher" }),
    );
    writeSession(join(namedDir, "2026-01-01T00-00-00.jsonl"));

    await expect(
      runner.revive(DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, id, "go"),
    ).rejects.toThrow(/malformed JSON/);
  });

  it("rejects ambiguity between generic and named records with the same id", () => {
    const id = "duplicate-generic-named";
    const genericDir = genericSubagentDir(tmp, id);
    mkdirSync(genericDir, { recursive: true });
    writeMeta(genericSubagentMetaPath(tmp, id), validMeta(id));

    mkdirSync(namedAgentDir(tmp, "researcher"), { recursive: true });
    mkdirSync(namedAgentInstanceDir(tmp, "researcher", id), { recursive: true });
    writeMeta(
      namedAgentInstanceMetaPath(tmp, "researcher", id),
      validMeta(id, { role: "named", name: "researcher" }),
    );

    let failure: unknown;
    try {
      loadSubagentMeta(tmp, id);
    } catch (err) {
      failure = err;
    }
    expect(failure).toBeInstanceOf(SubagentMetadataAmbiguityError);
    const ambiguity = failure as SubagentMetadataAmbiguityError;
    expect(ambiguity.paths).toHaveLength(2);
    expect(ambiguity.message).toContain(id);
  });

  it("rejects ambiguity across multiple named-agent records", () => {
    const id = "duplicate-named";
    for (const name of ["researcher", "writer"]) {
      mkdirSync(namedAgentDir(tmp, name), { recursive: true });
      mkdirSync(namedAgentInstanceDir(tmp, name, id), { recursive: true });
      writeMeta(
        namedAgentInstanceMetaPath(tmp, name, id),
        validMeta(id, { role: "named", name }),
      );
    }

    expect(() => loadSubagentMeta(tmp, id)).toThrow(SubagentMetadataAmbiguityError);
  });

  it("revives a named instance beneath a symlinked named-agent directory", async () => {
    const id = "symlinked-named";
    const targetDir = join(tmp, "named-agent-target");
    const targetInstanceDir = join(targetDir, "instances", id);
    mkdirSync(targetInstanceDir, { recursive: true });
    writeFileSync(join(targetDir, "AGENTS.md"), "# Researcher");
    writeMeta(join(targetInstanceDir, "meta.json"), validMeta(id, {
      role: "named",
      name: "researcher",
    }));
    writeSession(join(targetInstanceDir, "2026-01-01T00-00-00.jsonl"));

    mkdirSync(namedAgentsRoot(tmp), { recursive: true });
    symlinkSync(targetDir, namedAgentDir(tmp, "researcher"), "dir");

    expect(listNamedAgents(tmp)).toEqual(["researcher"]);
    expect(loadSubagentMeta(tmp, id).meta.name).toBe("researcher");

    const revival = runner.revive(
      DEFAULT_PARENT_CAPTURE,
      EMPTY_GENERIC_SUBAGENT_INHERITANCE,
      id,
      "continue",
    );
    await flush();
    host.latest().complete("revived");
    await expect(revival).resolves.toBe("revived");
  });

  it("never reconstructs a missing or corrupt record during cancellation", async () => {
    const missing = await runner.spawn({
      prompt: "missing metadata",
      authority: DEFAULT_AUTHORITY,
      inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE,
    });
    await flush();
    rmSync(genericSubagentMetaPath(tmp, missing.id));

    await expect(runner.cancel(missing.id)).rejects.toThrow(/metadata file is missing/);
    expect(existsSync(genericSubagentMetaPath(tmp, missing.id))).toBe(false);

    const corrupt = await runner.spawn({
      prompt: "corrupt metadata",
      authority: DEFAULT_AUTHORITY,
      inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE,
    });
    await flush();
    const corruptPath = genericSubagentMetaPath(tmp, corrupt.id);
    writeFileSync(corruptPath, "not-json");

    await expect(runner.cancel(corrupt.id)).rejects.toThrow(/malformed JSON/);
    expect(readFileSync(corruptPath, "utf-8")).toBe("not-json");
    expect(host.latest().stopCalls).toBe(1);
  });

  it("rejects status-dependent metadata that has no error detail", async () => {
    const id = "invalid-status";
    const dir = genericSubagentDir(tmp, id);
    mkdirSync(dir, { recursive: true });
    writeMeta(genericSubagentMetaPath(tmp, id), validMeta(id, { status: "error" }));
    writeSession(join(dir, "2026-01-01T00-00-00.jsonl"));

    await expect(
      runner.revive(DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, id, "go"),
    ).rejects.toThrow(/error records must include errorMessage/);
  });
});
