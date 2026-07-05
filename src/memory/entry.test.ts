import { describe, it, expect } from "bun:test";
import {
  formatReflectedEntry,
  parseEntryMetadata,
  stripEntryMetadata,
  type EntryMetadata,
} from "./entry.ts";

const BASE_METADATA: EntryMetadata = {
  category: "decision",
  confidence: 0.86,
  created_at: "2026-07-03T00:00:00.000Z",
  updated_at: "2026-07-03T00:00:00.000Z",
  source_session: "s_123",
  source_role: "user",
};

describe("memory entry metadata", () => {
  describe("formatReflectedEntry", () => {
    it("formats a metadata-bearing entry with the comment header and body", () => {
      const entry = formatReflectedEntry(BASE_METADATA, "Decided: no vector database for memory in v1.");
      expect(entry.startsWith("<!-- memory:")).toBe(true);
      expect(entry.endsWith("Decided: no vector database for memory in v1.")).toBe(true);
      expect(entry).toContain("category=decision");
      expect(entry).toContain("confidence=0.86");
      expect(entry).toContain("created_at=2026-07-03T00:00:00.000Z");
      expect(entry).toContain("updated_at=2026-07-03T00:00:00.000Z");
      expect(entry).toContain("source_session=s_123");
      expect(entry).toContain("source_role=user");
    });

    it("includes updated_source_session when present", () => {
      const entry = formatReflectedEntry(
        { ...BASE_METADATA, updated_source_session: "s_456" },
        "Updated preference.",
      );
      expect(entry).toContain("updated_source_session=s_456");
    });

    it("omits updated_source_session when absent", () => {
      const entry = formatReflectedEntry(BASE_METADATA, "Body.");
      expect(entry).not.toContain("updated_source_session");
    });

    it("emits fields in a stable order", () => {
      const entry = formatReflectedEntry(BASE_METADATA, "Body.");
      const header = entry.slice(0, entry.indexOf(" -->"));
      const fields = header.split(" ").slice(2); // drop "<!--" and "memory:"
      const keys = fields.map((f) => f.split("=")[0]);
      expect(keys).toEqual([
        "category",
        "confidence",
        "created_at",
        "updated_at",
        "source_session",
        "source_role",
      ]);
    });
  });

  describe("parseEntryMetadata", () => {
    it("round-trips a formatted entry", () => {
      const text = "User prefers terse engineering summaries with command/test evidence.";
      const entry = formatReflectedEntry(BASE_METADATA, text);
      const parsed = parseEntryMetadata(entry);
      expect(parsed).not.toBeNull();
      expect(parsed!.metadata).toEqual(BASE_METADATA);
      expect(parsed!.body).toBe(text);
    });

    it("round-trips an entry with updated_source_session", () => {
      const meta = { ...BASE_METADATA, updated_source_session: "s_456" };
      const entry = formatReflectedEntry(meta, "Body.");
      const parsed = parseEntryMetadata(entry);
      expect(parsed!.metadata).toEqual(meta);
    });

    it("returns null for a legacy plain entry", () => {
      expect(parseEntryMetadata("Just a plain legacy entry.")).toBeNull();
    });

    it("returns null for an entry without the memory prefix", () => {
      expect(parseEntryMetadata("<!-- something else -->\nbody")).toBeNull();
    });

    it("returns null when the closing suffix is missing", () => {
      expect(parseEntryMetadata("<!-- memory: category=decision confidence=0.86")).toBeNull();
    });

    it("returns null when required fields are missing", () => {
      const malformed = "<!-- memory: category=decision confidence=0.86 -->\nbody";
      expect(parseEntryMetadata(malformed)).toBeNull();
    });

    it("returns null for an unknown category", () => {
      const entry = formatReflectedEntry(BASE_METADATA, "body").replace(
        "category=decision",
        "category=unknown_cat",
      );
      expect(parseEntryMetadata(entry)).toBeNull();
    });

    it("round-trips a commitment category entry", () => {
      const meta: EntryMetadata = { ...BASE_METADATA, category: "commitment" };
      const entry = formatReflectedEntry(meta, "I commit to reviewing invoices every Friday.");
      const parsed = parseEntryMetadata(entry);
      expect(parsed).not.toBeNull();
      expect(parsed!.metadata.category).toBe("commitment");
      expect(parsed!.body).toBe("I commit to reviewing invoices every Friday.");
    });

    it("round-trips a standing_order category entry", () => {
      const meta: EntryMetadata = { ...BASE_METADATA, category: "standing_order" };
      const entry = formatReflectedEntry(meta, "standing order: remind me to check backups weekly");
      const parsed = parseEntryMetadata(entry);
      expect(parsed).not.toBeNull();
      expect(parsed!.metadata.category).toBe("standing_order");
      expect(parsed!.body).toBe("standing order: remind me to check backups weekly");
    });

    it("returns null for an unknown source_role", () => {
      const entry = formatReflectedEntry(BASE_METADATA, "body").replace(
        "source_role=user",
        "source_role=alien",
      );
      expect(parseEntryMetadata(entry)).toBeNull();
    });

    it("handles a multi-line body", () => {
      const text = "Line one.\nLine two.\nLine three.";
      const entry = formatReflectedEntry(BASE_METADATA, text);
      const parsed = parseEntryMetadata(entry);
      expect(parsed!.body).toBe(text);
    });
  });

  describe("stripEntryMetadata", () => {
    it("returns the body for a metadata-bearing entry", () => {
      const text = "User prefers terse summaries.";
      const entry = formatReflectedEntry(BASE_METADATA, text);
      expect(stripEntryMetadata(entry)).toBe(text);
    });

    it("returns legacy entries unchanged", () => {
      const legacy = "Plain legacy entry with no metadata.";
      expect(stripEntryMetadata(legacy)).toBe(legacy);
    });

    it("round-trips through format then strip", () => {
      const text = "Some durable fact.";
      expect(stripEntryMetadata(formatReflectedEntry(BASE_METADATA, text))).toBe(text);
    });
  });
});
