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

function importSpecifiers(src: string): string[] {
  return src
    .split("\n")
    .filter((line) => /^\s*import\b/.test(line))
    .map((line) => {
      const m = line.match(/from\s+["']([^"']+)["']/);
      return m?.[1] ?? "";
    })
    .filter((s) => s.length > 0);
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
      it(`${rel} does not import session state or current bindings`, () => {
        const src = readFileSync(file, "utf-8");
        const specifiers = importSpecifiers(src);
        for (const specifier of specifiers) {
          for (const forbidden of STATE_BINDING_MODULES) {
            expect(
              specifier,
              `${rel}: forbidden import "${specifier}" matches "${forbidden}"`,
            ).not.toBe(forbidden);
          }
        }
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

    for (const file of files) {
      const rel = relative(SRC_DIR, file);
      it(`${rel} only imports raw-record operations when allowed`, () => {
        const src = readFileSync(file, "utf-8");
        const specifiers = importSpecifiers(src);
        const importsRaw = specifiers.some((s) =>
          RAW_RECORD_OPERATIONS.some((op) => s.includes(op)),
        );
        if (!importsRaw) return;

        const allowed =
          rel === join("sessions", "transcript.ts").replace(/\\/g, "/") ||
          rel ===
            join("sessions", "transcript-provenance-migration.ts").replace(
              /\\/g,
              "/",
            );
        expect(
          allowed,
          `${rel}: imports a raw-record operation but is not the transcript module or TranscriptProvenanceMigrator`,
        ).toBe(true);
      });
    }
  });

});
