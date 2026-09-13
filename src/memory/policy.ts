/**
 * Shared memory policy seam.
 *
 * Houses the pure policy helpers used by both the dreaming pipeline and the
 * replay-safe effect application path in `MemoryStore`: procedural-noise
 * classification, near-duplicate detection (text rule plus best-effort cosine
 * enrichment), and event-time provenance scope resolution (decisions 0025,
 * 0035, and 0037). It also defines the boundary types for accepted fact
 * effects and their canonical outcomes.
 *
 * This module owns no I/O: MemoryStore owns SQL and effect receipts; the
 * dreaming pipeline owns phase orchestration and audit artifacts.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { parseSurfaceId } from "../surface.ts";
import { activeMemoryScopeFor, resolveActiveScope, type MemoryScope } from "./scope.ts";
import { stripEntryMetadata } from "./entry.ts";
import { cosineSimilarity } from "./search.ts";
import type { EmbeddingProvider } from "./embeddings.ts";

// ---------------------------------------------------------------------------
// Environment-driven policy constants
// ---------------------------------------------------------------------------

function envFloat(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Confidence threshold below which automatic candidates are rejected. */
export const CONFIDENCE_THRESHOLD = envFloat("GOBLIN_MEMORY_DREAM_CONFIDENCE_THRESHOLD", 0.7);

/** Cosine similarity above which a candidate is considered a duplicate. */
export const DEDUP_COSINE_THRESHOLD = envFloat("GOBLIN_MEMORY_DEDUP_SIMILARITY_THRESHOLD", 0.85);

// ---------------------------------------------------------------------------
// Procedural noise
// ---------------------------------------------------------------------------

const NOISE_PATTERNS: RegExp[] = [
  /^\s*(run|do|try|check|show|list|tell me|explain|what|how|why|when|where|who|can you|could you|would you|please|help|fix|update|create|delete|remove|add|install|build|test|deploy|start|stop|restart|kill|send|write|read|open|close|edit|change|set|get)\b/i,
  /^\s*(hi|hello|hey|thanks|thank you|ok|okay|sure|yes|no|yep|nope|cool|nice|great|lol|haha)\s*$/i,
];

