import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_SNAPSHOT_ENTRIES,
  MAX_TOTAL_SKILL_SNAPSHOT_BYTES,
  resolveSkillSet,
  DEFAULT_SKILL_POLICY,
  SkillResolutionError,
  type SkillPolicy,
} from "./mod.ts";
import {
  goblinSkillsPath,
  personalEnvironmentSkillsPath,
} from "../../workspace/paths.ts";
import {
  personalEnvironment,
  projectEnvironment,
} from "../../sessions/environment.ts";

/** Write a minimal valid SKILL.md into a skill directory. */
function writeSkill(root: string, name: string, body = "Does the thing."): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`,
    "utf-8",
  );
}

describe("SkillCatalogResolver", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "goblin-skills-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("default policy (goblin all, environment all, host none)", () => {
    it("loads goblin and personal-environment skills, excludes host", async () => {
      writeSkill(goblinSkillsPath(tmpDir), "goblin-skill");
      writeSkill(personalEnvironmentSkillsPath(tmpDir), "env-skill");
      // Host skill that must NOT be loaded. Write it to the real host root to
      // prove the default policy excludes it; skip the host-exclusion assertion
      // if the sandbox blocks $HOME writes.
      const hostRoot = join(homedir(), ".agents", "skills");
      const hostSkillName = "goblin-resolver-test-host-skill";
      const hostSkillDir = join(hostRoot, hostSkillName);
      let hostWritten = false;
      try {
        writeSkill(hostRoot, hostSkillName);
        hostWritten = true;
      } catch (err) {
        console.warn(`host exclusion test skipped write: ${(err as Error).message}`);
      }

      const result = await resolveSkillSet(
        personalEnvironment(),
        DEFAULT_SKILL_POLICY,
        tmpDir,
      );

      const names = result.skills.map((s) => s.name);
      expect(names).toContain("goblin-skill");
      expect(names).toContain("env-skill");
      try {
        if (hostWritten) {
          expect(names).not.toContain(hostSkillName);
        }
      } finally {
        if (hostWritten) rmSync(hostSkillDir, { recursive: true, force: true });
      }
    });

    it("loads goblin and project-environment skills from exact project roots only", async () => {
      const projectRoot = join(tmpDir, "my-project");
      mkdirSync(projectRoot, { recursive: true });
      writeSkill(goblinSkillsPath(tmpDir), "goblin-skill");
      writeSkill(join(projectRoot, ".agents", "skills"), "project-skill");
      writeSkill(join(projectRoot, ".pi", "skills"), "pi-project-skill");

      const result = await resolveSkillSet(
        projectEnvironment(projectRoot),
        DEFAULT_SKILL_POLICY,
        tmpDir,
      );

      // Goblin skill loads via the goblin source; project skills load via the
      // environment source from exact project roots. No ancestor walk occurs
      // because loadSourcedSkills receives exact paths, not pi ambient discovery.
      const goblinEntries = result.skills.filter((s) => s.source === "goblin");
      const envEntries = result.skills.filter((s) => s.source === "environment");
      expect(goblinEntries.map((s) => s.name)).toEqual(["goblin-skill"]);
      expect(envEntries.map((s) => s.name).sort()).toEqual(["pi-project-skill", "project-skill"]);
    });

    it("returns empty skills when no catalogs are populated", async () => {
      const result = await resolveSkillSet(
        personalEnvironment(),
        DEFAULT_SKILL_POLICY,
        tmpDir,
      );
      expect(result.skills).toEqual([]);
      expect(result.diagnostics).toEqual([]);
      expect(result.fingerprint).toBeTypeOf("string");
      expect(result.fingerprint.length).toBeGreaterThan(0);
    });
  });

  describe("policy selection", () => {
    it("host all loads host skills", async () => {
      const hostRoot = join(homedir(), ".agents", "skills");
      const hostSkillName = "goblin-resolver-host-all-test";
      const hostSkillDir = join(hostRoot, hostSkillName);
      try {
        writeSkill(hostRoot, hostSkillName);
      } catch (err) {
        // Skip if $HOME not writable in this sandbox rather than masking a
        // failure as a pass.
        console.warn(`host skill test skipped: ${(err as Error).message}`);
        return;
      }
      try {
        const policy: SkillPolicy = {
          goblin: { mode: "none" },
          environment: { mode: "none" },
          host: { mode: "all" },
        };
        const result = await resolveSkillSet(personalEnvironment(), policy, tmpDir);
        const names = result.skills.map((s) => s.name);
        expect(names).toContain(hostSkillName);
      } finally {
        rmSync(hostSkillDir, { recursive: true, force: true });
      }
    });

    it("selected mode loads only named skills", async () => {
      writeSkill(goblinSkillsPath(tmpDir), "alpha");
      writeSkill(goblinSkillsPath(tmpDir), "beta");
      writeSkill(goblinSkillsPath(tmpDir), "gamma");

      const policy: SkillPolicy = {
        goblin: { mode: "selected", names: ["alpha", "gamma"] },
        environment: { mode: "none" },
        host: { mode: "none" },
      };
      const result = await resolveSkillSet(personalEnvironment(), policy, tmpDir);
      const names = result.skills.map((s) => s.name).sort();
      expect(names).toEqual(["alpha", "gamma"]);
    });

    it("selected names are validated at the input boundary", async () => {
      const policy: SkillPolicy = {
        goblin: { mode: "selected", names: ["UPPERCASE"] },
        environment: { mode: "none" },
        host: { mode: "none" },
      };
      await expect(
        resolveSkillSet(personalEnvironment(), policy, tmpDir),
      ).rejects.toThrow(SkillResolutionError);
    });

    it("a selected name absent from the catalog is an error", async () => {
      writeSkill(goblinSkillsPath(tmpDir), "alpha");
      const policy: SkillPolicy = {
        goblin: { mode: "selected", names: ["alpha", "missing"] },
        environment: { mode: "none" },
        host: { mode: "none" },
      };
      await expect(
        resolveSkillSet(personalEnvironment(), policy, tmpDir),
      ).rejects.toThrow(/not found in goblin catalog: missing/);
    });
  });

  describe("deduplication and conflicts", () => {
    it("deduplicates the same file selected through two roots", async () => {
      // Make the goblin and environment roots the same directory via a symlink.
      // Simpler: write the same skill into both roots by making env root a
      // symlink to goblin root. If symlink creation fails, skip.
      const goblinRoot = goblinSkillsPath(tmpDir);
      const envRoot = personalEnvironmentSkillsPath(tmpDir);
      writeSkill(goblinRoot, "shared");
      // Replace the environment root with a symlink to the goblin root so both
      // sources resolve to the same canonical files.
      rmSync(envRoot, { recursive: true, force: true });
      // Recreate the parent directory that rmSync removed, so symlinkSync has
      // a valid parent to create the link in.
      mkdirSync(join(envRoot, ".."), { recursive: true });
      try {
        symlinkSync(goblinRoot, envRoot, "dir");
      } catch (err) {
        // Skip on sandboxed filesystems without symlink support rather than
        // masking a failure as a pass.
        console.warn(`symlink dedup test skipped: ${(err as Error).message}`);
        return;
      }

      const policy: SkillPolicy = {
        goblin: { mode: "all" },
        environment: { mode: "all" },
        host: { mode: "none" },
      };
      const result = await resolveSkillSet(personalEnvironment(), policy, tmpDir);
      const shared = result.skills.filter((s) => s.name === "shared");
      // The same canonical file is deduplicated to one entry.
      expect(shared).toHaveLength(1);
    });

    it("fails on distinct files with the same skill name", async () => {
      writeSkill(goblinSkillsPath(tmpDir), "dup-name", "goblin body");
      writeSkill(personalEnvironmentSkillsPath(tmpDir), "dup-name", "env body");

      const policy: SkillPolicy = {
        goblin: { mode: "all" },
        environment: { mode: "all" },
        host: { mode: "none" },
      };
      await expect(
        resolveSkillSet(personalEnvironment(), policy, tmpDir),
      ).rejects.toThrow(/skill name "dup-name" selected from distinct files/);
    });
  });

  describe("fingerprint stability", () => {
    it("is stable across resolves with the same inputs", async () => {
      writeSkill(goblinSkillsPath(tmpDir), "stable-skill");
      const a = await resolveSkillSet(personalEnvironment(), DEFAULT_SKILL_POLICY, tmpDir);
      const b = await resolveSkillSet(personalEnvironment(), DEFAULT_SKILL_POLICY, tmpDir);
      expect(a.fingerprint).toBe(b.fingerprint);
    });

    it("changes when the environment changes", async () => {
      writeSkill(goblinSkillsPath(tmpDir), "fp-skill");
      const projectRoot = join(tmpDir, "proj");
      mkdirSync(projectRoot, { recursive: true });
      const personal = await resolveSkillSet(personalEnvironment(), DEFAULT_SKILL_POLICY, tmpDir);
      const project = await resolveSkillSet(projectEnvironment(projectRoot), DEFAULT_SKILL_POLICY, tmpDir);
      expect(personal.fingerprint).not.toBe(project.fingerprint);
    });

    it("changes when the policy changes", async () => {
      writeSkill(goblinSkillsPath(tmpDir), "fp-policy");
      const allPolicy = DEFAULT_SKILL_POLICY;
      const nonePolicy: SkillPolicy = {
        goblin: { mode: "none" },
        environment: { mode: "none" },
        host: { mode: "none" },
      };
      const a = await resolveSkillSet(personalEnvironment(), allPolicy, tmpDir);
      const b = await resolveSkillSet(personalEnvironment(), nonePolicy, tmpDir);
      expect(a.fingerprint).not.toBe(b.fingerprint);
    });
  });

  describe("diagnostics", () => {
    it("surfaces pi parser diagnostics with source provenance", async () => {
      // Write a SKILL.md with an invalid name in frontmatter. Pi falls back to
      // the directory name but emits an invalid_metadata diagnostic.
      const goblinRoot = goblinSkillsPath(tmpDir);
      const dir = join(goblinRoot, "bad-name-skill");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "SKILL.md"),
        "---\nname: UPPERCASE INVALID\ndescription: has desc\n---\nbody\n",
        "utf-8",
      );

      const result = await resolveSkillSet(personalEnvironment(), DEFAULT_SKILL_POLICY, tmpDir);
      expect(result.diagnostics.length).toBeGreaterThan(0);
      const diag = result.diagnostics.find((d) => d.source === "goblin");
      expect(diag).toBeDefined();
      expect(diag!.source).toBe("goblin");
      expect(diag!.code).toBe("invalid_metadata");
    });
  });

  describe("snapshot limits", () => {
    it("caps the number of visited skill-directory entries", async () => {
      const root = goblinSkillsPath(tmpDir);
      const skillDir = join(root, "many-resources");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, "SKILL.md"),
        "---\nname: many-resources\ndescription: many resources\n---\nbody\n",
        "utf-8",
      );
      for (let index = 0; index < MAX_SKILL_SNAPSHOT_ENTRIES; index += 1) {
        writeFileSync(join(skillDir, `empty-${index}`), "");
      }

      await expect(
        resolveSkillSet(personalEnvironment(), DEFAULT_SKILL_POLICY, tmpDir, { captureSnapshots: true }),
      ).rejects.toThrow(
        `skill snapshot exceeds ${MAX_SKILL_SNAPSHOT_ENTRIES} entries: ${skillDir}`,
      );
    });

    it("caps the aggregate size of individually valid skill snapshots", async () => {
      const root = goblinSkillsPath(tmpDir);
      const skillCount = Math.ceil(MAX_TOTAL_SKILL_SNAPSHOT_BYTES / MAX_SKILL_FILE_BYTES) + 1;
      const resource = Buffer.alloc(MAX_SKILL_FILE_BYTES, 65);
      for (let index = 0; index < skillCount; index += 1) {
        const name = `large-skill-${index}`;
        writeSkill(root, name);
        writeFileSync(join(root, name, "resource.bin"), resource);
      }

      await expect(
        resolveSkillSet(personalEnvironment(), DEFAULT_SKILL_POLICY, tmpDir, { captureSnapshots: true }),
      ).rejects.toThrow(
        `skill snapshots exceed ${MAX_TOTAL_SKILL_SNAPSHOT_BYTES} bytes`,
      );
    });
  });
});
