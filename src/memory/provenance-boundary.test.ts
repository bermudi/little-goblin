import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SRC_DIR = join(import.meta.dir, "..");

function walkTs(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      results.push(...walkTs(join(dir, entry.name)));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      results.push(join(dir, entry.name));
    }
  }
  return results;
}

type ImportInfo = {
  module: string;
  names: string[];
};

function parseNamedBindings(bindings: string): string[] {
  const names: string[] = [];
  for (const entry of bindings.split(",")) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    if (/^type\s+/.test(trimmed)) continue;
    const parts = trimmed.split(/\s+as\s+/);
    const original = parts[0]?.trim() ?? "";
    if (original.length > 0) names.push(original);
  }
  return names;
}

function parseImports(src: string): ImportInfo[] {
  const imports: ImportInfo[] = [];

  const namedRe = /import(\s+type)?\s*\{\s*([\s\S]*?)\s*\}\s*from\s+["']([^"']+)["']/g;
  for (const m of src.matchAll(namedRe)) {
    const isTypeOnly = m[1] != null;
    const modulePath = m[3];
    const bindings = m[2];
    if (modulePath == null || bindings == null) continue;
    imports.push({
      module: modulePath,
      names: isTypeOnly ? [] : parseNamedBindings(bindings),
    });
  }

  const defaultRe = /import(\s+type)?\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from\s+["']([^"']+)["']/g;
  for (const m of src.matchAll(defaultRe)) {
    const isTypeOnly = m[1] != null;
    const modulePath = m[3];
    const name = m[2];
    if (modulePath == null || name == null) continue;
    imports.push({
      module: modulePath,
      names: isTypeOnly ? [] : [name],
    });
  }

  const namespaceRe = /import(\s+type)?\s*\*\s*as\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from\s+["']([^"']+)["']/g;
  for (const m of src.matchAll(namespaceRe)) {
    const isTypeOnly = m[1] != null;
    const modulePath = m[3];
    const name = m[2];
    if (modulePath == null || name == null) continue;
    imports.push({
      module: modulePath,
      names: isTypeOnly ? [] : [name],
    });
  }

  return imports;
}

const STATE_BINDING_MODULES = [
  "../sessions/state.ts",
  "../sessions/manager.ts",
  "../sessions/bindings.ts",
  "../sessions/conversation-store.ts",
  "../sessions/project-assignment.ts",
];

const RAW_RECORD_OPERATIONS = [
  "readTranscriptRawDocument",
  "readTranscriptRawDocumentAtPath",
  "writeTranscriptRawDocument",
];

const RAW_RECORD_ALLOWED_PATHS = new Set([
  join("sessions", "transcript.ts").replace(/\\/g, "/"),
  join("sessions", "transcript-provenance-migration.ts").replace(/\\/g, "/"),
]);

function normalizeRel(rel: string): string {
  return rel.replace(/\\/g, "/");
}

function checkStateBindingImports(rel: string, src: string): string[] {
  const violations: string[] = [];
  const imports = parseImports(src);
  for (const imp of imports) {
    for (const forbidden of STATE_BINDING_MODULES) {
      if (imp.module === forbidden) {
        violations.push(
          `${rel}: forbidden import "${imp.module}" from session state or binding module`,
        );
      }
    }
  }
  return violations;
}

function checkRawRecordImports(rel: string, src: string): string[] {
  const violations: string[] = [];
  const imports = parseImports(src);
  for (const imp of imports) {
    for (const name of imp.names) {
      if (RAW_RECORD_OPERATIONS.includes(name)) {
        if (!RAW_RECORD_ALLOWED_PATHS.has(normalizeRel(rel))) {
          violations.push(
            `${rel}: imports raw-record operation "${name}" from "${imp.module}" but is not the transcript module or TranscriptProvenanceMigrator`,
          );
        }
      }
    }
  }
  return violations;
}

describe("provenance boundary", () => {
  describe("transcript indexing and dreaming do not import session state or current bindings", () => {
    const files = [
      join(SRC_DIR, "memory", "transcript-index.ts"),
      join(SRC_DIR, "memory", "dreaming.ts"),
    ];

    it("checks the indexing and dreaming source files", () => {
      for (const file of files) {
        expect(readFileSync(file, "utf-8")).toBeTruthy();
      }
    });

    for (const file of files) {
      const rel = relative(SRC_DIR, file);
      it(`${normalizeRel(rel)} does not import session state or current bindings`, () => {
        const src = readFileSync(file, "utf-8");
        const violations = checkStateBindingImports(normalizeRel(rel), src);
        expect(violations, violations.join("\n")).toEqual([]);
      });
    }
  });

  describe("lossless raw-record operations stay inside the migration", () => {
    const files = walkTs(SRC_DIR).filter(
      (f) => !f.endsWith(".d.ts") && !f.includes(".test.ts"),
    );

    it("finds at least one source file", () => {
      expect(files.length).toBeGreaterThan(0);
    });

    it("detects raw-record operations in multi-line imports", () => {
      const src = `import {
        readTranscriptRawDocument,
        readTranscriptRawDocumentAtPath,
        writeTranscriptRawDocument,
        type TranscriptRawDocument,
      } from "../sessions/transcript.ts";`;
      const violations = checkRawRecordImports("memory/evil.ts", src);
      expect(violations.length).toBe(3);
      expect(violations[0]).toContain("readTranscriptRawDocument");
      expect(violations[1]).toContain("readTranscriptRawDocumentAtPath");
      expect(violations[2]).toContain("writeTranscriptRawDocument");
    });

    it("allows the migrator to import raw-record operations", () => {
      const src = `import {
        readTranscriptRawDocument,
        readTranscriptRawDocumentAtPath,
        writeTranscriptRawDocument,
        type TranscriptRawDocument,
      } from "./transcript.ts";`;
      const violations = checkRawRecordImports(
        "sessions/transcript-provenance-migration.ts",
        src,
      );
      expect(violations).toEqual([]);
    });

    for (const file of files) {
      const rel = relative(SRC_DIR, file);
      it(`${normalizeRel(rel)} only imports raw-record operations when allowed`, () => {
        const src = readFileSync(file, "utf-8");
        const violations = checkRawRecordImports(normalizeRel(rel), src);
        expect(violations, violations.join("\n")).toEqual([]);
      });
    }
  });
});