export function isProceduralNoise(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  for (const re of NOISE_PATTERNS) {
    if (re.test(trimmed)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Near-duplicate detection
// ---------------------------------------------------------------------------

export function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
}

export interface ExistingEntry {
  id: string;
  text: string;
}

export interface DuplicateMatch {
  id: string;
  existingText: string;
  preserveExisting: boolean;
}

export function textNearDuplicate(text: string, entries: ExistingEntry[]): DuplicateMatch | null {
  const normalizedText = normalizeText(text);
  if (normalizedText.length === 0) return null;
  const textWords = new Set(normalizedText.split(" "));

  for (const entry of entries) {
    const body = stripEntryMetadata(entry.text);
    const normalizedBody = normalizeText(body);
    if (normalizedBody.length === 0) continue;

    if (normalizedBody === normalizedText) {
      return { id: entry.id, existingText: body, preserveExisting: false };
    }
    if (normalizedBody.includes(normalizedText) || normalizedText.includes(normalizedBody)) {
      const preserveExisting = normalizedBody.length > normalizedText.length;
      return { id: entry.id, existingText: body, preserveExisting };
    }
    const bodyWords = new Set(normalizedBody.split(" "));
    let intersection = 0;
    for (const w of textWords) {
      if (bodyWords.has(w)) intersection++;
    }
    const union = textWords.size + bodyWords.size - intersection;
    if (union > 0 && intersection / union > 0.6) {
      return { id: entry.id, existingText: body, preserveExisting: false };
    }
  }
  return null;
}

/**
 * Cosine-enrichment pass over the scope's existing entries. Requires a live
 * (non-degraded) provider; callers treat a thrown error as "no cosine match"
 * so the canonical path degrades to text-only deduplication.
 */
export async function findNearDuplicateWithEmbeddings(
  text: string,
  entries: ExistingEntry[],
  provider: EmbeddingProvider,
  cosineThreshold: number,
): Promise<DuplicateMatch | null> {
  const allTexts = [text, ...entries.map((e) => stripEntryMetadata(e.text))];
  const embeddings = await provider.embedBatch(allTexts);
  const candidateEmbedding = embeddings[0]?.embedding;
  if (!candidateEmbedding) return null;

  let bestId: string | null = null;
  let bestText = "";
  let bestScore = 0;
  for (let i = 0; i < entries.length; i++) {
    const embedding = embeddings[i + 1]?.embedding;
    if (!embedding) continue;
    const score = cosineSimilarity(candidateEmbedding, embedding);
    if (score > bestScore) {
      bestScore = score;
      bestId = entries[i]!.id;
      bestText = entries[i]!.text;
    }
  }
  if (bestScore >= cosineThreshold && bestId !== null) {
    const existingText = stripEntryMetadata(bestText);
    const preserveExisting = existingText.length > text.length;
    return { id: bestId, existingText, preserveExisting };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Event-time provenance scope resolution
// ---------------------------------------------------------------------------

/**
 * Project a captured SurfaceId to its memory scope. Returns null when the
 * SurfaceId cannot be parsed — the caller decides the fallback (decision 0025
 * sends unprovable provenance to `general`).
 */
export function surfaceProvenanceScope(sourceSurfaceId: string): MemoryScope | null {
  try {
    const surface = parseSurfaceId(sourceSurfaceId);
    return activeMemoryScopeFor(resolveActiveScope(surface));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fact effects (issue #67, decision 0035)
// ---------------------------------------------------------------------------

/** Targets a fact effect may name. `agent` is admitted only to be denied. */
export type MemoryFactTarget = "memory" | "user" | "agent";

export interface MemoryFactEffectSource {
  /** Conversation identity captured with the wake input. */
  readonly session: string;
  /** Cited transcript line index within the captured window. */
  readonly lineIndex: number;
  /** Event-time Surface provenance of the cited line, when captured. */
  readonly sourceSurfaceId: string | null;
}

/**
 * One persisted accepted fact intent, applied through `MemoryStore`. Scope
 * derives from the captured event-time provenance, never the current binding.
 */
export interface MemoryFactEffect {
  /** Stable wake/effect identity; the effect receipt's primary key. */
  readonly effectKey: string;
  readonly target: MemoryFactTarget;
  /** Verbatim fact excerpt. */
  readonly text: string;
  /** Model-judgment confidence carried by the accepted intent. */
  readonly confidence: number;
  readonly source: MemoryFactEffectSource;
}

export type MemoryEffectRejectionReason =
  | "no_agent_authority"
  | "procedural_noise"
  | "unsafe"
  | "low_confidence"
  | "budget_exhausted";

/** Canonical, receipt-recorded outcome of one fact effect. */
export type MemoryEffectOutcome =
  | { readonly kind: "added"; readonly entryId: string }
  | { readonly kind: "updated"; readonly entryId: string; readonly preservedExisting: boolean }
  | { readonly kind: "rejected"; readonly reason: MemoryEffectRejectionReason; readonly message: string };

const memoryEffectOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("added"), entryId: z.string().min(1) }).strict(),
  z.object({
    kind: z.literal("updated"),
    entryId: z.string().min(1),
    preservedExisting: z.boolean(),
  }).strict(),
  z.object({
    kind: z.literal("rejected"),
    reason: z.enum([
      "no_agent_authority",
      "procedural_noise",
      "unsafe",
      "low_confidence",
      "budget_exhausted",
    ]),
    message: z.string().min(1),
  }).strict(),
]);

/**
 * Strictly parse one persisted receipt outcome. A receipt is canonical
 * authority for its effect: anything that does not match the outcome shape is
 * corruption, not a replayable outcome, and fails closed with the effect key
 * (issue #67, admission gate C3).
 */
export function parseMemoryEffectOutcome(effectKey: string, raw: string): MemoryEffectOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`corrupt memory effect receipt for ${effectKey}: outcome is not valid JSON`);
  }
  const outcome = memoryEffectOutcomeSchema.safeParse(parsed);
  if (!outcome.success) {
    const detail = outcome.error.issues
      .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "outcome"}: ${issue.message}`)
      .join("; ")
      .slice(0, 300);
    throw new Error(`corrupt memory effect receipt for ${effectKey}: outcome shape is invalid (${detail})`);
  }
  return outcome.data;
}

/**
 * Resolve the curated scope a fact effect writes to, or null when the target
 * is denied (named-agent targets; decision 0035). User facts go to the `user`
 * scope; memory facts follow the cited line's event-time Surface projection
 * with the `general` fallback when provenance cannot establish a target
 * (decisions 0025 and 0037).
 */
export function resolveFactEffectScope(effect: MemoryFactEffect): MemoryScope | "user" | null {
  if (effect.target === "user") return "user";
  if (effect.target !== "memory") return null;
  if (effect.source.sourceSurfaceId === null) return "general";
  return surfaceProvenanceScope(effect.source.sourceSurfaceId) ?? "general";
}

/**
 * Stable payload identity for one fact effect: a digest over everything the
 * policy outcome depends on. Replay compares this against the recorded
 * receipt; a mismatch under the same effect key is a conflict.
 */
export function factEffectPayloadHash(effect: MemoryFactEffect): string {
  const payload = {
    target: effect.target,
    text: effect.text,
    confidence: effect.confidence,
    source: {
      session: effect.source.session,
      lineIndex: effect.source.lineIndex,
      sourceSurfaceId: effect.source.sourceSurfaceId,
    },
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
