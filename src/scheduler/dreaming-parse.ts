/**
 * Parsing boundary for dreaming extractor model output.
 *
 * The model returns a JSON envelope `{ "candidates": [...] }` that may be
 * wrapped in markdown code fences. Item shape is validated by a zod schema;
 * a per-entry mapping step then resolves the context-dependent fields
 * (line-range fallback to excerpt bounds, source-role lookup from transcript
 * lines). Malformed items are rejected individually without discarding valid
 * siblings; every rejection appends a `malformed` quarantine record through
 * `appendQuarantine`, whose failures propagate (fail loud).
 */
import { z } from "zod";
import { DREAMING_CATEGORIES, type Candidate } from "../memory/dreaming.ts";
import type { EntrySourceRole } from "../memory/entry.ts";
import { appendQuarantine } from "../memory/quarantine.ts";
import type { TranscriptLine } from "../sessions/transcript.ts";

export interface ParseDreamingResponseArgs {
  /** `$GOBLIN_HOME`; used to append quarantine records for rejected content. */
  goblinHome: string;
  /** Raw model output text. */
  raw: string;
  /** Source Conversation ID; recorded as the candidate/quarantine provenance. */
  conversationId: string;
  /** Transcript excerpt lines the model saw; bounds the lineRange fallback. */
  lines: TranscriptLine[];
}

const dreamingEnvelopeSchema = z.object({
  candidates: z.array(z.unknown()),
});

const candidateItemSchema = z.preprocess(
  (item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return item;
    const record = item as Record<string, unknown>;
    // `summary` is accepted as a `text` alias, but only when `text` itself is
    // absent or non-string; a present string `text` always wins, even when
    // it trims to empty (which then rejects below).
    const text =
      typeof record.text === "string"
        ? record.text
        : typeof record.summary === "string"
          ? record.summary
          : undefined;
    return { ...record, text };
  },
  z.object({
    // `target` is optional — absent defaults to "memory" in the mapping step.
    // A present-but-invalid value fails the schema and quarantines the entry.
    target: z.enum(["memory", "user", "agent"]).optional(),
    category: z.enum(DREAMING_CATEGORIES),
    // Confidence accepts numbers in [0, 1]; non-numbers are coerced through
    // parseFloat(String(...)) exactly as the hand-rolled parser did, so a
    // string like "0.5" still parses while garbage becomes NaN and rejects.
    confidence: z.preprocess(
      (value) => (typeof value === "number" ? value : Number.parseFloat(String(value))),
      z.number().min(0).max(1),
    ),
    text: z
      .string()
      .transform((value) => value.trim())
      .pipe(z.string().min(1)),
    // Absent lineRange is fine (falls back to excerpt bounds); a
    // present-but-malformed or inverted range rejects the entry.
    lineRange: z
      .tuple([z.number().finite(), z.number().finite()])
      .refine(([start, end]) => start <= end)
      .optional(),
  }),
);

function roleForLine(line: TranscriptLine | undefined): EntrySourceRole {
  switch (line?.role) {
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "toolResult":
      return "tool";
    default:
      return "system";
  }
}

export function parseDreamingResponse(args: ParseDreamingResponseArgs): Candidate[] {
  const { goblinHome, raw, conversationId, lines } = args;
  const cleaned = raw
    .replace(/```(?:json)?\n([\s\S]*?)\n```/, "$1")
    .replace(/^```(?:json)?\s*/, "")
    .replace(/```\s*$/, "")
    .trim();

  const quarantineMalformed = (preview: string): void => {
    appendQuarantine({
      goblinHome,
      sourceSession: conversationId,
      targetScope: `transcript/${conversationId}`,
      category: null,
      reason: "malformed",
      content: preview,
      previewMaxLen: 200,
    });
  };

  if (cleaned.length === 0) return [];

  let json: unknown;
  try {
    json = JSON.parse(cleaned);
  } catch {
    quarantineMalformed(cleaned);
    return [];
  }

  const envelope = dreamingEnvelopeSchema.safeParse(json);
  if (!envelope.success) {
    quarantineMalformed(cleaned);
    return [];
  }

  const defaultStart = lines[0]?.index ?? 0;
  const defaultEnd = lines[lines.length - 1]?.index ?? defaultStart;

  const result: Candidate[] = [];
  for (const item of envelope.data.candidates) {
    const parsed = candidateItemSchema.safeParse(item);
    if (!parsed.success) {
      quarantineMalformed(JSON.stringify(item));
      continue;
    }
    const start = parsed.data.lineRange?.[0] ?? defaultStart;
    const end = parsed.data.lineRange?.[1] ?? defaultEnd;
    const sourceRole = roleForLine(lines.find((line) => line.index === start));
    result.push({
      target: parsed.data.target ?? "memory",
      category: parsed.data.category,
      confidence: parsed.data.confidence,
      text: parsed.data.text,
      source: {
        // Candidate is a memory-owned compatibility contract whose persisted
        // field remains `sessionId`; the value is a Conversation ID.
        sessionId: conversationId,
        lineRange: [start, end],
        sourceRole,
      },
    });
  }
  return result;
}
